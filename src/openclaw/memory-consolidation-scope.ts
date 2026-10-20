import { AsyncLocalStorage } from "node:async_hooks";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { BoundTurnRequest } from "./turn-request.js";

type Scope = { request: BoundTurnRequest; signal: AbortSignal; active: boolean };
const scopes = new AsyncLocalStorage<Scope>();
/** Entered only by the separately granted Core consolidation handler. This
 * lifetime authorizes neither main-agent execution nor external delivery. */
export async function withMemoryConsolidation<T>(input: Omit<Scope, "active">, work: () => Promise<T>): Promise<T> {
  if (scopes.getStore()) throw new CatalogError("memory_consolidation_nested");
  const scope = { ...input, active: true };
  try { return await scopes.run(scope, async () => {
    assertMemoryConsolidation(input.request);
    const result = await work();
    assertMemoryConsolidation(input.request); return result;
  }); } finally { scope.active = false; }
}
export function memoryConsolidation(request?: BoundTurnRequest): Readonly<Pick<Scope, "request" | "signal">> | undefined {
  const scope = scopes.getStore(); if (!scope) return undefined;
  if (!scope.active || request && request !== scope.request) throw new CatalogError("memory_consolidation_expired");
  scope.signal.throwIfAborted(); return scope;
}
export function assertMemoryConsolidation(request: BoundTurnRequest): void {
  if (!memoryConsolidation(request)) throw new CatalogError("memory_consolidation_not_admitted");
}
