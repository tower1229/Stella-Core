import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createOrdinaryPlugin, SOURCE_READ_TOOL } from "../src/ordinary-plugin.js";
import { canonicalJson } from "../src/canghai/content-version.js";
import { segmentLocator } from "../src/canghai/source-segments.js";
import { fixture, prefix, profilePath, hostVersion } from "./fixtures/ordinary-source-read.js";
import type { GatewayRequestScopeReader } from "../src/openclaw/ordinary-source-admission.js";

const identity = { agentId: "main", sessionKey: "agent:main:synthetic", sessionId: "synthetic-session" };
const purpose = { readPurpose: "personal_context", derivePurpose: "personal_understanding", deliveryScope: "owner-direct" };
const grantPath = `${prefix}/capabilities/source_access_context.json`;
async function setup(t: TestContext, leafDerivePurposes?: string[], getGatewayRequestScope?: GatewayRequestScopeReader) {
  const f = await fixture(t, 2, 0, undefined, purpose, leafDerivePurposes);
  const source = JSON.parse(await readFile(path.join(f.root, f.catalog.sources[0]!.locator.path), "utf8"));
  const sourceRef = { id: f.catalog.sources[0]!.id, version: f.catalog.sources[0]!.version };
  const segment = source.accessSegments[0];
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: "synthetic-owner", requesterIds: ["synthetic-requester"],
    modelRefs: ["google/gemini-3.8-flash"], purpose, descriptors: [source.policyRef, segment.policyRef].map(policyRef =>
      ({ sourceRef, policyRef, segment: segmentLocator(segment), description: "A synthetic harbor-walk record; no real person or private history." })) };
  f.profile.capabilities.push({ id: "source_access_context", required: true, adapter_id: "stella.personal-context-access", adapter_version: "1",
    config_ref: `path:${grantPath}`, acceptance_ref: `path:${prefix}/not-loaded-acceptance.json`, required_secret_refs: [] } as never);
  await f.put(grantPath, canonicalJson(grant)); await f.put(profilePath, canonicalJson(f.profile)); f.binding.revision = await f.commit();
  const hooks = new Map<string, Function>(); let factory: any, modelCalls = 0, active = true, denyScenario = false;
  const modelRequestHashes = new Set<string>();
  const plugin = createOrdinaryPlugin({ getGatewayRequestScope, completeSourceAccess: async params => {
    modelCalls++;
    const value = JSON.parse(params.prompt.slice(params.prompt.lastIndexOf("\n") + 1));
    modelRequestHashes.add(value.requestHash);
    return { text: JSON.stringify({ requestHash: value.requestHash, sourceRef: value.sourceRef, policyRef: value.policyRef, segment: value.segment,
      applicable: true, scenarios: [denyScenario ? "social" : "writing"], topicRequested: true, topicExplicitlyNamed: true }) };
  } });
  plugin.register!({ pluginConfig: { agentId: "main", publisher: false, sourceRead: f.binding }, runtime: { version: hostVersion },
    registerTool(v: unknown) { factory = v; }, registerCommand() {}, on(name: string, handler: Function) { hooks.set(name, handler); } } as unknown as OpenClawPluginApi);
  function turn(runId = "run-1", changes: { ctx?: Record<string, unknown>; factory?: Record<string, unknown>; receipt?: Record<string, unknown> } = {}) {
    const abort = new AbortController(); let persisted = true, blocked = false;
    const receipt: Record<string, unknown> = { ...identity, storePath: "/synthetic/not-read.db", entryId: runId + "-entry", logicalTurnId: runId + "-turn",
      generation: "synthetic-generation", idempotencyKey: runId + "-key", role: "user", rawSeq: 1, effectiveParentId: null, activeMessagePosition: 0, ...changes.receipt };
    const recorder = new Proxy({ hasPersisted: () => persisted, isBlocked: () => blocked, getAdmissionReceipt: () => receipt }, {
      get(target, key, receiver) { assert.ok(Object.hasOwn(target, key), `forbidden recorder access ${String(key)}`); return Reflect.get(target, key, receiver); },
    });
    const context = { ...identity, requesterSenderId: "synthetic-requester", senderIsOwner: true,
      memoryAudience: { kind: "owner-private", agentId: "main" }, activeModel: { modelRef: "google/gemini-3.8-flash" },
      assertInvocationCurrent() { assert.ok(active, "request_expired"); }, ...changes.factory };
    const event = { runId, sessionKey: identity.sessionKey, ctx: { AgentId: "main", SessionKey: identity.sessionKey,
      SenderId: "synthetic-requester", rawText: "Use the fictional harbor-walk record to answer this synthetic question.", ChatType: "direct", ...changes.ctx } };
    const dispatch = () => hooks.get("reply_dispatch")!(event, { dispatchKind: "agent", abortSignal: abort.signal, userTurnTranscriptRecorder: recorder });
    const tool = factory.create(context).find((v: any) => v.name === SOURCE_READ_TOOL);
    const hook = (callId: string, extra = {}) => hooks.get("before_tool_call")!({ toolName: SOURCE_READ_TOOL, toolCallId: callId, runId },
      { ...identity, toolName: SOURCE_READ_TOOL, toolCallId: callId, runId, abortSignal: abort.signal,
        requester: { senderId: "synthetic-requester", senderIsOwner: true }, ...extra });
    return { receipt, context, event, dispatch, hook, tool, abort,
      pending() { persisted = false; }, commit() { persisted = true; }, block() { blocked = true; },
      end() { hooks.get("agent_end")!({ runId }, { ...identity, runId }); } };
  }
  return { ...f, grant, turn, hooks, modelCalls: () => modelCalls, modelRequestHashes, expire() { active = false; }, deny() { denyScenario = true; } };
}

