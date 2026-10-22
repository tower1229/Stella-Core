import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export class ExclusiveFileLockError extends Error {
  constructor(readonly category: "lock_busy" | "lock_unsafe_path" | "lock_ownership_lost" | "lock_io_failed") {
    super(`Exclusive file lock failed: ${category}`);
  }
}
type Lease = { path: string; parent: string; parentStat: Stats; handle: FileHandle; stat: Stats; bytes: Buffer; state: "holding" | "releasing" | "released"; release?: Promise<void> };
const owners = new AsyncLocalStorage<ReadonlyMap<string, Lease>>();
function fail(category: ExclusiveFileLockError["category"]): never { throw new ExclusiveFileLockError(category); }
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function code(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? error.code : undefined; }
async function canonicalParent(target: string): Promise<{ parent: string; stat: Stats }> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || /[\x00-\x1f\x7f]/.test(target)) fail("lock_unsafe_path");
  const parent = path.dirname(target);
  let directory = path.parse(parent).root;
  for (const part of parent.slice(directory.length).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("lock_unsafe_path");
  }
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) fail("lock_unsafe_path");
  return { parent, stat };
}
async function syncDirectory(parent: string): Promise<void> {
  const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function assertOwned(lease: Lease, forRelease = false): Promise<void> {
  const expectedState = forRelease ? "releasing" : "holding";
  if (lease.state !== expectedState) fail("lock_ownership_lost");
  try {
  const parent = await canonicalParent(lease.path);
  if (!same(parent.stat, lease.parentStat)) fail("lock_ownership_lost");
  const held = await lease.handle.stat(), leaf = await lstat(lease.path);
  if (!held.isFile() || held.nlink !== 1 || !leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 ||
      !same(held, lease.stat) || !same(leaf, lease.stat) || held.size !== lease.bytes.length) fail("lock_ownership_lost");
  const content = Buffer.alloc(lease.bytes.length + 1);
  let length = 0;
  while (length < content.length) {
    const next = await lease.handle.read(content, length, content.length - length, length);
    if (!next.bytesRead) break;
    length += next.bytesRead;
  }
  const after = await lease.handle.stat(), current = await lstat(lease.path);
  if (length !== lease.bytes.length || !content.subarray(0, length).equals(lease.bytes) || !same(after, lease.stat) ||
      !same(current, lease.stat) || after.nlink !== 1 || current.nlink !== 1 || current.isSymbolicLink() ||
      after.size !== held.size || after.mtimeMs !== held.mtimeMs || after.ctimeMs !== held.ctimeMs) fail("lock_ownership_lost");
  if (lease.state !== expectedState) fail("lock_ownership_lost");
  } catch (error) { if (lease.state !== expectedState) fail("lock_ownership_lost"); throw error; }
}
function release(lease: Lease): Promise<void> {
  if (lease.release) return lease.release;
  lease.state = "releasing";
  return lease.release = (async () => {
    try {
      await assertOwned(lease, true);
      await unlink(lease.path);
      // Never unlink again, even when the following directory fsync fails.
      lease.state = "released";
      await syncDirectory(lease.parent);
    } finally { lease.state = "released"; await lease.handle.close(); }
  })();
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { if (error instanceof ExclusiveFileLockError) throw error; fail("lock_io_failed"); }
}
/** True only for this async chain's still-active, inode/nonce-verified lease. */
export async function ownsExclusiveFileLock(target: string): Promise<boolean> {
  return guarded(async () => {
    const lease = owners.getStore()?.get(`${target}.lock`);
    if (!lease) return false;
    await assertOwned(lease);
    if (lease.state !== "holding") fail("lock_ownership_lost");
    return true;
  });
}
/** Cooperative local filesystem mutex. Existing/empty/corrupt/crash-residue locks
 * always refuse admission; there is no PID lookup, retry, polling or stale recovery.
 * Callers must drain old binaries before adopting this format and shared fence.
 */
export async function withExclusiveFileLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || !path.basename(target) || /[\x00-\x1f\x7f]/.test(target)) fail("lock_unsafe_path");
  const lockPath = `${target}.lock`, inherited = owners.getStore();
  const existing = inherited?.get(lockPath);
  if (existing) { await guarded(() => assertOwned(existing)); if (existing.state !== "holding") fail("lock_ownership_lost"); return work(); }
  const lease = await guarded(async () => {
    const parent = await canonicalParent(lockPath);
    let handle: FileHandle;
    try { handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (code(error) === "EEXIST") fail("lock_busy"); throw error; }
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: "stella.exclusive-file-lock/v1", nonce: randomUUID() }) + "\n");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) fail("lock_unsafe_path");
      const owned: Lease = { path: lockPath, parent: parent.parent, parentStat: parent.stat, handle, stat, bytes, state: "holding" };
      await handle.writeFile(bytes); await handle.sync(); await syncDirectory(parent.parent);
      await assertOwned(owned);
      return owned;
    } catch (error) {
      await handle.close(); throw error;
    }
  });
  const scope = new Map(inherited); scope.set(lockPath, lease);
  let failed = false, workError: unknown, result!: T;
  try { result = await owners.run(scope, work); } catch (error) { failed = true; workError = error; }
  try { await guarded(() => release(lease)); }
  catch (cleanupError) {
    if (failed) throw new AggregateError([workError, cleanupError], "Business operation and lock cleanup failed", { cause: workError });
    throw cleanupError;
  }
  if (failed) throw workError;
  return result;
}
