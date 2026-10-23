import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { registerCheckpointPlugin } from "../src/openclaw/checkpoint-plugin-registration.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { captureCheckpointHostRequest } from "../src/openclaw/checkpoint-host-request.js";
import { CHECKPOINT_MEMORY_TOOL } from "../src/openclaw/checkpoint-agent-supply.js";
import { createAgentSupplySource, SUPPLY_MARKER } from "./checkpoint-agent-supply-fixture.js";

async function fixture(t: TestContext, options: Parameters<typeof createAgentSupplySource>[0] = {}) {
  const source = await createAgentSupplySource(options), parent = await realpath(await mkdtemp("/tmp/stella-agent-supply-"));
  t.after(async () => { await rm(source.root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const authority = path.join(parent, "authority"), state = path.join(parent, "host-state"), storePath = path.join(parent, "sessions.json");
  await mkdir(authority); await mkdir(state);
  const config = { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: source.root, agentId: "synthetic", dataMode: "local_write", agentMemory: "fresh_tools" };
  const live: any = { commands: { ownerAllowFrom: ["synthetic-owner"] }, session: { store: storePath }, plugins: { entries: { "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config } } } };
  const key = "agent:synthetic:fresh", sessionId = "synthetic-physical-session", runId = "synthetic-normal-host-run";
  await upsertSessionEntry({ agentId: "synthetic", sessionKey: key, storePath, env: { OPENCLAW_STATE_DIR: state }, entry: { sessionId, updatedAt: 1 } });
  const hooks = new Map<string, Function>(), methods = new Map<string, Function>(), factories: Function[] = [], stops: Function[] = [], beforeDeliver: Function[] = [];
  let calls = 0, models = 0, configWrites = 0;
  const observation: { beforeCurrent?: () => void } = {};
  const api = { pluginConfig: config, config: live, runtime: { version: "2026.8.2", state: { resolveStateDir: () => state },
    config: { current: () => { observation.beforeCurrent?.(); return live; }, async mutateConfigFile() { configWrites++; throw new Error("No config writes"); } },
    llm: { async complete() { models++; throw new Error("Core must not invoke a model"); } } },
    logger: { info() {}, error() {}, warn() {}, debug() {} }, on(name: string, handler: Function) { hooks.set(name, handler); },
    registerGatewayMethod(name: string, handler: Function) { methods.set(name, handler); },
    registerService(service: { stop(): Promise<void> }) { stops.push(() => service.stop()); }, registerTool(factory: Function) { factories.push(factory); },
  } as unknown as OpenClawPluginApi;
  registerCheckpointPlugin(api); t.after(async () => { for (const stop of stops) await stop(); });
  async function rpc(action: string, extra: any = {}) { let result: any; await methods.get("stella.checkpoint")!({ params: { action, ...extra }, respond: (ok: boolean, payload: any, error: any) => { result = { ok, payload, error }; } }); return result; }
  assert.equal((await rpc("initialize", { revision: source.revision, operationId: "synthetic-initialize" })).ok, true);
  const controller = new AbortController(), event: any = { runId, sessionKey: key, sendPolicy: "allow", inboundAudio: false,
    ctx: { SessionKey: key, Body: "Recall my writing preference", SenderId: "synthetic-owner", From: "synthetic-owner", Provider: "webchat", ChatType: "direct", Timestamp: Date.now(), CommandAuthorized: true } };
  const context: any = { dispatchKind: "agent", cfg: live, abortSignal: controller.signal,
    dispatcher: { appendBeforeDeliver(fn: Function) { beforeDeliver.push(fn); } }, recordProcessed() {}, markIdle() {} };
  const agent = { agentId: "synthetic", sessionKey: key, sessionId, runId, modelProviderId: "google", modelId: "gemini-3.8-flash" };
  const toolContext = { agentId: "synthetic", sessionKey: key, sessionId, senderIsOwner: true, requesterSenderId: "synthetic-owner" };
  const tool = factories.map(factory => factory(toolContext)).find(value => value?.name === CHECKPOINT_MEMORY_TOOL);
  const ingress = () => hooks.get("reply_dispatch")!(event, context);
  const admit = (messages: unknown[] = []) => hooks.get("before_agent_run")!({ prompt: event.ctx.Body, messages, senderIsOwner: true }, agent);
  async function execute(value: unknown, hook = true, overrides: any = {}) {
    const callId = `synthetic-tool-${++calls}`;
    if (hook) { const gate = await hooks.get("before_tool_call")!({ toolName: CHECKPOINT_MEMORY_TOOL, params: value }, { ...agent, toolName: CHECKPOINT_MEMORY_TOOL, toolCallId: callId, abortSignal: controller.signal, ...overrides });
      if (gate?.block) throw new Error(gate.blockReason); }
    return tool.execute(callId, value, controller.signal);
  }
  return { ...source, config, live, api, authority, state, storePath, observation, rpc, hooks, factories, tool, toolContext, event, context, agent, controller, beforeDeliver, ingress, admit, execute, stops, counts: () => ({ models, configWrites }) };
}

test("stock Host orchestration fixture can call retained data tools and continue its model loop", async t => {
  const f = await fixture(t); assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  assert.deepEqual((await f.hooks.get("before_prompt_build")!({}, f.agent)).toolsAllow, [CHECKPOINT_MEMORY_TOOL]);
  const list = await f.execute({ action: "list" }); assert.equal(list.details.items[0].handle, "E1");
  const read = await f.execute({ action: "read", handle: "E1" }); assert.ok(read.details.original.text.includes(SUPPLY_MARKER));
  // This is a synthetic Host/model loop, not an actual transport acceptance.
  const modelRequests = [{ tool: "list" }, { tool: "read" }, { toolResult: read.content, answer: "Preserve unresolved questions." }];
  assert.equal(modelRequests.length, 3); const payload = { text: modelRequests[2]!.answer };
  await f.hooks.get("agent_end")!({ success: true }, f.agent);
  assert.deepEqual(await f.beforeDeliver[0]!(payload), payload);
  assert.equal((await f.rpc("status")).payload.capabilities.full_memory, false);
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("old history, missing ingress, wrong identity and reused physical session remain blocked", async t => {
  for (const kind of ["history", "no-ingress", "wrong-session", "reused"] as const) await t.test(kind, async t => {
    const f = await fixture(t); if (kind !== "no-ingress") await f.ingress();
    if (kind === "wrong-session") f.agent.sessionId = "another-session";
    if (kind === "reused") { assert.equal((await f.admit()).outcome, "pass"); await f.hooks.get("agent_end")!({}, f.agent); }
    assert.equal((await f.admit(kind === "history" ? [{ role: "assistant", content: "OLD_PRIVATE_MARKER" }] : [])).outcome, "block");
    await assert.rejects(f.execute({ action: "list" }, false), /checkpoint_agent_tool_scope_unavailable/);
  });
});

test("tool body gate survives a missing hook and rejects extra arguments, paths and cross-run permits", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  await assert.rejects(f.execute({ action: "list" }, false), /checkpoint_agent_tool_scope_unavailable/);
  await assert.rejects(f.execute({ action: "list", path: "private.md" }), /checkpoint_agent_tool_arguments_invalid/);
  await assert.rejects(f.execute({ action: "read", handle: "E1" }), /checkpoint_agent_handle_unavailable/);
  await assert.rejects(f.execute({ action: "list" }, true, { runId: "another-run" }), /checkpoint_agent_tool_scope_unavailable/);
});

test("live revocation, payload deletion, cancellation and registration close prevent further body supply", async t => {
  for (const kind of ["revoke", "delete", "cancel", "close"] as const) await t.test(kind, async t => {
    const f = await fixture(t); await f.ingress(); await f.admit();
    const list = await f.execute({ action: "list" }); assert.ok(list.details.items[0].preview.includes(SUPPLY_MARKER));
    if (kind === "revoke") f.live.plugins.entries["stella-core"].enabled = false;
    if (kind === "delete") await rm(path.join(f.root, f.archive.payload.path));
    if (kind === "cancel") f.controller.abort();
    if (kind === "close") for (const stop of f.stops) await stop();
    await assert.rejects(f.execute({ action: "read", handle: "E1" }));
    assert.equal(await f.beforeDeliver[0]!({ text: "Stale draft" }), null);
  });
});

test("group ingress never creates a normal Agent memory grant", async t => {
  const f = await fixture(t); f.event.ctx.ChatType = "group";
  assert.equal((await f.ingress()).handled, true); assert.equal((await f.admit()).outcome, "block");
});


test("structured group, channel, cron and subagent keys cannot borrow a direct envelope", async t => {
  for (const suffix of ["telegram:group:synthetic-room", "discord:work:channel:synthetic-room", "cron:synthetic-job", "subagent:11111111-2222-3333-4444-555555555555"]) await t.test(suffix, async t => {
    const f = await fixture(t), key = `agent:synthetic:${suffix}`;
    await upsertSessionEntry({ agentId: "synthetic", sessionKey: key, storePath: f.storePath, env: { OPENCLAW_STATE_DIR: f.state }, entry: { sessionId: f.agent.sessionId, updatedAt: 1 } });
    f.event.sessionKey = f.event.ctx.SessionKey = f.agent.sessionKey = key;
    assert.equal((await f.ingress()).handled, true); assert.equal((await f.admit()).outcome, "block");
    assert.equal((await f.rpc("status")).payload.supply.state, "blocked");
  });
});

test("configured personal access authority is refused rather than silently omitted", async t => {
  const f = await fixture(t, { sourceAccess: true }); assert.equal((await f.ingress()).handled, true);
  assert.equal((await f.rpc("status")).payload.supply.category, "checkpoint_agent_access_binding_not_supported");
  assert.equal((await f.admit()).outcome, "block");
});

test("do_not_retain evidence is never returned into persistent Host tool history", async t => {
  const f = await fixture(t, { doNotRetain: true }); await f.ingress(); await f.admit();
  await assert.rejects(f.execute({ action: "list" }), /checkpoint_agent_source_mode_unavailable/);
});

test("agent_end during an asynchronous tool authorization check invalidates body release", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  f.observation.beforeCurrent = () => { void f.hooks.get("agent_end")!({}, f.agent); };
  await assert.rejects(f.execute({ action: "list" }), /checkpoint_agent_scope_closed/);
});


test("an old Host tool grant cannot adopt a later committed checkpoint B", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  const before = (await f.rpc("status")).payload.authority;
  const writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(f.config), "2026.8.2"); t.after(() => writer.close());
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-other-source", sessionKey: "agent:synthetic:another",
    prompt: "Synthetic independently authorized new event", senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-other-writer");
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2020-01-02T00:00:00Z" }, { ...f.binding.archive, ownerId: "owner-fixture" });
  const accepted = await writer.archiveLocal({ recovery: await writer.capture(), reader: await CatalogReader.load(f.root, f.catalogPath), archive,
    operationId: "synthetic-independent-writer-B", purpose: f.binding.purpose });
  assert.notEqual(accepted.authority.revision, before.revision); assert.notEqual(accepted.authority.token, before.token);
  await assert.rejects(f.execute({ action: "list" }));
  assert.equal(await f.beforeDeliver[0]!({ text: "Old A draft" }), null);
  assert.deepEqual((await f.rpc("status")).payload.authority, accepted.authority);
});


test("public payload gate covers a Host facade without appendBeforeDeliver", async t => {
  const f = await fixture(t); delete f.context.dispatcher.appendBeforeDeliver;
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  await f.execute({ action: "list" });
  const event = { payload: { text: "Synthetic source-current answer" }, kind: "final", runId: f.agent.runId, sessionKey: f.agent.sessionKey };
  const context = { channelId: "webchat", sessionKey: f.agent.sessionKey };
  assert.deepEqual((await f.hooks.get("reply_payload_sending")!(event, context)).payload, event.payload);
  assert.equal((await f.hooks.get("reply_payload_sending")!({ ...event, sessionKey: undefined }, { channelId: "webchat" })).cancel, true);
  assert.equal((await f.hooks.get("reply_payload_sending")!(event, { ...context, sessionKey: "agent:other:wrong" })).cancel, true);
  assert.equal((await f.hooks.get("reply_payload_sending")!({ ...event, runId: "unrecognized" }, { ...context, runId: f.agent.runId })).cancel, true);
  f.live.plugins.entries["stella-core"].enabled = false;
  assert.equal((await f.hooks.get("reply_payload_sending")!(event, context)).cancel, true);
  assert.equal((await f.hooks.get("reply_payload_sending")!({ ...event, runId: "different-run" }, context)).cancel, true);
});

test("public delivery check returns explicit cancellation before a slow Host hook can fail open", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  const original = CatalogReader.prototype.assertCurrent;
  CatalogReader.prototype.assertCurrent = async () => new Promise<void>(() => {});
  try {
    const result = await f.hooks.get("reply_payload_sending")!({ payload: { text: "Must not escape" }, kind: "final", runId: f.agent.runId, sessionKey: f.agent.sessionKey }, { channelId: "webchat" });
    assert.equal(result.cancel, true); assert.equal(result.reason, "checkpoint_agent_delivery_check_timeout");
  } finally { CatalogReader.prototype.assertCurrent = original; }
});


test("readonly Host ingress does not fabricate an absent Host timestamp", async t => {
  const f = await fixture(t); delete f.event.ctx.Timestamp;
  const before = Date.now(), input = captureCheckpointHostRequest(f.api, parseCheckpointPluginConfig(f.config), f.event, f.context, f.controller.signal);
  assert.equal(input.request.hostMessageTimestamp, undefined); assert.ok(Date.parse(input.capturedAt) >= before && Date.parse(input.capturedAt) <= Date.now());
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  assert.ok((await f.execute({ action: "list" })).details.items[0].preview.includes(SUPPLY_MARKER));
});


test("missing or withdrawn public conversation-hook permission blocks native handoff and further supply", async t => {
  for (const kind of ["missing", "withdrawn", "prompt-disabled"] as const) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === "withdrawn") { await f.ingress(); await f.admit(); await f.execute({ action: "list" }); }
    if (kind === "prompt-disabled") f.live.plugins.entries["stella-core"].hooks.allowPromptInjection = false;
    else delete f.live.plugins.entries["stella-core"].hooks.allowConversationAccess;
    if (kind === "withdrawn") {
      await assert.rejects(f.execute({ action: "read", handle: "E1" }), /checkpoint_agent_hook_permission_required/);
      assert.equal(await f.beforeDeliver[0]!({ text: "Stale synthetic answer" }), null);
    } else {
      assert.equal((await f.ingress()).handled, true);
      assert.equal((await f.rpc("status")).payload.supply.category, "checkpoint_agent_hook_permission_required");
      assert.equal((await f.admit()).outcome, "block");
    }
    assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
  });
});