test("actual ordinary hooks and factory read only reviewed descriptors, then exact original with existing dual-policy kernel", async t => {
  const f = await setup(t), turn = f.turn(); turn.dispatch(); assert.equal(turn.hook("list"), undefined);
  const listed = await turn.tool.execute("list", { action: "list" });
  assert.equal(listed.details.status, "listed"); assert.equal(listed.details.items.length, 1); assert.equal(listed.details.excludedByScopeOnPage, 1);
  assert.equal(f.modelCalls(), 0); assert.equal(JSON.stringify(listed).includes("harbor walk is planned"), false);
  assert.equal(turn.hook("read"), undefined);
  const read = await turn.tool.execute("read", { action: "read", ref: f.refs[0] });
  assert.equal(read.details.status, "read"); assert.equal(read.details.original.text, f.texts[0]); assert.equal(f.modelCalls(), 2);
  assert.equal(read.details.publisher, false); assert.equal(read.details.authorConfirmation, false);
  turn.hook("out-of-scope"); const denied = await turn.tool.execute("out-of-scope", { action: "read", ref: f.refs[1] });
  assert.equal(denied.details.code, "source_descriptor_scope_denied"); assert.equal(f.modelCalls(), 2);
});

test("missing real hook/request fields never use owner flags, model parameters or session latest", async t => {
  const f = await setup(t);
  const absent = f.turn("absent");
  assert.equal((await absent.tool.execute("no-hook", { action: "list" })).details.code, "source_request_admission_unavailable");
  for (const [index, ctx] of [{ rawText: undefined }, { ChatType: "group" }, { InternalTurnSource: "cron" }, { SenderId: undefined }].entries()) {
    const turn = f.turn(`missing-${index}`, { ctx }); turn.dispatch(); assert.equal(turn.hook(`call-${index}`)?.block, true);
    assert.equal((await turn.tool.execute(`call-${index}`, { action: "list", owner: true, requester: "synthetic-requester" })).isError, true);
  }
  assert.equal(f.modelCalls(), 0);
});

test("Host owner/requester/audience/model must match existing grant without granting new identities", async t => {
  const f = await setup(t);
  for (const [index, changes] of [
    { factory: { senderIsOwner: false } }, { factory: { requesterSenderId: "different" } },
    { factory: { memoryAudience: { kind: "conversation", ...identity } } },
    { factory: { activeModel: { modelRef: "google/old-model" } } },
  ].entries()) {
    const turn = f.turn(`denied-${index}`, changes); turn.dispatch(); turn.hook(`call-${index}`);
    const value = await turn.tool.execute(`call-${index}`, { action: "list" }); assert.equal(value.isError, true);
  }
  const other = f.turn("other", { ctx: { SenderId: "other-requester" }, factory: { requesterSenderId: "other-requester" } });
  other.dispatch(); assert.equal(other.hook("other", { requester: { senderId: "other-requester", senderIsOwner: true } }), undefined);
  assert.equal((await other.tool.execute("other", { action: "list" })).details.code, "personal_context_requester_forbidden");
  assert.equal(f.modelCalls(), 0);
});

