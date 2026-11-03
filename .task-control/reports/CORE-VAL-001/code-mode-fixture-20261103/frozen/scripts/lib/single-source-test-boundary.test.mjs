import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSingleSourceTestBoundary } from "./single-source-test-boundary.mjs";
import { createSingleSourceNativeEntry } from "../fixtures/single-source-native-entry.mjs";

const request = "Read the fictional city's walking note. Do not infer a real person's history.";
const seed = () => ({ agentId: "main", sessionKey: "agent:main:test-only", sessionId: "synthetic-session",
  requestSha256: createHash("sha256").update(request).digest("hex"), ref: { id: "synthetic-evidence", version: `sha256:${"a".repeat(64)}` } });
const params = () => ({ action: "read", ref: { ...seed().ref } });
function fixture(options) {
  const abort = new AbortController(), gate = createSingleSourceTestBoundary(seed(), options);
  const ctx = { agentId: "main", sessionKey: seed().sessionKey, sessionId: seed().sessionId,
    runId: "synthetic-run", toolName: "stella_source_read", toolCallId: "synthetic-call", abortSignal: abort.signal,
    assertInvocationCurrent() { abort.signal.throwIfAborted(); } };
  const event = { toolName: ctx.toolName, toolCallId: ctx.toolCallId, runId: ctx.runId, params: params() };
  const dispatch = { runId: ctx.runId, sessionKey: ctx.sessionKey, ctx: {
    AgentId: "main", SessionKey: ctx.sessionKey, ChatType: "direct", rawText: request } };
  const dispatchContext = { dispatchKind: "agent", abortSignal: abort.signal };
  return { gate, ctx, event, dispatch, dispatchContext, abort,
    start() { gate.observeDispatch(dispatch, dispatchContext); },
    tool(execute) { return gate.wrapTool({ name: ctx.toolName, execute }, ctx); } };
}
const allowed = f => assert.deepEqual(f.gate.beforeTool(f.event, f.ctx), { params: params() });

test("one admitted exact read and one original policy completion; no identity/grant manufactured", async () => {
  const f = fixture(); f.start(); allowed(f);
  let reads = 0, policies = 0;
  const result = await f.tool(async () => {
    const verdict = await f.gate.complete({ maxTokens: 8192 }, async () => { policies++; return { text: "synthetic-policy" }; });
    reads++; return verdict;
  }).execute(f.ctx.toolCallId, params());
  assert.deepEqual(result, { text: "synthetic-policy" });
  assert.equal(reads, 1); assert.equal(policies, 1);
  const summary = f.gate.summary();
  assert.equal(summary.executions, 1); assert.equal(summary.policyCompletions, 1);
  assert.equal(summary.completedExecutions, 1); assert.equal(summary.pendingExecutions, 0);
  assert.equal(summary.denials, 0); assert.equal(summary.captureIncomplete, false);
  assert.equal(summary.collectionComplete, false);
});

for (const [name, change] of [
  ["wrong evidence", p => { p.ref.id = "other"; }],
  ["wrong version", p => { p.ref.version = `sha256:${"b".repeat(64)}`; }],
  ["list", p => { p.action = "list"; }],
  ["extra outer field", p => { p.root = "/private"; }],
  ["extra ref field", p => { p.ref.body = "synthetic"; }],
  ["accessor arguments", p => Object.defineProperty(p.ref, "id", { get: () => seed().ref.id })],
]) test(name + " denied before execution", async () => {
  const f = fixture(); f.start(); change(f.event.params);
  assert.equal(f.gate.beforeTool(f.event, f.ctx).block, true);
  let reads = 0;
  await assert.rejects(f.tool(async () => ++reads).execute(f.ctx.toolCallId, f.event.params));
  assert.equal(reads, 0);
});

test("other tools blocked and prompt tools narrowed only for target", () => {
  const f = fixture(); f.start();
  assert.deepEqual(f.gate.beforePrompt({}, f.ctx), { toolsAllow: ["stella_source_read"] });
  assert.equal(f.gate.beforeTool({ ...f.event, toolName: "read" }, { ...f.ctx, toolName: "read" }).block, true);
  assert.equal(f.gate.beforePrompt({}, { sessionKey: "other" }), undefined);
});

test("direct execute cannot bypass before-tool admission; guard remains original", async () => {
  const f = fixture(); f.start(); let calls = 0;
  const wrapped = f.tool(async () => ++calls);
  await assert.rejects(wrapped.execute(f.ctx.toolCallId, params()), /unadmitted/);
  allowed(f); f.abort.abort(); f.ctx.assertInvocationCurrent = () => {};
  await assert.rejects(wrapped.execute(f.ctx.toolCallId, params())); assert.equal(calls, 0);
});

test("concurrent execute and second hook consume no second read", async () => {
  const f = fixture(); f.start(); allowed(f); let release, reads = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const tool = f.tool(async () => { reads++; await barrier; return "first"; });
  const first = tool.execute(f.ctx.toolCallId, params());
  await assert.rejects(tool.execute(f.ctx.toolCallId, params()), /repeated/);
  assert.equal(f.gate.beforeTool({ ...f.event, toolCallId: "second" }, { ...f.ctx, toolCallId: "second" }).block, true);
  release(); assert.equal(await first, "first"); assert.equal(reads, 1);
});

test("failed original permission check consumes attempt; no fallback or retry", async () => {
  const f = fixture(); f.start(); allowed(f); let calls = 0;
  const tool = f.tool(async () => { calls++; throw new Error("original_grant_denied"); });
  await assert.rejects(tool.execute(f.ctx.toolCallId, params()), /original_grant_denied/);
  await assert.rejects(tool.execute(f.ctx.toolCallId, params()), /repeated/); assert.equal(calls, 1);
});

