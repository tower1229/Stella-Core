import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { openLocalCheckpointRecovery } from "../src/canghai/local-checkpoint-recovery.js";
import { openCheckpointRecoveryRuntime } from "../src/canghai/checkpoint-recovery-runtime.js";
import { serializeMemoryTransactionJournal } from "../src/canghai/memory-transaction-journal.js";
import type { RecoveryCheckpointLock } from "../src/canghai/recovery-checkpoint-contract.js";

async function fixture(t: TestContext) {
  const parent = await realpath(await mkdtemp("/tmp/stella-local-checkpoint-")), root = path.join(parent, "repository"), stateDirectory = path.join(parent, "state"), hooks = path.join(parent, "hooks");
  const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(parent, { recursive: true, force: true }); });
  await mkdir(stateDirectory); await mkdir(hooks);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Synthetic Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Synthetic Test", GIT_COMMITTER_EMAIL: "test@example.invalid" });
  async function run(args: string[]) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${hooks}`, ...args],
        { cwd: parent, env, timeout: 10000 }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
      children.push(child);
    });
  }
  await run(["init", "--quiet", "-b", "synthetic", root]);
  const git = (...args: string[]) => run(["-C", root, ...args]);
  await writeFile(path.join(root, "manifest.json"), '{"synthetic":true}\n'); await writeFile(path.join(root, "memory.txt"), "A\n");
  await git("add", "--", "manifest.json", "memory.txt"); await git("commit", "--quiet", "-m", "Synthetic A");
  const revision = (await git("rev-parse", "HEAD")).trim(), binding = { agentId: "synthetic", repositoryRoot: root, manifestPath: "manifest.json" };
  return { root, stateDirectory, binding, revision, git, options: { stateDirectory, binding } };
}
function category(expected: string) { return (error: unknown): boolean => { assert.ok(error && typeof error === "object" && "category" in error); assert.equal(error.category, expected); return true; }; }
test("actual local lock adapter initializes, confirms original journal CAS and reopens without SDK locks", async t => {
  const f = await fixture(t), runtime = await openLocalCheckpointRecovery(f.options);
  await assert.rejects(runtime.read(), category("checkpoint_missing"));
  const initial = (await runtime.initialize({ revision: f.revision, operationId: "initialize-A" })).checkpoint;
  const plan = { operationId: "local-operation", journalPath: "operations/local.json", files: [{ path: "memory.txt", before: "A\n", after: "B\n" }],
    recoveryCheckpoint: { binding: f.binding, expected: { revision: initial.revision, token: initial.token } } };
  await mkdir(path.join(f.root, "operations")); await writeFile(path.join(f.root, "memory.txt"), "B\n");
  await writeFile(path.join(f.root, plan.journalPath), serializeMemoryTransactionJournal(plan));
  await f.git("add", "--", "memory.txt", plan.journalPath); await f.git("commit", "--quiet", "-m", "Synthetic B");
  const revisionB = (await f.git("rev-parse", "HEAD")).trim();
  const confirmed = await runtime.confirmCommitted({ revision: revisionB, journalPath: plan.journalPath });
  assert.notEqual(confirmed.checkpoint.token, initial.token);
  const reopened = await openLocalCheckpointRecovery(f.options); assert.equal((await reopened.read()).revision, revisionB);
  const replay = await reopened.confirmCommitted({ revision: revisionB, journalPath: plan.journalPath });
  assert.equal(replay.replayed, true); assert.equal(replay.checkpoint.token, confirmed.checkpoint.token);
  await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json.lock")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.stateDirectory, "checkpoint.json.lock")), { code: "ENOENT" });
});
test("a forged same-name lock is not clean-dirt authority and is never reclaimed", async t => {
  const f = await fixture(t), lock = path.join(f.root, ".stella-memory-transaction.json.lock"), bytes = '{"schemaVersion":"stella.exclusive-file-lock/v1","nonce":"forged"}\n';
  await writeFile(lock, bytes);
  const passthrough: RecoveryCheckpointLock = async (_key, work) => work();
  const runtime = await openCheckpointRecoveryRuntime({ ...f.options, withRepositoryLock: passthrough, withCheckpointLock: passthrough });
  await assert.rejects(runtime.initialize({ revision: f.revision, operationId: "initialize-forged" }), category("checkpoint_runtime_dirty"));
  await assert.rejects(openLocalCheckpointRecovery(f.options));
  assert.equal(await readFile(lock, "utf8"), bytes);
});
test("corrupt checkpoint and unresolved pending do not fall back or initialize", async t => {
  const f = await fixture(t), runtime = await openLocalCheckpointRecovery(f.options);
  const marker = path.join(f.root, ".stella-memory-transaction.json");
  await writeFile(marker, "legacy pending");
  await assert.rejects(runtime.initialize({ revision: f.revision, operationId: "initialize-pending" }), category("checkpoint_runtime_pending"));
  assert.equal(await readFile(marker, "utf8"), "legacy pending"); await rm(marker);
  await runtime.initialize({ revision: f.revision, operationId: "initialize-valid" });
  await writeFile(path.join(f.stateDirectory, "checkpoint.json"), "corrupt");
  await assert.rejects(runtime.read(), category("checkpoint_corrupt"));
  assert.equal(await readFile(path.join(f.stateDirectory, "checkpoint.json"), "utf8"), "corrupt");
});