test("exact call/run/incarnation rejects ambiguity, mismatch, replay and expired original guard", async t => {
  const f = await setup(t), turn = f.turn(); turn.dispatch();
  turn.hook("duplicate"); assert.equal(turn.hook("duplicate")?.block, true);
  assert.equal((await turn.tool.execute("duplicate", { action: "list" })).isError, true);
  turn.hook("incarnation", { sessionId: "other-session" });
  assert.equal((await turn.tool.execute("incarnation", { action: "list" })).details.code, "source_request_binding_mismatch");
  turn.hook("once"); assert.equal((await turn.tool.execute("once", { action: "list" })).details.status, "listed");
  assert.equal(turn.hook("once")?.block, true);
  assert.equal((await turn.tool.execute("once", { action: "list" })).isError, true);
  turn.hook("closed"); f.expire(); turn.context.assertInvocationCurrent = () => {};
  await assert.rejects(turn.tool.execute("closed", { action: "list" }), /request_expired/);
});

test("uncommitted or blocked native turn cannot read; commitment before a later first valid call is supported", async t => {
  const f = await setup(t), turn = f.turn(); turn.pending(); turn.dispatch(); turn.hook("pending");
  assert.equal((await turn.tool.execute("pending", { action: "list" })).details.code, "source_native_admission_unavailable");
  turn.commit(); turn.hook("committed"); assert.equal((await turn.tool.execute("committed", { action: "list" })).details.status, "listed");
  const blocked = f.turn("blocked"); blocked.block(); blocked.dispatch(); blocked.hook("blocked");
  assert.equal((await blocked.tool.execute("blocked", { action: "read", ref: f.refs[0] })).details.code, "source_native_admission_unavailable");
  assert.equal(f.modelCalls(), 0);
});

test("new user request in same session requalifies its own input and rereads selected version; old qualification is not reused", async t => {
  const f = await setup(t), first = f.turn("first"); first.dispatch(); first.hook("first-read");
  assert.equal((await first.tool.execute("first-read", { action: "read", ref: f.refs[0] })).details.status, "read"); first.end();
  const second = f.turn("second", { ctx: { rawText: "A new synthetic request over the same fictional record." } });
  assert.equal(second.hook("no-dispatch")?.block, true); second.dispatch(); second.hook("second-read");
  assert.equal((await second.tool.execute("second-read", { action: "read", ref: f.refs[0] })).details.status, "read");
  assert.equal(f.modelCalls(), 4); assert.equal(f.modelRequestHashes.size, 2);
  await f.put(grantPath, canonicalJson({ ...f.grant, requesterIds: ["changed-requester"] })); await f.commit();
  const third = f.turn("third"); third.dispatch(); third.hook("third-read");
  assert.equal((await third.tool.execute("third-read", { action: "read", ref: f.refs[0] })).details.code, "source_revision_mismatch");
  assert.equal(f.modelCalls(), 4);
});

test("native admission conflict, cancellation and end do not revive an old binding", async t => {
  const f = await setup(t), turn = f.turn(); turn.dispatch(); turn.hook("list");
  assert.equal((await turn.tool.execute("list", { action: "list" })).details.status, "listed");
  turn.receipt.logicalTurnId = "different-turn"; turn.hook("changed");
  assert.equal((await turn.tool.execute("changed", { action: "list" })).details.code, "source_native_admission_unavailable");
  const cancelled = f.turn("cancelled"); cancelled.dispatch(); cancelled.hook("cancelled"); cancelled.abort.abort();
  assert.equal((await cancelled.tool.execute("cancelled", { action: "list" })).isError, true);
  const ended = f.turn("ended"); ended.dispatch(); ended.hook("ended"); ended.end();
  assert.equal((await ended.tool.execute("ended", { action: "list" })).isError, true);
});

test("semantic policy denial remains an explicit read failure; metadata access does not grant body access", async t => {
  const f = await setup(t), turn = f.turn(); turn.dispatch(); turn.hook("denied"); f.deny();
  assert.equal((await turn.tool.execute("denied", { action: "read", ref: f.refs[0] })).details.code, "source_scenario_forbidden");
  assert.equal(f.modelCalls(), 1);
});

test("reviewed descriptor membership cannot override the segment's metadata-processing purpose", async t => {
  const f = await setup(t, ["other-purpose"]), turn = f.turn(); turn.dispatch(); turn.hook("metadata-denied");
  assert.equal((await turn.tool.execute("metadata-denied", { action: "list" })).details.code, "permission_denied");
  assert.equal(f.modelCalls(), 0);
});

