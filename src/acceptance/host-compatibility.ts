import { createHash } from "node:crypto";

export const HOST_COMPATIBILITY = {
  id: "stella-openclaw-2026.8.2-private-draft-v1",
  hostVersion: "2026.8.2",
  module: "dist/embedded-agent-DGMNaRB-.js",
  originalSha256: "c4ec52bc3425c25af43fd177ce6eb7b06b3ac2d338970a47dbbfdb7f79154c7f",
  patchedSha256: "1ced0b8b80c2b9046f5f60af71c07db99b4dbce3bef7dc1d6db1eb25852c3d8c",
} as const;
export type HostCompatibility = typeof HOST_COMPATIBILITY;
export function parseHostCompatibility(value: unknown): HostCompatibility {
  if (value === null || typeof value !== "object" || Object.keys(value).length !== Object.keys(HOST_COMPATIBILITY).length ||
      Object.entries(HOST_COMPATIBILITY).some(([key, expected]) => (value as Record<string, unknown>)[key] !== expected)) {
    throw new Error("host_compatibility_mismatch");
  }
  return { ...HOST_COMPATIBILITY };
}
export const hostModuleHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export function assertSameHostCompatibility(...values: unknown[]): void {
  const identities = values.map((value) => value === undefined ? "original" : parseHostCompatibility(value).id);
  if (new Set(identities).size > 1) throw new Error("host_compatibility_mismatch");
}

/** Exact byte transformation, not a fuzzy patch or a package-version-only check. */
export function patchPrivateDraftHost(bytes: Uint8Array): Buffer {
  const hash = hostModuleHash(bytes);
  if (hash === HOST_COMPATIBILITY.patchedSha256) return Buffer.from(bytes);
  if (hash !== HOST_COMPATIBILITY.originalSha256) throw new Error("host_original_module_mismatch");
  const before = "const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent || settledTurnFinalizationAttempted ? null : resolveReasoningOnlyRetryInstruction({";
  const after = "const nextReasoningOnlyRetryInstruction = input.finalAssistantVisibleText?.trim() || emptyAssistantReplyIsSilent || settledTurnFinalizationAttempted ? null : resolveReasoningOnlyRetryInstruction({";
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.split(before).length !== 2) throw new Error("host_patch_target_mismatch");
  const patched = Buffer.from(source.replace(before, after));
  if (hostModuleHash(patched) !== HOST_COMPATIBILITY.patchedSha256) throw new Error("host_patched_module_mismatch");
  return patched;
}
