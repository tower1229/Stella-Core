import { AsyncLocalStorage } from "node:async_hooks";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { BoundTurnRequest } from "./turn-request.js";

type Verification = { request: BoundTurnRequest; signal: AbortSignal; assertCurrent(): Promise<void>; active: boolean };
const verifications = new AsyncLocalStorage<Verification>();

/** Core's authenticated constrained verifier owns this private lifetime. It grants
 * no main-agent, source expansion, persistence, or delivery permit. */
export async function withHostMemoryVerification<T>(input: Omit<Verification, "active">, work: () => Promise<T>): Promise<T> {
  if (verifications.getStore()) throw new CatalogError("host_memory_verification_nested");
  const scope = { ...input, active: true };
  try {
    return await verifications.run(scope, async () => {
      await assertHostMemoryVerification(input.request);
      const result = await work();
      await assertHostMemoryVerification(input.request);
      return result;
    });
  } finally { scope.active = false; }
}

export function hostMemoryVerification(request?: BoundTurnRequest): Readonly<Pick<Verification, "request" | "signal">> | undefined {
  const scope = verifications.getStore();
  if (!scope) return undefined;
  if (!scope.active || request && scope.request !== request) throw new CatalogError("host_memory_verification_not_admitted");
  scope.signal.throwIfAborted();
  return scope;
}

export async function assertHostMemoryVerification(request: BoundTurnRequest): Promise<void> {
  const scope = hostMemoryVerification(request);
  if (!scope) throw new CatalogError("host_memory_verification_not_admitted");
  await verifications.getStore()!.assertCurrent();
  if (hostMemoryVerification(request) !== scope) throw new CatalogError("host_memory_verification_not_admitted");
}
