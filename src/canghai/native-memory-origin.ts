import { CatalogError } from "./catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";

export const NATIVE_MEMORY_PROVIDERS = ["memory-core", "session-memory", "memory-wiki"] as const;
export type NativeMemoryOrigin = {
  schemaVersion: "stella.native-memory-origin/v1";
  hostVersion: string;
  agentId: string;
  provider: (typeof NATIVE_MEMORY_PROVIDERS)[number];
  path: string;
  fromLine: number;
  lineCount: number;
  claimId?: string;
};

/** An immutable locator on a retained Source, never a grant or a producer receipt. */
export function parseNativeMemoryOrigin(value: unknown): NativeMemoryOrigin {
  if (!isRecord(value) || Object.keys(value).sort().join() !== (value.claimId === undefined
      ? "agentId,fromLine,hostVersion,lineCount,path,provider,schemaVersion" : "agentId,claimId,fromLine,hostVersion,lineCount,path,provider,schemaVersion") ||
    value.schemaVersion !== "stella.native-memory-origin/v1" || typeof value.hostVersion !== "string" || !value.hostVersion ||
    typeof value.agentId !== "string" || !value.agentId || !NATIVE_MEMORY_PROVIDERS.includes(value.provider as NativeMemoryOrigin["provider"]) ||
    typeof value.path !== "string" || value.path.length > 1024 || !value.path.endsWith(".md") || value.path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value.path) ||
    value.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":")) ||
    !Number.isSafeInteger(value.fromLine) || Number(value.fromLine) < 1 ||
    !Number.isSafeInteger(value.lineCount) || Number(value.lineCount) < 1 || Number(value.lineCount) > 120 ||
    !Number.isSafeInteger(Number(value.fromLine) + Number(value.lineCount)) ||
    value.claimId !== undefined && (value.provider !== "memory-wiki" || typeof value.claimId !== "string" ||
      !value.claimId.trim() || value.claimId !== value.claimId.trim() || value.claimId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.claimId))) {
    throw new CatalogError("invalid_native_memory_origin");
  }
  return structuredClone(value) as NativeMemoryOrigin;
}
