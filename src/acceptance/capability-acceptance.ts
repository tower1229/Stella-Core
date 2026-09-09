import { canonicalJson } from "../canghai/content-version.js";
import {
  CapabilityReceiptError,
  issueCapabilityReceipt,
  type CapabilityHostBinding,
  type CapabilityReceipt,
  type CapabilityReceiptStore,
  type CapabilityVersionBinding,
} from "./capability-receipt.js";

const allowedConstrainedEffects = ["observe", "verify"] as const;
export type ConstrainedAcceptanceEffect = typeof allowedConstrainedEffects[number];

export type CapabilityAdapter = {
  capabilityId: string;
  adapterId: string;
  adapterVersion: string;
  allowedEffects: readonly ConstrainedAcceptanceEffect[];
  execute(input: {
    mode: "constrained_acceptance";
    host: CapabilityHostBinding;
    signal?: AbortSignal;
  }): Promise<{ outcome: "passed" | "failed"; executionDigest: string }>;
};

function check(value: unknown, category: string): asserts value {
  if (!value) throw new CapabilityReceiptError(category);
}

/**
 * Run one adapter under constrained acceptance.
 * Produces a version-bound receipt without granting ordinary business admission or expanding permissions.
 */
export async function runConstrainedCapabilityAcceptance(input: {
  adapter: CapabilityAdapter;
  host: CapabilityHostBinding;
  captureBinding: () => Promise<CapabilityVersionBinding>;
  store: CapabilityReceiptStore;
  signal?: AbortSignal;
  ttlMs?: number;
}): Promise<CapabilityReceipt> {
  check(!input.signal?.aborted, "operation_cancelled");
  check(input.adapter.capabilityId === input.host.purpose.capabilityId, "capability_purpose_mismatch");
  check(input.adapter.allowedEffects.length > 0 &&
    input.adapter.allowedEffects.every(effect => (allowedConstrainedEffects as readonly string[]).includes(effect)),
  "constrained_acceptance_effect_forbidden");
  const before = await input.captureBinding();
  check(!input.signal?.aborted, "operation_cancelled");
  const execution = await input.adapter.execute({
    mode: "constrained_acceptance",
    host: structuredClone(input.host),
    signal: input.signal,
  });
  check(!input.signal?.aborted, "operation_cancelled");
  check(execution.outcome === "passed" || execution.outcome === "failed", "invalid_adapter_outcome");
  check(canonicalJson(await input.captureBinding()) === canonicalJson(before), "capability_dependencies_changed");
  return issueCapabilityReceipt({
    capabilityId: input.adapter.capabilityId,
    adapterId: input.adapter.adapterId,
    adapterVersion: input.adapter.adapterVersion,
    host: input.host,
    binding: before,
    result: execution.outcome,
    executionDigest: execution.executionDigest,
    store: input.store,
    ttlMs: input.ttlMs,
  });
}
