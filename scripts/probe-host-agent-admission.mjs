import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = path.join(root, "node_modules/openclaw");
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const successfulPersistence = process.argv.includes("--success");
const useAdapter = process.argv.includes("--adapter");
const cancelStage = process.argv.includes("--cancel-generation") ? "generate"
  : process.argv.includes("--cancel-persistence") ? "persist" : undefined;
assert.ok(!(successfulPersistence && cancelStage), "Choose one probe scenario");
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
import { coordinateCompletion, completionDraftHash } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion.js")).href)};
import { publishCompletionDraft } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion-delivery.js")).href)};
import { hasCompletionRunPermit, recordCompletionPreparation } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion.js")).href)};
import { registerCompletionTranscriptGuard } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion-transcript.js")).href)};
import { registerCompletionAdapter } from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/openclaw/completion-adapter.js")).href)};
const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ event }) + '\\n');
export default { id: 'stella-admission-probe', register(api) {
  if (${!process.argv.includes("--without-draft-guard")}) registerCompletionTranscriptGuard(api, 'probe');
  api.on('before_agent_run', (_event, ctx) => { record('before_agent_run'); return hasCompletionRunPermit(ctx.runId) ? { outcome: 'pass' } : { outcome: 'block', reason: 'synthetic no-permit gate', message: 'SYNTHETIC_ADMISSION_BLOCKED', category: 'capability_unavailable' }; });
  if (${useAdapter}) {
    api.on('before_prompt_build', (_event, ctx) => {
      if (hasCompletionRunPermit(ctx.runId)) recordCompletionPreparation(ctx.runId, { runId: ctx.runId, marker: 'synthetic-preparation' });
    });
    registerCompletionAdapter(api, 'probe', {
      async resourceScope() { return ${JSON.stringify(workspace)}; },
      describeDraft(runId, text, input, preparation) {
        if (preparation?.runId !== runId || preparation?.marker !== 'synthetic-preparation') throw new Error('Synthetic preparation correlation failed');
        record('exact_preparation_captured');
        if (input.text !== 'Synthetic chat takeover probe' || input.event.message?.role !== 'user' || !input.entryId || !input.logicalTurnId) throw new Error('Synthetic original input capture failed');
        record('original_host_input_captured');
        record('embedded_generation_completed');
        return { draftId: 'synthetic-draft', text, evidenceRef: 'synthetic-evidence', responseKind: 'action_advice', requiresCriticalPersistence: true };
      },
      async persist({ operationId, draft, responseKind, abortSignal }) {
        if (${cancelStage === 'persist'}) {
          record('synthetic_persistence_waiting');
          await new Promise((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener('abort', resolve, { once: true });
          });
          record('synthetic_persistence_cancelled');
          throw new Error('Synthetic persistence cancelled');
        }
        if (!${successfulPersistence}) { record('synthetic_persist_failure'); throw new Error('synthetic push failure'); }
        record('synthetic_persist_success');
        return { schemaVersion: 'stella.completion-receipt/v1', operationId, draftId: draft.draftId,
          draftHash: completionDraftHash(draft.text), responseKind, evidenceRef: draft.evidenceRef,
          writeOperationIds: [operationId], observedRevision: 'a'.repeat(40), generationId: 'synthetic-generation',
          persistenceStatus: 'synchronized', checkedAt: new Date().toISOString() };
      },
      settled(runId, result) { record(result ? 'delivery_' + result.delivery.status : 'completion_failed_closed'); record('probe_settled'); },
    });
    return;
  }
  api.on('reply_dispatch', async (event, ctx) => {
    record('reply_dispatch');
    const sessionKey = event.sessionKey ?? event.ctx.SessionKey;
    const entry = getSessionEntry({ agentId: 'probe', sessionKey });
    const sessionId = entry?.sessionId ?? randomUUID();
    const runId = event.runId;
    if (!sessionKey || !runId) { record('missing_runtime_identity'); return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }; }
    let terminalOutcome = 'failed';
    const cancellation = new AbortController();
    const abortSignal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, cancellation.signal]) : cancellation.signal;
    const ownership = ctx.onAgentRunStart?.(runId, undefined, { completionSource: 'reply-dispatch', getResult: () => ({ terminalOutcome: { reason: terminalOutcome, status: terminalOutcome === 'completed' ? 'ok' : 'error' } }) });
    record(ownership === 'reply-dispatch' ? 'completion_ownership_accepted' : 'completion_ownership_unavailable');
    try {
      const completion = await coordinateCompletion({ operationId: runId, runId, timeoutMs: 60000, abortSignal }, {
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
          if (${JSON.stringify(cancelStage ?? "")} === 'generate') { cancellation.abort(); record('synthetic_generation_cancelled'); }
          record(getSessionEntry({ agentId: 'probe', sessionKey })?.sessionId === sessionId ? 'session_identity_preserved' : 'session_identity_missing');
          return { draftId: 'synthetic-draft', text: result.payloads?.map((item) => item.text ?? '').join('\\n') ?? '', evidenceRef: 'synthetic-evidence', responseKind: 'action_advice', requiresCriticalPersistence: true };
        },
        async persist({ operationId, draft, responseKind }) {
          if (${JSON.stringify(cancelStage ?? "")} === 'persist') { cancellation.abort(); record('synthetic_persistence_cancelled'); }
          else if (!${successfulPersistence}) { record('synthetic_persist_failure'); throw new Error('synthetic push failure'); }
          record('synthetic_persist_success');
          return { schemaVersion: 'stella.completion-receipt/v1', operationId, draftId: draft.draftId,
            draftHash: completionDraftHash(draft.text), responseKind, evidenceRef: draft.evidenceRef,
            writeOperationIds: [operationId], observedRevision: 'a'.repeat(40), generationId: 'synthetic-generation',
            persistenceStatus: 'synchronized', checkedAt: new Date().toISOString() };
        },
        async publishFinal(input) {
          record(${successfulPersistence} ? 'business_publish' : 'UNEXPECTED_business_publish');
          record('dispatcher_settled_' + Boolean(ctx.dispatcher.supportsSettledReceipt));
          record('dispatcher_before_deliver_' + Boolean(ctx.dispatcher.appendBeforeDeliver));
          return publishCompletionDraft({ ...input, dispatcher: ctx.dispatcher });
        },
      });
      record('delivery_' + completion.delivery.status);
      terminalOutcome = completion.delivery.status === 'confirmed' ? 'completed' : 'failed';
    } catch (error) { record('completion_failed_closed'); record('completion_failure_' + error.category + '_' + error.stage); }
    if (!${successfulPersistence}) ctx.dispatcher.sendFinalReply({ text: 'SYNTHETIC_PERSISTENCE_FAILED' });
    ctx.recordProcessed(terminalOutcome === 'completed' ? 'completed' : 'error', { reason: 'synthetic probe' });
    ctx.markIdle('synthetic probe completed');
    record('probe_settled');
    return { handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  }, { eligibleDispatchKinds: ['agent'] });
} };
`);
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic isolated probe. No tools or private data.\n");
let providerRequests = 0;
const provider = createServer(async (request, response) => {
  providerRequests++;
  if (useAdapter && cancelStage === 'generate') {
    await new Promise((resolve) => response.on('close', resolve));
    return;
  }
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
let observer;
let prematureVisibleDrafts = 0;
let explicitFailureEvents = 0;
let nativeAbortEvents = 0;
let nativeErrorEvents = 0;
const prematureEventKinds = [];
try {
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Synthetic event observer timed out")), 15000);
    observer = new GatewayClient({
      url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`,
      token: gateway.env.OPENCLAW_GATEWAY_TOKEN, env: gateway.env,
      clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"],
      sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); },
      onConnectError() { clearTimeout(timeout); reject(new Error("Synthetic event observer failed to connect")); },
      onEvent(event) {
        if (event.event === 'chat' && event.payload?.sessionKey === 'agent:probe:completion-chat-probe') {
          if (event.payload.state === 'aborted') nativeAbortEvents++;
          if (event.payload.state === 'error') nativeErrorEvents++;
        }
        if (event.event === 'chat' && event.payload?.state === 'error' &&
            JSON.stringify(event.payload).includes('Stella 未完成本轮请求') &&
            JSON.stringify(event.payload).includes(cancelStage ?? 'persist')) explicitFailureEvents++;
        if (!JSON.stringify(event).includes("SYNTHETIC_UNCOMMITTED_DRAFT")) return;
        let persisted = false;
        try { persisted = readFileSync(eventsPath, "utf8").includes('"synthetic_persist_success"'); } catch {}
        if (!persisted || !successfulPersistence) {
          prematureVisibleDrafts++;
          prematureEventKinds.push({ event: event.event, stream: event.payload?.stream, state: event.payload?.state });
        }
      },
    });
    observer.start();
  });
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
  const chatOutput = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "call", "chat.send", "--json", "--params",
    JSON.stringify({ sessionKey: "agent:probe:completion-chat-probe", message: "Synthetic chat takeover probe", idempotencyKey: "synthetic-chat-probe" })],
  { cwd: temp, env: gateway.env, timeout: 120000, maxBuffer: 1048576 });
  const chatRunId = JSON.parse(chatOutput.stdout).runId;
  let chatTakeover = false;
  let hostCancellationRequested = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    const current = await readFile(eventsPath, "utf8");
    if (useAdapter && cancelStage && !hostCancellationRequested &&
        (cancelStage === 'generate' ? providerRequests > 0 : current.includes('"synthetic_persistence_waiting"'))) {
      const aborted = await observer.request('chat.abort', { sessionKey: 'agent:probe:completion-chat-probe', runId: chatRunId });
      assert.equal(aborted.ok, true, 'Host must accept the cancellation');
      hostCancellationRequested = true;
    }
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
  const terminalOutput = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "call", "agent.wait", "--json", "--params",
    JSON.stringify({ runId: chatRunId, timeoutMs: 10000 })],
  { cwd: temp, env: gateway.env, timeout: 30000, maxBuffer: 1048576 });
  const terminal = JSON.parse(terminalOutput.stdout);
  const failureMarker = useAdapter ? 'Stella 未完成本轮请求' : 'SYNTHETIC_PERSISTENCE_FAILED';
  const report = { schemaVersion: "stella.host-completion-probe/v1", host: host.version, runner: "gateway-agent-command", events, providerRequests,
    scenario: cancelStage ? `cancelled_${cancelStage}` : successfulPersistence ? "synthetic_persistence_success" : "synthetic_persistence_failure",
    adapter: useAdapter ? "Core-public-sdk-adapter" : "probe-inline-adapter",
    terminalStatus: terminal.status,
    prematureVisibleDrafts,
    explicitFailureEvents,
    nativeAbortEvents,
    nativeErrorEvents,
    prematureEventKinds,
    sessionPersistence: process.argv.includes("--detached") ? "detached" : "durable",
    draftTranscriptGuard: !process.argv.includes("--without-draft-guard"),
    completionTakeoverAvailable: events.includes("reply_dispatch"), admissionBlocked: true,
    alternativeChatSendTakeoverAvailable: chatTakeover,
    completionEvents,
    originalHostInputCaptured: completionEvents.includes("original_host_input_captured"),
    exactPreparationCaptured: completionEvents.includes("exact_preparation_captured"),
    hostCancellationRequested,
    historySummary: { messageCount: historyMessages.length,
      userMessages: historyMessages.filter((message) => message.role === "user").length,
      uncommittedDrafts: historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length,
      failureMessages: historyMessages.filter((message) => JSON.stringify(message).includes(failureMarker)).length },
    persistenceFailureIsolationPassed: !successfulPersistence && !cancelStage && chatTakeover && prematureVisibleDrafts === 0 && terminal.status === "error" &&
      completionEvents.includes("synthetic_persist_failure") && (useAdapter ? explicitFailureEvents === 1 : historyMessages.filter((message) => JSON.stringify(message).includes(failureMarker)).length === 1) &&
      historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length === 0,
    cancellationIsolationPassed: Boolean(cancelStage) && chatTakeover && (useAdapter ? hostCancellationRequested && terminal.status === 'error' && prematureVisibleDrafts === 0 && nativeAbortEvents === 1 && nativeErrorEvents === 0 && !completionEvents.includes('synthetic_persist_success') : completionEvents.includes(`synthetic_${cancelStage === "generate" ? "generation" : "persistence"}_cancelled`)) &&
      !completionEvents.includes("UNEXPECTED_business_publish") && historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length === 0,
    successfulPublicationPassed: successfulPersistence && chatTakeover && prematureVisibleDrafts === 0 && terminal.status === "ok" && completionEvents.includes("delivery_confirmed") &&
      historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length === 1,
    evidenceDirectory: temp };
  await writeFile(path.join(temp, "completion-capability.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(historyMessages.filter((message) => JSON.stringify(message).includes("SYNTHETIC_UNCOMMITTED_DRAFT")).length, successfulPersistence ? 1 : 0,
    "chat.history must contain exactly one committed final and no uncommitted draft");
  assert.equal(historyMessages.filter((message) => message.role === "user").length, 1,
    "Host must retain exactly one original user input");
  assert.equal(useAdapter ? explicitFailureEvents : historyMessages.filter((message) => JSON.stringify(message).includes(failureMarker)).length, successfulPersistence || useAdapter && cancelStage ? 0 : 1,
    "Host must deliver one explicit failure through its native error surface");
  if (useAdapter && cancelStage) {
    assert.equal(nativeAbortEvents, 1, 'Host must deliver exactly one native cancellation event');
    assert.equal(nativeErrorEvents, 0, 'User cancellation must not create a duplicate failure notification');
    if (cancelStage === 'generate') assert.equal(completionEvents.includes('synthetic_persistence_waiting'), false);
  }
  if (useAdapter && cancelStage) assert.ok(report.cancellationIsolationPassed);
  else assert.ok(completionEvents.includes(cancelStage ? `synthetic_${cancelStage === "generate" ? "generation" : "persistence"}_cancelled`
    : successfulPersistence ? "synthetic_persist_success" : "synthetic_persist_failure"));
  if (successfulPersistence) assert.ok(completionEvents.includes("delivery_confirmed"));
  if (useAdapter && cancelStage !== 'generate') {
    assert.ok(completionEvents.includes("original_host_input_captured"), "Capture must read the exact committed Host input before persistence");
    assert.ok(report.exactPreparationCaptured, "Preparation must cross Host hook registries with the exact run identity");
  }
  assert.equal(terminal.status, successfulPersistence ? "ok" : "error", "Host terminal status must match coordinated completion");
  assert.equal(prematureVisibleDrafts, 0, "Gateway events must not expose a draft before successful persistence");
  assert.equal(completionEvents.includes("UNEXPECTED_business_publish"), false);
} finally {
  await observer?.stopAndWait({ timeoutMs: 2000 });
  await gateway?.stop();
  await new Promise((resolve) => provider.close(resolve));
}
