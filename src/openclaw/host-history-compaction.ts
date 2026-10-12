import { AsyncLocalStorage } from "node:async_hooks";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { BoundTurnRequest } from "./turn-request.js";

type Operation = {
  request: BoundTurnRequest;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  active: boolean;
  publishing: boolean;
};
const operations = new AsyncLocalStorage<Operation>();

/** Only the authenticated Core gateway handler enters this scope. Neither a
 * session locator nor a serialized copy authorizes model processing. This is
 * deliberately separate from completion, business-write and delivery permits. */
export async function withHostHistoryCompaction<T>(input: Omit<Operation, "active" | "publishing">,
  work: () => Promise<T>): Promise<T> {
  if (operations.getStore()) throw new CatalogError("host_context_compaction_nested");
  const operation = { ...input, active: true, publishing: false };
  try {
    return await operations.run(operation, async () => {
      await assertHostHistoryCompaction(input.request);
      const result = await work();
      await assertHostHistoryCompaction(input.request);
      return result;
    });
  } finally { operation.active = false; }
}

export function hostHistoryCompaction(request?: BoundTurnRequest): Readonly<Pick<Operation, "request" | "signal" | "publishing">> | undefined {
  const operation = operations.getStore();
  if (!operation) return undefined;
  if (!operation.active || request && operation.request !== request) throw new CatalogError("host_context_compaction_not_admitted");
  operation.signal.throwIfAborted();
  return operation;
}

export async function assertHostHistoryCompaction(request: BoundTurnRequest): Promise<void> {
  const operation = hostHistoryCompaction(request);
  if (!operation) throw new CatalogError("host_context_compaction_not_admitted");
  await operations.getStore()!.assertCurrent();
  if (hostHistoryCompaction(request) !== operation) throw new CatalogError("host_context_compaction_not_admitted");
}

/** Once inference completes, publication can only revalidate decisions already
 * made for this exact operation. It cannot mint access to another source. */
export async function publishHostHistoryCompaction<T>(request: BoundTurnRequest, work: () => Promise<T>): Promise<T> {
  await assertHostHistoryCompaction(request);
  operations.getStore()!.publishing = true;
  return work();
}