for (const field of ["runId", "sessionId", "sessionKey", "agentId", "toolCallId"]) test(`conflicting ${field} rejected`, () => {
  const f = fixture(); f.start();
  assert.equal(f.gate.beforeTool(f.event, { ...f.ctx, [field]: "conflict" }).block, true);
});

test("absent native dispatch and changed request do not acquire admission", () => {
  const f = fixture(); assert.equal(f.gate.beforeTool(f.event, f.ctx).block, true);
  f.dispatch.ctx.rawText += " different"; f.start();
  assert.equal(f.gate.beforeTool(f.event, f.ctx).block, true); assert.equal(f.gate.summary().requestObserved, false);
});

test("same session new request cannot reuse old qualification", () => {
  const f = fixture(); f.start();
  f.gate.observeDispatch({ ...f.dispatch, runId: "next-run" }, f.dispatchContext);
  assert.equal(f.gate.beforeTool(f.event, f.ctx).block, true);
});

test("cancel, end and delayed timer deadline deny further execution", async () => {
  for (const mode of ["cancel", "end", "deadline"]) {
    let clock = 0; const f = fixture({ now: () => clock }); f.start(); allowed(f); let calls = 0;
    if (mode === "cancel") f.abort.abort();
    if (mode === "end") f.gate.end({ runId: f.ctx.runId }, f.ctx);
    if (mode === "deadline") clock = 90_000;
    await assert.rejects(f.tool(async () => ++calls).execute(f.ctx.toolCallId, params())); assert.equal(calls, 0);
  }
});

test("factory mutation and execute-time argument mutation rejected", async () => {
  const f = fixture(); f.start(); allowed(f); let calls = 0; const tool = f.tool(async () => ++calls);
  const wrong = params(); wrong.ref.id = "other";
  await assert.rejects(tool.execute(f.ctx.toolCallId, wrong));
  f.ctx.sessionId = "changed"; await assert.rejects(tool.execute(f.ctx.toolCallId, params())); assert.equal(calls, 0);
});

test("second policy completion rejected; other async request retains original behavior", async () => {
  const f = fixture(); f.start(); allowed(f); let calls = 0;
  const original = async () => { calls++; return "verdict"; };
  await f.tool(async () => {
    await f.gate.complete({ maxTokens: 8192 }, original);
    await assert.rejects(f.gate.complete({ maxTokens: 8192 }, original), /policy_limit/);
  }).execute(f.ctx.toolCallId, params());
  assert.equal(calls, 1);
  await f.gate.complete({ maxTokens: 8192 }, original); assert.equal(calls, 2);
});

test("other sessions, unbound status and end events unaffected", async () => {
  const f = fixture();
  assert.equal(f.gate.beforeTool({ toolName: "stella_status" }, { toolName: "stella_status" }), undefined);
  f.gate.end({}, {}); assert.equal(f.gate.summary().closed, false);
  const tool = { name: "stella_source_read", execute: async () => "other" };
  assert.equal(f.gate.wrapTool(tool, { sessionKey: "other", sessionId: "other" }), tool);
});

test("return-boundary cancellation and identity mutation cannot pass as success", async () => {
  for (const change of [f => f.abort.abort(), f => { f.ctx.sessionId = "changed"; }]) {
    const f = fixture(); f.start(); allowed(f);
    await assert.rejects(f.tool(async () => { change(f); return "not-deliverable"; }).execute(f.ctx.toolCallId, params()));
  }
});

test("invalid policy token limits and delayed out-of-scope completion never call model port", async () => {
  const f = fixture(); f.start(); allowed(f); let calls = 0, late;
  await f.tool(async () => {
    for (const maxTokens of [0, -1, 8193, NaN, "8192"]) {
      await assert.rejects(f.gate.complete({ maxTokens }, async () => ++calls), /policy_limit/);
    }
    late = new Promise(resolve => setImmediate(() => resolve(assert.rejects(
      f.gate.complete({ maxTokens: 8192 }, async () => ++calls), /outside_execution/))));
  }).execute(f.ctx.toolCallId, params());
  await late; assert.equal(calls, 0);
});

test("thin entry retains native completion and original registration; no admission injection", async () => {
  const handlers = new Map(); let factory, observedOptions, originalCalls = 0, reads = 0;
  const f = fixture();
  const ordinary = {
    createSourcePolicyCompletion(api, agent) { assert.equal(api.tag, "original-api"); assert.equal(agent, "main"); return async () => { originalCalls++; return "verdict"; }; },
    createOrdinaryPlugin(options) {
      observedOptions = options;
      return { register(api) { api.registerTool({ contextVersion: 2, create() { return [{ name: "stella_source_read", async execute() {
        await options.completeSourceAccess({ maxTokens: 8192 }); reads++; return "synthetic-read";
      } }]; } }, { names: ["stella_source_read"] }); } };
    },
  };
  createSingleSourceNativeEntry(ordinary, seed()).register({ tag: "original-api", registerTool(value) { factory = value; },
    on(name, handler) { handlers.set(name, handler); } });
  assert.deepEqual(Object.keys(observedOptions), ["completeSourceAccess"]);
  handlers.get("reply_dispatch")(f.dispatch, f.dispatchContext);
  assert.equal(handlers.get("before_tool_call")(f.event, f.ctx).block, undefined);
  const [tool] = factory.create(f.ctx);
  assert.equal(await tool.execute(f.ctx.toolCallId, params()), "synthetic-read");
  assert.equal(originalCalls, 1); assert.equal(reads, 1);
});
