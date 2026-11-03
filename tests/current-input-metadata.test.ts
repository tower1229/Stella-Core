import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createCurrentInputMetadata } from "../src/openclaw/current-input-metadata.js";
import plugin, { CANDIDATE_TOOL } from "../src/ordinary-plugin.js";

const identity = { agentId: "main", sessionKey: "agent:main:synthetic", sessionId: "synthetic-session" };
const proposal = { topic: "Fictional walk", interpretation: "Two endings remain possible",
  proposedPremises: [], openQuestions: ["Which ending?"], evidenceReferences: [] };
function fixture(runId = "synthetic-run") {
  const abort = new AbortController();
  let persisted = false, blocked = false, reads = 0;
  const receipt: Record<string, unknown> = { ...identity, storePath: "/synthetic/transcript.db", entryId: "entry-1",
    logicalTurnId: "turn-1", generation: "generation-1", idempotencyKey: "native-key-1", role: "user",
    rawSeq: 1, effectiveParentId: null, activeMessagePosition: 0 };
  const methods = { hasPersisted() { reads++; return persisted; }, isBlocked() { reads++; return blocked; },
    getAdmissionReceipt() { reads++; return receipt; } };
  // Reading messages, config, provenance, credentials or a mutation method fails.
  const recorder = new Proxy(methods, { get(target, key, receiver) {
    assert.ok(Object.hasOwn(target, key), `forbidden recorder member ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
  const ctx = new Proxy({ AgentId: identity.agentId, SessionKey: identity.sessionKey }, { get(target, key, receiver) {
    assert.ok(Object.hasOwn(target, key), `forbidden inbound member ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
  const event = { runId, sessionKey: identity.sessionKey, ctx } as any;
  const context = { dispatchKind: "agent", userTurnTranscriptRecorder: recorder, abortSignal: abort.signal } as any;
  return { event, context, receipt, recorder, methods, abort, reads: () => reads,
    commit() { persisted = true; }, block() { blocked = true; }, uncommit() { persisted = false; } };
}
function hash(result: ReturnType<ReturnType<typeof createCurrentInputMetadata>["inspect"]>) {
  assert.equal(result.status, "observed");
  return result.receiptHash;
}

test("dispatch is passive; first call reads only committed native metadata and returns no transcript path or text", () => {
  const observer = createCurrentInputMetadata("main"), f = fixture();
  assert.equal(observer.observe(f.event, f.context), "dispatch_observed");
  assert.equal(f.reads(), 0);
  assert.equal(observer.inspect(f.event.runId, identity).code, "admission_uncommitted");
  f.commit();
  const result = observer.inspect(f.event.runId, identity);
  assert.equal(result.status, "observed"); assert.equal(result.code, "native_input_metadata_only");
  assert.match(result.receiptHash!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.authorQualification, false); assert.equal(result.sourceRepresentation, "unverified");
  assert.equal(result.modelConsumption, "unverified");
  assert.equal(JSON.stringify(result).includes("/synthetic"), false);
  assert.equal(JSON.stringify(result).includes("entry-1"), false);
  const previous = result.receiptHash;
  result.receiptHash = "changed consumer copy";
  assert.equal(hash(observer.inspect(f.event.runId, identity)), previous);
});

test("missing ingress, signal, session or agent fields never fall back to prompt, history or another run", () => {
  for (const update of [
    (f: any) => { f.event.runId = undefined; },
    (f: any) => { f.event.sessionKey = undefined; },
    (f: any) => { f.event.ctx = { AgentId: "other", SessionKey: identity.sessionKey }; },
    (f: any) => { f.event.ctx = { AgentId: "main", SessionKey: "different" }; },
    (f: any) => { f.context.abortSignal = undefined; },
    (f: any) => { f.context.userTurnTranscriptRecorder = undefined; },
    (f: any) => { f.context.dispatchKind = "acp"; },
  ]) {
    const observer = createCurrentInputMetadata("main"), f = fixture(); update(f);
    observer.observe(f.event, f.context); assert.equal(f.reads(), 0);
    assert.equal(observer.inspect("synthetic-run", identity).status, "unavailable");
  }
  const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit();
  observer.observe(f.event, f.context);
  assert.equal(observer.inspect(null, identity).code, "host_run_not_provided");
  assert.equal(observer.inspect("other-run", identity).code, "reply_dispatch_not_observed");
  assert.equal(f.reads(), 0);
});

test("committed receipt and factory must match exact agent, session and incarnation", () => {
  for (const patch of [{ agentId: "other" }, { sessionKey: "different" }, { sessionId: "different" }, { sessionId: undefined }]) {
    const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit(); observer.observe(f.event, f.context);
    assert.equal(observer.inspect(f.event.runId, { ...identity, ...patch }).code, "native_input_binding_mismatch");
    assert.equal(observer.inspect(f.event.runId, identity).status, "rejected");
  }
  for (const key of ["agentId", "sessionId", "sessionKey"]) {
    const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit(); f.receipt[key] = "other";
    observer.observe(f.event, f.context);
    assert.equal(observer.inspect(f.event.runId, identity).code, "native_input_binding_mismatch");
  }
});

test("receipt identity and numeric fields are required; receipt exceptions stay explicit", () => {
  for (const patch of [{ idempotencyKey: undefined }, { role: "assistant" }, { rawSeq: 0 }, { rawSeq: 1.5 },
    { activeMessagePosition: -1 }, { effectiveParentId: 7 }, { logicalTurnId: "" }]) {
    const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit(); Object.assign(f.receipt, patch);
    observer.observe(f.event, f.context);
    assert.equal(observer.inspect(f.event.runId, identity).code, "native_input_receipt_invalid");
  }
  const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit();
  f.methods.getAdmissionReceipt = () => { throw Error("synthetic failure"); };
  observer.observe(f.event, f.context);
  assert.equal(observer.inspect(f.event.runId, identity).code, "native_input_recorder_read_failed");
});

for (const scenario of [
  { key: "rawSeq", first: 0, later: 1, code: "native_input_receipt_invalid" },
  { key: "activeMessagePosition", first: -1, later: 0, code: "native_input_receipt_invalid" },
  { key: "effectiveParentId", first: 7, later: "parent-1", code: "native_input_receipt_invalid" },
  { key: "sessionId", first: "different-session", later: identity.sessionId, code: "native_input_binding_mismatch" },
]) {
  test(`receipt getter snapshot rejects invalid first ${scenario.key} without accepting a later value`, () => {
    const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit();
    let reads = 0;
    Object.defineProperty(f.receipt, scenario.key, { get() { return ++reads === 1 ? scenario.first : scenario.later; } });
    observer.observe(f.event, f.context);
    const result = observer.inspect(f.event.runId, identity);
    assert.equal(result.code, scenario.code);
    assert.equal(result.status, "rejected");
    assert.equal(reads, 1);
    assert.equal(observer.inspect(f.event.runId, identity).code, "native_input_ambiguous");
    assert.equal(reads, 1);
  });
}

test("receipt scalar snapshot is read once and the same validated values determine its hash", () => {
  const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit();
  const expected = createCurrentInputMetadata("main"), stable = fixture(); stable.commit();
  expected.observe(stable.event, stable.context);
  const expectedHash = hash(expected.inspect(stable.event.runId, identity));
  const reads = new Map<string, number>();
  for (const [key, value] of Object.entries(f.receipt)) {
    Object.defineProperty(f.receipt, key, { get() {
      const count = (reads.get(key) ?? 0) + 1; reads.set(key, count);
      return count === 1 ? value : { invalid: "later non-scalar value" };
    } });
  }
  observer.observe(f.event, f.context);
  assert.equal(hash(observer.inspect(f.event.runId, identity)), expectedHash);
  assert.equal(reads.size, Object.keys(f.receipt).length);
  for (const count of reads.values()) assert.equal(count, 1);
});

test("one run cannot switch recorders or native admissions; restoring old metadata cannot revive it", () => {
  const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit(); observer.observe(f.event, f.context);
  assert.equal(observer.observe(f.event, f.context), "dispatch_observed");
  assert.equal(observer.inspect(f.event.runId, identity).status, "observed");
  f.receipt.entryId = "entry-2";
  assert.equal(observer.inspect(f.event.runId, identity).code, "native_input_changed");
  f.receipt.entryId = "entry-1";
  assert.equal(observer.inspect(f.event.runId, identity).code, "native_input_ambiguous");
  const other = createCurrentInputMetadata("main"), a = fixture(), b = fixture();
  other.observe(a.event, a.context);
  assert.equal(other.observe(b.event, b.context), "dispatch_ambiguous");
  assert.equal(other.inspect(a.event.runId, identity).code, "native_input_ambiguous");
});

test("blocked/vanished admission never becomes observed; independent new requests read their own receipt", () => {
  const observer = createCurrentInputMetadata("main"), a = fixture("run-a"), b = fixture("run-b");
  a.commit(); b.commit(); b.receipt.entryId = "entry-b"; b.receipt.idempotencyKey = "native-key-b";
  observer.observe(a.event, a.context); observer.observe(b.event, b.context);
  const first = hash(observer.inspect(a.event.runId, identity));
  assert.notEqual(hash(observer.inspect(b.event.runId, identity)), first);
  assert.equal(hash(observer.inspect(a.event.runId, identity)), first);
  a.uncommit(); assert.equal(observer.inspect(a.event.runId, identity).code, "native_input_changed");
  const c = fixture("run-c"); c.commit(); c.block(); observer.observe(c.event, c.context);
  assert.equal(observer.inspect(c.event.runId, identity).code, "admission_uncommitted");
});

test("original read methods are captured; cancellation and exact agent-end release bounded references", () => {
  const observer = createCurrentInputMetadata("main"), f = fixture(); observer.observe(f.event, f.context);
  f.methods.hasPersisted = () => true; // Cannot replace the captured original method.
  assert.equal(observer.inspect(f.event.runId, identity).code, "admission_uncommitted");
  f.commit(); assert.equal(observer.inspect(f.event.runId, identity).status, "observed");
  observer.end({ runId: f.event.runId } as any, { ...identity, runId: "different" });
  assert.equal(observer.inspect(f.event.runId, identity).status, "observed");
  observer.end({ runId: f.event.runId } as any, { ...identity, runId: f.event.runId });
  assert.equal(observer.inspect(f.event.runId, identity).status, "unavailable");
  const a = fixture("aborted"); observer.observe(a.event, a.context); a.abort.abort();
  assert.equal(observer.inspect(a.event.runId, identity).status, "unavailable");
  assert.equal(observer.observe(a.event, a.context), "dispatch_identity_or_lifetime_unavailable");
  const live = Array.from({ length: 32 }, (_, i) => fixture(`bounded-${i}`));
  for (const entry of live) assert.equal(observer.observe(entry.event, entry.context), "dispatch_observed");
  const overflow = fixture("overflow"); assert.equal(observer.observe(overflow.event, overflow.context), "dispatch_capacity");
  live[0].abort.abort(); assert.equal(observer.observe(overflow.event, overflow.context), "dispatch_observed");
  for (const entry of [...live, overflow]) entry.abort.abort();
});

test("cancellation or agent-end during a recorder read cannot return an observation", () => {
  for (const finish of ["abort", "end"]) {
    const observer = createCurrentInputMetadata("main"), f = fixture(); f.commit();
    f.methods.getAdmissionReceipt = () => {
      if (finish === "abort") f.abort.abort();
      else observer.end({ runId: f.event.runId }, { ...identity, runId: f.event.runId });
      return f.receipt;
    };
    observer.observe(f.event, f.context);
    assert.equal(observer.inspect(f.event.runId, identity).code, "reply_dispatch_not_observed");
  }
});

test("ordinary plugin callbacks carry native metadata to only the exact candidate; candidate and publisher limits stay intact", async () => {
  let factory: any, terminal: any; const hooks = new Map<string, Function>();
  plugin.register!({ agent: { events: { registerAgentEventSubscription(value: any) { terminal = value.handle; } } }, pluginConfig: { agentId: "main", publisher: false },
    on(name: string, handler: Function) { hooks.set(name, handler); }, registerTool(value: unknown) { factory = value; },
    registerCommand() {} } as unknown as OpenClawPluginApi);
  const f = fixture(); const context = { ...identity, assertInvocationCurrent() {} };
  const tool = factory.create(context).find((t: any) => t.name === CANDIDATE_TOOL);
  assert.equal(hooks.get("reply_dispatch")!(f.event, f.context), undefined); assert.equal(f.reads(), 0);
  f.commit();
  const event = { toolName: CANDIDATE_TOOL, toolCallId: "call-1", runId: f.event.runId };
  assert.equal(hooks.get("before_tool_call")!(event, { ...identity, ...event }), undefined);
  const result = await tool.execute("call-1", proposal);
  assert.equal(result.details.currentInputObservation.status, "observed");
  assert.equal(result.details.requestBinding.runId, f.event.runId);
  assert.equal(result.details.code, "author_source_unavailable");
  for (const key of ["publisher", "authorConfirmation", "saved"]) assert.equal(result.details[key], false);
  assert.equal(result.details.evidenceStatus, "model_supplied_unverified");
  assert.deepEqual(result.details.proposal, proposal);
  const direct = await tool.execute("without-hook", proposal);
  assert.equal(direct.details.currentInputObservation.code, "host_run_not_provided");
  assert.equal(direct.details.status, "candidate");
  terminal({ ...identity, runId: f.event.runId, stream: "lifecycle", data: { phase: "end" } }, {});
  const late = { ...event, toolCallId: "late" }; hooks.get("before_tool_call")!(late, { ...identity, ...late });
  assert.equal((await tool.execute("late", proposal)).details.currentInputObservation.code, "reply_dispatch_not_observed");
});
