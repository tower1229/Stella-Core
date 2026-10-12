import assert from "node:assert/strict";
import test from "node:test";
import { withHostHistoryCompaction, hostHistoryCompaction, assertHostHistoryCompaction, publishHostHistoryCompaction } from "../src/openclaw/host-history-compaction.js";
import { hasCompletionRunPermit, hasCompletionPersistencePermit, isCompletionResourceActive, withCompletionResourceReservation, readActiveCompletionRequest, coordinateCompletion } from "../src/openclaw/completion.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";

const request = snapshotTurnRequest({ agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
  prompt: "Compact the existing conversation", senderId: "owner", senderIsOwner: true, chatType: "direct" }, "compact-run");

test("history compaction is request-local, expires across async continuations, and grants no completion permit", async () => {
  let resolve!: () => void;
  const release = { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
  let late!: Promise<void>;
  await assert.rejects(assertHostHistoryCompaction(request), /host_context_compaction_not_admitted/);
  await withHostHistoryCompaction({ request, signal: AbortSignal.timeout(5000), assertCurrent: async () => {} }, async () => {
    assert.equal(hostHistoryCompaction(request)?.publishing, false);
    assert.equal(hasCompletionRunPermit(request.runId), false);
    assert.equal(hasCompletionPersistencePermit(request.runId), false);
    assert.throws(() => readActiveCompletionRequest(request.agentId), /invalid_run_permit/);
    assert.throws(() => hostHistoryCompaction({ ...request }), /host_context_compaction_not_admitted/);
    await assert.rejects(withHostHistoryCompaction({ request, signal: AbortSignal.timeout(5000), assertCurrent: async () => {} }, async () => {}),
      /host_context_compaction_nested/);
    await publishHostHistoryCompaction(request, async () => assert.equal(hostHistoryCompaction(request)?.publishing, true));
    late = release.promise.then(() => assertHostHistoryCompaction(request));
  });
  assert.equal(hostHistoryCompaction(), undefined);
  release.resolve();
  await assert.rejects(late, /host_context_compaction_not_admitted/);
});

test("revocation or cancellation during an asynchronous check prevents history publication", async () => {
  const controller = new AbortController();
  let revoked = false;
  await assert.rejects(withHostHistoryCompaction({ request, signal: controller.signal, assertCurrent: async () => {
    if (revoked) throw new Error("grant_revoked");
  } }, async () => {
    revoked = true;
    await assert.rejects(publishHostHistoryCompaction(request, async () => assert.fail("revoked publication")), /grant_revoked/);
    revoked = false;
    controller.abort(new Error("compaction_cancelled"));
    await assert.rejects(assertHostHistoryCompaction(request), /compaction_cancelled/);
  }), /compaction_cancelled/);
});

test("maintenance reserves the completion repository exclusion without granting model or persistence authority", async () => {
  const root = "/synthetic/compaction-exclusion";
  await assert.rejects(withCompletionResourceReservation(root, async () => {
    assert.equal(isCompletionResourceActive(root), true);
    assert.equal(hasCompletionRunPermit(request.runId), false);
    await assert.rejects(withCompletionResourceReservation(root, async () => assert.fail("concurrent maintenance")), /operation_in_progress/);
    await assert.rejects(coordinateCompletion({ runId: "normal-run", operationId: "normal-turn", timeoutMs: 5000, resourceScope: root }, {
      async generateDraft() { return assert.fail("A competing ordinary turn must stop before generation"); },
      async persist() { return assert.fail("No competing business write"); },
      async publishFinal() { return assert.fail("No competing delivery"); },
    }), /operation_in_progress/);
    throw new Error("publication_failed");
  }), /publication_failed/);
  assert.equal(isCompletionResourceActive(root), false);
});
