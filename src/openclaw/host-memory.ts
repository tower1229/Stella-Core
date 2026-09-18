import type { RuntimeProfile } from "../canghai/runtime-profile.js";
import { CatalogError } from "../canghai/catalog-reader.js";

/**
 * OpenClaw 2026.8.2 exposes a before_agent_run snapshot, not a provenance-bound
 * inventory of every model input. Session replay/compaction, bootstrap caches,
 * memory providers, Active Memory and Dreaming cannot currently be certified.
 * Empty history or a passed capability receipt does not prove their absence.
 * Keep this blocker independent of capability receipts and session lifetime.
 */
export function hostMemoryRuntimeBlockers(profile: RuntimeProfile["contract_profile"] | undefined): string[] {
  return profile === "full_memory" ? ["host_memory_consumption_unverifiable"] : [];
}

export function assertHostMemoryConsumptionSupported(profile: RuntimeProfile): void {
  const blocker = hostMemoryRuntimeBlockers(profile.contract_profile)[0];
  if (blocker) throw new CatalogError(blocker);
}
