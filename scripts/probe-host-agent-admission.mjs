import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = path.join(root, "node_modules/openclaw");
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-completion-admission-"));
const state = path.join(temp, "state");
const plugin = path.join(temp, "plugin");
const workspace = path.join(temp, "workspace");
await Promise.all([state, plugin, workspace].map((dir) => mkdir(dir, { recursive: true })));
const eventsPath = path.join(temp, "events.jsonl");
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "stella-admission-probe", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify({
  id: "stella-admission-probe", name: "Synthetic admission probe", activation: { onStartup: true, onAgentHarnesses: ["openclaw"] }, configSchema: { type: "object", additionalProperties: false },
}));
await writeFile(path.join(plugin, "index.mjs"), `
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSessionEntry } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-store-runtime.js")).href)};
import { coordinateCompletion } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion.js")).href)};
import { hasCompletionRunPermit } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion.js")).href)};
import { registerCompletionTranscriptGuard } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion-transcript.js")).href)};
const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ event }) + '\\n');
export default { id: 'stella-admission-probe', register(api) {
  if (${!process.argv.includes("--without-draft-guard")}) registerCompletionTranscriptGuard(api, 'probe');
  api.on('reply_dispatch', async (event, ctx) => {
    record('reply_dispatch');
    const sessionKey = event.sessionKey ?? event.ctx.SessionKey;
    const entry = getSessionEntry({ agentId: 'probe', sessionKey });
    const sessionId = entry?.sessionId ?? randomUUID();
    const runId = event.runId;
    if (!sessionKey || !runId) { record('missing_runtime_identity'); return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }; }
    const ownership = ctx.onAgentRunStart?.(runId, undefined, { completionSource: 'reply-dispatch', getResult: () => ({ terminalOutcome: 'failed' }) });
    record(ownership === 'reply-dispatch' ? 'completion_ownership_accepted' : 'completion_ownership_unavailable');
    try {
      await coordinateCompletion({ operationId: runId, runId, responseKind: 'action_advice', critical: true, timeoutMs: 60000, abortSignal: ctx.abortSignal }, {
        async generateDraft({ abortSignal }) {
          const result = await api.runtime.agent.runEmbeddedAgent({
            agentId: 'probe', sessionId, sessionKey, runId,
            sessionPersistence: ${JSON.stringify(process.argv.includes("--detached") ? "detached" : "durable")},
            workspaceDir: ${JSON.stringify(workspace)}, config: ctx.cfg,
            prompt: 'Synthetic completion generation', transcriptPrompt: event.ctx.Body,
            provider: 'stella-smoke', model: 'probe', modelFallbacksOverride: [],
            timeoutMs: 45000, abortSignal, disableTools: true,
            userTurnTranscriptRecorder: ctx.userTurnTranscriptRecorder,
            prepareAssistantTranscriptMessage: ctx.prepareAssistantTranscriptMessage,
          });
          record('embedded_generation_completed');
          record(getSessionEntry({ agentId: 'probe', sessionKey })?.sessionId === sessionId ? 'session_identity_preserved' : 'session_identity_missing');
          return { draftId: 'synthetic-draft', text: result.payloads?.map((item) => item.text ?? '').join('\\n') ?? '', evidenceRef: 'synthetic-evidence' };
        },
        async persist() { record('synthetic_persist_failure'); throw new Error('synthetic push failure'); },
        async publishFinal() { record('UNEXPECTED_business_publish'); throw new Error('should never publish'); },
      });
    } catch { record('completion_failed_closed'); }
    ctx.dispatcher.sendFinalReply({ text: 'SYNTHETIC_PERSISTENCE_FAILED' });
    ctx.recordProcessed('error', { reason: 'synthetic persistence fault' });
    ctx.markIdle('synthetic probe completed');
    record('probe_settled');
    return { handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  }, { eligibleDispatchKinds: ['agent'] });
  api.on('before_agent_run', (_event, ctx) => { record('before_agent_run'); return hasCompletionRunPermit(ctx.runId) ? { outcome: 'pass' } : { outcome: 'block', reason: 'synthetic no-permit gate', message: 'SYNTHETIC_ADMISSION_BLOCKED', category: 'capability_unavailable' }; });
} };
`);
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic isolated probe. No tools or private data.\n");
let providerRequests = 0;
const provider = createServer((request, response) => {
  providerRequests++;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "synthetic-completion", object: "chat.completion", created: 1, model: "probe",
    choices: [{ index: 0, message: { role: "assistant", content: "SYNTHETIC_UNCOMMITTED_DRAFT" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const configPath = path.join(state, "openclaw.json");
await writeFile(configPath, JSON.stringify({
  gateway: { mode: "local" },
  agents: { defaults: { model: { primary: "stella-smoke/probe" } }, entries: { probe: { workspace } } },
  models: { providers: { "stella-smoke": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-local-only",
    api: "openai-completions", models: [{ id: "probe", name: "probe", contextWindow: 32768, maxTokens: 256 }] } } },
  plugins: { allow: ["stella-admission-probe"], load: { paths: [plugin] }, entries: { "stella-admission-probe": { enabled: true, hooks: { allowConversationAccess: true } } } },
  tools: { deny: ["*"] },
}));
const env = { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
delete env.NODE_OPTIONS;
let gateway;
try {
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  let output;
  try {
    output = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "agent", "--agent", "probe",
      "--session-key", "agent:probe:completion-probe", "--message", "Synthetic admission probe", "--json", "--timeout", "60"],
    { cwd: temp, env: gateway.env, timeout: 120000, maxBuffer: 1048576 });
  } catch (error) { output = error; }
  const eventText = await readFile(eventsPath, "utf8").catch(() => {
    throw new Error(`Synthetic Host probe did not reach admission: ${output.stdout ?? ""}\n${output.stderr ?? ""}`);
  });
  const events = eventText.trim().split("\n").map((line) => JSON.parse(line).event);
  assert.ok(events.includes("before_agent_run"));
  assert.equal(providerRequests, 0);
  assert.ok(`${output.stdout}\n${output.stderr}`.includes("SYNTHETIC_ADMISSION_BLOCKED"));
  await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "call", "chat.send", "--json", "--params",
    JSON.stringify({ sessionKey: "agent:probe:completion-chat-probe", message: "Synthetic chat takeover probe", idempotencyKey: "synthetic-chat-probe" })],
  { cwd: temp, env: gateway.env, timeout: 120000, maxBuffer: 1048576 });
  let chatTakeover = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    const current = await readFile(eventsPath, "utf8");
    if (current.includes('"probe_settled"')) { chatTakeover = true; break; }
    if (current.includes('missing_runtime_identity')) break;
    await delay(250);
  }
  const completionEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line).event);
  const historyOutput = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "call", "chat.history", "--json", "--params",
    JSON.stringify({ sessionKey: "agent:probe:completion-chat-probe", limit: 10 })],
  { cwd: temp, env: gateway.env, timeout: 120000, maxBuffer: 1048576 });
  const history = JSON.parse(historyOutput.stdout);
  const historyMessages = history.messages ?? [];
  const report = { schemaVersion: "stella.host-completion-probe/v1", host: host.version, runner: "gateway-agent-command", events, providerRequests,
    sessionPersistence: process.argv.includes("--detached") ? "detached" : "durable",
    draftTranscriptGuard: !process.argv.includes("--without-draft-guard"),
    completionTakeoverAvailable: events.includes("reply_dispatch"), admissionBlocked: true,
    alternativeChatSendTakeoverAvailable: chatTakeover,
    completionEvents,
    historySummary: { messageCount: historyMessages.length,
      userMessages: historyMessages.filter((message) => message.role === "user").length,
      uncommittedDrafts: historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length,
      failureMessages: historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_PERSISTENCE_FAILED")).length },
    persistenceFailureIsolationPassed: chatTakeover && historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length === 0,
    evidenceDirectory: temp };
  await writeFile(path.join(temp, "completion-capability.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length, 0,
    "chat.history must not expose an uncommitted business draft after persistence failure");
  assert.equal(historyMessages.filter((message) => message.role === "user").length, 1,
    "Host must retain exactly one original user input");
  assert.equal(historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_PERSISTENCE_FAILED")).length, 1,
    "Host must retain one explicit failure reply");
  assert.ok(completionEvents.includes("synthetic_persist_failure"));
  assert.equal(completionEvents.includes("UNEXPECTED_business_publish"), false);
} finally {
  await gateway?.stop();
  await new Promise((resolve) => provider.close(resolve));
}
