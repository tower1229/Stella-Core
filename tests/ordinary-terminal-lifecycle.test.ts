import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import plugin, { CANDIDATE_TOOL } from "../src/ordinary-plugin.js";

const identity = { agentId: "main", sessionKey: "agent:main:synthetic", sessionId: "synthetic-session" };
const proposal = { topic: "Synthetic", interpretation: "Unconfirmed", proposedPremises: [], openQuestions: [], evidenceReferences: [] };
function setup() {
  let factory: any, subscription: any;
  const hooks = new Map<string, Function>();
  plugin.register!({ pluginConfig: { agentId: "main", publisher: false },
    agent: { events: { registerAgentEventSubscription(value: unknown) { subscription = value; } } },
    registerTool(value: unknown) { factory = value; }, registerCommand() {},
    on(name: string, handler: Function) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi);
  const tool = factory.create({ ...identity, assertInvocationCurrent() {} }).find((t: any) => t.name === CANDIDATE_TOOL);
  function turn(runId: string) {
    const abort = new AbortController();
    const receipt = { ...identity, storePath: "/synthetic/not-read.db", entryId: runId, logicalTurnId: runId,
      generation: "g", idempotencyKey: runId, role: "user", rawSeq: 1, effectiveParentId: null, activeMessagePosition: 0 };
    hooks.get("reply_dispatch")!({ runId, sessionKey: identity.sessionKey, ctx: { AgentId: "main", SessionKey: identity.sessionKey } },
      { dispatchKind: "agent", abortSignal: abort.signal, userTurnTranscriptRecorder: {
        hasPersisted: () => true, isBlocked: () => false, getAdmissionReceipt: () => receipt,
      } });
    const hook = (toolCallId: string) => hooks.get("before_tool_call")!({ toolName: CANDIDATE_TOOL, toolCallId, runId },
      { ...identity, toolName: CANDIDATE_TOOL, toolCallId, runId, abortSignal: abort.signal });
    return { abort, hook, read: (id: string) => tool.execute(id, proposal) };
  }
  const emit = (runId: string, data: object, extra = {}) => subscription.handle({ ...identity, runId,
    seq: 1, ts: 1, stream: "lifecycle", data, ...extra }, {});
  return { hooks, subscription, turn, emit };
}

test("normal terminal lifecycle replaces conversation hook and releases metadata plus unconsumed calls", async () => {
  const f = setup();
  assert.ok(f.subscription, "public lifecycle subscription missing");
  assert.deepEqual(f.subscription.streams, ["lifecycle"]); assert.equal(f.hooks.has("agent_end"), false);
  for (let i = 0; i < 40; i++) {
    const run = `run-${i}`, t = f.turn(run);
    t.hook(`${run}-read`);
    assert.equal((await t.read(`${run}-read`)).details.currentInputObservation.status, "observed");
    // Four calls never execute. Without terminal cleanup the 128-call cap leaks.
    for (let n = 0; n < 4; n++) assert.equal(t.hook(`${run}-pending-${n}`), undefined);
    f.emit(run, { phase: "end" }); assert.equal(t.abort.signal.aborted, false);
    assert.equal((await t.read(`${run}-pending-0`)).details.requestBinding.status, "unavailable");
    t.hook(`${run}-late`);
    assert.equal((await t.read(`${run}-late`)).details.currentInputObservation.code, "reply_dispatch_not_observed");
  }
});

test("tool rounds, recoverable errors, absent or mismatched identities do not retire an active request", async () => {
  const f = setup(), t = f.turn("run-active"); assert.ok(f.subscription);
  const cases = [
    [{ phase: "end" }, { stream: "tool" }], [{ phase: "start" }, {}], [{ phase: "error" }, {}],
    [{ phase: "end" }, { agentId: "other" }], [{ phase: "end" }, { agentId: undefined }],
    [{ phase: "end" }, { sessionKey: "other" }], [{ phase: "end" }, { sessionKey: undefined }],
    [{ phase: "end" }, { runId: "other" }], [{ phase: "end" }, { runId: undefined }],
  ] as const;
  for (const [i, [data, extra]] of cases.entries()) {
    f.emit("run-active", data, extra); t.hook(`continued-${i}`);
    assert.equal((await t.read(`continued-${i}`)).details.currentInputObservation.status, "observed");
  }
});

test("settled/exhausted errors and cancellation retire only the matching request", async () => {
  for (const data of [{ phase: "error", executionSettled: true }, { phase: "error", fallbackExhaustedFailure: true }]) {
    const f = setup(), a = f.turn("a"), b = f.turn("b"); assert.ok(f.subscription);
    f.emit("a", data); f.emit("a", data);
    a.hook("a-late"); assert.equal((await a.read("a-late")).details.currentInputObservation.status, "unavailable");
    b.hook("b-live"); assert.equal((await b.read("b-live")).details.currentInputObservation.status, "observed");
    b.abort.abort(); b.hook("b-late");
    assert.equal((await b.read("b-late")).details.currentInputObservation.status, "unavailable");
  }
});