test("separate public plugin registrations share only original exact-scope permits", async t => {
  const f = await fixture(t), hooks = new Map<string, Function>(), factories: Function[] = [], stops: Function[] = [];
  const api = { ...f.api, on(name: string, fn: Function) { hooks.set(name, fn); }, registerTool(factory: Function) { factories.push(factory); },
    registerService(service: { stop(): Promise<void> }) { stops.push(() => service.stop()); } } as unknown as OpenClawPluginApi;
  registerCheckpointPlugin(api); t.after(async () => { for (const stop of stops) await stop(); });
  assert.equal(await f.ingress(), undefined);
  assert.equal((await hooks.get("before_agent_run")!({ messages: [], senderIsOwner: true }, f.agent)).outcome, "pass");
  const callId = "synthetic-cross-registration-call", value = { action: "list" };
  assert.equal(await hooks.get("before_tool_call")!({ toolName: CHECKPOINT_MEMORY_TOOL, params: value }, { ...f.agent, toolName: CHECKPOINT_MEMORY_TOOL, toolCallId: callId, abortSignal: f.controller.signal }), undefined);
  const tool = factories.map(fn => fn(f.toolContext)).find(value => value?.name === CHECKPOINT_MEMORY_TOOL);
  assert.ok((await tool.execute(callId, value, f.controller.signal)).details.items[0].preview.includes(SUPPLY_MARKER));
  assert.equal((await f.hooks.get("reply_payload_sending")!({ payload: { text: "Same original permit" }, runId: f.agent.runId, sessionKey: f.agent.sessionKey }, {})).payload.text, "Same original permit");
  for (const stop of stops) await stop();
  await assert.rejects(f.execute({ action: "list" }));
  assert.equal((await f.admit()).outcome, "block");
});

