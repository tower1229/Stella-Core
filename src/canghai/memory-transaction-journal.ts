import path from "node:path";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { isRecord } from "../shared/type-guards.js";
import type { MemoryFileChange, MemoryTransactionPlan } from "./memory-transaction-plan.js";

export class MemoryTransactionJournalError extends Error {
  readonly category = "invalid_transaction_journal";
  constructor() { super("Memory transaction failed: invalid_transaction_journal"); }
}
function fail(): never { throw new MemoryTransactionJournalError(); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) fail();
  return value as Record<string, unknown>;
}
function recovery(value: unknown): NonNullable<MemoryTransactionPlan["recoveryCheckpoint"]> {
  const input = exact(value, ["binding", "expected"]);
  const binding = exact(input.binding, ["agentId", "repositoryRoot", "manifestPath"]);
  const expected = exact(input.expected, ["revision", "token"]);
  if (typeof binding.agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(binding.agentId) ||
      typeof binding.repositoryRoot !== "string" || !path.isAbsolute(binding.repositoryRoot) || path.resolve(binding.repositoryRoot) !== binding.repositoryRoot ||
      typeof binding.manifestPath !== "string" || !binding.manifestPath || /[\\:\x00-\x1f\x7f]/.test(binding.manifestPath) ||
      binding.manifestPath.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      typeof expected.revision !== "string" || !/^[a-f0-9]{40}$/.test(expected.revision) ||
      typeof expected.token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(expected.token)) fail();
  return { binding: { agentId: binding.agentId, repositoryRoot: binding.repositoryRoot, manifestPath: binding.manifestPath },
    expected: { revision: expected.revision, token: expected.token } };
}
function file(value: unknown): MemoryFileChange {
  if (!isRecord(value) || typeof value.path !== "string" ||
      (value.before !== null && typeof value.before !== "string") || typeof value.after !== "string" ||
      (value.encoding !== undefined && value.encoding !== "utf8" && value.encoding !== "base64")) fail();
  return { path: value.path, before: value.before, after: value.after,
    ...(value.encoding !== undefined ? { encoding: value.encoding } : {}) };
}
function archive(value: unknown): NonNullable<MemoryTransactionPlan["contextArchive"]> {
  const input = exact(value, ["archiveRoot", "digest"]);
  if (typeof input.archiveRoot !== "string" || typeof input.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.digest)) fail();
  return { archiveRoot: input.archiveRoot, digest: input.digest };
}
/** Exact v1 compatibility; v2 adds the frozen checkpoint expectation to the same journal. */
export function parseMemoryTransactionJournal(bytes: string, expectedOperationId?: string): MemoryTransactionPlan {
  try {
    const value: unknown = JSON.parse(bytes);
    if (!isRecord(value) || (value.schemaVersion !== "stella.memory-transaction/v1" && value.schemaVersion !== "stella.memory-transaction/v2") ||
        typeof value.operationId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(value.operationId) ||
        (expectedOperationId !== undefined && value.operationId !== expectedOperationId) ||
        typeof value.journalPath !== "string" || !Array.isArray(value.files)) fail();
    if ((value.schemaVersion === "stella.memory-transaction/v2") !== (value.recoveryCheckpoint !== undefined)) fail();
    const plan: MemoryTransactionPlan = { operationId: value.operationId, journalPath: value.journalPath,
      ...(value.contextArchive !== undefined ? { contextArchive: archive(value.contextArchive) } : {}),
      ...(value.recoveryCheckpoint !== undefined ? { recoveryCheckpoint: recovery(value.recoveryCheckpoint) } : {}),
      files: value.files.map(file) };
    if (canonicalJson({ schemaVersion: value.schemaVersion, ...plan, planHash: bytesVersion(canonicalJson(plan)) }) !== bytes) fail();
    return plan;
  } catch { return fail(); }
}
export function serializeMemoryTransactionJournal(plan: MemoryTransactionPlan): string {
  try {
    const bytes = canonicalJson({ schemaVersion: plan.recoveryCheckpoint === undefined ? "stella.memory-transaction/v1" : "stella.memory-transaction/v2",
      ...plan, planHash: bytesVersion(canonicalJson(plan)) });
    parseMemoryTransactionJournal(bytes, plan.operationId);
    return bytes;
  } catch { return fail(); }
}
