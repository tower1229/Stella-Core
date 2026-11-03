import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSingleSourceTestBoundary, singleSourceCodeModeProgram, summarizeSingleSourceOutcome } from "./single-source-test-boundary.mjs";
import { createSingleSourceNativeEntry } from "../fixtures/single-source-native-entry.mjs";
import { identity, createReplayedControl } from "../fixtures/single-source-code-mode-replay.mjs";

const request = "Synthetic single-fragment code-mode check.";
const seed = { agentId: "main", sessionKey: "synthetic:code-mode", sessionId: "synthetic-session",
  requestSha256: createHash("sha256").update(request).digest("hex"),
  ref: { id: "synthetic-fragment", version: `sha256:${"c".repeat(64)}` } };
const read = () => ({ action: "read", ref: { ...seed.ref } });
function setup({ onChange, execute, clock = () => 0 } = {}) {
  const receipts = [], abort = new AbortController();
  const gate = createSingleSourceTestBoundary(seed, { now: clock, onChange: s => { receipts.push(s); return onChange?.(s); } });
  const ctx = { agentId: "main", sessionKey: seed.sessionKey, sessionId: seed.sessionId, runId: "synthetic-run",
    abortSignal: abort.signal, assertInvocationCurrent() { abort.signal.throwIfAborted(); } };
  let sourceCalls = 0, policyCalls = 0;
  const wrapped = gate.wrapTool({ name: "stella_source_read", async execute(...args) {
    sourceCalls++; if (execute) return execute(gate, ...args);
    await gate.complete({ maxTokens: 8192 }, async () => { policyCalls++; return "synthetic-verdict"; });
    return "synthetic-body";
  } }, ctx);
  gate.observeDispatch({ runId: ctx.runId, sessionKey: ctx.sessionKey,
    ctx: { AgentId: "main", SessionKey: ctx.sessionKey, ChatType: "direct", rawText: request } },
  { dispatchKind: "agent", abortSignal: abort.signal });
  const invokeInner = async (params, toolCallId, signal) => {
    const e = { toolName: "stella_source_read", toolCallId, runId: ctx.runId, params };
    const answer = gate.beforeTool(e, { ...ctx, toolName: e.toolName, toolCallId });
    if (answer?.block) throw new Error(answer.blockReason);
    return wrapped.execute(toolCallId, answer.params, signal);
  };
  const replay = createReplayedControl({ ctx, invokeInner });
  const raw = { title: "Read the single synthetic fragment", code: singleSourceCodeModeProgram(seed.ref) };
  const outer = async (params = raw, tool = replay.tool, metadataOverride) => {
    const normalized = identity.normalizeCodeModeExecBeforeHookParams({ tool, params });
    const metadata = metadataOverride ?? identity.getCodeModeExecBeforeHookMetadata({ tool, params: normalized });
    const e = { toolName: tool.name, runId: ctx.runId, toolCallId: "synthetic-outer", params: normalized, ...metadata };
    const result = gate.beforeTool(e, { ...ctx, toolName: tool.name, toolCallId: e.toolCallId, ...metadata });
    if (result?.block) throw new Error(result.blockReason);
    const reconciled = identity.reconcileCodeModeExecBeforeHookParams({ owner: { tool },
      originalParams: normalized, hookParams: normalized, adjustedParams: result?.params ?? normalized });
    return tool.execute(e.toolCallId, reconciled, abort.signal);
  };
  return { gate, ctx, abort, receipts, outer, raw, invokeInner, replay,
    counts: () => ({ sourceCalls, policyCalls, programs: replay.programsExecuted() }) };
}

test("fixed 10.9 control identity, aliases, code reader and nested bridge reach one exact source", async () => {
  const f = setup(); const result = await f.outer();
  assert.equal(result.value, "synthetic-body");
  assert.deepEqual(f.counts(), { sourceCalls: 1, policyCalls: 1, programs: 1 });
  assert.equal(f.gate.summary().pendingExecutions, 0);
  assert.equal(f.gate.summary().controlCalls, 1);
  assert.equal(f.receipts.at(-1).completedExecutions, 1);
});

for (const [label, transform] of [
  ["shell exec", f => ({ tool: { name: "exec", execute() { throw Error("must_not_execute"); } }, params: f.raw })],
  ["params cannot manufacture kind", f => ({ params: { ...f.raw, toolKind: "code_mode_exec" } })],
  ["wrong runtime kind", f => ({ params: f.raw, metadata: { toolKind: "code_mode_exec", toolInputKind: "shell" } })],
  ["other tool", f => ({ params: { ...f.raw, code: 'return await web_fetch({url:"https://invalid.example"});' } })],
  ["session store", f => ({ params: { ...f.raw, code: 'return await load("private");' } })],
  ["network", f => ({ params: { ...f.raw, code: 'return await fetch("https://invalid.example");' } })],
  ["second read in program", f => ({ params: { ...f.raw, code: `${f.raw.code}\n${f.raw.code}` } })],
  ["another source", f => ({ params: { ...f.raw, code: singleSourceCodeModeProgram({ ...seed.ref, id: "other" }) } })],
  ["different code/command", f => ({ params: { ...f.raw, command: 'return null;' } })],
  ["extra whitespace also explicit failure", f => ({ params: { ...f.raw, code: `${f.raw.code}\n` } })],
  ["restart replay", f => ({ params: { ...f.raw, restartSafe: true } })],
]) test(`${label}: rejected before guest/source/policy execution`, async () => {
  const f = setup(), change = transform(f);
  await assert.rejects(f.outer(change.params, change.tool, change.metadata));
  assert.deepEqual(f.counts(), { sourceCalls: 0, policyCalls: 0, programs: 0 });
  assert.equal(f.receipts.at(-1).denials, 1);
});

