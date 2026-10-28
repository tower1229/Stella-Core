import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntry, patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { registerCheckpointPlugin } from "../src/openclaw/checkpoint-plugin-registration.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { assertInitialOwnerTranscript, captureCheckpointHostRequest } from "../src/openclaw/checkpoint-host-request.js";
import { registerCheckpointAgentSupply, CHECKPOINT_MEMORY_TOOL } from "../src/openclaw/checkpoint-agent-supply.js";
import { createAgentSupplySource, publishAgentSupplySourceRevision, SUPPLY_MARKER } from "./checkpoint-agent-supply-fixture.js";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { CHECKPOINT_FAILURE_TEXT } from "../src/openclaw/checkpoint-failure-reply.js";
import { nativeProfileCaller } from "./openclaw-native-caller-fixture.js";

async function fixture(t: TestContext, options: Parameters<typeof createAgentSupplySource>[0] = {}, automaticArchive = false, webchatProfile: boolean | "device" = false) {
  const source = await createAgentSupplySource(options), parent = await realpath(await mkdtemp("/tmp/stella-agent-supply-"));
  t.after(async () => { await rm(source.root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const authority = path.join(parent, "authority"), state = path.join(parent, "host-state"), storePath = path.join(parent, "sessions.json");
  await mkdir(authority); await mkdir(state);
  const config = { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: source.root, agentId: "synthetic", dataMode: "local_write", agentMemory: "fresh_tools", ...(webchatProfile === "device" ? { webchatOwnerDeviceId: "d".repeat(64) } : webchatProfile ? { webchatOwnerProfileId: "synthetic-profile" } : {}), ...(automaticArchive ? { requestArchive: "local" } : {}) };
  const live: any = { commands: { ownerAllowFrom: ["synthetic-owner"] }, session: { store: storePath }, plugins: { entries: { "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config } } } };
  const key = "agent:synthetic:fresh", sessionId = "synthetic-physical-session", runId = "synthetic-normal-host-run";
  await upsertSessionEntry({ agentId: "synthetic", sessionKey: key, storePath, env: { OPENCLAW_STATE_DIR: state }, entry: { sessionId, updatedAt: 1 } });
  if (options.policyContext || options.requesterId) live.agents = { entries: { synthetic: { model: { primary: "google/gemini-3.8-flash", fallbacks: [] } } } };
  const hooks = new Map<string, Function>(), methods = new Map<string, Function>(), factories: Function[] = [], stops: Function[] = [], beforeDeliver: Function[] = [];
  let calls = 0, models = 0, configWrites = 0;
  const observation: { beforeCurrent?: () => void; beforePolicyComplete?: (params: any) => Promise<void> } = {};
  const api = { pluginConfig: config, config: live, runtime: { version: "2026.8.2", state: { resolveStateDir: () => state },
    config: { current: () => { observation.beforeCurrent?.(); return live; }, async mutateConfigFile() { configWrites++; throw new Error("No config writes"); } },
    llm: { async complete(params: any) {
      models++; if (!options.policyContext) throw new Error("No policy judgment expected");
      assert.doesNotMatch(params.messages[0].content, new RegExp(SUPPLY_MARKER));
      await observation.beforePolicyComplete?.(params);
      const input = JSON.parse(params.messages[0].content.split("\n").at(-1));
      return { text: JSON.stringify({ requestHash: input.requestHash, sourceRef: input.sourceRef, policyRef: input.policyRef,
        applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
        ruleChecks: [{ id: "requested_topic", satisfied: options.policyContext === "allow" }] }),
        provider: "google", model: "gemini-3.8-flash", agentId: "synthetic", usage: {}, execution: { mode: "direct-provider", owner: { kind: "provider", id: "google" } },
        audit: { caller: { kind: "plugin", id: "stella-core" } } };
    } } },
    logger: { info() {}, error() {}, warn() {}, debug() {} }, on(name: string, handler: Function) { hooks.set(name, handler); },
    registerGatewayMethod(name: string, handler: Function) { methods.set(name, handler); },
    registerService(service: { stop(): Promise<void> }) { stops.push(() => service.stop()); }, registerTool(factory: Function) { factories.push(factory); },
  } as unknown as OpenClawPluginApi;
  registerCheckpointPlugin(api); t.after(async () => { for (const stop of stops) await stop(); });
  async function rpc(action: string, extra: any = {}) { let result: any; await methods.get("stella.checkpoint")!({ params: { action, ...extra }, respond: (ok: boolean, payload: any, error: any) => { result = { ok, payload, error }; } }); return result; }
  assert.equal((await rpc("initialize", { revision: source.revision, operationId: "synthetic-initialize" })).ok, true);
  const controller = new AbortController(), event: any = { runId, sessionKey: key, sendPolicy: "allow", inboundAudio: false,
    ctx: { SessionKey: key, Body: "Recall my writing preference", SenderId: "synthetic-owner", From: "synthetic-owner", Provider: "webchat", ChatType: "direct", Timestamp: Date.now(), CommandAuthorized: true } };
  if (webchatProfile) {
    delete event.ctx.SenderId; delete event.ctx.From;
    // Keep the pinned Host builder's original context/capability object. A
    // profile stamp alone no longer represents an authenticated 10.7 caller.
    if (webchatProfile !== "device") event.ctx = Object.assign(nativeProfileCaller("synthetic-profile").ctx, event.ctx);
    Object.assign(event.ctx, { Surface: "webchat", GatewayClientScopes: ["operator.admin"], SessionCreation: webchatProfile === "device" ? { via: "operator" } : { via: "operator", actor: { type: "human", source: "profile", id: "synthetic-profile" } },
      ...(webchatProfile === "device" ? { ApprovalReviewerDeviceId: "d".repeat(64) } : {}) });
  }
  const context: any = { dispatchKind: "agent", cfg: live, abortSignal: controller.signal,
    dispatcher: { appendBeforeDeliver(fn: Function) { beforeDeliver.push(fn); } }, recordProcessed() {}, markIdle() {} };
  const agent = { agentId: "synthetic", sessionKey: key, sessionId, runId, modelProviderId: "google", modelId: "gemini-3.8-flash" };
  const toolContext = { agentId: "synthetic", sessionKey: key, sessionId, senderIsOwner: true, requesterSenderId: webchatProfile ? undefined : "synthetic-owner" };
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
  assert.equal(f.beforeDeliver.length, 0);
  assert.equal(f.hooks.has("reply_payload_sending"), false);
  assert.equal(f.hooks.has("before_message_write"), false);
  assert.equal((await f.rpc("status")).payload.capabilities.full_memory, false);
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("device owner uses the existing run, tool and history fences without granting source access implicitly", async t => {
  const f = await fixture(t, { requesterId: "openclaw-device:" + "d".repeat(64) }, true, "device");
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  const list = await f.execute({ action: "list" }); assert.ok(list.details.items.length);
  const read = await f.execute({ action: "read", handle: list.details.items[0].handle });
  assert.ok(read.details.original.text.includes(SUPPLY_MARKER));
  await assert.rejects(f.execute({ action: "read", handle: "E1", senderId: "synthetic-owner" }), /checkpoint_agent_tool_arguments_invalid/);
  await assert.rejects(f.execute({ action: "list" }, true, { runId: "another-run" }), /checkpoint_agent_tool_scope_unavailable/);
  await f.hooks.get("agent_end")!({}, f.agent);
  await assert.rejects(f.execute({ action: "list" }), /checkpoint_agent_tool_scope_unavailable/);
  f.event.runId = f.agent.runId = "synthetic-next-device-run";
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit([{ role: "assistant", content: "Previous answer" }])).outcome, "pass");
  assert.ok((await f.execute({ action: "list" })).details.items.length);
  await f.hooks.get("agent_end")!({}, f.agent);
  f.event.runId = f.agent.runId = "synthetic-device-changed"; f.event.ctx.ApprovalReviewerDeviceId = "b".repeat(64);
  assert.equal((await f.ingress()).handled, true); assert.equal((await f.admit()).outcome, "block");
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("device mode refuses absent and other-principal source grants before any model admission", async t => {
  for (const automaticArchive of [false, true]) for (const requesterId of [undefined, "synthetic-owner"]) await t.test(`${requesterId ?? "no-grant"}/archive=${automaticArchive}`, async t => {
    const f = await fixture(t, { requesterId }, automaticArchive, "device"), before = (await f.rpc("status")).payload.authority;
    assert.equal((await f.ingress()).handled, true);
    assert.equal((await f.rpc("status")).payload.supply.category, requesterId ? "personal_context_requester_forbidden" : "checkpoint_device_source_grant_required");
    assert.equal((await f.admit()).outcome, "block");
    const after = (await f.rpc("status")).payload.authority;
    // Owner-input retention precedes retrieval authorization. Never describe a
    // failed source grant as zero writes when local request archiving is enabled.
    if (automaticArchive) assert.notEqual(after.token, before.token);
    else assert.deepEqual(after, before);
    assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
  });
});

test("device binding does not adopt unknown old transcript or accept changed current identity", async t => {
  const f = await fixture(t, { requesterId: "openclaw-device:" + "d".repeat(64) }, false, "device");
  const captured = captureCheckpointHostRequest(f.api, parseCheckpointPluginConfig(f.config), f.event, f.context, new AbortController().signal);
  f.event.ctx.ApprovalReviewerDeviceId = "c".repeat(64);
  await assert.rejects(captured.assertCurrent(), /checkpoint_webchat_device_not_bound/);
  f.event.ctx.ApprovalReviewerDeviceId = "d".repeat(64);
  await f.ingress(); assert.equal((await f.admit([{ role: "assistant", content: "Unknown previous owner" }])).outcome, "block");
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("unknown initial history, missing ingress, wrong identity and reused request grant remain blocked", async t => {
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
  await assert.rejects(f.execute({ action: "work", question: "A model cannot replace the owner's request" }), /checkpoint_agent_tool_arguments_invalid/);
  await assert.rejects(f.execute({ action: "work" }), /personal_view_processing_grant_required/);
  assert.equal((await f.execute({ action: "list" })).details.items.length, 1, "Optional work permission must not disable existing raw reads");
  await assert.rejects(f.execute({ action: "read", handle: "not-a-handle" }), /checkpoint_agent_handle_unavailable/);
  await assert.rejects(f.execute({ action: "list" }, true, { runId: "another-run" }), /checkpoint_agent_tool_scope_unavailable/);
});

test("already-authorized originals survive a request-local source change, but cancellation and close still stop supply", async t => {
  for (const kind of ["delete", "policy", "cancel", "close"] as const) await t.test(kind, async t => {
    const f = await fixture(t); await f.ingress(); await f.admit();
    const list = await f.execute({ action: "list" }); assert.ok(list.details.items[0].preview.includes(SUPPLY_MARKER));
    if (kind === "delete") await rm(path.join(f.root, f.archive.payload.path));
    if (kind === "policy") {
      const catalog = JSON.parse(await readFile(path.join(f.root, f.catalogPath), "utf8"));
      const file = path.join(f.root, catalog.policies[0].locator.path), document = JSON.parse(await readFile(file, "utf8"));
      document.readPurposes = []; await writeFile(file, JSON.stringify(document));
    }
    if (kind === "cancel") f.controller.abort();
    if (kind === "close") for (const stop of f.stops) await stop();
    if (kind === "cancel" || kind === "close") await assert.rejects(f.execute({ action: "read", handle: "E1" }));
    else {
      const read = await f.execute({ action: "read", handle: "E1" }); assert.ok(read.details.original.text.includes(SUPPLY_MARKER));
      read.details.original.text = "CALLER_MUTATION";
      assert.ok((await f.execute({ action: "read", handle: "E1" })).details.original.text.includes(SUPPLY_MARKER));
    }
  });
});

test("new user request with empty history can reuse a reset physical session but not its old evidence cache", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit(); await f.execute({ action: "list" });
  await f.hooks.get("agent_end")!({}, f.agent);
  await rm(path.join(f.root, f.archive.payload.path));
  f.event.runId = f.agent.runId = "synthetic-next-user-request";
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  await assert.rejects(f.execute({ action: "list" }));
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
  assert.equal((await f.rpc("status")).payload.supply.category, "invalid_personal_context_access");
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


test("cached A remains request-local while the next user request loads committed checkpoint B", async t => {
  for (const cached of [true, false]) await t.test(cached ? "authorized A" : "unseen A", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  const before = (await f.rpc("status")).payload.authority;
  if (cached) await f.execute({ action: "list" });
  const writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(f.config), "2026.8.2"); t.after(() => writer.close());
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-other-source", sessionKey: "agent:synthetic:another",
    prompt: "Synthetic independently authorized new event", senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-other-writer");
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2020-01-02T00:00:00Z" }, { ...f.binding.archive, ownerId: "owner-fixture" });
  const accepted = await writer.archiveLocal({ recovery: await writer.capture(), reader: await CatalogReader.load(f.root, f.catalogPath), archive,
    operationId: "synthetic-independent-writer-B", purpose: f.binding.purpose });
  assert.notEqual(accepted.authority.revision, before.revision); assert.notEqual(accepted.authority.token, before.token);
  if (cached) assert.ok((await f.execute({ action: "read", handle: "E1" })).details.original.text.includes(SUPPLY_MARKER));
  else await assert.rejects(f.execute({ action: "list" }));
  await f.hooks.get("agent_end")!({}, f.agent);
  f.event.runId = f.agent.runId = "synthetic-next-request-B";
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  const next = await f.execute({ action: "list" });
  assert.equal(next.details.items.length, 2);
  assert.ok(next.details.items.some((item: { preview: string }) => item.preview.includes("Synthetic independently authorized new event")));
  assert.deepEqual((await f.rpc("status")).payload.authority, accepted.authority);
  });
});


test("Host retains native output and history ownership without Core delivery interception", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  assert.equal(f.hooks.has("reply_payload_sending"), false);
  assert.equal(f.hooks.has("before_message_write"), false);
  assert.equal(f.beforeDeliver.length, 0);
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
  assert.equal(f.hooks.has("reply_payload_sending"), false);
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


test("an unseen source failure denies first supply without claiming Host output control", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  await rm(path.join(f.root, f.archive.payload.path));
  await assert.rejects(f.execute({ action: "list" }));
  assert.equal(f.hooks.has("reply_payload_sending"), false);
  assert.equal(f.hooks.has("before_message_write"), false);
});

test("source changes before first authorization cannot enter a request-local cache", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  await writeFile(path.join(f.root, f.archive.payload.path), "UNAUTHORIZED_REPLACEMENT");
  await assert.rejects(f.execute({ action: "list" }));
  await assert.rejects(f.execute({ action: "read", handle: "E1" }), /checkpoint_agent_handle_unavailable/);
});

test("public session lifecycle changes invalidate old request identity", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit(); await f.execute({ action: "list" });
  await upsertSessionEntry({ agentId: "synthetic", sessionKey: f.agent.sessionKey, storePath: f.storePath,
    env: { OPENCLAW_STATE_DIR: f.state }, entry: { sessionId: f.agent.sessionId, lifecycleRevision: "synthetic-reset-revision", updatedAt: 2 } });
  await assert.rejects(f.execute({ action: "read", handle: "E1" }), /checkpoint_ingress_session_changed/);
});


test("owner ingress automatically archives once before normal Agent supply and the next user request reads it", async t => {
  const f = await fixture(t, {}, true), run = promisify(execFile);
  const git = async (...args: string[]) => (await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", f.root, ...args])).stdout.trim();
  const marker = "SYNTHETIC_AUTOMATIC_OWNER_INPUT_7296"; f.event.ctx.Body = marker; delete f.event.ctx.Timestamp;
  const before = (await f.rpc("status")).payload.authority, received = Date.now();
  assert.equal(await f.ingress(), undefined);
  const after = (await f.rpc("status")).payload; assert.equal(after.ingress.state, "local_committed");
  assert.equal(after.ingress.capturedAtSource, "core_receive_clock"); assert.notEqual(after.authority.token, before.token);
  assert.equal(await git("rev-list", "--count", `${before.revision}..HEAD`), "1");
  assert.equal((await f.admit()).outcome, "pass");
  const list = await f.execute({ action: "list" }), selected = list.details.items.find((item: any) => item.preview === marker); assert.ok(selected);
  const original = (await f.execute({ action: "read", handle: selected.handle })).details.original;
  assert.equal(original.text, marker); assert.ok(Date.parse(original.capturedAt) >= received);
  const reader = await CatalogReader.load(f.root, f.catalogPath), source = await reader.read(reader.catalog.sources.find(entry => entry.id === selected.evidence.id.replace("evidence_", "source_"))!, "sources");
  const payload = JSON.parse(await readFile(path.join(f.root, (source.payloads as any[])[0].path), "utf8"));
  assert.equal(payload.request.hostMessageTimestamp, undefined); assert.equal(payload.request.prompt, marker);
  assert.equal((await f.ingress()).handled, true); // Duplicate grant never reruns archive or model.
  assert.deepEqual((await f.rpc("status")).payload.authority, after.authority);
  await f.hooks.get("agent_end")!({}, f.agent);
  f.event.runId = f.agent.runId = "synthetic-next-automatic-user"; f.event.ctx.Body = "Recall the previous preference";
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  const next = await f.execute({ action: "list" }), retained = next.details.items.find((item: any) => item.preview === marker); assert.ok(retained);
  assert.equal((await f.execute({ action: "read", handle: retained.handle })).details.original.text, marker);
  const final = (await f.rpc("status")).payload; assert.notEqual(final.authority.token, after.authority.token);
  assert.equal(await git("rev-list", "--count", `${before.revision}..HEAD`), "2");
  assert.equal((await CatalogReader.load(f.root, f.catalogPath)).catalog.sources.length, 3);
  assert.equal(final.capabilities.full_memory, false); assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("automatic archive failure never admits Agent execution or advances checkpoint", async t => {
  for (const kind of ["non-owner", "group", "cancel", "do-not-retain", "invalid-time"] as const) await t.test(kind, async t => {
    const f = await fixture(t, { doNotRetain: kind === "do-not-retain" }, true), before = (await f.rpc("status")).payload.authority;
    if (kind === "non-owner") f.event.ctx.SenderId = f.event.ctx.From = "synthetic-outsider";
    if (kind === "group") f.event.ctx.ChatType = "group";
    if (kind === "cancel") f.controller.abort();
    if (kind === "invalid-time") f.event.ctx.Timestamp = Number.NaN;
    assert.equal((await f.ingress()).handled, true); assert.equal((await f.admit()).outcome, "block");
    assert.deepEqual((await f.rpc("status")).payload.authority, before); assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
  });
});

test("nested archive and direct preparation failures publish one sanitized failure reply without Agent admission", async t => {
  for (const mode of ["archive", "preparation"] as const) await t.test(mode, async t => {
    const f = await fixture(t, { doNotRetain: mode === "archive" }, true);
    const before = (await f.rpc("status")).payload.authority;
    const delivered: Array<{ text?: string; isError?: boolean }> = [], outcomes: string[] = []; let idle = 0;
    f.context.dispatcher = createReplyDispatcher({ async deliver(payload) { delivered.push(payload); } });
    f.context.recordProcessed = (outcome: string) => outcomes.push(outcome);
    f.context.markIdle = () => { idle++; };
    if (mode === "preparation") f.event.ctx.SenderId = f.event.ctx.From = "synthetic-outsider";
    const result = await f.ingress();
    assert.equal(result.handled, true); assert.equal(result.queuedFinal, true); assert.equal(result.counts.final, 1);
    assert.deepEqual(delivered, [{ text: CHECKPOINT_FAILURE_TEXT, isError: true }]);
    assert.ok(outcomes.length); assert.ok(outcomes.every(outcome => outcome === "error"));
    assert.equal(idle, 1); assert.equal((await f.admit()).outcome, "block");
    assert.deepEqual((await f.rpc("status")).payload.authority, before);
    await f.ingress(); assert.equal(delivered.length, 1, "same failed request cannot send twice"); assert.equal(idle, 1);
    assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
  });
});


test("Agent preparation refuses a checkpoint different from the archive return instead of adopting observation", async t => {
  const f = await fixture(t), writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(f.config), "2026.8.2"); t.after(() => writer.close());
  const original = await writer.capture(), request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-intervening-session",
    sessionKey: "agent:synthetic:intervening", prompt: "Synthetic intervening publication", senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-intervening-run");
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2020-01-02T00:00:00Z" }, { ...f.binding.archive, ownerId: "owner-fixture" });
  const accepted = await writer.archiveLocal({ recovery: original, reader: await CatalogReader.load(f.root, f.catalogPath), archive,
    operationId: "synthetic-intervening-publication", purpose: f.binding.purpose });
  const isolatedScope = registerCheckpointAgentSupply(f.api, parseCheckpointPluginConfig(f.config), async () => writer, undefined, async () => ({ recovery: original }));
  t.after(() => isolatedScope.close());
  assert.equal((await f.ingress()).handled, true); assert.equal(isolatedScope.status()?.category, "checkpoint_agent_archive_changed");
  assert.equal((await f.admit()).outcome, "block"); assert.deepEqual((await f.rpc("status")).payload.authority, accepted.authority);
});


test("same owner keeps conversation history while every new request obtains fresh tools and provenance", async t => {
  const f = await fixture(t, {}, true);
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  const first = await f.execute({ action: "list" }), a = first.details.currentMemory;
  assert.equal(a.userRequest, f.event.runId); await f.hooks.get("agent_end")!({}, f.agent);
  f.event.runId = f.agent.runId = "synthetic-continuous-next"; f.event.ctx.Body = "Continue the previous conversation";
  assert.equal(await f.ingress(), undefined);
  assert.equal((await f.admit([{ role: "assistant", content: "Past conversation remains" }, { role: "toolResult", content: first.content }])).outcome, "pass");
  const next = await f.execute({ action: "list" }); assert.equal(next.details.currentMemory.userRequest, f.event.runId);
  assert.notEqual(next.details.currentMemory.checkpointToken, a.checkpointToken);
  const prompt = await f.hooks.get("before_prompt_build")!({}, f.agent);
  assert.ok(prompt.appendSystemContext.includes("history records what was said") && prompt.appendSystemContext.includes("not proof of current facts"));
  const status = (await f.rpc("status")).payload; assert.equal(status.mode, "experimental_owner_chat");
  assert.equal(status.capabilities.continuousOwnerChat, true); assert.deepEqual(status.blockers, []); assert.equal(status.capabilities.full_memory, false);
});

test("public session owner binding survives a registration restart without clearing chat history", async t => {
  const f = await fixture(t); await f.ingress(); assert.equal((await f.admit()).outcome, "pass"); await f.hooks.get("agent_end")!({}, f.agent);
  const before = getSessionEntry({ agentId: "synthetic", sessionKey: f.agent.sessionKey, storePath: f.storePath, env: { OPENCLAW_STATE_DIR: f.state }, readConsistency: "latest" });
  assert.ok(before?.pluginExtensions?.["stella-core"]?.["owner-history/v1"]);
  for (const stop of f.stops) await stop(); registerCheckpointPlugin(f.api);
  f.event.runId = f.agent.runId = "synthetic-after-registration-restart";
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit([{ role: "assistant", content: "Retained prior history" }])).outcome, "pass");
  const value = { action: "list" }, callId = "synthetic-restarted-tool";
  assert.equal(await f.hooks.get("before_tool_call")!({ toolName: CHECKPOINT_MEMORY_TOOL, params: value }, { ...f.agent, toolName: CHECKPOINT_MEMORY_TOOL, toolCallId: callId, abortSignal: f.controller.signal }), undefined);
  const currentTool = f.factories.map(factory => factory(f.toolContext)).filter(tool => tool?.name === CHECKPOINT_MEMORY_TOOL).at(-1);
  assert.ok((await currentTool.execute(callId, value, f.controller.signal)).details.items.length);
});

test("changed owner, account or provider is refused before automatic archive writes", async t => {
  for (const kind of ["owner", "account", "provider", "surface", "originating-channel"] as const) await t.test(kind, async t => {
    const f = await fixture(t, {}, true); await f.ingress(); await f.admit(); await f.hooks.get("agent_end")!({}, f.agent);
    const before = (await f.rpc("status")).payload.authority;
    f.event.runId = f.agent.runId = "synthetic-different-audience";
    if (kind === "owner") { f.live.commands.ownerAllowFrom = ["synthetic-owner", "synthetic-other-owner"]; f.event.ctx.SenderId = f.event.ctx.From = "synthetic-other-owner"; }
    if (kind === "account") f.event.ctx.AccountId = "another-synthetic-account";
    if (kind === "provider") f.event.ctx.Provider = "another-synthetic-provider";
    if (kind === "surface") f.event.ctx.Surface = "telegram";
    if (kind === "originating-channel") f.event.ctx.OriginatingChannel = "telegram";
    assert.equal((await f.ingress()).handled, true); assert.equal((await f.rpc("status")).payload.supply.category, "checkpoint_agent_history_audience_changed");
    assert.equal((await f.admit()).outcome, "block"); assert.deepEqual((await f.rpc("status")).payload.authority, before);
  });
});

test("a malformed persisted audience binding is rejected instead of adopted", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit(); await f.hooks.get("agent_end")!({}, f.agent);
  await patchSessionEntry({ agentId: "synthetic", sessionKey: f.agent.sessionKey, storePath: f.storePath, env: { OPENCLAW_STATE_DIR: f.state }, requireWriteSuccess: true,
    update(entry) { return { pluginExtensions: { ...entry.pluginExtensions, "stella-core": { "owner-history/v1": { sessionId: f.agent.sessionId, lifecycleRevision: entry.lifecycleRevision ?? null, principal: "forged" } } } }; } });
  f.event.runId = f.agent.runId = "synthetic-corrupt-binding"; assert.equal((await f.ingress()).handled, true);
  assert.equal((await f.rpc("status")).payload.supply.category, "checkpoint_agent_history_binding_invalid");
});


test("revised source replaces current tool facts while same-owner prior conversation remains", async t => {
  const f = await fixture(t); await f.ingress(); await f.admit();
  const listA = await f.execute({ action: "list" }), originalA = await f.execute({ action: "read", handle: listA.details.items[0].handle });
  await f.hooks.get("agent_end")!({}, f.agent);
  const writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(f.config), "2026.8.2"); t.after(() => writer.close());
  const textB = "SYNTHETIC_REVISED_PREFERENCE_B_5281: Write concrete open questions first.";
  await publishAgentSupplySourceRevision(f, f.authority, await writer.capture(), textB);
  f.event.runId = f.agent.runId = "synthetic-revised-next-request"; f.event.ctx.Body = "Continue our conversation with the current preference";
  assert.equal(await f.ingress(), undefined);
  assert.equal((await f.admit([{ role: "assistant", content: "Previous answer" }, { role: "toolResult", content: originalA.content }])).outcome, "pass");
  const listB = await f.execute({ action: "list" }); assert.equal(listB.details.items.length, 1); assert.equal(listB.details.items[0].preview, textB);
  assert.ok(!JSON.stringify(listB.details).includes(SUPPLY_MARKER));
  const readB = await f.execute({ action: "read", handle: listB.details.items[0].handle }); assert.equal(readB.details.original.text, textB);
  assert.ok(JSON.stringify(originalA.content).includes(SUPPLY_MARKER)); assert.notEqual(readB.details.currentMemory.checkpointToken, originalA.details.currentMemory.checkpointToken);
});


test("initial public v3/v4 session headers preserve exact current owner input and reject unknown history", async t => {
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionKey: "agent:synthetic:new", sessionId: "synthetic-created-session", prompt: "Current input", senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-current-run");
  const current = { type: "message", message: { role: "user", content: request.prompt, idempotencyKey: `${request.runId}:user`, __openclaw: { senderIsOwner: true } } };
  assert.doesNotThrow(() => assertInitialOwnerTranscript([], request));
  for (const version of [3, 4]) await t.test(`version ${version}`, async t => {
    // Both installed Host creation paths use createSessionTranscriptHeader.
    const header = { type: "session", version, id: request.sessionId, timestamp: "2026-10-27T00:00:00.000Z", cwd: "/tmp/synthetic-workspace" };
    assert.doesNotThrow(() => assertInitialOwnerTranscript([header], request));
    assert.doesNotThrow(() => assertInitialOwnerTranscript([header, current], request));
    assert.doesNotThrow(() => assertInitialOwnerTranscript([{ ...header, parentSession: "/tmp/synthetic-parent" }, current], request));
    for (const kind of ["old-run", "old-body", "not-owner", "missing-owner", "assistant", "unknown-system", "text-blocks", "extra-history", "duplicate-header", "duplicate-input"] as const) await t.test(kind, () => {
      const record = structuredClone(current) as any;
      if (kind === "old-run") record.message.idempotencyKey = "another-run:user";
      if (kind === "old-body") record.message.content = "Another input";
      if (kind === "not-owner") record.message.__openclaw.senderIsOwner = false;
      if (kind === "missing-owner") delete record.message.__openclaw;
      if (kind === "assistant") record.message.role = "assistant";
      if (kind === "unknown-system") record.type = "compaction";
      if (kind === "text-blocks") record.message.content = [{ type: "text", text: request.prompt }];
      const events = kind === "extra-history" ? [header, current, record] : kind === "duplicate-header" ? [header, header] : kind === "duplicate-input" ? [current, current] : [header, record];
      assert.throws(() => assertInitialOwnerTranscript(events, request), /checkpoint_agent_history_owner_unknown/);
    });
    for (const [name, change] of [
      ["wrong-session", { id: "another-session" }], ["missing-timestamp", { timestamp: undefined }],
      ["invalid-timestamp", { timestamp: "not-a-date" }], ["numeric-timestamp", { timestamp: 1 }],
      ["missing-cwd", { cwd: undefined }], ["invalid-parent", { parentSession: {} }],
      ["hidden-message", { message: current.message }],
    ] as const) await t.test(name, () => {
      assert.throws(() => assertInitialOwnerTranscript([{ ...header, ...change }], request), /checkpoint_agent_history_owner_unknown/);
    });
    for (const unknown of [undefined, 1, 2, 5, 4.1, "4"]) await t.test(`unknown-version-${unknown}`, () => {
      assert.throws(() => assertInitialOwnerTranscript([{ ...header, version: unknown }], request), /checkpoint_agent_history_owner_unknown/);
    });
  });
});


test("catalogs larger than 64 return complete bounded pages with stable authorized handles", async t => {
  const f = await fixture(t, { additionalEvidence: 66 });
  await f.ingress(); assert.equal((await f.admit()).outcome, "pass");
  let cursor: number | null = 0; const handles: string[] = [];
  do {
    const page = await f.execute({ action: "list", cursor });
    assert.ok(page.details.items.length <= 16); assert.deepEqual(page.details.exclusions, {});
    handles.push(...page.details.items.map((item: any) => item.handle));
    cursor = page.details.nextCursor;
  } while (cursor !== null);
  assert.equal(handles.length, 67); assert.equal(new Set(handles).size, 67);
  assert.equal(handles.at(-1), "E67");
  assert.match((await f.execute({ action: "read", handle: "E67" })).details.original.text, /Synthetic retained entry 67/);
  await assert.rejects(f.execute({ action: "list", cursor: -1 }), /checkpoint_agent_tool_arguments_invalid/);
  await assert.rejects(f.execute({ action: "list", cursor: 68 }), /checkpoint_agent_cursor_unavailable/);
  await assert.rejects(f.execute({ action: "read", handle: "E1", cursor: 0 }), /checkpoint_agent_tool_arguments_invalid/);
});


test("fresh tools reuse v3 policy judgments and retain interpretation constraints", async t => {
  const f = await fixture(t, { policyContext: "allow" });
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  const list = await f.execute({ action: "list" }); assert.equal(list.details.items.length, 1);
  assert.equal(list.details.items[0].usageConstraints[0].rules[0].id, "keep_scope");
  assert.equal(list.details.items[0].usageConstraints[0].quotePolicy, "summarize_only");
  assert.deepEqual(list.details.exclusions, {});
  const read = await f.execute({ action: "read", handle: "E1" });
  assert.match(read.details.original.text, new RegExp(SUPPLY_MARKER));
  assert.equal(read.details.original.usageConstraints[0].rules[0].id, "keep_scope");
  assert.equal(read.details.original.usageConstraints[0].quotePolicy, "summarize_only");
  assert.equal(f.counts().models, 1); assert.equal(f.counts().configWrites, 0);
});

test("v3 business refusal excludes an item without supplying its payload or pretending technical failure", async t => {
  const f = await fixture(t, { policyContext: "deny" });
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit()).outcome, "pass");
  const list = await f.execute({ action: "list" }); assert.deepEqual(list.details.items, []);
  assert.deepEqual(list.details.exclusions, { source_rule_forbidden: 1 }); assert.equal(list.details.examined, 1);
  assert.equal(list.details.nextCursor, null);
  await assert.rejects(f.execute({ action: "read", handle: "E1" }), /checkpoint_agent_handle_unavailable/);
});


test("tool-only cancellation reaches the semantic Host call before any original payload read", async t => {
  const f = await fixture(t, { policyContext: "allow" });
  await f.ingress(); assert.equal((await f.admit()).outcome, "pass");
  const toolAbort = new AbortController(); let reads = 0;
  const readPayload = CatalogReader.prototype.readPayload;
  CatalogReader.prototype.readPayload = async function(...args: Parameters<typeof readPayload>) {
    if (this.root === f.root) reads++;
    return readPayload.apply(this, args);
  };
  t.after(() => { CatalogReader.prototype.readPayload = readPayload; });
  f.observation.beforePolicyComplete = async params => {
    assert.equal(f.controller.signal.aborted, false); toolAbort.abort();
    assert.equal(params.signal.aborted, true); params.signal.throwIfAborted();
  };
  await assert.rejects(f.execute({ action: "list" }, true, { abortSignal: toolAbort.signal }));
  assert.equal(reads, 0); assert.equal(f.counts().models, 1);
});


test("a missing reviewed descriptor is reported as unavailable context, not a policy refusal or an original", async t => {
  const f = await fixture(t, { policyContext: "missing" });
  await f.ingress(); assert.equal((await f.admit()).outcome, "pass");
  const list = await f.execute({ action: "list" });
  assert.deepEqual(list.details.items, []); assert.deepEqual(list.details.exclusions, {});
  assert.deepEqual(list.details.contextRequired, { personal_context_descriptor_required: 1 });
  assert.equal(f.counts().models, 0);
});


test("cancellation after policy approval but before payload access does not start an original read", async t => {
  const f = await fixture(t, { policyContext: "allow" });
  await f.ingress(); assert.equal((await f.admit()).outcome, "pass");
  const toolAbort = new AbortController(); let reads = 0;
  const read = CatalogReader.prototype.read, payload = CatalogReader.prototype.readPayload;
  CatalogReader.prototype.read = async function(...args: Parameters<typeof read>) {
    const value = await read.apply(this, args);
    if (this.root === f.root && args[1] === "coverage") toolAbort.abort();
    return value;
  };
  CatalogReader.prototype.readPayload = async function(...args: Parameters<typeof payload>) {
    if (this.root === f.root) reads++;
    return payload.apply(this, args);
  };
  t.after(() => { CatalogReader.prototype.read = read; CatalogReader.prototype.readPayload = payload; });
  await assert.rejects(f.execute({ action: "list" }, true, { abortSignal: toolAbort.signal }));
  assert.equal(f.controller.signal.aborted, false); assert.equal(reads, 0);
});


test("current profile uses one owner binding across archive, normal Agent tools and continuous history", async t => {
  const f = await fixture(t, {}, true, true);
  const ingress = await f.ingress();
  assert.equal(ingress, undefined, JSON.stringify((await f.rpc("status")).payload.supply)); assert.equal((await f.admit()).outcome, "pass");
  const list = await f.execute({ action: "list" }); assert.ok(list.details.items.length >= 1);
  const read = await f.execute({ action: "read", handle: "E1" }); assert.ok(read.details.original.text.includes(SUPPLY_MARKER));
  const entry = getSessionEntry({ agentId: "synthetic", sessionKey: f.agent.sessionKey, storePath: f.storePath, env: { OPENCLAW_STATE_DIR: f.state } });
  assert.match(JSON.stringify(entry!.pluginExtensions), /openclaw-profile:synthetic-profile/);
  await f.hooks.get("agent_end")!({ success: true }, f.agent);
  f.event.runId = f.agent.runId = "synthetic-profile-second"; f.event.ctx.Body = "Synthetic next profile input";
  assert.equal(await f.ingress(), undefined); assert.equal((await f.admit([{ role: "assistant", content: "Synthetic previous reply" }])).outcome, "pass");
  assert.equal((await f.rpc("status")).payload.ingress.state, "local_committed");
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("profile replacement or forged tool sender cannot borrow a captured run/session permit", async t => {
  const f = await fixture(t, {}, false, true);
  const ingress = await f.ingress();
  assert.equal(ingress, undefined, JSON.stringify((await f.rpc("status")).payload.supply)); assert.equal((await f.admit()).outcome, "pass");
  f.toolContext.requesterSenderId = "openclaw-profile:synthetic-profile";
  await assert.rejects(f.execute({ action: "list" }), /checkpoint_agent_tool_scope_unavailable/);
  f.toolContext.requesterSenderId = undefined;
  f.event.ctx.SessionCreation.actor.id = "another-profile";
  await assert.rejects(f.execute({ action: "list" }), /checkpoint_webchat_profile_required/);
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("an unselected current profile is refused before automatic archive or checkpoint publication", async t => {
  const f = await fixture(t, {}, true, true), before = await f.rpc("status");
  f.event.ctx = Object.assign(nativeProfileCaller("another-profile").ctx, {
    SessionKey: f.event.ctx.SessionKey, Body: f.event.ctx.Body, Timestamp: f.event.ctx.Timestamp,
    Provider: "webchat", Surface: "webchat", ChatType: "direct" });
  assert.equal((await f.ingress()).handled, true);
  const after = await f.rpc("status"); assert.equal(after.payload.supply.category, "checkpoint_webchat_profile_not_bound");
  assert.deepEqual(after.payload.authority, before.payload.authority); assert.equal(after.payload.ingress, null);
});


test("completed owner requests do not exhaust the concurrent capacity and old runs remain refused", { timeout: 120_000 }, async t => {
  const f = await fixture(t), originalRun = f.event.runId;
  for (let index = 0; index < 65; index++) {
    f.event.runId = f.agent.runId = `synthetic-sequential-owner-${index}`;
    const prepared = await f.ingress();
    assert.equal(prepared, undefined, `completed request ${index + 1}: ${JSON.stringify((await f.rpc("status")).payload?.supply)}`);
    assert.equal((await f.admit(index ? [{ role: "assistant", content: "Synthetic prior conversation" }] : [])).outcome, "pass");
    await f.hooks.get("agent_end")!({}, { ...f.agent });
  }
  f.event.runId = f.agent.runId = "synthetic-sequential-owner-0";
  assert.equal((await f.ingress()).handled, true);
  assert.equal((await f.admit()).outcome, "block");
  f.event.runId = f.agent.runId = originalRun;
  assert.equal(await f.ingress(), undefined);
  await f.hooks.get("agent_end")!({}, { ...f.agent });
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("pending preparations count as live capacity and duplicate refusal cannot release their slot", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let preparationsEntered = 0;
  const supply = registerCheckpointAgentSupply(f.api, parseCheckpointPluginConfig(f.config), async () => { throw new Error("No runtime needed for owned refusal"); }, undefined,
    async () => { preparationsEntered++; await barrier; return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }; });
  t.after(() => supply.close());
  const dispatch = (runId: string) => f.hooks.get("reply_dispatch")!({ ...f.event, runId }, f.context);
  const pending = Array.from({ length: 64 }, (_, index) => dispatch(`synthetic-pending-owner-${index}`));
  try {
    assert.throws(() => supply.assertIdle(), /active_turn_drain_required/);
    assert.equal((await dispatch("synthetic-pending-owner-0")).handled, true);
    assert.equal((await dispatch("synthetic-pending-over-capacity")).handled, true);
  } finally { release(); await Promise.all(pending); }
  assert.equal(preparationsEntered, 64);
  supply.assertIdle();
  assert.equal((await dispatch("synthetic-after-owned-refusal")).handled, true);
  assert.equal(supply.status()?.category, "checkpoint_agent_archive_failed");
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});

test("ending a pending preparation prevents its late runtime result from restoring a grant", { timeout: 30_000 }, async t => {
  const f = await fixture(t), runtime = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(f.config), "2026.8.2");
  t.after(() => runtime.close());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const supply = registerCheckpointAgentSupply(f.api, parseCheckpointPluginConfig(f.config), async () => ({ ...runtime,
    async load() { enter(); await barrier; return runtime.load(); } }));
  t.after(() => supply.close());
  const pending = f.ingress();
  await entered;
  try { await f.hooks.get("agent_end")!({}, { ...f.agent }); } finally { release(); }
  assert.equal((await pending)?.handled, true);
  assert.equal((await f.admit()).outcome, "block");
  supply.assertIdle();
  assert.deepEqual(f.counts(), { models: 0, configWrites: 0 });
});


test("import maintenance refuses preparation before identity/history reads or archive writes", async t => {
  const f = await fixture(t); let identityReads = 0, archives = 0;
  f.observation.beforeCurrent = () => { identityReads++; };
  const supply = registerCheckpointAgentSupply(f.api, parseCheckpointPluginConfig(f.config),
    async () => { throw new Error("Maintenance must precede runtime loading"); }, undefined,
    async () => { archives++; }, () => { throw Object.assign(new Error("Maintenance"), { category: "checkpoint_import_in_progress" }); });
  const refused = await f.ingress();
  assert.equal(refused.handled, true); assert.equal(supply.status()?.category, "checkpoint_import_in_progress");
  assert.equal(identityReads, 0); assert.equal(archives, 0); supply.assertIdle();
});
