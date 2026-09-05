import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type ResponseKind = "answer" | "clarification" | "collaboration" | "action_advice" | "outcome_ack";
export type PersistenceStatus = "not_required" | "local_committed" | "remote_pending" | "synchronized";
export type CompletionDraft = { draftId: string; text: string; evidenceRef: string };
export type CompletionReceipt = {
  schemaVersion: "stella.completion-receipt/v1";
  operationId: string;
  draftId: string;
  draftHash: string;
  responseKind: ResponseKind;
  evidenceRef: string;
  writeOperationIds: string[];
  observedRevision: string;
  generationId: string;
  persistenceStatus: PersistenceStatus;
  checkedAt: string;
};
export type CompletionResult = {
  receipt: CompletionReceipt;
  delivery: { deliveryId: string; status: "confirmed" | "failed" | "unknown" };
};

export class CompletionError extends Error {
  constructor(readonly category: string, readonly stage: string, options?: ErrorOptions) {
    super(`Stella completion failed: ${category} (${stage})`, options);
  }
}

type RunPermit = { operationId: string; runId: string; active: boolean };
const permits = new AsyncLocalStorage<RunPermit>();

export function hasCompletionRunPermit(runId: string | undefined): boolean {
  const permit = permits.getStore();
  return Boolean(permit?.active && runId && permit.runId === runId);
}

export function isCompletionDraftContext(): boolean {
  return permits.getStore() !== undefined;
}

export type CompletionPorts = {
  generateDraft(input: { operationId: string; runId: string; responseKind: ResponseKind; abortSignal: AbortSignal }): Promise<CompletionDraft>;
  persist(input: { operationId: string; draft: CompletionDraft; responseKind: ResponseKind; abortSignal: AbortSignal }): Promise<CompletionReceipt>;
  publishFinal(input: { operationId: string; draft: CompletionDraft; receipt: CompletionReceipt; abortSignal: AbortSignal }): Promise<CompletionResult["delivery"]>;
};

export function completionDraftHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function validateReceipt(receipt: CompletionReceipt, input: {
  operationId: string; responseKind: ResponseKind; critical: boolean;
}, draft: CompletionDraft): void {
  if (receipt.schemaVersion !== "stella.completion-receipt/v1" ||
      receipt.operationId !== input.operationId || receipt.draftId !== draft.draftId ||
      receipt.draftHash !== completionDraftHash(draft.text) ||
      receipt.evidenceRef !== draft.evidenceRef || receipt.responseKind !== input.responseKind ||
      !/^[0-9a-f]{40}$/.test(receipt.observedRevision) || !receipt.generationId ||
      !Number.isFinite(Date.parse(receipt.checkedAt)) ||
      !["not_required", "local_committed", "remote_pending", "synchronized"].includes(receipt.persistenceStatus) ||
      !Array.isArray(receipt.writeOperationIds) || receipt.writeOperationIds.some((id) => !id) ||
      (input.critical && (receipt.persistenceStatus !== "synchronized" || receipt.writeOperationIds.length === 0))) {
    throw new CompletionError("invalid_completion_receipt", "persist");
  }
}

/** Ports retain durable operation identity; this coordinator never retries a write or send. */
export async function coordinateCompletion(input: {
  operationId: string;
  runId: string;
  responseKind: ResponseKind;
  critical: boolean;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}, ports: CompletionPorts): Promise<CompletionResult> {
  if (!input.operationId || !input.runId || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new CompletionError("invalid_input", "admission");
  }
  const controller = new AbortController();
  const permit: RunPermit = { operationId: input.operationId, runId: input.runId, active: true };
  let stage = "generate";
  let rejectAborted: (error: CompletionError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  const cancel = (category: string) => {
    if (controller.signal.aborted) return;
    permit.active = false;
    controller.abort();
    rejectAborted(new CompletionError(stage === "publish" ? "delivery_unknown" : category, stage));
  };
  const onAbort = () => cancel("cancelled");
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => cancel("resource_exhausted"), input.timeoutMs);
  const checkActive = () => {
    if (controller.signal.aborted || !permit.active) throw new CompletionError("cancelled", stage);
  };
  const work = async (): Promise<CompletionResult> => {
    checkActive();
    const draft = await permits.run(permit, () => ports.generateDraft({ ...input, abortSignal: controller.signal }));
    checkActive();
    permit.active = false;
    if (!draft.draftId || !draft.text.trim() || !draft.evidenceRef) throw new CompletionError("invalid_draft", stage);
    stage = "persist";
    const receipt = await ports.persist({ ...input, draft, abortSignal: controller.signal });
    if (controller.signal.aborted) throw new CompletionError("cancelled", stage);
    validateReceipt(receipt, input, draft);
    stage = "publish";
    const delivery = await ports.publishFinal({ ...input, draft, receipt, abortSignal: controller.signal });
    if (!delivery.deliveryId || !["confirmed", "failed", "unknown"].includes(delivery.status)) {
      throw new CompletionError("invalid_delivery_receipt", stage);
    }
    return { receipt, delivery };
  };
  try {
    if (input.abortSignal?.aborted) onAbort();
    return await Promise.race([aborted, work()]);
  } catch (cause) {
    if (cause instanceof CompletionError) throw cause;
    throw new CompletionError(stage === "publish" ? "delivery_unknown" : "completion_failed", stage, { cause });
  } finally {
    clearTimeout(timer);
    permit.active = false;
    controller.abort();
    input.abortSignal?.removeEventListener("abort", onAbort);
  }
}
