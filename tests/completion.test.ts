import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerCompletionTranscriptGuard } from "../src/openclaw/completion-transcript.js";
import {
  CompletionError, completionDraftHash, coordinateCompletion, hasCompletionRunPermit,
  isCompletionDraftContext,
  type CompletionPorts, type CompletionReceipt,
} from "../src/openclaw/completion.js";

const input = { operationId: "op-test", runId: "run-test", responseKind: "action_advice" as const, critical: true, timeoutMs: 1000 };
const draft = { draftId: "draft-test", text: "Synthetic advice", evidenceRef: "bundle-test" };
const receipt: CompletionReceipt = {
  schemaVersion: "stella.completion-receipt/v1", operationId: input.operationId,
  draftId: draft.draftId, draftHash: completionDraftHash(draft.text), responseKind: input.responseKind,
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
test("critical completion rejects mismatched, pending and empty-write receipts", async () => {
  for (const change of [{ draftHash: "bad" }, { operationId: "other" },
    { persistenceStatus: "remote_pending" as const }, { writeOperationIds: [] }]) {
    const events: string[] = [];
    await assert.rejects(coordinateCompletion(input, { ...ports(events), async persist() { return { ...receipt, ...change }; } }),
      (error: unknown) => error instanceof CompletionError && error.category === "invalid_completion_receipt");
    assert.deepEqual(events, ["generate"]);
  }
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
