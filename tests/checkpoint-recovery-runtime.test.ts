import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { openCheckpointRecoveryRuntime } from "../src/canghai/checkpoint-recovery-runtime.js";
import { GitCangHaiDurability, type CangHaiDurabilityStage } from "../src/canghai/durability.js";
import { serializeMemoryTransactionJournal } from "../src/canghai/memory-transaction-journal.js";
import type { MemoryTransactionPlan } from "../src/canghai/memory-transaction-plan.js";
import { RecoveryBoundLoader } from "../src/canghai/recovery-bound-loader.js";
import { RecoveryAuthorityError, type CheckpointRecoveryRuntimeOptions } from "../src/canghai/recovery-authority-contract.js";
import { RecoveryCheckpointError, type RecoveryCheckpoint, type RecoveryCheckpointLock, type RecoveryCheckpointVersion } from "../src/canghai/recovery-checkpoint-contract.js";
import { openRecoveryCheckpointStore } from "../src/canghai/recovery-checkpoint-store.js";

const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_AUTHOR_NAME: "Synthetic Checkpoint Test",
  GIT_AUTHOR_EMAIL: "checkpoint@example.invalid", GIT_COMMITTER_NAME: "Synthetic Checkpoint Test",
  GIT_COMMITTER_EMAIL: "checkpoint@example.invalid", GIT_AUTHOR_DATE: "2026-10-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-22T00:00:00Z",
};
const previous = new Map<string, string | undefined>();
before(() => { for (const [key, value] of Object.entries(gitEnvironment)) { previous.set(key, process.env[key]); process.env[key] = value; } });
after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const memoryA = "Synthetic memory A\n", memoryB = "Synthetic memory B\n", fixedNow = Date.parse("2026-10-22T00:00:00Z");
/** Fixture-only serializer; no production or cross-process lock proof. */
function serializer(): RecoveryCheckpointLock {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), tail = previous.then(() => held);
    tails.set(key, tail); await previous;
    try { return await work(); } finally { release(); if (tails.get(key) === tail) tails.delete(key); }
  };
}
function failure(...categories: string[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RecoveryAuthorityError || error instanceof RecoveryCheckpointError);
    assert.ok(categories.includes(error.category), `Unexpected refusal category: ${error.category}`);
    return true;
  };
}
function version(value: RecoveryCheckpointVersion): RecoveryCheckpointVersion { return { revision: value.revision, token: value.token }; }
async function fixture(t: TestContext) {
  const parent = await realpath(await mkdtemp("/tmp/stella-checkpoint-runtime-"));
  assert.ok(!/\/(Documents|Desktop)\//.test(parent) && !parent.includes("/Library/Mobile Documents/"));
  const root = path.join(parent, "repository"), stateDirectory = path.join(parent, "authority");
  const remote = path.join(parent, "localRemote.git"), hooks = path.join(parent, "empty-hooks");
  const children: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
  t.after(async () => {
    for (const { child, exited } of children) { if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
    await rm(parent, { recursive: true, force: true });
  });
  await mkdir(stateDirectory, { mode: 0o700 }); await mkdir(hooks, { mode: 0o700 });
  async function execute(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${hooks}`, ...args],
        { cwd: parent, timeout: 10_000, maxBuffer: 256_000 }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
      const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
      children.push({ child, exited });
    });
  }
  await execute(["init", "--quiet", "-b", "checkpoint-main", root]);
  const git = (...args: string[]) => execute(["-C", root, ...args]);
  await git("config", "user.name", gitEnvironment.GIT_AUTHOR_NAME); await git("config", "user.email", gitEnvironment.GIT_AUTHOR_EMAIL);
  await git("config", "core.hooksPath", hooks); await git("config", "commit.gpgsign", "false"); await git("config", "core.fsmonitor", "false");
  await writeFile(path.join(root, "manifest.json"), '{"synthetic":true}\n'); await writeFile(path.join(root, "memory.txt"), memoryA);
  await git("add", "--", "manifest.json", "memory.txt"); await git("commit", "--quiet", "-m", "Synthetic explicit baseline A");
  const revisionA = (await git("rev-parse", "HEAD")).trim();
  const binding = { agentId: "synthetic-agent", repositoryRoot: await realpath(root), manifestPath: "manifest.json" };
  const checkpointPath = path.join(stateDirectory, "checkpoint.json"), repositoryQueue = serializer(), checkpointQueue = serializer();
  const repositoryOwner = new AsyncLocalStorage<boolean>();
  const withRepositoryLock: RecoveryCheckpointLock = (key, work) => {
    assert.equal(key, binding.repositoryRoot);
    return repositoryOwner.getStore() ? work() : repositoryQueue(key, () => repositoryOwner.run(true, work));
  };
  const withCheckpointLock: RecoveryCheckpointLock = (key, work) => {
    assert.equal(repositoryOwner.getStore(), true, "Repository admission must precede checkpoint admission");
    assert.equal(key, checkpointPath); return checkpointQueue(key, work);
  };
  return { parent, root, stateDirectory, remote, git, binding, checkpointPath, revisionA, withRepositoryLock, withCheckpointLock,
    open: (overrides: Partial<CheckpointRecoveryRuntimeOptions> = {}) => openCheckpointRecoveryRuntime({ stateDirectory, binding, withRepositoryLock, withCheckpointLock, ...overrides }),
    async cloneBaselineRemote() { await execute(["clone", "--bare", "--quiet", root, remote]); await git("remote", "add", "origin", remote); },
    remoteHead: () => execute(["--git-dir", remote, "rev-parse", "refs/heads/checkpoint-main"]).then(value => value.trim()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function stageOperation(f: Fixture, expected: RecoveryCheckpointVersion, options: { operationId?: string; journalPath?: string; after?: string; binding?: CheckpointRecoveryRuntimeOptions["binding"]; legacy?: boolean } = {}) {
  const operationId = options.operationId ?? "operation-O", journalPath = options.journalPath ?? `operations/${operationId}.json`;
  const plan: MemoryTransactionPlan = { operationId, journalPath,
    files: [{ path: "memory.txt", before: await readFile(path.join(f.root, "memory.txt"), "utf8"), after: options.after ?? memoryB }],
    ...(!options.legacy ? { recoveryCheckpoint: { binding: options.binding ?? f.binding, expected: version(expected) } } : {}) };
  const bytes = serializeMemoryTransactionJournal(plan);
  await mkdir(path.dirname(path.join(f.root, journalPath)), { recursive: true });
  await writeFile(path.join(f.root, "memory.txt"), plan.files[0]!.after); await writeFile(path.join(f.root, journalPath), bytes);
  return { plan, bytes, paths: ["memory.txt", journalPath] };
}
async function commitOperation(f: Fixture, operation: Awaited<ReturnType<typeof stageOperation>>, message = "[stella:normal] synthetic operation") {
  await f.git("add", "--", ...operation.paths); await f.git("commit", "--quiet", "-m", message, "--", ...operation.paths);
  return (await f.git("rev-parse", "HEAD")).trim();
}
function durabilityOptions(f: Fixture) {
  return { root: f.root, remote: "origin", branch: "checkpoint-main", criticalWritePolicy: "sync_immediately" as const,
    normalWritePolicy: "bounded_batch" as const, maxNormalRpoSeconds: 300, now: () => fixedNow, schedule() {} };
}
function forbidSynchronization(stage: CangHaiDurabilityStage) { assert.notEqual(stage, "synchronize", "This batch forbids any git push, including fixture remotes"); }

test("missing adapters fail before nonexistent paths are inspected", async t => {
  const parent = await realpath(await mkdtemp("/tmp/stella-checkpoint-no-lock-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const options = { stateDirectory: path.join(parent, "missing-state"), binding: { agentId: "synthetic-agent", repositoryRoot: path.join(parent, "missing-repository"), manifestPath: "manifest.json" } };
  const neverRun: RecoveryCheckpointLock = async () => { assert.fail("No adapter may run before both exist"); };
  for (const adapters of [{}, { withCheckpointLock: neverRun }, { withRepositoryLock: neverRun }])
    await assert.rejects(openCheckpointRecoveryRuntime({ ...options, ...adapters }), failure("checkpoint_runtime_lock_unavailable"));
  await assert.rejects(readFile(path.join(options.stateDirectory, "checkpoint.json")), { code: "ENOENT" });
});

test("read never adopts HEAD; explicit initialization rejects dirty or missing manifest", async t => {
  const f = await fixture(t), runtime = await f.open();
  await assert.rejects(runtime.read(), failure("checkpoint_missing"));
  await writeFile(path.join(f.root, "memory.txt"), "Synthetic owner edit\n");
  await assert.rejects(runtime.initialize({ revision: f.revisionA, operationId: "initialize-dirty" }), failure("checkpoint_runtime_dirty"));
  await writeFile(path.join(f.root, "memory.txt"), memoryA);
  const missing = await f.open({ binding: { ...f.binding, manifestPath: "missing-manifest.json" } });
  await assert.rejects(missing.initialize({ revision: f.revisionA, operationId: "initialize-missing" }), failure("checkpoint_runtime_git_mismatch", "checkpoint_runtime_io_failed"));
  const initialized = await runtime.initialize({ revision: f.revisionA, operationId: "initialize-A" });
  const snapshot = await runtime.read();
  assert.equal(snapshot.mode, "core_checkpoint"); assert.deepEqual(version(snapshot), version(initialized.checkpoint));
  assert.deepEqual(snapshot.binding, f.binding); await runtime.assertCurrent(snapshot);
});

test("real Git durability commits O to B and reopened loader reads B without changing synthetic Host config A", async t => {
  const f = await fixture(t), runtime = await f.open();
  const initial = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-mainline" })).checkpoint;
  await f.cloneBaselineRemote();
  const syntheticHostConfig = Object.freeze({ recoveryRevision: f.revisionA }), operation = await stageOperation(f, initial);
  const port = runtime.durability(operation.plan.journalPath); let confirmations = 0;
  const stages: CangHaiDurabilityStage[] = [];
  const durability = new GitCangHaiDurability({ ...durabilityOptions(f), checkpointRecovery: { async confirmRevision(revision) { confirmations++; await port.confirmRevision(revision); } },
    onStage(stage) { stages.push(stage); forbidSynchronization(stage); } });
  const status = await durability.recordNormal(operation.paths, "synthetic operation O"), revisionB = (await f.git("rev-parse", "HEAD")).trim();
  assert.notEqual(revisionB, f.revisionA); assert.equal((await f.git("rev-parse", "HEAD^")).trim(), f.revisionA);
  assert.equal(status.localRevision, revisionB); assert.equal(status.normalState, "pending"); assert.equal(await f.remoteHead(), f.revisionA);
  const atB = await runtime.read(); assert.equal(atB.revision, revisionB); assert.notEqual(atB.token, initial.token); assert.equal(confirmations, 1);
  await durability.recordNormal(operation.paths, "exact operation O retry");
  assert.equal(confirmations, 2); assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2"); assert.deepEqual(await runtime.read(), atB);
  assert.ok(stages.includes("recovery_pointer_cas"));
  const reopened = await f.open(), loader = new RecoveryBoundLoader({ authority: reopened,
    load: async snapshot => ({ revision: snapshot.revision, memory: await f.git("show", `${snapshot.revision}:memory.txt`) }) });
  assert.deepEqual(await loader.load(), { revision: revisionB, memory: memoryB });
  await assert.rejects(reopened.assertCurrent({ mode: "core_checkpoint", binding: f.binding, ...version(initial) }), failure("checkpoint_runtime_stale"));
  assert.equal(syntheticHostConfig.recoveryRevision, f.revisionA);
});

test("Git commit before failed CAS retries original O without another commit", async t => {
  const f = await fixture(t); let refuseAdmission = false;
  const withCheckpointLock: RecoveryCheckpointLock = (key, work) => f.withCheckpointLock(key, async () => {
    if (refuseAdmission) { refuseAdmission = false; throw new Error("Synthetic pre-CAS failure"); } return work(); });
  const runtime = await f.open({ withCheckpointLock }), initial = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-pre-CAS" })).checkpoint;
  await f.cloneBaselineRemote(); const operation = await stageOperation(f, initial); let failOnce = true;
  const durability = new GitCangHaiDurability({ ...durabilityOptions(f), checkpointRecovery: runtime.durability(operation.plan.journalPath),
    onStage(stage) { forbidSynchronization(stage); if (stage === "recovery_pointer_cas" && failOnce) { failOnce = false; refuseAdmission = true; } } });
  await assert.rejects(durability.recordNormal(operation.paths, "synthetic O"));
  const committedB = (await f.git("rev-parse", "HEAD")).trim(); assert.notEqual(committedB, f.revisionA); assert.deepEqual(version(await runtime.read()), version(initial));
  await durability.recordNormal(operation.paths, "exact O retry");
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), committedB); assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
  assert.equal((await runtime.read()).revision, committedB); assert.equal(await f.remoteHead(), f.revisionA);
});

test("accepted but unacknowledged CAS reopens and replays with unchanged token", async t => {
  const f = await fixture(t); let failAfterRevision: string | undefined;
  const withCheckpointLock: RecoveryCheckpointLock = (key, work) => f.withCheckpointLock(key, async () => {
    const result = await work();
    if (failAfterRevision !== undefined) { const persisted = JSON.parse(await readFile(f.checkpointPath, "utf8")) as RecoveryCheckpoint;
      if (persisted.revision === failAfterRevision) { failAfterRevision = undefined; throw new Error("Synthetic lost acknowledgement"); } }
    return result;
  });
  const runtime = await f.open({ withCheckpointLock }), initial = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-unacknowledged" })).checkpoint;
  const operation = await stageOperation(f, initial), revisionB = await commitOperation(f, operation); failAfterRevision = revisionB;
  await assert.rejects(runtime.confirmCommitted({ revision: revisionB, journalPath: operation.plan.journalPath }), failure("checkpoint_io_failed", "checkpoint_runtime_io_failed"));
  const persisted = JSON.parse(await readFile(f.checkpointPath, "utf8")) as RecoveryCheckpoint;
  assert.equal(persisted.revision, revisionB); assert.notEqual(persisted.token, initial.token);
  const reopened = await f.open(), replay = await reopened.confirmCommitted({ revision: revisionB, journalPath: operation.plan.journalPath });
  assert.equal(replay.replayed, true); assert.equal(replay.checkpoint.token, persisted.token); assert.deepEqual(version(await reopened.read()), version(persisted));
  assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
});

test("legacy journal, wrong binding, dirty journal and unrelated HEAD cannot advance authority", async t => {
  for (const scenario of ["legacy-v1", "wrong-binding", "modified-journal", "unrelated-HEAD"] as const) await t.test(scenario, async subtest => {
    const f = await fixture(subtest), runtime = await f.open(), initial = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-negative" })).checkpoint;
    const operation = await stageOperation(f, initial, { ...(scenario === "legacy-v1" ? { legacy: true } : {}), ...(scenario === "wrong-binding" ? { binding: { ...f.binding, agentId: "wrong-agent" } } : {}) });
    const revisionB = await commitOperation(f, operation);
    if (scenario === "modified-journal") await writeFile(path.join(f.root, operation.plan.journalPath), `${operation.bytes}\n`);
    if (scenario === "unrelated-HEAD") { await writeFile(path.join(f.root, "owner.txt"), "Synthetic unrelated owner commit\n"); await f.git("add", "--", "owner.txt"); await f.git("commit", "--quiet", "-m", "Synthetic unrelated owner commit"); }
    const categories = scenario === "wrong-binding" ? ["checkpoint_runtime_binding_mismatch"] : scenario === "unrelated-HEAD" ? ["checkpoint_runtime_git_mismatch"] : scenario === "modified-journal" ? ["checkpoint_runtime_dirty", "checkpoint_runtime_journal_invalid"] : ["checkpoint_runtime_journal_invalid"];
    await assert.rejects(runtime.confirmCommitted({ revision: revisionB, journalPath: operation.plan.journalPath }), failure(...categories));
    assert.deepEqual(JSON.parse(await readFile(f.checkpointPath, "utf8")), initial);
  });
});

test("same operation ID with changed input cannot replay", async t => {
  const f = await fixture(t), runtime = await f.open(), initial = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-op-reuse" })).checkpoint;
  const first = await stageOperation(f, initial), revisionB = await commitOperation(f, first);
  const accepted = await runtime.confirmCommitted({ revision: revisionB, journalPath: first.plan.journalPath });
  const second = await stageOperation(f, accepted.checkpoint, { operationId: first.plan.operationId, journalPath: "operations/reused-O.json", after: "Synthetic changed operation\n" });
  const revisionC = await commitOperation(f, second);
  await assert.rejects(runtime.confirmCommitted({ revision: revisionC, journalPath: second.plan.journalPath }), failure("checkpoint_operation_conflict"));
  assert.deepEqual(JSON.parse(await readFile(f.checkpointPath, "utf8")), accepted.checkpoint);
});

test("stale original journal token is never filled from the observed checkpoint", async t => {
  const f = await fixture(t), runtime = await f.open(), original = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-stale" })).checkpoint;
  const store = await openRecoveryCheckpointStore({ stateDirectory: f.stateDirectory, binding: f.binding, withLock: f.withCheckpointLock });
  const rotated = await f.withRepositoryLock(f.root, () => store.compareAndSet({ expected: version(original), nextRevision: f.revisionA, operationId: "concurrent-token-change" }));
  assert.notEqual(rotated.checkpoint.token, original.token);
  const operation = await stageOperation(f, original), revisionB = await commitOperation(f, operation);
  await assert.rejects(runtime.confirmCommitted({ revision: revisionB, journalPath: operation.plan.journalPath }), failure("checkpoint_conflict"));
  assert.deepEqual(JSON.parse(await readFile(f.checkpointPath, "utf8")), rotated.checkpoint);
});

test("unresolved legacy pending intent prevents initialization and is never drained by read", async t => {
  const f = await fixture(t), runtime = await f.open(), marker = path.join(f.root, ".stella-memory-transaction.json"), bytes = '{"synthetic":"legacy pending"}\n';
  await writeFile(marker, bytes);
  await assert.rejects(runtime.initialize({ revision: f.revisionA, operationId: "initialize-over-pending" }), failure("checkpoint_runtime_pending"));
  await assert.rejects(readFile(f.checkpointPath), { code: "ENOENT" }); assert.equal(await readFile(marker, "utf8"), bytes);
  await rm(marker); await runtime.initialize({ revision: f.revisionA, operationId: "initialize-before-pending" });
  await writeFile(marker, bytes); const checkpoint = await runtime.read();
  assert.equal(checkpoint.revision, f.revisionA); assert.equal(await readFile(marker, "utf8"), bytes);
});

test("checkpoint diagnostics of unsynchronized critical history do not confirm or synchronize", async t => {
  const f = await fixture(t), runtime = await f.open(), initial = (await runtime.initialize({ revision: f.revisionA, operationId: "initialize-diagnostics" })).checkpoint;
  await f.cloneBaselineRemote(); const operation = await stageOperation(f, initial), revisionB = await commitOperation(f, operation, "[stella:critical] pending critical");
  let confirmations = 0; const stages: CangHaiDurabilityStage[] = [];
  const durability = new GitCangHaiDurability({ ...durabilityOptions(f), checkpointRecovery: { async confirmRevision() { confirmations++; assert.fail("Diagnostics must not confirm"); } },
    onStage(stage) { stages.push(stage); assert.fail("Diagnostics must not write"); } });
  const before = await readFile(f.checkpointPath, "utf8"), diagnostic = await durability.diagnostics();
  assert.equal(diagnostic.localRevision, revisionB); assert.equal(diagnostic.criticalSynchronized, false); assert.equal(await f.remoteHead(), f.revisionA);
  assert.equal(await readFile(f.checkpointPath, "utf8"), before); assert.equal(confirmations, 0); assert.deepEqual(stages, []);
});

test("invalid checkpoint callbacks and mixed legacy mode fail at construction", () => {
  const options = { root: "/synthetic/canghai", remote: "origin", branch: "synthetic", criticalWritePolicy: "sync_immediately" as const, normalWritePolicy: "bounded_batch" as const, maxNormalRpoSeconds: 300 };
  for (const callback of [null, {}, { confirmRevision: null }, { confirmRevision: "not-a-function" }])
    assert.throws(() => new GitCangHaiDurability({ ...options, checkpointRecovery: callback as unknown as { confirmRevision(revision: string): Promise<void> } }));
  assert.throws(() => new GitCangHaiDurability({ ...options, checkpointRecovery: { async confirmRevision() {} }, onRevision() {} }));
});
