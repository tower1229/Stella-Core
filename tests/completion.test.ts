import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerCompletionTranscriptGuard } from "../src/openclaw/completion-transcript.js";
import {
  CompletionError, completionDraftHash, coordinateCompletion, hasCompletionRunPermit,
  isCompletionDraftContext, captureCompletionOutput, readCompletionOutput, recordCompletionPreparation, readCompletionPreparation,
  type CompletionPorts, type CompletionReceipt,
} from "../src/openclaw/completion.js";

const input = { operationId: "op-test", runId: "run-test", timeoutMs: 1000 };
const draft = { draftId: "draft-test", text: "Synthetic advice", evidenceRef: "bundle-test",
  responseKind: "action_advice" as const, requiresCriticalPersistence: true };
const receipt: CompletionReceipt = {
  schemaVersion: "stella.completion-receipt/v1", operationId: input.operationId,
  draftId: draft.draftId, draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind,
  evidenceRef: draft.evidenceRef, writeOperationIds: ["write-test"], observedRevision: "a".repeat(40),
  generationId: "generation-test", persistenceStatus: "synchronized", checkedAt: "2026-09-05T00:00:00Z",
};
function ports(events: string[]): CompletionPorts {
  return {
    async generateDraft() {
      assert.equal(hasCompletionRunPermit(input.runId), true);
      assert.equal(isCompletionDraftContext(), true);
      assert.equal(hasCompletionRunPermit("another-run"), false);
      events.push("generate"); return draft;
    },
    async persist() { events.push("persist"); return receipt; },
    async publishFinal() { events.push("publish"); return { deliveryId: "delivery-test", status: "confirmed" }; },
  };
}
test("completion only publishes a bound synchronized receipt and fences the run permit", async () => {
  const events: string[] = [];
  const result = await coordinateCompletion(input, ports(events));
  assert.deepEqual(events, ["generate", "persist", "publish"]);
  assert.equal(result.delivery.status, "confirmed");
  assert.equal(hasCompletionRunPermit(input.runId), false);
  assert.equal(isCompletionDraftContext(), false);
});
test("persistence failure cannot release a business reply", async () => {
  const events: string[] = [];
  await assert.rejects(coordinateCompletion(input, { ...ports(events), async persist() { throw new Error("push failed"); } }),
    (error: unknown) => error instanceof CompletionError && error.stage === "persist");
  assert.deepEqual(events, ["generate"]);
});

test("settled failures revoke draft permission without cancelling the Host failure dispatcher", async () => {
  let generationSignal: AbortSignal | undefined;
  await assert.rejects(coordinateCompletion(input, {
    ...ports([]),
    async generateDraft({ abortSignal }) { generationSignal = abortSignal; return draft; },
    async persist() { throw new Error("synthetic persistence failure"); },
  }));
  assert.equal(generationSignal?.aborted, false);
  assert.equal(hasCompletionRunPermit(input.runId), false);
});

test("private output is run-scoped across independent hook registrations and expires before persistence", async () => {
  const output = { role: "assistant", content: [{ type: "text", text: "synthetic" }] };
  const independentHook = () => captureCompletionOutput(input.runId, output);
  await coordinateCompletion(input, {
    ...ports([]),
    async generateDraft() {
      captureCompletionOutput("wrong-run", { wrong: true });
      assert.equal(readCompletionOutput(input.runId), undefined);
      independentHook();
      assert.equal(readCompletionOutput(input.runId), output);
      return draft;
    },
    async persist() {
      assert.throws(() => readCompletionOutput(input.runId), CompletionError);
      return receipt;
    },
  });
  assert.throws(() => readCompletionOutput(input.runId), CompletionError);
});

test("prepared context is isolated per run and unavailable outside active generation", async () => {
  const preparation = { runId: input.runId, responseKind: "clarification", evidenceRefs: ["synthetic"] };
  await coordinateCompletion(input, {
    ...ports([]),
    async generateDraft() {
      assert.throws(() => recordCompletionPreparation("other-run", preparation), CompletionError);
      recordCompletionPreparation(input.runId, preparation);
      assert.deepEqual(readCompletionPreparation(input.runId), preparation);
      return draft;
    },
    async persist() { assert.throws(() => readCompletionPreparation(input.runId), CompletionError); return receipt; },
  });
  assert.throws(() => recordCompletionPreparation(input.runId, preparation), CompletionError);
});
test("critical completion rejects mismatched, pending and empty-write receipts", async () => {
  for (const change of [{ draftHash: "bad" }, { operationId: "other" }, { responseKind: "answer" as const },
    { persistenceStatus: "remote_pending" as const }, { writeOperationIds: [] }]) {
    const events: string[] = [];
    await assert.rejects(coordinateCompletion(input, { ...ports(events), async persist() { return { ...receipt, ...change }; } }),
      (error: unknown) => error instanceof CompletionError && error.category === "invalid_completion_receipt");
    assert.deepEqual(events, ["generate"]);
  }
});

