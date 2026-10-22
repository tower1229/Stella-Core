import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";
import { RecoveryAuthorityError, type CheckpointRecoveryRuntime, type CheckpointRecoveryRuntimeOptions, type RecoveryAuthoritySnapshot } from "./recovery-authority-contract.js";
import { RecoveryCheckpointError, type RecoveryCheckpointBinding, type RecoveryCheckpointLock, type RecoveryCheckpointWriteResult } from "./recovery-checkpoint-contract.js";
import { openRecoveryCheckpointStore } from "./recovery-checkpoint-store.js";
import { parseMemoryTransactionJournal } from "./memory-transaction-journal.js";
import type { MemoryFileChange, MemoryTransactionPlan } from "./memory-transaction-plan.js";

const execFileAsync = promisify(execFile);
const MARKER = ".stella-memory-transaction.json";
const REVISION = /^[a-f0-9]{40}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_JOURNAL = 16 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_METADATA = 16 * 1024 * 1024;
const ERROR_CATEGORIES = new Set([
  "checkpoint_runtime_lock_unavailable", "checkpoint_runtime_invalid_input", "checkpoint_runtime_unsafe_path",
  "checkpoint_runtime_binding_mismatch", "checkpoint_runtime_stale", "checkpoint_runtime_git_mismatch",
  "checkpoint_runtime_dirty", "checkpoint_runtime_pending", "checkpoint_runtime_journal_invalid", "checkpoint_runtime_io_failed",
]);
const STORE_CATEGORIES = new Set([
  "checkpoint_missing", "checkpoint_corrupt", "checkpoint_binding_mismatch", "checkpoint_conflict",
  "checkpoint_operation_conflict", "checkpoint_unsafe_path", "checkpoint_state_inside_repository",
  "checkpoint_invalid_input", "checkpoint_io_failed",
]);
function fail(category: string): never { throw new RecoveryAuthorityError(category); }
function check(value: unknown, category: string): asserts value { if (!value) fail(category); }
/** Public errors retain neither caller values, filesystem paths nor raw Git stderr/causes. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error: unknown) {
    if (error instanceof RecoveryCheckpointError && STORE_CATEGORIES.has(error.category)) throw new RecoveryCheckpointError(error.category);
    fail(error instanceof RecoveryAuthorityError && ERROR_CATEGORIES.has(error.category) ? error.category : "checkpoint_runtime_io_failed");
  }
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "checkpoint_runtime_invalid_input");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === "string" && (required.includes(key) || optional.includes(key)), "checkpoint_runtime_invalid_input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && "value" in descriptor && descriptor.enumerable, "checkpoint_runtime_invalid_input");
    result[key] = descriptor.value;
  }
  check(required.every(key => Object.hasOwn(result, key)), "checkpoint_runtime_invalid_input");
  return result;
}
function matching(value: unknown, pattern: RegExp): string {
  check(typeof value === "string" && pattern.test(value), "checkpoint_runtime_invalid_input");
  return value;
}
function pathString(value: unknown): string {
  check(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[\\:\x00-\x1f\x7f]/.test(value), "checkpoint_runtime_unsafe_path");
  return value;
}
function relativePath(value: unknown): string {
  const file = pathString(value);
  check(!path.isAbsolute(file) && file.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !/[. ]$/.test(part)), "checkpoint_runtime_unsafe_path");
  return file;
}
function absolutePath(value: unknown): string {
  const directory = pathString(value);
  check(path.isAbsolute(directory) && path.resolve(directory) === directory, "checkpoint_runtime_unsafe_path");
  return directory;
}
function snapshotBinding(value: unknown): RecoveryCheckpointBinding {
  const input = record(value, ["agentId", "repositoryRoot", "manifestPath"]);
  return Object.freeze({ agentId: matching(input.agentId, AGENT), repositoryRoot: absolutePath(input.repositoryRoot), manifestPath: relativePath(input.manifestPath) });
}
function sameBinding(left: RecoveryCheckpointBinding, right: RecoveryCheckpointBinding): boolean {
  return left.agentId === right.agentId && left.repositoryRoot === right.repositoryRoot && left.manifestPath === right.manifestPath;
}
function authoritySnapshot(value: unknown): RecoveryAuthoritySnapshot {
  const input = record(value, ["mode", "binding", "revision", "token"]);
  check(input.mode === "core_checkpoint" || input.mode === "legacy_config", "checkpoint_runtime_invalid_input");
  return Object.freeze({ mode: input.mode, binding: snapshotBinding(input.binding), revision: matching(input.revision, REVISION), token: matching(input.token, TOKEN) });
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("checkpoint_runtime_journal_invalid"); }
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function fileBytes(file: MemoryFileChange, content: string): Buffer {
  if (file.encoding !== "base64") return Buffer.from(content, "utf8");
  const bytes = Buffer.from(content, "base64");
  check(bytes.toString("base64") === content, "checkpoint_runtime_journal_invalid");
  return bytes;
}
function planPaths(plan: MemoryTransactionPlan, journalPath: string): ReadonlyMap<string, { before: Buffer | null; after: Buffer }> {
  check(plan.journalPath === journalPath && plan.files.length > 0 && plan.files.length <= 64, "checkpoint_runtime_journal_invalid");
  const paths = new Map<string, { before: Buffer | null; after: Buffer }>();
  const folds = new Set([journalPath.normalize("NFC").toLowerCase()]);
  for (const file of plan.files) {
    const name = relativePath(file.path), folded = name.normalize("NFC").toLowerCase();
    check(name.toLowerCase() !== MARKER && name.toLowerCase() !== MARKER + ".lock" && !folds.has(folded), "checkpoint_runtime_journal_invalid");
    folds.add(folded);
    const before = file.before === null ? null : fileBytes(file, file.before), after = fileBytes(file, file.after);
    check((before === null || before.length <= MAX_FILE) && after.length <= MAX_FILE, "checkpoint_runtime_journal_invalid");
    paths.set(name, { before, after });
  }
  for (const name of folds) {
    const parts = name.split("/");
    for (let count = 1; count < parts.length; count++) check(!folds.has(parts.slice(0, count).join("/")), "checkpoint_runtime_journal_invalid");
  }
  return paths;
}
function journalLocation(value: unknown): string {
  const file = relativePath(value);
  check(file.toLowerCase() !== MARKER && file.toLowerCase() !== MARKER + ".lock", "checkpoint_runtime_unsafe_path");
  return file;
}
/** Local authority only: confirmation does not publish a view, synchronize or attest consumption. */
export async function openCheckpointRecoveryRuntime(options: CheckpointRecoveryRuntimeOptions): Promise<CheckpointRecoveryRuntime> {
  const input = record(options, [], ["stateDirectory", "binding", "withCheckpointLock", "withRepositoryLock"]);
  check(typeof input.withCheckpointLock === "function" && typeof input.withRepositoryLock === "function", "checkpoint_runtime_lock_unavailable");
  const stateDirectory = absolutePath(input.stateDirectory), binding = snapshotBinding(input.binding);
  const withCheckpointLock = input.withCheckpointLock as RecoveryCheckpointLock;
  const withRepositoryLock = input.withRepositoryLock as RecoveryCheckpointLock;
  const root = binding.repositoryRoot;
  const gitEnvironment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  Object.assign(gitEnvironment, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  return guarded(async () => {
    const store = await withRepositoryLock(root, () => openRecoveryCheckpointStore({ stateDirectory, binding, withLock: withCheckpointLock }));
    async function git(args: string[], maxBuffer = MAX_METADATA): Promise<Buffer> {
      try {
        const { stdout } = await execFileAsync("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root, ...args], { cwd: root, env: gitEnvironment, encoding: "buffer", maxBuffer });
        return stdout;
      } catch { return fail("checkpoint_runtime_git_mismatch"); }
    }
    async function assertRepository(): Promise<void> {
      const stats = await lstat(root);
      check(stats.isDirectory() && !stats.isSymbolicLink() && await realpath(root) === root, "checkpoint_runtime_unsafe_path");
      const metadata = await lstat(path.join(root, ".git"));
      check(!metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile() && metadata.nlink === 1), "checkpoint_runtime_unsafe_path");
      check(utf8(await git(["rev-parse", "--show-toplevel"])).trimEnd() === root, "checkpoint_runtime_git_mismatch");
    }
    async function head(): Promise<string> {
      const revision = utf8(await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      check(REVISION.test(revision), "checkpoint_runtime_git_mismatch");
      return revision;
    }
    async function parents(revision: string): Promise<string[]> {
      const commit = utf8(await git(["cat-file", "commit", revision])), boundary = commit.indexOf("\n\n");
      check(boundary >= 0, "checkpoint_runtime_git_mismatch");
      const header = commit.slice(0, boundary).split("\n");
      check(/^tree [a-f0-9]{40}$/.test(header[0] ?? ""), "checkpoint_runtime_git_mismatch");
      const result = header.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
      check(result.every(value => REVISION.test(value)), "checkpoint_runtime_git_mismatch");
      return result;
    }
    async function blob(revision: string, file: string, limit = MAX_FILE): Promise<Buffer | null> {
      const listing = utf8(await git(["ls-tree", "-z", revision, "--", ":(literal)" + file]));
      if (!listing) return null;
      const entries = listing.split("\0");
      check(entries.length === 2 && entries[1] === "", "checkpoint_runtime_git_mismatch");
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entries[0]!);
      check(match && match[3] === file, "checkpoint_runtime_unsafe_path");
      return git(["cat-file", "blob", match[2]!], limit);
    }
    async function workingFile(file: string, limit: number, allowMissing = false): Promise<Buffer | null> {
      const parts = file.split("/");
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        let stats: Stats;
        try { stats = await lstat(parent); }
        catch (error: unknown) { if (allowMissing && errorCode(error) === "ENOENT") return null; throw error; }
        check(stats.isDirectory() && !stats.isSymbolicLink(), "checkpoint_runtime_unsafe_path");
      }
      const location = path.join(parent, parts.at(-1)!);
      let before: Stats;
      try { before = await lstat(location); }
      catch (error: unknown) { if (allowMissing && errorCode(error) === "ENOENT") return null; throw error; }
      check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit, "checkpoint_runtime_unsafe_path");
      const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        check(opened.isFile() && opened.nlink === 1 && sameFile(before, opened) && opened.size <= limit, "checkpoint_runtime_unsafe_path");
        const bytes = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await handle.stat(), leaf = await lstat(location);
        check(after.isFile() && after.nlink === 1 && leaf.isFile() && !leaf.isSymbolicLink() && leaf.nlink === 1 && sameFile(opened, after) && sameFile(opened, leaf) && length === opened.size && length === after.size && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs, "checkpoint_runtime_unsafe_path");
        return bytes.subarray(0, length);
      } finally { await handle.close(); }
    }
    async function markerPresent(): Promise<boolean> {
      try { await lstat(path.join(root, MARKER)); return true; }
      catch (error: unknown) { if (errorCode(error) === "ENOENT") return false; throw error; }
    }
    async function clean(journal?: Buffer): Promise<void> {
      const index = utf8(await git(["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
      check(index.every(entry => entry.startsWith("H ")), "checkpoint_runtime_dirty");
      const status = utf8(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none", "--no-renames"]));
      const entries = status.split("\0").filter(Boolean);
      check(entries.every(entry => entry === "?? " + MARKER), "checkpoint_runtime_dirty");
      const marker = await workingFile(MARKER, MAX_JOURNAL, true);
      if (journal === undefined) check(marker === null && entries.length === 0, "checkpoint_runtime_pending");
      else check(marker === null ? entries.length === 0 : entries.length === 1 && marker.equals(journal), "checkpoint_runtime_pending");
    }
    async function confirmCommitted(revision: string, journalPath: string): Promise<RecoveryCheckpointWriteResult> {
      await assertRepository();
      check(await head() === revision, "checkpoint_runtime_git_mismatch");
      const journal = await blob(revision, journalPath, MAX_JOURNAL);
      check(journal !== null, "checkpoint_runtime_journal_invalid");
      let plan: MemoryTransactionPlan;
      try { plan = parseMemoryTransactionJournal(utf8(journal)); } catch { return fail("checkpoint_runtime_journal_invalid"); }
      const recovery = plan.recoveryCheckpoint;
      check(recovery !== undefined, "checkpoint_runtime_journal_invalid");
      check(sameBinding(recovery.binding, binding), "checkpoint_runtime_binding_mismatch");
      const changes = planPaths(plan, journalPath), ancestry = await parents(revision);
      check(ancestry.length === 1 && ancestry[0] === recovery.expected.revision, "checkpoint_runtime_git_mismatch");
      check(await blob(recovery.expected.revision, journalPath, MAX_JOURNAL) === null, "checkpoint_runtime_journal_invalid");
      check(await blob(revision, MARKER, MAX_JOURNAL) === null, "checkpoint_runtime_journal_invalid");
      const changed = utf8(await git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-r", "-z", recovery.expected.revision, revision, "--"])).split("\0").filter(Boolean);
      const expectedPaths = new Set([...changes.keys(), journalPath]);
      check(changed.length === expectedPaths.size && new Set(changed).size === changed.length && changed.every(file => expectedPaths.has(file)), "checkpoint_runtime_git_mismatch");
      for (const [file, bytes] of changes) {
        const before = await blob(recovery.expected.revision, file), after = await blob(revision, file);
        check(bytes.before === null ? before === null : before !== null && before.equals(bytes.before), "checkpoint_runtime_git_mismatch");
        check(after !== null && after.equals(bytes.after), "checkpoint_runtime_git_mismatch");
        const working = await workingFile(file, MAX_FILE);
        check(working !== null && working.equals(bytes.after), "checkpoint_runtime_dirty");
      }
      const currentJournal = await workingFile(journalPath, MAX_JOURNAL);
      check(currentJournal !== null && currentJournal.equals(journal), "checkpoint_runtime_journal_invalid");
      await clean(journal);
      check(await head() === revision, "checkpoint_runtime_git_mismatch");
      return store.compareAndSet({ expected: { ...recovery.expected }, nextRevision: revision, operationId: plan.operationId });
    }
    const runtime: CheckpointRecoveryRuntime = {
      mode: "core_checkpoint",
      async read(): Promise<RecoveryAuthoritySnapshot> {
        return guarded(() => withRepositoryLock(root, async () => {
          const checkpoint = await store.read();
          return Object.freeze({ mode: "core_checkpoint", binding: Object.freeze({ ...checkpoint.binding }), revision: checkpoint.revision, token: checkpoint.token });
        }));
      },
      async assertCurrent(value: RecoveryAuthoritySnapshot): Promise<void> {
        const expected = authoritySnapshot(value);
        return guarded(() => withRepositoryLock(root, async () => {
          check(expected.mode === "core_checkpoint", "checkpoint_runtime_stale");
          check(sameBinding(expected.binding, binding), "checkpoint_runtime_binding_mismatch");
          const current = await store.read();
          check(current.revision === expected.revision && current.token === expected.token, "checkpoint_runtime_stale");
        }));
      },
      async initialize(value: { revision: string; operationId: string }): Promise<RecoveryCheckpointWriteResult> {
        const selected = record(value, ["revision", "operationId"]), revision = matching(selected.revision, REVISION), operationId = matching(selected.operationId, OPERATION);
        return guarded(() => withRepositoryLock(root, async () => {
          await assertRepository();
          check(!await markerPresent(), "checkpoint_runtime_pending");
          check(await head() === revision, "checkpoint_runtime_git_mismatch");
          await parents(revision);
          const manifest = await blob(revision, binding.manifestPath), working = await workingFile(binding.manifestPath, MAX_FILE);
          check(manifest !== null && working !== null && manifest.equals(working), "checkpoint_runtime_git_mismatch");
          await clean();
          check(await head() === revision, "checkpoint_runtime_git_mismatch");
          return store.initialize({ revision, operationId });
        }));
      },
      async confirmCommitted(value: { revision: string; journalPath: string }): Promise<RecoveryCheckpointWriteResult> {
        const selected = record(value, ["revision", "journalPath"]), revision = matching(selected.revision, REVISION), journalPath = journalLocation(selected.journalPath);
        return guarded(() => withRepositoryLock(root, () => confirmCommitted(revision, journalPath)));
      },
      durability(value: string): Readonly<{ confirmRevision(revision: string): Promise<void> }> {
        const journalPath = journalLocation(value);
        return Object.freeze({ async confirmRevision(revision: string): Promise<void> {
          const selected = matching(revision, REVISION);
          await guarded(() => withRepositoryLock(root, () => confirmCommitted(selected, journalPath)));
        } });
      },
    };
    return Object.freeze(runtime);
  });
}
