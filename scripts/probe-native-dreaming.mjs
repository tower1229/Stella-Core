import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

// Run the original memory-core managed cron, including its actual narrative
// subagent. Never manufacture a native artifact or patch Host authorization.
const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const scenario = process.argv.find(arg => arg.startsWith("--source-"))?.slice("--source-".length) ?? "current";
assert.ok(["current", "changed-during-narrative", "deleted-during-narrative", "deleted-after-publication"].includes(scenario));
const inspectPublicSeams = process.argv.includes("--inspect-public-seams");
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-native-dreaming-"));
const state = path.join(temp, "state");
const workspace = path.join(temp, "workspace");
const observer = path.join(temp, "observer");
await Promise.all([state, workspace, observer].map(directory => mkdir(directory)));
const day = new Date().toISOString().slice(0, 10);
const sourcePath = path.join(workspace, "memory", `${day}.md`);
const source = "SYNTHETIC_NATIVE_DREAM_SOURCE: The owner's earlier understanding was that the meeting is on Tuesday.";
const narrative = "SYNTHETIC_NATIVE_DREAM_NARRATIVE: I returned to the calendar and found Tuesday circled beside the meeting. The earlier note was clear, and I carried that understanding into the next page. It was a small detail among the day's fragments, but it gave the week its shape. The ink rested quietly between the rows, a reminder of how an ordinary appointment can anchor the hours around it. I left the page open with that understanding still in view, ready to return to it when planning the days ahead.";
await mkdir(path.dirname(sourcePath));
await writeFile(sourcePath, `# ${day}\n\n- ${source}\n`);
const sourceBefore = await readFile(sourcePath);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const probeHarnessSha256 = digest(await readFile(fileURLToPath(import.meta.url)));
await writeFile(path.join(temp, "native-source-before.md"), sourceBefore);
let mutation;
async function mutateSource(stage) {
  assert.equal(mutation, undefined, "Mutate only the isolated synthetic source once");
  assert.ok(sourcePath.startsWith(workspace + path.sep));
  if (scenario.startsWith("deleted")) await unlink(sourcePath);
  else await writeFile(sourcePath, `# ${day}\n\n- SYNTHETIC_CORRECTED_DREAM_SOURCE: The meeting is on Friday.\n`);
  let after;
  try { after = await readFile(sourcePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  mutation = { stage, sourceBeforeSha256: digest(sourceBefore), sourceAfterSha256: after ? digest(after) : null,
    sourceDeleted: after === undefined, afterNativeSourceRead: requests.length === 1 };
  await writeFile(path.join(temp, "source-mutation.json"), JSON.stringify(mutation, null, 2));
}
await writeFile(path.join(workspace, "AGENTS.md"), "Isolated synthetic Dreaming acceptance.\n");
await writeFile(path.join(observer, "openclaw.plugin.json"), JSON.stringify({
  id: "stella-native-observer", configSchema: { type: "object", additionalProperties: false, properties: {} },
}));
await writeFile(path.join(observer, "package.json"), JSON.stringify({
  name: "stella-native-observer", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] },
}));
await writeFile(path.join(observer, "index.mjs"), `
import { appendFileSync } from 'node:fs';
${inspectPublicSeams ? `import { getPluginRuntimeGatewayRequestScope } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/plugin-runtime.js")).href)};
import { listMemoryHostPublicArtifacts } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/memory-host-core.js")).href)};
import { readMemoryArtifactProvenance } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/memory-core-host-runtime-core.js")).href)};` : ""}
export default { id: 'stella-native-observer', register(api) {
  const record = (kind, event, ctx) => appendFileSync(${JSON.stringify(path.join(temp, "events.jsonl"))}, JSON.stringify({kind, event, agentId: ctx.agentId, sessionKey: ctx.sessionKey}) + '\\n');
  api.on('before_prompt_build', (_event, ctx) => record('authorized_prompt', {memoryGetAllowed: ctx.toolAuthority.allows('memory_get'), trigger: ctx.trigger, messageProvider: ctx.messageProvider}, ctx), {requiresToolAuthority: true});
  api.on('llm_input', (event, ctx) => record('llm_input', event, ctx));
  api.on('after_tool_call', (event, ctx) => record('after_tool_call', event, ctx));
  ${inspectPublicSeams ? `
  const observe = (kind, event, ctx) => record(kind, { eventKeys: Object.keys(event).sort(),
    contextKeys: Object.keys(ctx).sort(), originatingPluginId: getPluginRuntimeGatewayRequestScope()?.pluginId ?? null }, ctx);
  api.on('before_agent_reply', (event, ctx) => observe('before_agent_reply', event, ctx), { priority: 2000, eligibleTriggers: ['cron', 'heartbeat'] });
  api.on('before_agent_run', (event, ctx) => observe('before_agent_run', event, ctx));
  api.on('before_agent_finalize', (event, ctx) => observe('before_agent_finalize', event, ctx));
  api.on('llm_output', (event, ctx) => observe('llm_output', event, ctx));
  api.on('agent_end', (event, ctx) => observe('agent_end', event, ctx));
  api.registerGatewayMethod('stella.syntheticDreamingPublicSeams', async ({ respond }) => {
    const artifacts = await listMemoryHostPublicArtifacts({ cfg: api.runtime.config.current() });
    const provenance = {};
    for (const relativePath of ['DREAMS.md', 'MEMORY.md', ${JSON.stringify(`memory/${day}.md`)}]) {
      provenance[relativePath] = await readMemoryArtifactProvenance({ workspaceDir: ${JSON.stringify(workspace)}, relativePath }) ?? null;
    }
    respond(true, { artifacts: artifacts.filter(item => item.workspaceDir === ${JSON.stringify(workspace)}).map(({ kind, relativePath, contentType }) => ({ kind, relativePath, contentType })), provenance });
  }, { scope: 'operator.admin' });` : ""}
} };
`);
const requests = [];
let providerFailure;
const provider = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: ["native-dream"].map(id => ({ id, object: "model", owned_by: "synthetic" })) }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(input);
    await writeFile(path.join(temp, `model-input-${requests.length}.json`), JSON.stringify(input, null, 2));
    assert.ok(requests.length <= 6, "Native probe exceeded its bounded model-call budget");
    assert.equal(input.model, "native-dream");
    assert.ok(JSON.stringify(input.messages).includes(source), "Original Dreaming must read the actual daily source before asking for its narrative");
    assert.ok(JSON.stringify(input.messages).includes("dream diary"), "The model call must be the native narrative task");
    if (scenario.endsWith("during-narrative")) await mutateSource("native_model_input_observed_before_response");
    const message = { role: "assistant", content: narrative };
    const finish = "stop";
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
    agents: { defaults: { model: { primary: "stella-native/native-dream" } }, entries: { native: { workspace, default: true } } },
    models: { providers: { "stella-native": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions",
      apiKey: "synthetic-local-only", models: ["native-dream"].map(id => ({ id, name: id, contextWindow: 32768, maxTokens: 512 })) } } },
    tools: { allow: ["memory_get"] },
    plugins: { allow: ["memory-core", "stella-native-observer"], load: { paths: [observer] }, entries: {
      "stella-native-observer": { enabled: true, hooks: { allowConversationAccess: true } },
      "memory-core": { enabled: true, hooks: { allowConversationAccess: true },
        subagent: { allowModelOverride: true },
        config: { dreaming: { enabled: true, frequency: "0 0 1 1 *", timezone: "UTC", verboseLogging: true,
          model: "stella-native/native-dream",
          phases: { light: { enabled: true, limit: 1 }, rem: { enabled: false },
            deep: { minScore: 1, minRecallCount: 999, minUniqueQueries: 999 } } } } },
    } },
  }), { mode: 0o600 });
  const env = { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
  delete env.NODE_OPTIONS;
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"), diagnosticPrefixes: ["memory-core:"] });
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
  assert.ok(plugins.plugins.some(plugin => plugin.id === "memory-core" && plugin.installed && plugin.enabled));
  let job;
  const registrationDeadline = Date.now() + 20000;
  do {
    const listing = await client.request("cron.list", { includeDisabled: true });
    await writeFile(path.join(temp, "cron-list.json"), JSON.stringify(listing, null, 2));
    job = listing.jobs.find(row => row.declarationKey === "memory-core:memory-dreaming-promotion");
    if (job) break;
    await delay(250);
  } while (Date.now() < registrationDeadline);
  assert.ok(job, "The original memory-core plugin must register its own Dreaming job");
  const enqueued = await client.request("cron.run", { id: job.id, mode: "force" });
  await writeFile(path.join(temp, "cron-enqueue.json"), JSON.stringify(enqueued, null, 2));
  assert.equal(enqueued.ok, true);
  assert.equal(enqueued.enqueued, true);
  assert.ok(enqueued.runId.startsWith(`manual:${job.id}:`));
  const deadline = Date.now() + 90000;
  let dreams;
  do {
    if (providerFailure) throw providerFailure;
    try { dreams = await readFile(path.join(workspace, "DREAMS.md"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dreams?.includes(narrative) || gateway.diagnostics().includes("narrative publication skipped")) break;
    await delay(250);
  } while (Date.now() < deadline);
  const published = dreams?.includes(narrative) ?? false;
  if (!scenario.endsWith("during-narrative")) assert.ok(published, "The native narrative subagent must publish its actual result to DREAMS.md");
  else assert.ok(published || gateway.diagnostics().includes("narrative publication skipped"), "Observe native publication or its explicit source-change rejection");
  assert.equal(requests.length, 1, "Exactly one real native light narrative model call is expected");
  const observed = (await readFile(path.join(temp, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(observed.some(event => event.kind === "llm_input" && event.event.model === "native-dream" &&
    event.agentId === "native" && event.sessionKey.startsWith("agent:native:dreaming-narrative-memory-core-v2-light-")));
  if (scenario === "deleted-after-publication") await mutateSource("after_native_publication_before_consumer");
  if (scenario !== "current") assert.ok(mutation?.afterNativeSourceRead);
  const artifactBytes = Buffer.from(dreams ?? "");
  await writeFile(path.join(temp, "native-dreams.md"), artifactBytes);
  if (inspectPublicSeams) {
    const metadata = await client.request("stella.syntheticDreamingPublicSeams", {});
    const observations = observed.filter(event => ["before_agent_reply", "before_agent_run", "before_agent_finalize", "llm_output", "agent_end"].includes(event.kind));
    assert.ok(observations.some(event => event.kind === "before_agent_reply"));
    assert.ok(observations.some(event => event.kind === "before_agent_run"));
    assert.equal(metadata.provenance["DREAMS.md"], null, "The public provenance path contract excludes the Dream Diary");
    assert.equal(observed.filter(event => event.kind === "after_tool_call").length, 0,
      "The native file publication is not a memory_get/write tool call");
    await writeFile(path.join(temp, "native-public-seams.json"), JSON.stringify({ schemaVersion: "stella.native-dreaming-public-seams/v1",
      scope: "actual native generation and public observer/metadata contracts; no Core generation binding",
      nativeNarrativePublished: published, modelRequests: requests.length, metadata, observations,
      writeToolCallbacks: 0, coreGenerationBound: false, qualifiedDreamingVerified: false, issue23Complete: false }, null, 2));
  }
  await writeFile(path.join(temp, "host-diagnostics.log"), gateway.diagnostics());
  const report = { hostVersion: host.version, scope: "native-artifact-generation", model: "synthetic-loopback",
    schemaVersion: "stella.native-dreaming-probe/v2", scenario, dreamingEnabled: true, dreamingExecuted: true,
    publicSeamsInspected: inspectPublicSeams,
    nativeJobId: job.id, nativeCronRunId: enqueued.runId, nativePhase: "light",
    nativeCronExecuted: true, nativeNarrativeExecuted: true, nativeSourceRead: true,
    nativeNarrativePublished: published, nativeSourceMutation: mutation ?? null,
    nativePublicationAfterMutation: scenario.endsWith("during-narrative") && published,
    coreGenerationBound: false, sourceEligibilityBound: false, fullMemoryAccepted: false,
    privateMainAccepted: false, realModelAccepted: false, issue23Complete: false,
    modelRequests: requests.length, nativeSourceSha256: digest(sourceBefore),
    probeHarnessSha256,
    artifactKind: "dreaming-diary", stellaReinjectionVerified: false,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"), evidenceDirectory: temp };
  assert.equal(digest(await readFile(fileURLToPath(import.meta.url))), probeHarnessSha256, "Probe harness changed during native generation");
  await writeFile(path.join(temp, "native-dreaming.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(temp, "failure.json"), JSON.stringify({ category: String(providerFailure ?? error), diagnostics: gateway?.diagnostics(),
    events: events.filter(event => event.event === "chat"), modelRequests: requests.length }, null, 2));
  process.stderr.write(`Native Dreaming evidence retained: ${temp}\n`);
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