test("one outer control cannot be replayed; inner extra reads and changed refs rejected", async () => {
  const f = setup(); await f.outer(); await assert.rejects(f.outer(), /control_limit/);
  await assert.rejects(f.invokeInner(read(), "extra", f.abort.signal), /read_limit/);
  const g = setup(); await assert.rejects(g.invokeInner({ ...read(), ref: { ...seed.ref, id: "other" } }, "bad", g.abort.signal), /fragment/);
  assert.equal(g.counts().sourceCalls, 0); assert.equal(f.counts().sourceCalls, 1);
});

test("non-target inner tool rejected even if an outer control has been admitted", async () => {
  const f = setup(); await f.outer();
  const e = { toolName: "web_fetch", toolCallId: "network", runId: f.ctx.runId, params: {} };
  assert.equal(f.gate.beforeTool(e, { ...f.ctx, toolName: e.toolName, toolCallId: e.toolCallId }).block, true);
});

test("native wrapper retains original source permission failure and consumes attempt", async () => {
  const f = setup({ execute: async () => { throw new Error("original_grant_denied"); } });
  await assert.rejects(f.outer(), /original_grant_denied/); await assert.rejects(f.outer(), /control_limit/);
  assert.equal(f.gate.summary().failedExecutions, 1); assert.equal(f.counts().policyCalls, 0);
});

test("cancellation and deadline block the outer control before guest execution", async () => {
  let time = 0; const f = setup({ clock: () => time }); time = 90000;
  await assert.rejects(f.outer(), /inactive/); assert.equal(f.counts().programs, 0);
  const g = setup(); g.abort.abort(); await assert.rejects(g.outer(), /inactive/);
  assert.equal(g.receipts.at(-1).closed, true);
});

test("pending work is recorded; cancel plus final settle cannot claim complete collection", async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const f = setup({ execute: async () => { await barrier; return "synthetic"; } });
  const running = f.outer();
  // A deterministic transition barrier, not timing-based completion guessing.
  for (let i = 0; i < 100 && f.gate.summary().pendingExecutions === 0; i++) await Promise.resolve();
  assert.equal(f.receipts.at(-1).pendingExecutions, 1); f.abort.abort(); release();
  await assert.rejects(running, /inactive|abort/i);
  assert.equal(f.receipts.at(-1).pendingExecutions, 0);
  const outcome = summarizeSingleSourceOutcome(f.receipts.at(-1), { runId: f.ctx.runId, terminal: true, hasActiveRun: false, pendingInputs: 0 });
  assert.equal(outcome.terminalObserved, true); assert.equal(outcome.collectionComplete, false);
  assert.equal(outcome.successfulSourceExecutionObserved, false);
});

test("receipt sink failures are fail-closed, including settlement; no unhandled async rejection", async () => {
  for (const event of ["dispatch", "control_admitted", "read_admitted", "execute_started", "policy_started", "execute_settled"]) {
    const f = setup({ onChange: s => { if (s.lastEvent === event) throw new Error("synthetic_disk_error"); } });
    await assert.rejects(f.outer(), /receipt/); assert.equal(f.gate.summary().captureIncomplete, true);
  }
  const g = setup({ onChange: () => Promise.reject(new Error("synthetic_async_sink")) });
  await assert.rejects(g.outer(), /receipt/); await new Promise(resolve => setImmediate(resolve));
});

test("entry records rejection inside the blocking hook, without later observer or agent_end", () => {
  const handlers = new Map(), receipts = [];
  const ordinary = { createSourcePolicyCompletion: () => async () => {}, createOrdinaryPlugin: () => ({ register() {} }) };
  createSingleSourceNativeEntry(ordinary, seed, s => receipts.push(s)).register({ on(n, f) { handlers.set(n, f); } });
  handlers.get("before_tool_call")({ toolName: "exec" }, { sessionKey: seed.sessionKey, toolName: "exec" });
  assert.equal(receipts.at(-1).denials, 1); assert.equal(receipts.at(-1).lastEvent, "denied");
  assert.equal(receipts.at(-1).collectionComplete, false);
});

test("terminal summary rejects missing/mismatched/active Host facts and never declares full capture", async () => {
  const f = setup(); await f.outer(); f.gate.end({ runId: f.ctx.runId }, f.ctx);
  for (const host of [{}, { runId: "other", terminal: true, hasActiveRun: false, pendingInputs: 0 },
    { runId: f.ctx.runId, terminal: true, hasActiveRun: true, pendingInputs: 0 },
    { runId: f.ctx.runId, terminal: true, hasActiveRun: false, pendingInputs: 1 }]) {
    assert.equal(summarizeSingleSourceOutcome(f.receipts.at(-1), host).terminalObserved, false);
  }
  assert.equal(summarizeSingleSourceOutcome(f.receipts[0], {}).collectionComplete, false);
});
