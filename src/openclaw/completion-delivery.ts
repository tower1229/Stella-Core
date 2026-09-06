import { CompletionError, type CompletionDraft, type CompletionResult } from "./completion.js";

type SettledCounts = {
  delivered: number; deliveredNotVisible: number; cancelled: number;
  failedBeforeSend: number; failedAfterSend: number;
};
export type CompletionDispatcher = {
  supportsSettledReceipt?: true;
  sendFinalReply(payload: { text: string }): boolean;
  markComplete(): void;
  waitForIdle(): Promise<void | { counts: { final: SettledCounts }; anyVisibleDelivered: boolean }>;
};

export async function publishCompletionDraft(input: {
  operationId: string;
  draft: CompletionDraft;
  abortSignal: AbortSignal;
  dispatcher: CompletionDispatcher;
}): Promise<CompletionResult["delivery"]> {
  const { dispatcher, abortSignal } = input;
  if (!dispatcher.supportsSettledReceipt) {
    throw new CompletionError("capability_unavailable", "publish");
  }
  if (abortSignal.aborted) throw new CompletionError("cancelled", "publish");
  // reply_dispatch exposes an abort-aware facade, not the underlying dispatcher hooks.
  // After queue admission, cancellation cannot prove that delivery was retracted.
  const deliveryId = `${input.operationId}:${input.draft.draftId}`;
  if (!dispatcher.sendFinalReply({ text: input.draft.text })) return { deliveryId, status: "failed" };
  dispatcher.markComplete();
  let receipt: Awaited<ReturnType<CompletionDispatcher["waitForIdle"]>>;
  try { receipt = await dispatcher.waitForIdle(); }
  catch { return { deliveryId, status: "unknown" }; }
  if (!receipt) return { deliveryId, status: "unknown" };
  const counts = receipt.counts.final;
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { deliveryId, status: "unknown" };
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const status = total !== 1 || counts.failedAfterSend > 0 ? "unknown"
    : counts.delivered === 1 && receipt.anyVisibleDelivered ? "confirmed"
    : counts.cancelled === 1 || counts.failedBeforeSend === 1 ? "failed" : "unknown";
  return { deliveryId, status };
}
