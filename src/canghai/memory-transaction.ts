import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { acquireFileLock, reclaimDefinitelyStaleFileLock } from "openclaw/plugin-sdk/file-lock";
import { isRecord } from "../shared/type-guards.js";

const markerName = ".stella-memory-transaction.json";
const owners = new AsyncLocalStorage<{ root: string; intent: string; active: boolean }>();
export class MemoryTransactionError extends Error {
  constructor(readonly category: string) { super(`Memory transaction failed: ${category}`); }
}
const check = (value: unknown, category: string) => { if (!value) throw new MemoryTransactionError(category); };
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
async function acquireMutationLock(root: string): Promise<{ release(): Promise<void> }> {
  const target = path.join(root, markerName);
  const options = { stale: 0, retries: { retries: 0 }, staleRecovery: "fail-closed" as const };
  try { return await acquireFileLock(target, options); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "file_lock_stale") {
      const reclaimed = await reclaimDefinitelyStaleFileLock(`${target}.lock`);
      if (reclaimed !== "retained") {
        try { return await acquireFileLock(target, options); }
        catch { throw new MemoryTransactionError("memory_transaction_in_progress"); }
      }
    }
    throw new MemoryTransactionError("memory_transaction_in_progress");
  }
}
async function text(file: string): Promise<string | null> {
  try {
    const stat = await lstat(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 20 * 1024 * 1024, "unsafe_transaction_file");
    return await readFile(file, "utf8");
  } catch (error) { if (missing(error)) return null; throw error; }
}

/** A failed publication remains fenced on disk, including after a process restart. */
export async function assertMemoryTransactionReadable(root: string): Promise<void> {
  const resolved = path.resolve(root);
  const pending = await text(path.join(resolved, markerName));
  if (pending === null) return;
  const owner = owners.getStore();
  check(owner?.active && owner.root === resolved && owner.intent === pending, "memory_transaction_pending");
}

export async function withMemoryMutationLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root);
  const owner = owners.getStore();
  await assertMemoryTransactionReadable(resolved);
  if (owner?.active && owner.root === resolved) return work();
  const stat = await lstat(resolved);
  check(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_transaction_path");
  const lock = await acquireMutationLock(resolved);
  try { await assertMemoryTransactionReadable(resolved); return await work(); }
  finally { await lock.release(); }
}

