import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type ResponseKind = "answer" | "clarification" | "collaboration" | "action_advice" | "outcome_ack";
export type PersistenceStatus = "not_required" | "local_committed" | "remote_pending" | "synchronized";
export type CompletionDraft = {
  draftId: string; text: string; evidenceRef: string;
  responseKind: ResponseKind;
  requiresCriticalPersistence: boolean;
};
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

type RunPermit = { operationId: string; runId: string; active: boolean; abortSignal: AbortSignal; outputCount?: number; privateOutput?: unknown; preparation?: unknown };
const permits = new AsyncLocalStorage<RunPermit>();
const activeResources = new Set<string>();
// Sequential routing and evidence judgments share this budget. The Host allows
// a further 30 seconds for Core to return an explicit preparation failure.
export const PREPARATION_TIMEOUT_MS = 300_000;
export const PREPARATION_HOOK_TIMEOUT_MS = 330_000;
const preparationScopes = new AsyncLocalStorage<{ signal: AbortSignal; active: boolean }>();

async function untilAborted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([aborted, work()]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function runCompletionPreparation<T>(runId: string, prepare: () => Promise<T>, timeoutMs = PREPARATION_TIMEOUT_MS): Promise<T> {
  if (!hasCompletionRunPermit(runId)) throw new CompletionError("invalid_run_permit", "prepare");
  const parent = permits.getStore()!.abortSignal;
  const controller = new AbortController();
  const cancel = () => controller.abort(new CompletionError("cancelled", "prepare"));
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new CompletionError("preparation_timeout", "prepare")), timeoutMs);
  const scope = { signal: controller.signal, active: true };
  try { return await preparationScopes.run(scope, () => untilAborted(scope.signal, prepare)); }
  finally {
    scope.active = false;
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
  }
}

/** Outside preparation, persistence/recovery keep their own existing signals. */
export async function completeWithPreparationSignal<T>(complete: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const scope = preparationScopes.getStore();
  if (!scope) return complete(undefined);
  if (!scope.active) throw new CompletionError("cancelled", "prepare");
  const result = await untilAborted(scope.signal, () => complete(scope.signal));
  scope.signal.throwIfAborted();
  return result;
}

export function hasCompletionRunPermit(runId: string | undefined): boolean {
  const permit = permits.getStore();
  return Boolean(permit?.active && runId && permit.runId === runId);
}

export function isCompletionDraftContext(): boolean {
  return permits.getStore() !== undefined;
}

export function captureCompletionOutput(runId: string, output: unknown): void {
  if (!hasCompletionRunPermit(runId)) return;
  const permit = permits.getStore()!;
  permit.outputCount = (permit.outputCount ?? 0) + 1;
  // A Host continuation is not the original evidence-bound draft. Keep the first
  // capture private for diagnosis; never silently select the last generation.
  if (permit.outputCount === 1) permit.privateOutput = output;
}

export function readCompletionOutput(runId: string): unknown {
  if (!hasCompletionRunPermit(runId)) throw new CompletionError("invalid_run_permit", "generate");
  if ((permits.getStore()!.outputCount ?? 0) > 1) throw new CompletionError("host_generation_retried", "generate");
  return permits.getStore()!.privateOutput;
}

export function recordCompletionPreparation(runId: string, preparation: unknown): void {
  const scope = preparationScopes.getStore();
  if (scope && (!scope.active || scope.signal.aborted)) throw new CompletionError("cancelled", "prepare");
  if (!hasCompletionRunPermit(runId)) throw new CompletionError("invalid_run_permit", "prepare");
  permits.getStore()!.preparation = preparation;
}

export function readCompletionPreparation(runId: string): unknown {
  if (!hasCompletionRunPermit(runId)) throw new CompletionError("invalid_run_permit", "prepare");
  return permits.getStore()!.preparation;
}

export type CompletionPorts = {
  generateDraft(input: { operationId: string; runId: string; abortSignal: AbortSignal }): Promise<CompletionDraft>;
  persist(input: { operationId: string; draft: CompletionDraft; responseKind: ResponseKind; abortSignal: AbortSignal }): Promise<CompletionReceipt>;
  publishFinal(input: { operationId: string; draft: CompletionDraft; receipt: CompletionReceipt; abortSignal: AbortSignal }): Promise<CompletionResult["delivery"]>;
};

export function completionDraftHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function validateReceipt(receipt: CompletionReceipt, input: { operationId: string }, draft: CompletionDraft): void {
  if (receipt.schemaVersion !== "stella.completion-receipt/v1" ||
      receipt.operationId !== input.operationId || receipt.draftId !== draft.draftId ||
      receipt.draftHash !== completionDraftHash(draft.text) ||
      receipt.evidenceRef !== draft.evidenceRef || receipt.responseKind !== draft.responseKind ||
      !/^[0-9a-f]{40}$/.test(receipt.observedRevision) || !receipt.generationId ||
      !Number.isFinite(Date.parse(receipt.checkedAt)) ||
      !["not_required", "local_committed", "remote_pending", "synchronized"].includes(receipt.persistenceStatus) ||
      !Array.isArray(receipt.writeOperationIds) || receipt.writeOperationIds.some((id) => !id) ||
      (draft.requiresCriticalPersistence && (receipt.persistenceStatus !== "synchronized" || receipt.writeOperationIds.length === 0))) {
    throw new CompletionError("invalid_completion_receipt", "persist");
  }
}

/** Ports retain durable operation identity; this coordinator never retries a write or send. */
export async function coordinateCompletion(input: {
  operationId: string;
  runId: string;
  timeoutMs: number;
  resourceScope?: string;
  abortSignal?: AbortSignal;
}, ports: CompletionPorts): Promise<CompletionResult> {
  if (!input.operationId || !input.runId || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new CompletionError("invalid_input", "admission");
  }
  const resourceScope = input.resourceScope ?? input.runId;
  if (!resourceScope.trim()) throw new CompletionError("invalid_input", "admission");
  if (activeResources.has(resourceScope)) throw new CompletionError("operation_in_progress", "admission");
  activeResources.add(resourceScope);
  const controller = new AbortController();
  const permit: RunPermit = { operationId: input.operationId, runId: input.runId, active: true, abortSignal: controller.signal };
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
    if (!draft.draftId || !draft.text.trim() || !draft.evidenceRef ||
        !["answer", "clarification", "collaboration", "action_advice", "outcome_ack"].includes(draft.responseKind) ||
        typeof draft.requiresCriticalPersistence !== "boolean") throw new CompletionError("invalid_draft", stage);
    stage = "persist";
    const receipt = await ports.persist({ ...input, draft, responseKind: draft.responseKind, abortSignal: controller.signal });
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
    // Cancellation ends the Host request, not necessarily the underlying write.
    const drainingWork = work().finally(() => { activeResources.delete(resourceScope); });
    return await Promise.race([aborted, drainingWork]);
  } catch (cause) {
    if (cause instanceof CompletionError) throw cause;
    throw new CompletionError(stage === "publish" ? "delivery_unknown" : "completion_failed", stage, { cause });
  } finally {
    clearTimeout(timer);
    permit.active = false;
    input.abortSignal?.removeEventListener("abort", onAbort);
  }
}