function browserScope() {
  const rpc = new AbortController(), connection = new AbortController();
  const client: any = { connId: "synthetic-browser-connection", authenticatedUserProfile: { profileId: "synthetic-requester" },
    connectionSignal: connection.signal, internal: { authenticatedControlUi: true, authenticatedOperator: true } };
  const scope: any = { client, signal: rpc.signal, isWebchatConnect: () => true, hasCurrentClientAuthority: () => true };
  return { scope, client, rpc, connection };
}
const browserFields = { ctx: { SenderId: undefined }, factory: { requesterSenderId: undefined } };

test("authenticated public WebChat profile binds the same native run/call and existing grant without fabricating SenderId", async t => {
  const browser = browserScope(), f = await setup(t, undefined, () => browser.scope);
  const turn = f.turn("browser", browserFields); turn.dispatch();
  assert.equal(turn.event.ctx.SenderId, undefined);
  assert.equal(turn.hook("browser-list", { requester: undefined }), undefined);
  assert.equal((await turn.tool.execute("browser-list", { action: "list" })).details.items.length, 1);
  turn.hook("browser-read", { requester: { senderIsOwner: true } });
  const read = await turn.tool.execute("browser-read", { action: "read", ref: f.refs[0] });
  assert.equal(read.details.original.text, f.texts[0]); assert.equal(read.details.publisher, false);
  assert.equal(f.modelCalls(), 2); assert.equal(turn.context.requesterSenderId, undefined);
});

test("missing or unqualified WebChat scope cannot be replaced with wire-looking owner/profile fields", async t => {
  let scope: any;
  const f = await setup(t, undefined, () => scope);
  for (const [i, mutate] of [
    () => undefined,
    (v: any) => { v.client.internal.authenticatedControlUi = undefined; },
    (v: any) => { v.client.authenticatedUserProfile = undefined; },
    (v: any) => { v.hasCurrentClientAuthority = undefined; },
    (v: any) => { v.hasCurrentClientAuthority = () => false; },
    (v: any) => { v.client.internal.authenticatedOperator = undefined; },
    (v: any) => { v.client.connId = ""; },
    (v: any) => { v.client.invalidated = true; },
  ].entries()) {
    scope = browserScope().scope; if (i === 0) scope = undefined; else mutate(scope);
    const turn = f.turn(`missing-browser-${i}`, browserFields); turn.dispatch();
    assert.equal(turn.hook(`missing-browser-${i}`, { requester: undefined })?.block, true);
    assert.equal((await turn.tool.execute(`missing-browser-${i}`, { action: "list", authenticatedUserProfile: { profileId: "synthetic-requester" },
      owner: true, requester: "synthetic-requester" })).isError, true);
  }
  assert.equal(f.modelCalls(), 0);
});

test("synthetic and delegated Gateway clients cannot fall back to matching transport sender or owner flags", async t => {
  let scope: any;
  const f = await setup(t, undefined, () => scope);
  for (const [i, flag] of ["syntheticClient", "agentToolCaller", "agentRuntimeIdentity", "pluginSubagentRequester"].entries()) {
    scope = browserScope().scope; scope.client.internal[flag] = true;
    for (const [j, fields] of [browserFields, {}].entries()) {
      const turn = f.turn(`delegate-${i}-${j}`, fields); turn.dispatch();
      assert.equal(turn.hook(`delegate-${i}-${j}`)?.block, true);
      assert.equal((await turn.tool.execute(`delegate-${i}-${j}`, { action: "list" })).isError, true);
    }
  }
  assert.equal(f.modelCalls(), 0);
});

