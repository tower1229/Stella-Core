import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

// Selection control only: enabling a hook in this synthetic workspace grants
// no production activation or authority to consume its generated artifact.
const selected = process.argv[2] ?? "absent";
assert.ok(["absent", "configured"].includes(selected));
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
assert.equal(JSON.parse(await readFile(path.join(hostRoot, "package.json"))).version, "2026.8.2");
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const { runExactHostEvaluationChat } = await import(pathToFileURL(path.join(packageRoot, "dist/src/acceptance/exact-host-chat.js")).href);
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-hook-selection-"));
const state = path.join(temp, "state"), workspace = path.join(temp, "workspace");
await Promise.all([state, workspace].map(directory => mkdir(directory)));
await mkdir(path.join(workspace, "memory"));
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic hook selection control only.\n");
let modelRequests = 0;
const provider = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));
  assert.ok(++modelRequests <= 3);
  await writeFile(path.join(temp, `model-${modelRequests}.json`), JSON.stringify(input));
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "hook-selection", object: "chat.completion", created: 1, model: "probe",
    choices: [{ index: 0, message: { role: "assistant", content: "SYNTHETIC_HOOK_SELECTION_OBSERVATION" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
let gateway, client;
const listeners = new Set();
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const configPath = path.join(state, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" },
    agents: { defaults: { contextInjection: "always", model: { primary: "stella-hook/probe" } }, entries: { probe: { workspace } } },
    models: { providers: { "stella-hook": { api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      apiKey: "synthetic-local-only", models: [{ id: "probe", name: "synthetic", contextWindow: 32768, maxTokens: 256 }] } } },
    ...(selected === "configured" ? { hooks: { internal: { entries: { "session-memory": { enabled: true, llmSlug: false } } } } } : {}),
    plugins: { allow: ["memory-core"], entries: { "memory-core": { enabled: true, config: { dreaming: { enabled: false } } } } },
    tools: { deny: ["*"] },
  }), { mode: 0o600 });
  gateway = await startExactHostGateway({ cwd: temp, env: { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath },
    openclawBin: path.join(hostRoot, "openclaw.mjs"), diagnosticPrefixes: ["session-memory", "hooks"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hook_selection_connection_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], deviceIdentity: null,
      sharedStateMode: "read-only", onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError: reject,
      onEvent(event) { for (const listener of listeners) listener(event); } }); client.start();
  });
  await runExactHostEvaluationChat({ request: (method, params) => client.request(method, params, { timeoutMs: 35000 }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    { sessionKey: "agent:probe:main", message: "Retain SYNTHETIC_HOOK_SELECTION_OBSERVATION", idempotencyKey: "hook-selection-turn", timeoutMs: 60000 });
  await client.request("chat.send", { sessionKey: "agent:probe:main", message: "/new", idempotencyKey: "hook-selection-reset" });
  const deadline = Date.now() + (selected === "configured" ? 20000 : 3000);
  let artifacts = [];
  do {
    artifacts = (await readdir(path.join(workspace, "memory"))).filter(name => name.endsWith(".md"));
    if (artifacts.length && selected === "configured") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(artifacts.length, selected === "configured" ? 1 : 0);
  const artifact = artifacts[0] ? await readFile(path.join(workspace, "memory", artifacts[0]), "utf8") : undefined;
  if (artifact) assert.ok(artifact.includes("SYNTHETIC_HOOK_SELECTION_OBSERVATION"));
  const report = { schemaVersion: "stella.session-hook-selection/v1", hostVersion: "2026.8.2", selected,
    configuredOnlyInSyntheticControl: selected === "configured", resetLifecycleExecuted: true, nativeArtifactProduced: Boolean(artifact),
    ...(artifact ? { artifactSha256: createHash("sha256").update(artifact).digest("hex") } : {}),
    llmSlugEnabled: false, modelRequests, externalModelRequests: 0, stellaConsumptionVerified: false,
    productionChanged: false, fullMemoryAccepted: false, evidenceDirectory: temp };
  await writeFile(path.join(temp, "selection.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(temp, "host-diagnostics.log"), gateway.diagnostics());
  console.log(JSON.stringify(report));
} finally {
  await client?.stopAndWait({ timeoutMs: 2000 }); await gateway?.stop();
  provider.closeAllConnections(); if (provider.listening) await new Promise(resolve => provider.close(resolve));
}
