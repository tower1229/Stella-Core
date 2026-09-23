import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

// Genuine native recall with a deterministic loopback model. This produces a
// native artifact; it does not by itself certify Stella's consumption gate.
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const { runExactHostEvaluationChat } = await import(pathToFileURL(path.join(packageRoot, "dist/src/acceptance/exact-host-chat.js")).href);
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-native-active-memory-"));
const state = path.join(temp, "state");
const workspace = path.join(temp, "workspace");
const observer = path.join(temp, "observer");
await Promise.all([state, workspace, observer].map(directory => mkdir(directory)));
const sourcePath = path.join(workspace, "memory", "retained-memory.md");
const source = "SYNTHETIC_NATIVE_RECALL_SOURCE: The owner's earlier understanding was that the meeting is on Tuesday.\n";
const summary = "The owner previously understood the meeting to be on Tuesday. SYNTHETIC_NATIVE_RECALL_SUMMARY";
await mkdir(path.dirname(sourcePath));
await writeFile(sourcePath, source);
await writeFile(path.join(workspace, "AGENTS.md"), "Isolated synthetic native memory acceptance. Use only the configured memory_get tool.\n");
await writeFile(path.join(observer, "openclaw.plugin.json"), JSON.stringify({
  id: "stella-native-observer", configSchema: { type: "object", additionalProperties: false, properties: {} },
}));
await writeFile(path.join(observer, "package.json"), JSON.stringify({
  name: "stella-native-observer", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] },
}));
await writeFile(path.join(observer, "index.mjs"), `
import { appendFileSync } from 'node:fs';
export default { id: 'stella-native-observer', register(api) {
  const record = (kind, event, ctx) => appendFileSync(${JSON.stringify(path.join(temp, "events.jsonl"))}, JSON.stringify({kind, event, agentId: ctx.agentId, sessionKey: ctx.sessionKey}) + '\\n');
  api.on('before_prompt_build', (_event, ctx) => record('authorized_prompt', {memoryGetAllowed: ctx.toolAuthority.allows('memory_get'), trigger: ctx.trigger, messageProvider: ctx.messageProvider}, ctx), {requiresToolAuthority: true});
  api.on('llm_input', (event, ctx) => record('llm_input', event, ctx));
  api.on('after_tool_call', (event, ctx) => record('after_tool_call', event, ctx));
} };
`);
const requests = [];
let providerFailure;
const provider = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: ["native-final", "native-recall"].map(id => ({ id, object: "model", owned_by: "synthetic" })) }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(input);
    await writeFile(path.join(temp, `model-input-${requests.length}.json`), JSON.stringify(input, null, 2));
    assert.ok(requests.length <= 6, "Native probe exceeded its bounded model-call budget");
    const recall = input.model === "native-recall";
    assert.ok(recall || input.model === "native-final", "Unexpected model route");
    const toolResults = input.messages.filter(message => message.role === "tool");
    let message;
    let finish = "stop";
    if (recall && toolResults.length === 0) {
      assert.ok(input.tools.some(tool => tool.function?.name === "memory_get"), "Native recall must receive the real memory_get tool");
      message = { role: "assistant", content: null, tool_calls: [{ id: "native-memory-read", type: "function",
        function: { name: "memory_get", arguments: JSON.stringify({ path: "memory/retained-memory.md" }) } }] };
      finish = "tool_calls";
    } else if (recall) {
      assert.ok(toolResults.some(result => JSON.stringify(result.content).includes(source.trim())), "Only summarize after actual native read");
      message = { role: "assistant", content: summary };
    } else {
      assert.ok(JSON.stringify(input.messages).includes(summary), "Native Active Memory must inject its grounded summary into the final model input");
      message = { role: "assistant", content: "SYNTHETIC_NATIVE_FINAL" };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `native-${requests.length}`, object: "chat.completion", created: 1, model: input.model,
      choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch (error) {
    providerFailure ??= error;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "native_probe_assertion_failed", type: "invalid_request_error" } }));
  }
});
let gateway;
let client;
const events = [];
const listeners = new Set();
try {
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const configPath = path.join(state, "openclaw.json");
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: "local" },
    agents: { defaults: { model: { primary: "stella-native/native-final" } }, entries: { native: { workspace } } },
    models: { providers: { "stella-native": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions",
      apiKey: "synthetic-local-only", models: ["native-final", "native-recall"].map(id => ({ id, name: id, contextWindow: 32768, maxTokens: 512 })) } } },
    tools: { allow: ["memory_get"] },
    plugins: { allow: ["active-memory", "memory-core", "stella-native-observer"], load: { paths: [observer] }, entries: {
      "stella-native-observer": { enabled: true, hooks: { allowConversationAccess: true } },
      "active-memory": { enabled: true, hooks: { allowConversationAccess: true }, config: { enabled: true, agents: ["native"], mode: "always", model: "stella-native/native-recall",
        toolsAllow: ["memory_get"], logging: true, persistTranscripts: true, timeoutMs: 45000 } },
    } },
  }), { mode: 0o600 });
  const env = { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
  delete env.NODE_OPTIONS;
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"), diagnosticPrefixes: ["active-memory:"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("native_probe_connection_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); },
      onConnectError() { clearTimeout(timeout); reject(new Error("native_probe_connection_failed")); },
      onEvent(event) { events.push(event); for (const listener of listeners) listener(event); },
    });
    client.start();
  });
  const plugins = await client.request("plugins.list", {});
  await writeFile(path.join(temp, "plugins.json"), JSON.stringify(plugins, null, 2));
  assert.ok(plugins.plugins.some(plugin => plugin.id === "active-memory" && plugin.installed && plugin.enabled));
  const result = await runExactHostEvaluationChat({ request: (method, params) => client.request(method, params, { timeoutMs: 35000 }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  }, { sessionKey: "agent:native:main", message: "What did I previously understand about the meeting date?", idempotencyKey: "native-active-memory", timeoutMs: 90000 });
  if (providerFailure) throw providerFailure;
  assert.equal(result.text, "SYNTHETIC_NATIVE_FINAL");
  assert.equal(requests.filter(input => input.model === "native-recall").length, 2);
  assert.equal(requests.filter(input => input.model === "native-final").length, 1);
  const observed = (await readFile(path.join(temp, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(observed.some(event => event.kind === "authorized_prompt" && event.event.memoryGetAllowed === true));
  assert.ok(observed.some(event => event.kind === "after_tool_call" && event.event.toolName === "memory_get"));
  const artifact = requests.find(input => input.model === "native-final");
  const artifactBytes = JSON.stringify(artifact, null, 2);
  await writeFile(path.join(temp, "native-final-input.json"), artifactBytes);
  const report = { hostVersion: host.version, scope: "native-artifact-generation", model: "synthetic-loopback", runId: result.runId,
    genuineToolAuthority: true, nativeReadExecuted: true, nativeRecallRequests: 2, nativeSummaryInjected: true,
    stellaReinjectionVerified: false, artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"), evidenceDirectory: temp };
  await writeFile(path.join(temp, "native-active-memory.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(temp, "failure.json"), JSON.stringify({ category: String(providerFailure ?? error), diagnostics: gateway?.diagnostics(),
    events: events.filter(event => event.event === "chat"), modelRequests: requests.length }, null, 2));
  process.stderr.write(`Native Active Memory evidence retained: ${temp}\n`);
  throw providerFailure ?? error;
} finally {
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => client?.stopAndWait({ timeoutMs: 2000 })),
    Promise.resolve().then(() => gateway?.stop()),
    Promise.resolve().then(async () => {
      provider.closeAllConnections();
      if (provider.listening) await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }),
  ]);
  const failures = cleanup.filter(result => result.status === "rejected");
  if (failures.length) {
    process.exitCode = 1;
    process.stderr.write(`Native probe resource cleanup failed; evidence retained at ${temp}\n`);
    await writeFile(path.join(temp, "cleanup-failure.json"), JSON.stringify(failures.map(result => String(result.reason))));
  }
}
