import assert from "node:assert/strict";
import test from "node:test";
import { publishCompletionDraft, type CompletionDispatcher } from "../src/openclaw/completion-delivery.js";
import { CompletionError } from "../src/openclaw/completion.js";

const input = { operationId: "synthetic-operation", draft: {
  draftId: "synthetic-draft", text: "Committed synthetic reply", evidenceRef: "synthetic-evidence",
  responseKind: "answer" as const, requiresCriticalPersistence: false,
} };
const delivered = { counts: { final: {
  delivered: 1, deliveredNotVisible: 0, cancelled: 0, failedBeforeSend: 0, failedAfterSend: 0,
} }, anyVisibleDelivered: true };

test("uses the public reply_dispatch facade without requiring internal delivery hooks", async () => {
  let sends = 0;
  const dispatcher: CompletionDispatcher = {
    supportsSettledReceipt: true,
    sendFinalReply() { sends++; return true; }, markComplete() {},
    async waitForIdle() { return delivered; },
  };
  const result = await publishCompletionDraft({ ...input, dispatcher, abortSignal: new AbortController().signal });
  assert.equal(result.status, "confirmed");
  assert.equal(sends, 1);
});

test("cancellation before admission sends nothing and a missing receipt stays unknown", async () => {
  let sends = 0;
  const controller = new AbortController(); controller.abort();
  const dispatcher: CompletionDispatcher = {
    supportsSettledReceipt: true,
    sendFinalReply() { sends++; return true; }, markComplete() {},
    async waitForIdle() {},
  };
  await assert.rejects(publishCompletionDraft({ ...input, dispatcher, abortSignal: controller.signal }),
    (error: unknown) => error instanceof CompletionError && error.category === "cancelled");
  assert.equal(sends, 0);
  const result = await publishCompletionDraft({ ...input, dispatcher, abortSignal: new AbortController().signal });
  assert.equal(result.status, "unknown");
  assert.equal(sends, 1);
});