test("a different configured scope or a replacement after close cannot adopt an old run", async t => {
  const f = await fixture(t); await f.ingress();
  const hooks = new Map<string, Function>();
  const api = { ...f.api, pluginConfig: { ...f.config, checkpointStateDirectory: path.join(f.authority, "different") },
    on(name: string, fn: Function) { hooks.set(name, fn); }, registerService() {}, registerTool() {}, registerGatewayMethod() {} } as unknown as OpenClawPluginApi;
  registerCheckpointPlugin(api);
  assert.equal((await hooks.get("before_agent_run")!({ messages: [], senderIsOwner: true }, f.agent)).outcome, "block");
  for (const stop of f.stops) await stop();
  registerCheckpointPlugin({ ...api, pluginConfig: f.config } as OpenClawPluginApi);
  assert.equal((await hooks.get("before_agent_run")!({ messages: [], senderIsOwner: true }, f.agent)).outcome, "block");
});


test("a source failure before any body release also closes final delivery", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  await rm(path.join(f.root, f.archive.payload.path));
  await assert.rejects(f.execute({ action: "list" }));
  assert.equal((await f.hooks.get("reply_payload_sending")!({ payload: { text: "Must stay blocked" }, runId: f.agent.runId, sessionKey: f.agent.sessionKey }, {})).cancel, true);
});
