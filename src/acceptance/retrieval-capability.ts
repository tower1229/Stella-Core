import { bytesVersion } from "../canghai/content-version.js";
import type { CapabilityAdapter } from "./capability-acceptance.js";

/** Constrained memory_access adapter: verifies authorized original discovery / fragment read surface without business admission. */
export function createMemoryAccessCapabilityAdapter(input: {
  verify: CapabilityAdapter["execute"];
}): CapabilityAdapter {
  return {
    capabilityId: "memory_access",
    adapterId: "stella.memory-access",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    execute: input.verify,
  };
}

/** Constrained semantic_retrieval adapter: verifies recall / counterevidence / temporal / failure semantics without business admission. */
export function createSemanticRetrievalCapabilityAdapter(input: {
  verify: CapabilityAdapter["execute"];
}): CapabilityAdapter {
  return {
    capabilityId: "semantic_retrieval",
    adapterId: "stella.semantic-retrieval",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    execute: input.verify,
  };
}

export function syntheticRetrievalExecutionDigest(label: string): string {
  return bytesVersion(label);
}