test("WebChat profile cannot alias the selected grant or disagree with Host sender, owner or audience", async t => {
  let scope: any = browserScope().scope;
  const f = await setup(t, undefined, () => scope);
  scope.client.authenticatedUserProfile.profileId = "different-profile";
  const other = f.turn("profile-not-granted", browserFields); other.dispatch(); other.hook("profile-not-granted", { requester: undefined });
  assert.equal((await other.tool.execute("profile-not-granted", { action: "list" })).details.code, "personal_context_requester_forbidden");
  scope = browserScope().scope;
  const ctxConflict = f.turn("ctx-conflict", { ...browserFields, ctx: { SenderId: "different-profile" } }); ctxConflict.dispatch();
  assert.equal(ctxConflict.hook("ctx-conflict")?.block, true);
  const hookConflict = f.turn("hook-conflict", browserFields); hookConflict.dispatch();
  assert.equal(hookConflict.hook("hook-conflict", { requester: { senderId: "different-profile", senderIsOwner: true } })?.block, true);
  for (const [i, factory] of [
    { requesterSenderId: "different-profile" }, { requesterSenderId: undefined, senderIsOwner: false },
    { requesterSenderId: undefined, memoryAudience: { kind: "conversation", agentId: "main" } },
  ].entries()) {
    const turn = f.turn(`factory-conflict-${i}`, { ctx: browserFields.ctx, factory }); turn.dispatch(); turn.hook(`factory-conflict-${i}`, { requester: undefined });
    assert.equal((await turn.tool.execute(`factory-conflict-${i}`, { action: "list" })).isError, true);
  }
  assert.equal(f.modelCalls(), 0);
});

test("WebChat keeps native request lifetime after RPC completion; each new request needs fresh live admission", async t => {
  const browser = browserScope(), f = await setup(t, undefined, () => browser.scope);
  const turn = f.turn("admitted-browser", browserFields); turn.dispatch();
  browser.rpc.abort(); browser.connection.abort(); browser.scope.hasCurrentClientAuthority = () => false;
  turn.hook("admitted-list", { requester: undefined });
  assert.equal((await turn.tool.execute("admitted-list", { action: "list" })).details.status, "listed");
  const next = f.turn("new-browser", browserFields); next.dispatch();
  assert.equal(next.hook("new-browser", { requester: undefined })?.block, true);
  turn.hook("old-call", { requester: undefined }); turn.end();
  assert.equal((await turn.tool.execute("old-call", { action: "list" })).isError, true);
});

test("WebChat identity mutation, cross-run call, incarnation mismatch and cancellation remain closed", async t => {
  let scope: any = browserScope().scope;
  const f = await setup(t, undefined, () => scope);
  const changed = f.turn("changed-browser", browserFields); changed.dispatch(); changed.hook("changed-browser", { requester: undefined });
  scope.client.authenticatedUserProfile.profileId = "changed-profile";
  assert.equal((await changed.tool.execute("changed-browser", { action: "list" })).details.code, "source_gateway_principal_changed");
  scope.client.authenticatedUserProfile.profileId = "synthetic-requester";
  assert.equal(changed.hook("restored-profile", { requester: undefined })?.block, true);
  scope = browserScope().scope;
  const first = f.turn("parallel-first", browserFields); first.dispatch();
  const second = f.turn("parallel-second", browserFields); second.dispatch();
  assert.equal(first.hook("cross-run", { requester: undefined, runId: "parallel-second" })?.block, true);
  assert.equal((await second.tool.execute("cross-run", { action: "list" })).isError, true);
  second.hook("wrong-incarnation", { requester: undefined, sessionId: "wrong-incarnation" });
  assert.equal((await second.tool.execute("wrong-incarnation", { action: "list" })).isError, true);
  second.hook("cancelled", { requester: undefined }); second.abort.abort();
  assert.equal((await second.tool.execute("cancelled", { action: "list" })).isError, true);
  assert.equal(f.modelCalls(), 0);
});

test("each WebChat hook and protected read requires the same public scope; parallel principals never merge", async t => {
  const a = browserScope(), b = browserScope();
  b.client.connId = "another-connection"; b.client.authenticatedUserProfile.profileId = "another-profile";
  let scope: any = a.scope;
  const f = await setup(t, undefined, () => scope);
  const first = f.turn("scope-a", browserFields); first.dispatch();
  scope = b.scope;
  const second = f.turn("scope-b", browserFields); second.dispatch(); second.hook("scope-b", { requester: undefined });
  assert.equal((await second.tool.execute("scope-b", { action: "list" })).details.code, "personal_context_requester_forbidden");
  assert.equal(first.hook("scope-conflict", { requester: undefined })?.block, true);
  scope = a.scope;
  assert.equal(first.hook("cannot-revive", { requester: undefined })?.block, true);
  const third = f.turn("scope-c", browserFields); third.dispatch(); third.hook("scope-c", { requester: undefined });
  scope = undefined;
  assert.equal((await third.tool.execute("scope-c", { action: "list" })).details.code, "source_gateway_scope_mismatch");
  scope = a.scope;
  assert.equal(third.hook("restored-scope", { requester: undefined })?.block, true);
  assert.equal(f.modelCalls(), 0);
});
