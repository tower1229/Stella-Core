import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { bytesVersion, canonicalJson } from "./content-version.js";
import {
  RecoveryCheckpointError,
  type RecoveryCheckpoint,
  type RecoveryCheckpointBinding,
  type RecoveryCheckpointLock,
  type RecoveryCheckpointStore,
  type RecoveryCheckpointStoreOptions,
  type RecoveryCheckpointVersion,
  type RecoveryCheckpointWritePhase,
  type RecoveryCheckpointWriteResult,
} from "./recovery-checkpoint-contract.js";

const SCHEMA = "stella.recovery-checkpoint/v1";
const MAX_BYTES = 16 * 1024;
const REVISION = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CATEGORIES = new Set([
  "checkpoint_missing", "checkpoint_corrupt", "checkpoint_binding_mismatch",
  "checkpoint_conflict", "checkpoint_operation_conflict", "checkpoint_unsafe_path",
  "checkpoint_state_inside_repository", "checkpoint_invalid_input", "checkpoint_io_failed",
]);
type Identity = Readonly<{ dev: number; ino: number }>;
type StoredCheckpoint = Readonly<{
  checkpoint: RecoveryCheckpoint;
  digest: string;
  identity: Identity;
}>;
type Operation = Readonly<{
  kind: "initialize" | "compare_and_set";
  operationId: string;
  expected: RecoveryCheckpointVersion | null;
  nextRevision: string;
  digest: string;
}>;

function failure(category: string): RecoveryCheckpointError {
  return new RecoveryCheckpointError(category);
}