test("completion binds response semantics chosen during generation without forcing critical writes", async () => {
  const result = await coordinateCompletion(input, {
    ...ports([]),
    async generateDraft() { return { ...draft, responseKind: "clarification", requiresCriticalPersistence: false }; },
    async persist({ responseKind }) {
      assert.equal(responseKind, "clarification");
      return { ...receipt, responseKind, writeOperationIds: [], persistenceStatus: "not_required" };
    },
  });
  assert.equal(result.receipt.responseKind, "clarification");
});
test("cancelled generation cannot persist or publish even when the provider completes late", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const pending = coordinateCompletion({ ...input, abortSignal: controller.signal }, {
    ...ports(events), async generateDraft() {
      await blocked;
      assert.equal(hasCompletionRunPermit(input.runId), false);
      assert.equal(isCompletionDraftContext(), true);
      return draft;
    },
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof CompletionError && error.category === "cancelled");
  release(); await delay(0);
  assert.deepEqual(events, []);
});
test("deadline fences late persistence completion without replaying the write", async () => {
  const events: string[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await assert.rejects(coordinateCompletion({ ...input, timeoutMs: 10 }, {
    ...ports(events), async persist() { events.push("persist"); await blocked; return receipt; },
  }), (error: unknown) => error instanceof CompletionError && error.category === "resource_exhausted");
  release(); await delay(0);
  assert.deepEqual(events, ["generate", "persist"]);
});
test("delivery unknown is preserved and never automatically resent", async () => {
  let sends = 0;
  const result = await coordinateCompletion(input, {
    ...ports([]), async publishFinal() { sends++; return { deliveryId: "delivery-test", status: "unknown" }; },
  });
  assert.equal(result.delivery.status, "unknown");
  assert.equal(sends, 1);
});

test("resource admission stays locked after cancellation until the underlying persistence drains", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const scoped = { ...input, resourceScope: "synthetic-shared-canghai" };
  const pending = coordinateCompletion({ ...scoped, abortSignal: controller.signal }, {
    ...ports([]),
    async persist() { started(); await blocked; return receipt; },
    async publishFinal() { assert.fail("Cancelled persistence must not publish"); },
  });
  await entered;
  const assertBusy = () => assert.rejects(coordinateCompletion({ ...scoped, runId: "other-run" }, {
    ...ports([]), async generateDraft() { assert.fail("Busy resource must not generate"); },
  }), (error: unknown) => error instanceof CompletionError && error.category === "operation_in_progress");
  await assertBusy();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof CompletionError && error.category === "cancelled");
  await assertBusy();
  const other = await coordinateCompletion({ ...input, resourceScope: "independent-canghai" }, ports([]));
  assert.equal(other.delivery.status, "confirmed");
  release();
  await delay(0);
  assert.equal((await coordinateCompletion(scoped, ports([]))).delivery.status, "confirmed");
});

test("resource admission is released after generation failure and pre-cancellation", async () => {
  const scoped = { ...input, resourceScope: "synthetic-failed-canghai" };
  await assert.rejects(coordinateCompletion(scoped, {
    ...ports([]), async generateDraft() { throw new Error("synthetic"); },
  }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(coordinateCompletion({ ...scoped, abortSignal: controller.signal }, ports([])));
  assert.equal((await coordinateCompletion(scoped, ports([]))).delivery.status, "confirmed");
});
test("pre-cancelled operations never generate", async () => {
  const controller = new AbortController(); controller.abort();
  const events: string[] = [];
  await assert.rejects(coordinateCompletion({ ...input, abortSignal: controller.signal }, ports(events)));
  assert.deepEqual(events, []);
});

test("transcript guard isolates target drafts but preserves user, other-agent and final messages", async () => {
  type Handler = (event: { agentId?: string; message: { role: string } }, context: { agentId?: string }) => unknown;
  let guard: Handler | undefined;
  registerCompletionTranscriptGuard({ on(name: string, handler: Handler) {
    assert.equal(name, "before_message_write"); guard = handler;
  } } as never, "owner");
  assert.ok(guard);
  const invoke = guard;
  await coordinateCompletion(input, {
    ...ports([]),
    async generateDraft() {
      assert.deepEqual(invoke({ agentId: "owner", message: { role: "assistant" } }, {}), { block: true });
      assert.deepEqual(invoke({ message: { role: "assistant" } }, { agentId: "owner" }), { block: true });
      assert.equal(invoke({ agentId: "owner", message: { role: "user" } }, {}), undefined);
      assert.equal(invoke({ agentId: "other", message: { role: "assistant" } }, {}), undefined);
      return draft;
    },
    async publishFinal() {
      assert.equal(invoke({ agentId: "owner", message: { role: "assistant" } }, {}), undefined);
      return { deliveryId: "final", status: "confirmed" };
    },
  });
});