export type MemoryFileChange = { path: string; before: string | null; after: string };
export type MemoryTransactionPlan = { operationId: string; journalPath: string; files: MemoryFileChange[] };
export async function readRecordedMemoryTransaction(root: string, expectedOperationId: string, completedJournalPath?: string): Promise<MemoryTransactionPlan> {
  const pending = await text(await location(path.resolve(root), markerName));
  const bytes = pending ?? (completedJournalPath ? await text(await location(path.resolve(root), completedJournalPath)) : null);
  check(bytes !== null, "pending_transaction_not_found");
  let value: unknown;
  try { value = JSON.parse(bytes!); } catch { throw new MemoryTransactionError("invalid_transaction_journal"); }
  if (!isRecord(value) || value.schemaVersion !== "stella.memory-transaction/v1" || value.operationId !== expectedOperationId ||
      typeof value.journalPath !== "string" || !Array.isArray(value.files) || !value.files.every((file) =>
        isRecord(file) && typeof file.path === "string" && (file.before === null || typeof file.before === "string") && typeof file.after === "string")) {
    throw new MemoryTransactionError("invalid_transaction_journal");
  }
  const plan: MemoryTransactionPlan = { operationId: expectedOperationId, journalPath: value.journalPath,
    files: value.files.map((file) => ({ path: file.path, before: file.before, after: file.after })) };
  check(canonicalJson({ schemaVersion: "stella.memory-transaction/v1", ...plan, planHash: bytesVersion(canonicalJson(plan)) }) === bytes,
    "invalid_transaction_journal");
  return plan;
}
type TransactionPorts = {
  validate(): Promise<void>;
  persist(paths: string[], operationId: string): Promise<void>;
  confirmPreviouslyCommitted(journalPath: string): Promise<void>;
};
async function location(root: string, relative: string, create = false): Promise<string> {
  check(relative && !path.isAbsolute(relative) && !relative.includes("\\") && relative.split("/").every((part) =>
    part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !part.includes(":")), "unsafe_transaction_path");
  const parts = relative.split("/");
  let current = root;
  for (const part of ["", ...parts.slice(0, -1)]) {
    if (part) current = path.join(current, part);
    if (part && create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const stat = await lstat(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_transaction_path");
  }
  const file = path.join(current, parts.at(-1)!);
  await text(file);
  return file;
}
async function writeNew(file: string, content: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
async function replace(file: string, content: string): Promise<void> {
  const staging = path.join(path.dirname(file), `.transaction-${randomUUID()}.staging`);
  try { await writeNew(staging, content); await rename(staging, file); }
  finally { try { await unlink(staging); } catch (error) { if (!missing(error)) throw error; } }
}

/** Only the verified transaction may see its unpublished multi-file state. */
export async function applyMemoryTransaction(root: string, value: MemoryTransactionPlan, ports: TransactionPorts,
  abortSignal?: AbortSignal): Promise<{ operationId: string; journalPath: string; replayed: boolean }> {
  const plan: MemoryTransactionPlan = JSON.parse(canonicalJson(value));
  const resolved = path.resolve(root);
  const checkActive = () => check(!abortSignal?.aborted, "operation_cancelled");
  checkActive();
  check(/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(plan.operationId) && plan.files.length > 0 && plan.files.length <= 64, "invalid_transaction_plan");
  const paths = [...plan.files.map((file) => file.path), plan.journalPath];
  check(new Set(paths.map((file) => process.platform === "win32" ? file.toLowerCase() : file)).size === paths.length &&
    paths.every((file) => ![markerName, `${markerName}.lock`].includes(file.toLowerCase())), "transaction_path_collision");
  check(plan.files.every((file) => (file.before === null || typeof file.before === "string") && typeof file.after === "string") &&
    Buffer.byteLength(canonicalJson(plan), "utf8") <= 16 * 1024 * 1024, "invalid_transaction_plan");
  const intent = canonicalJson({ schemaVersion: "stella.memory-transaction/v1", ...plan, planHash: bytesVersion(canonicalJson(plan)) });
  const marker = path.join(resolved, markerName);
  // A separate exclusive handle prevents two retries of the same durable intent from executing together.
  const rootStat = await lstat(resolved);
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "unsafe_transaction_path");
  const lock = await acquireMutationLock(resolved);
  try {
    const pending = await text(marker);
    check(pending === null || pending === intent, "memory_transaction_conflict");
    const journal = await location(resolved, plan.journalPath, true);
    const recorded = await text(journal);
    check(recorded === null || recorded === intent, "transaction_operation_conflict");
    if (recorded !== null && pending === null) {
      await ports.confirmPreviouslyCommitted(plan.journalPath);
      checkActive();
      return { operationId: plan.operationId, journalPath: plan.journalPath, replayed: true };
    }
    const targets = await Promise.all(plan.files.map((file) => location(resolved, file.path, true)));
    for (let index = 0; index < plan.files.length; index++) {
      const file = plan.files[index]!;
      const current = await text(targets[index]!);
      check(current === file.before || pending !== null && current === file.after, "transaction_version_conflict");
    }
    if (pending === null) await writeNew(marker, intent);
    const owner = { root: resolved, intent, active: true };
    try { await owners.run(owner, async () => {
      await ports.validate();
      checkActive();
      for (let index = 0; index < plan.files.length; index++) {
        checkActive();
        const file = plan.files[index]!;
        const target = targets[index]!;
        const current = await text(target);
        check(current === file.before || current === file.after, "transaction_version_conflict");
        if (current !== file.after) await replace(target, file.after);
      }
      if (recorded === null) await writeNew(journal, intent);
      checkActive();
      await ports.persist(paths, plan.operationId);
      checkActive();
      check(await text(marker) === intent, "memory_transaction_conflict");
      await unlink(marker);
    }); } catch (error) {
      if (await text(journal) === null && (await Promise.all(targets.map((target) => text(target))))
        .every((current, index) => current === plan.files[index]!.before) && await text(marker) === intent) {
        await unlink(marker);
      }
      throw error;
    } finally { owner.active = false; }
    return { operationId: plan.operationId, journalPath: plan.journalPath, replayed: pending !== null };
  } finally { await lock.release(); }
}