/** Do not retain filesystem paths or observer payloads in error messages/causes. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw failure(error instanceof RecoveryCheckpointError && CATEGORIES.has(error.category)
      ? error.category : "checkpoint_io_failed");
  }
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw failure("checkpoint_invalid_input");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
    || required.some((key) => !Object.hasOwn(value, key))) throw failure("checkpoint_invalid_input");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw failure("checkpoint_invalid_input");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function matching(value: unknown, expression: RegExp): string {
  if (typeof value !== "string" || !expression.test(value)) throw failure("checkpoint_invalid_input");
  return value;
}

function pathString(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw failure("checkpoint_invalid_input");
  }
  return value;
}

function absolutePath(value: unknown): string {
  const result = pathString(value);
  if (!path.isAbsolute(result) || path.resolve(result) !== result) throw failure("checkpoint_invalid_input");
  return result;
}

function snapshotBinding(value: unknown): RecoveryCheckpointBinding {
  const input = record(value, ["agentId", "repositoryRoot", "manifestPath"]);
  const manifestPath = pathString(input.manifestPath);
  if (path.posix.isAbsolute(manifestPath) || manifestPath.includes("\\") || manifestPath.includes(":")
    || manifestPath.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw failure("checkpoint_invalid_input");
  }
  return Object.freeze({
    agentId: matching(input.agentId, AGENT_ID),
    repositoryRoot: absolutePath(input.repositoryRoot),
    manifestPath,
  });
}

function snapshotVersion(value: unknown): RecoveryCheckpointVersion {
  const input = record(value, ["revision", "token"]);
  return Object.freeze({ revision: matching(input.revision, REVISION), token: matching(input.token, TOKEN) });
}

function cloneCheckpoint(value: RecoveryCheckpoint): RecoveryCheckpoint {
  return Object.freeze({ ...value, binding: Object.freeze({ ...value.binding }) });
}

function result(checkpoint: RecoveryCheckpoint, replayed: boolean): RecoveryCheckpointWriteResult {
  return Object.freeze({ checkpoint: cloneCheckpoint(checkpoint), replayed });
}

function identity(stats: Stats): Identity {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

async function canonicalDirectory(directory: string): Promise<Identity> {
  let current = path.parse(directory).root;
  try {
    const root = await lstat(current);
    if (!root.isDirectory() || root.isSymbolicLink()) throw failure("checkpoint_unsafe_path");
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw failure("checkpoint_unsafe_path");
    }
    if (await realpath(directory) !== directory) throw failure("checkpoint_unsafe_path");
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw failure("checkpoint_unsafe_path");
    return identity(stats);
  } catch (error: unknown) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errorCode(error) ?? "")) throw failure("checkpoint_unsafe_path");
    throw error;
  }
}

function sameBinding(a: RecoveryCheckpointBinding, b: RecoveryCheckpointBinding): boolean {
  return a.agentId === b.agentId && a.repositoryRoot === b.repositoryRoot && a.manifestPath === b.manifestPath;
}

function decodeCheckpoint(bytes: Uint8Array, binding: RecoveryCheckpointBinding): RecoveryCheckpoint {
  let checkpoint: RecoveryCheckpoint;
  try {
    const input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ["schemaVersion", "binding", "revision", "token", "lastOperationId", "lastOperationDigest"]);
    if (input.schemaVersion !== SCHEMA) throw failure("checkpoint_invalid_input");
    checkpoint = Object.freeze({
      schemaVersion: SCHEMA,
      binding: snapshotBinding(input.binding),
      revision: matching(input.revision, REVISION),
      token: matching(input.token, TOKEN),
      lastOperationId: matching(input.lastOperationId, OPERATION_ID),
      lastOperationDigest: matching(input.lastOperationDigest, DIGEST),
    });
  } catch {
    throw failure("checkpoint_corrupt");
  }
  if (!sameBinding(checkpoint.binding, binding)) throw failure("checkpoint_binding_mismatch");
  return checkpoint;
}

async function readStored(file: string, binding: RecoveryCheckpointBinding): Promise<StoredCheckpoint | null> {
  let before: Stats;
  try {
    before = await lstat(file);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw failure("checkpoint_unsafe_path");
  if (before.size < 1 || before.size > MAX_BYTES) throw failure("checkpoint_corrupt");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)) throw failure("checkpoint_unsafe_path");
    if (opened.size < 1 || opened.size > MAX_BYTES) throw failure("checkpoint_corrupt");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const leaf = await lstat(file);
    if (!after.isFile() || after.nlink !== 1 || leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1
      || !sameIdentity(opened, after) || !sameIdentity(opened, leaf)) throw failure("checkpoint_unsafe_path");
    if (length < 1 || length > MAX_BYTES || after.size !== length || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw failure("checkpoint_corrupt");
    const bytes = buffer.subarray(0, length);
    return Object.freeze({ checkpoint: decodeCheckpoint(bytes, binding), digest: bytesVersion(bytes), identity: identity(after) });
  } finally {
    await handle.close();
  }
}

function operation(kind: Operation["kind"], input: unknown, binding: RecoveryCheckpointBinding): Operation {
  const fields = kind === "initialize" ? ["revision", "operationId"] : ["expected", "nextRevision", "operationId"];
  const value = record(input, fields);
  const operationId = matching(value.operationId, OPERATION_ID);
  const expected = kind === "initialize" ? null : snapshotVersion(value.expected);
  const nextRevision = matching(kind === "initialize" ? value.revision : value.nextRevision, REVISION);
  const digest = bytesVersion(canonicalJson({
    schemaVersion: "stella.recovery-checkpoint-operation/v1", kind, binding, operationId, expected, nextRevision,
  }));
  return Object.freeze({ kind, operationId, expected, nextRevision, digest });
}

/** Local CAS only. A caller's existing journal owns uniqueness of historical operation IDs. */
export async function openRecoveryCheckpointStore(options: RecoveryCheckpointStoreOptions): Promise<RecoveryCheckpointStore> {
  // Capture all caller-owned values before the first await, including callback references.
  const input = record(options, ["stateDirectory", "binding", "withLock"], ["onWritePhase"]);
  const stateDirectory = absolutePath(input.stateDirectory);
  const binding = snapshotBinding(input.binding);
  if (typeof input.withLock !== "function" || (input.onWritePhase !== undefined && typeof input.onWritePhase !== "function")) {
    throw failure("checkpoint_invalid_input");
  }
  const withLock = input.withLock as RecoveryCheckpointLock;
  const observer = input.onWritePhase as RecoveryCheckpointStoreOptions["onWritePhase"];
  const relative = path.relative(binding.repositoryRoot, stateDirectory);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    throw failure("checkpoint_state_inside_repository");
  }
  const checkpointPath = path.join(stateDirectory, "checkpoint.json");
  return guarded(async () => {
    const repositoryIdentity = await canonicalDirectory(binding.repositoryRoot);
    const stateIdentity = await canonicalDirectory(stateDirectory);

    async function assertDirectories(): Promise<void> {
      if (!sameIdentity(repositoryIdentity, await canonicalDirectory(binding.repositoryRoot))
        || !sameIdentity(stateIdentity, await canonicalDirectory(stateDirectory))) throw failure("checkpoint_unsafe_path");
    }

    async function readCurrent(): Promise<StoredCheckpoint | null> {
      await assertDirectories();
      const stored = await readStored(checkpointPath, binding);
      await assertDirectories();
      return stored;
    }

    async function confirm(expected: StoredCheckpoint | null): Promise<void> {
      const actual = await readCurrent();
      if (expected === null ? actual !== null : actual === null || actual.digest !== expected.digest
        || !sameIdentity(actual.identity, expected.identity)) throw failure("checkpoint_conflict");
    }

    async function observe(phase: RecoveryCheckpointWritePhase): Promise<void> {
      try {
        if (observer) await observer(phase);
      } catch {
        throw failure("checkpoint_io_failed");
      }
    }

    async function syncDirectory(): Promise<void> {
      await assertDirectories();
      const handle = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isDirectory() || !sameIdentity(stats, stateIdentity)) throw failure("checkpoint_unsafe_path");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertDirectories();
    }

    async function acknowledge(stored: StoredCheckpoint, replayed: boolean): Promise<RecoveryCheckpointWriteResult> {
      await confirm(stored);
      await syncDirectory();
      if (!replayed) await observe("directory_synced");
      await confirm(stored);
      return result(stored.checkpoint, replayed);
    }

    async function removeOwnedTemporary(file: string, owned: Identity): Promise<void> {
      await assertDirectories();
      let stats: Stats;
      try {
        stats = await lstat(file);
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !sameIdentity(stats, owned)) {
        throw failure("checkpoint_unsafe_path");
      }
      await unlink(file);
    }

    async function write(current: StoredCheckpoint | null, op: Operation): Promise<RecoveryCheckpointWriteResult> {
      const checkpoint: RecoveryCheckpoint = Object.freeze({
        schemaVersion: SCHEMA, binding, revision: op.nextRevision, token: randomUUID(),
        lastOperationId: op.operationId, lastOperationDigest: op.digest,
      });
      const bytes = canonicalJson(checkpoint) + "\n";
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw failure("checkpoint_invalid_input");
      const temporary = path.join(stateDirectory, ".checkpoint-" + randomUUID() + ".tmp");
      let owned: Identity | undefined;
      let replaced = false;
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          owned = identity(await handle.stat());
          await handle.writeFile(bytes, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await observe("file_synced");
        await confirm(current);
        const staged = await readStored(temporary, binding);
        if (!owned || !staged || !sameIdentity(staged.identity, owned) || staged.digest !== bytesVersion(bytes)) {
          throw failure("checkpoint_unsafe_path");
        }
        await assertDirectories();
        await rename(temporary, checkpointPath);
        replaced = true;
        await observe("replaced");
        return await acknowledge(staged, false);
      } finally {
        if (owned && !replaced) {
          // Never unlink a replacement or traverse a directory whose identity changed.
          try {
            await removeOwnedTemporary(temporary, owned);
          } catch {
            // This is already a failed write; retain its error without touching a replacement.
          }
        }
      }
    }

    async function update(op: Operation): Promise<RecoveryCheckpointWriteResult> {
      const current = await readCurrent();
      if (current?.checkpoint.lastOperationId === op.operationId) {
        if (current.checkpoint.lastOperationDigest !== op.digest || current.checkpoint.revision !== op.nextRevision) {
          throw failure("checkpoint_operation_conflict");
        }
        // A replacement may already have succeeded when the prior acknowledgement failed.
        return acknowledge(current, true);
      }
      if (op.kind === "initialize") {
        if (current) throw failure("checkpoint_conflict");
      } else {
        if (!current) throw failure("checkpoint_missing");
        const expected = op.expected;
        if (!expected || current.checkpoint.revision !== expected.revision || current.checkpoint.token !== expected.token) {
          throw failure("checkpoint_conflict");
        }
      }
      return write(current, op);
    }

    return Object.freeze({
      path: checkpointPath,
      async read(): Promise<RecoveryCheckpoint> {
        return guarded(() => withLock(checkpointPath, async () => {
          const current = await readCurrent();
          if (!current) throw failure("checkpoint_missing");
          return cloneCheckpoint(current.checkpoint);
        }));
      },
      async initialize(value: { revision: string; operationId: string }): Promise<RecoveryCheckpointWriteResult> {
        const op = operation("initialize", value, binding);
        return guarded(() => withLock(checkpointPath, () => update(op)));
      },
      async compareAndSet(value: { expected: RecoveryCheckpointVersion; nextRevision: string; operationId: string }): Promise<RecoveryCheckpointWriteResult> {
        const op = operation("compare_and_set", value, binding);
        return guarded(() => withLock(checkpointPath, () => update(op)));
      },
    });
  });
}
