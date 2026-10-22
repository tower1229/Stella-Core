import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  RecoveryCheckpointError,
  type RecoveryCheckpoint,
  type RecoveryCheckpointLock,
  type RecoveryCheckpointStoreOptions,
  type RecoveryCheckpointVersion,
  type RecoveryCheckpointWritePhase,
} from "../src/canghai/recovery-checkpoint-contract.js";
import { openRecoveryCheckpointStore } from "../src/canghai/recovery-checkpoint-store.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Fixture-only scheduling, not a production or cross-process lock implementation.
 * The real public SDK adapter is intentionally untested here: on Darwin it invokes ps.
 */
function serialFixtureLock(keys: string[] = []): RecoveryCheckpointLock {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    keys.push(key);
    const previous = tails.get(key) ?? Promise.resolve();
    const released = deferred();
    const tail = previous.then(() => released.promise);
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      released.resolve();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function hasCategory(category: string) {
  const expected = category.startsWith("checkpoint_") ? category : `checkpoint_${category}`;
  return (error: unknown): boolean => {
    assert.ok(error instanceof RecoveryCheckpointError, `Expected checkpoint error ${expected}`);
    assert.equal(error.category, expected);
    return true;
  };
}

function version(checkpoint: RecoveryCheckpoint): RecoveryCheckpointVersion {
  return { revision: checkpoint.revision, token: checkpoint.token };
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp("/tmp/stella-recovery-checkpoint-"));
  assert.ok(!root.includes("/Library/Mobile Documents/"));
  assert.ok(!root.includes("/Documents/"));
  assert.ok(!root.includes("/Desktop/"));
  const children: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const repositoryRoot = path.join(root, "repository");
  const stateDirectory = path.join(root, "authority");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o700 });
  const manifestPath = path.join(repositoryRoot, "memory-manifest.json");
  await writeFile(manifestPath, '{"synthetic":true}\n');
  const binding = {
    agentId: "synthetic-agent",
    repositoryRoot: await realpath(repositoryRoot),
    manifestPath: "memory-manifest.json",
  };
  const keys: string[] = [];
  const withLock = serialFixtureLock(keys);
  return {
    root,
    repositoryRoot,
    stateDirectory,
    binding,
    keys,
    withLock,
    checkpointPath: path.join(stateDirectory, "checkpoint.json"),
    open: (overrides: Partial<RecoveryCheckpointStoreOptions> = {}) => openRecoveryCheckpointStore({
      stateDirectory,
      binding,
      withLock,
      ...overrides,
    }),
    registerChild(child: ChildProcess) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      children.push({ child, exited });
      return exited;
    },
  };
}

test("authority is missing until explicitly initialized; a synthetic HEAD is never adopted", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.repositoryRoot, ".git"));
  await writeFile(path.join(f.repositoryRoot, ".git", "HEAD"), `${revisionC}\n`);
  const store = await f.open();
  assert.equal(store.path, f.checkpointPath);
  await assert.rejects(store.read(), hasCategory("checkpoint_missing"));
  await assert.rejects(readFile(f.checkpointPath), { code: "ENOENT" });
  const initialized = await store.initialize({ revision: revisionA, operationId: "initialize-A" });
  assert.equal(initialized.replayed, false);
  assert.equal(initialized.checkpoint.revision, revisionA);
  assert.ok(initialized.checkpoint.token.length > 0);
  assert.deepEqual(initialized.checkpoint.binding, f.binding);
  assert.deepEqual(await store.read(), initialized.checkpoint);
  assert.ok(f.keys.length >= 3);
  assert.ok(f.keys.every((key) => key === store.path), "Every read and write must use the canonical checkpoint lock key");
});

test("initialization retry is idempotent and neither another initial choice nor another operation replaces it", async (t) => {
  const f = await fixture(t);
  const phases: RecoveryCheckpointWritePhase[] = [];
  const store = await f.open({ onWritePhase: (phase) => { phases.push(phase); } });
  const first = await store.initialize({ revision: revisionA, operationId: "initialize-A" });
  assert.deepEqual(phases, ["file_synced", "replaced", "directory_synced"]);
  phases.length = 0;
  const retry = await store.initialize({ revision: revisionA, operationId: "initialize-A" });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.checkpoint, first.checkpoint);
  assert.deepEqual(phases, [], "An acknowledged retry must not perform another write");
  await assert.rejects(store.initialize({ revision: revisionB, operationId: "initialize-A" }), hasCategory("operation_conflict"));
  await assert.rejects(store.initialize({ revision: revisionA, operationId: "initialize-other" }), hasCategory("conflict"));
  assert.deepEqual(await store.read(), first.checkpoint);
});

test("checkpoint records source authority only, independently of a recovery target or materialization record", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const source = (await store.initialize({ revision: revisionA, operationId: "initialize-source" })).checkpoint;
  await writeFile(path.join(f.stateDirectory, "synthetic-target.json"), JSON.stringify({
    targetRevision: revisionC,
    materializedRevision: revisionB,
    hostConsumed: false,
  }));
  assert.deepEqual(await store.read(), source);
  assert.deepEqual(Object.keys(source).sort(), [
    "schemaVersion", "binding", "revision", "token", "lastOperationId", "lastOperationDigest",
  ].sort());
  const advanced = await store.compareAndSet({ expected: version(source), nextRevision: revisionB, operationId: "advance-source" });
  assert.equal(advanced.checkpoint.revision, revisionB);
  assert.equal(JSON.parse(await readFile(path.join(f.stateDirectory, "synthetic-target.json"), "utf8")).targetRevision, revisionC);
});

test("the persisted authority must match the requested agent and manifest binding", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-binding" })).checkpoint;
  const otherManifest = path.join(f.repositoryRoot, "other-manifest.json");
  await writeFile(otherManifest, '{"synthetic":true}\n');
  for (const binding of [
    { ...f.binding, agentId: "other-agent" },
    { ...f.binding, manifestPath: "other-manifest.json" },
  ]) {
    await assert.rejects(async () => (await f.open({ binding })).read(), hasCategory("binding_mismatch"));
  }
  assert.deepEqual(await store.read(), original);
});

test("malformed or expanded checkpoint schemas fail closed instead of supplying an implicit revision", async (t) => {
  const corruptions: Array<[string, (checkpoint: RecoveryCheckpoint) => string]> = [
    ["invalid JSON", () => "{broken"],
    ["unknown schema", (checkpoint) => JSON.stringify({ ...checkpoint, schemaVersion: "future/v2" })],
    ["unknown root field", (checkpoint) => JSON.stringify({ ...checkpoint, targetRevision: revisionB })],
    ["unknown binding field", (checkpoint) => JSON.stringify({ ...checkpoint, binding: { ...checkpoint.binding, trusted: true } })],
    ["missing token", (checkpoint) => JSON.stringify({ ...checkpoint, token: undefined })],
    ["invalid revision", (checkpoint) => JSON.stringify({ ...checkpoint, revision: "HEAD" })],
  ];
  for (const [name, corrupt] of corruptions) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      const store = await f.open();
      const checkpoint = (await store.initialize({ revision: revisionA, operationId: "initialize-corruption" })).checkpoint;
      const bytes = corrupt(checkpoint);
      await writeFile(f.checkpointPath, bytes);
      await assert.rejects(store.read(), hasCategory("corrupt"));
      await assert.rejects(store.initialize({ revision: revisionB, operationId: "replace-corrupt" }), hasCategory("corrupt"));
      assert.equal(await readFile(f.checkpointPath, "utf8"), bytes, "Corrupt authority must not be silently repaired");
    });
  }
});

test("checkpoint paths cannot be symlinks or hardlinks", async (t) => {
  for (const kind of ["symlink", "hardlink"] as const) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      const store = await f.open();
      const checkpoint = (await store.initialize({ revision: revisionA, operationId: "initialize-path" })).checkpoint;
      const source = path.join(f.root, "unrelated-synthetic-file.json");
      const bytes = JSON.stringify(checkpoint);
      await writeFile(source, bytes);
      await rm(f.checkpointPath);
      if (kind === "symlink") await symlink(source, f.checkpointPath);
      else await link(source, f.checkpointPath);
      await assert.rejects(store.read(), hasCategory("unsafe_path"));
      await assert.rejects(store.compareAndSet({ expected: version(checkpoint), nextRevision: revisionB, operationId: "unsafe-write" }), hasCategory("unsafe_path"));
      assert.equal(await readFile(source, "utf8"), bytes);
    });
  }
});

test("the state directory must be canonical and outside the repository without changing existing permissions", async (t) => {
  const f = await fixture(t);
  const originalMode = (await stat(f.stateDirectory)).mode & 0o777;
  const alias = path.join(f.root, "authority-alias");
  await symlink(f.stateDirectory, alias);
  await assert.rejects(async () => (await f.open({ stateDirectory: alias })).read(), hasCategory("unsafe_path"));
  const inside = path.join(f.repositoryRoot, "checkpoint-state");
  await mkdir(inside, { mode: 0o700 });
  await assert.rejects(async () => (await f.open({ stateDirectory: await realpath(inside) })).read(), hasCategory("state_inside_repository"));
  const store = await f.open();
  await store.initialize({ revision: revisionA, operationId: "initialize-permissions" });
  assert.equal((await stat(f.stateDirectory)).mode & 0o777, originalMode);
  assert.equal((await lstat(f.checkpointPath)).isSymbolicLink(), false);
  assert.equal((await stat(f.checkpointPath)).nlink, 1);
});

test("invalid revision, operation, and expectation inputs cannot create or advance authority", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  for (const input of [
    { revision: "HEAD", operationId: "invalid-revision" },
    { revision: "A".repeat(40), operationId: "uppercase-revision" },
    { revision: revisionA, operationId: "" },
    { revision: revisionA, operationId: "1-invalid-operation" },
  ]) await assert.rejects(store.initialize(input), hasCategory("invalid_input"));
  await assert.rejects(store.read(), hasCategory("checkpoint_missing"));
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-input" })).checkpoint;
  await assert.rejects(store.compareAndSet({ expected: { revision: revisionA, token: "" }, nextRevision: revisionB, operationId: "empty-token" }), hasCategory("invalid_input"));
  await assert.rejects(store.compareAndSet({ expected: version(original), nextRevision: "HEAD", operationId: "invalid-next" }), hasCategory("invalid_input"));
  assert.deepEqual(await store.read(), original);
});

test("both original expectation fields are required; a stale revision or a different token is rejected", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-expectation" })).checkpoint;
  for (const expected of [
    { revision: revisionB, token: original.token },
    { revision: revisionA, token: `${original.token}x` },
  ]) {
    await assert.rejects(store.compareAndSet({ expected, nextRevision: revisionC, operationId: "wrong-expectation" }), hasCategory("conflict"));
  }
  assert.deepEqual(await store.read(), original);
});

test("two store instances sharing a fixture lock admit exactly one CAS from the same original token", async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const second = await f.open();
  const original = (await first.initialize({ revision: revisionA, operationId: "initialize-two-writers" })).checkpoint;
  const results = await Promise.allSettled([
    first.compareAndSet({ expected: version(original), nextRevision: revisionB, operationId: "writer-one" }),
    second.compareAndSet({ expected: version(original), nextRevision: revisionC, operationId: "writer-two" }),
  ]);
  const accepted = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(accepted[0].value.replayed, false);
  hasCategory("conflict")(rejected[0].reason);
  assert.deepEqual(await first.read(), accepted[0].value.checkpoint);
  assert.ok(f.keys.every((key) => key === f.checkpointPath));
});

test("returning to an old revision does not resurrect its token or an old accepted operation", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-ABA" })).checkpoint;
  const advance = { expected: version(original), nextRevision: revisionB, operationId: "advance-ABA" };
  const atB = (await store.compareAndSet(advance)).checkpoint;
  const returned = (await store.compareAndSet({ expected: version(atB), nextRevision: revisionA, operationId: "return-to-A" })).checkpoint;
  assert.equal(returned.revision, original.revision);
  assert.notEqual(returned.token, original.token);
  assert.notEqual(returned.token, atB.token);
  await assert.rejects(store.compareAndSet({ expected: version(original), nextRevision: revisionC, operationId: "late-old-token" }), hasCategory("conflict"));
  await assert.rejects(store.compareAndSet(advance), hasCategory("conflict"));
  assert.deepEqual(await store.read(), returned);
});

test("an exact CAS retry reuses its result, but the same operation ID cannot authorize different input", async (t) => {
  const f = await fixture(t);
  const phases: RecoveryCheckpointWritePhase[] = [];
  const store = await f.open({ onWritePhase: (phase) => { phases.push(phase); } });
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-operation" })).checkpoint;
  const input = { expected: version(original), nextRevision: revisionB, operationId: "advance-operation" };
  const accepted = await store.compareAndSet(input);
  phases.length = 0;
  const retry = await store.compareAndSet({ ...input, expected: { ...input.expected } });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.checkpoint, accepted.checkpoint);
  assert.deepEqual(phases, []);
  await assert.rejects(store.compareAndSet({ ...input, nextRevision: revisionC }), hasCategory("operation_conflict"));
  await assert.rejects(store.compareAndSet({ ...input, expected: version(accepted.checkpoint) }), hasCategory("operation_conflict"));
  assert.deepEqual(await store.read(), accepted.checkpoint);
});

test("mutating caller input while lock admission awaits cannot change the authorized CAS", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const resume = deferred();
  let pause = false;
  const withLock: RecoveryCheckpointLock = (key, work) => f.withLock(key, async () => {
    if (pause) {
      entered.resolve();
      await resume.promise;
    }
    return work();
  });
  const store = await f.open({ withLock });
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-input-race" })).checkpoint;
  const input = { expected: { ...version(original) }, nextRevision: revisionB, operationId: "authorized-before-await" };
  pause = true;
  const pending = store.compareAndSet(input);
  try {
    await entered.promise;
    input.expected.revision = revisionC;
    input.expected.token = "forged-while-waiting";
    input.nextRevision = revisionC;
    input.operationId = "mutated-after-await";
  } finally {
    pause = false;
    resume.resolve();
  }
  const accepted = await pending;
  assert.equal(accepted.checkpoint.revision, revisionB);
  assert.equal(accepted.checkpoint.lastOperationId, "authorized-before-await");
  assert.equal(accepted.replayed, false);
  assert.deepEqual(await store.read(), accepted.checkpoint);
});

for (const failedPhase of ["file_synced", "replaced", "directory_synced"] as const) {
  test(`failure at ${failedPhase} preserves the correct disk generation and an exact retry never advances twice`, async (t) => {
    const f = await fixture(t);
    let armed = false;
    const phases: RecoveryCheckpointWritePhase[] = [];
    const store = await f.open({
      onWritePhase(phase) {
        phases.push(phase);
        if (armed && phase === failedPhase) {
          armed = false;
          throw new Error(`Synthetic fault after ${phase}`);
        }
      },
    });
    const original = (await store.initialize({ revision: revisionA, operationId: `initialize-${failedPhase}` })).checkpoint;
    const input = { expected: version(original), nextRevision: revisionB, operationId: `advance-${failedPhase}` };
    phases.length = 0;
    armed = true;
    await assert.rejects(store.compareAndSet(input), hasCategory("io_failed"));
    assert.ok(phases.includes(failedPhase));
    const recovered = await (await f.open()).read();
    if (failedPhase === "file_synced") {
      assert.deepEqual(recovered, original, "A synced temporary file is not yet committed authority");
    } else {
      assert.equal(recovered.revision, revisionB, "A completed rename is the visible authority even if acknowledgement fails");
      assert.notEqual(recovered.token, original.token);
      assert.equal(recovered.lastOperationId, input.operationId);
    }
    phases.length = 0;
    const retried = await store.compareAndSet({ ...input, expected: { ...input.expected } });
    assert.equal(retried.replayed, failedPhase !== "file_synced");
    assert.equal(retried.checkpoint.revision, revisionB);
    if (failedPhase !== "file_synced") {
      assert.deepEqual(retried.checkpoint, recovered);
      assert.deepEqual(phases, [], "A committed but unacknowledged CAS must not generate another token");
    }
    assert.deepEqual(await store.read(), retried.checkpoint);
  });
}

function waitForReplacement(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  assert.ok(stdout);
  assert.ok(stderr);
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => finish(new Error(`Synthetic child did not reach replaced phase: ${errors}`)), 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("CHECKPOINT_REPLACED\n")) finish();
    };
    const onErrorData = (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2_000); };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error(`Synthetic child exited before replacement: ${errors}`));
    function finish(error?: Error) {
      clearTimeout(timer);
      stdout!.off("data", onData);
      stderr!.off("data", onErrorData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    stdout.on("data", onData);
    stderr.on("data", onErrorData);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

test("SIGKILL after replacement recovers the committed generation and replays the original CAS without another advance", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const original = (await store.initialize({ revision: revisionA, operationId: "initialize-kill" })).checkpoint;
  const input = { expected: version(original), nextRevision: revisionB, operationId: "advance-before-kill" };
  const moduleUrl = new URL("../src/canghai/recovery-checkpoint-store.js", import.meta.url).href;
  // The parent owns this entire synthetic fixture. It performs no store operation until this child exits.
  // This serial injected port demonstrates crash persistence, not an SDK cross-process lock guarantee.
  const code = `import { openRecoveryCheckpointStore } from ${JSON.stringify(moduleUrl)};
    const store = await openRecoveryCheckpointStore({
      stateDirectory: ${JSON.stringify(f.stateDirectory)}, binding: ${JSON.stringify(f.binding)},
      withLock: async (key, work) => {
        if (key !== ${JSON.stringify(f.checkpointPath)}) throw new Error('Unexpected checkpoint lock key');
        return work();
      },
      async onWritePhase(phase) {
        if (phase === 'replaced') {
          setInterval(() => {}, 1000);
          process.stdout.write('CHECKPOINT_REPLACED\\n');
          await new Promise(() => {});
        }
      }
    });
    await store.compareAndSet(${JSON.stringify(input)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: f.root,
    env: { PATH: path.dirname(process.execPath), TMPDIR: "/tmp" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = f.registerChild(child);
  assert.ok(child.pid !== undefined, "Register the owned child PID before waiting for its write phase");
  await writeFile(path.join(f.root, "child-registration.json"), JSON.stringify({ pid: child.pid, phase: "awaiting-replaced", synthetic: true }));
  try {
    await waitForReplacement(child);
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
    assert.equal(child.signalCode, "SIGKILL");
    const recovered = await (await f.open()).read();
    assert.equal(recovered.revision, revisionB);
    assert.equal(recovered.lastOperationId, input.operationId);
    assert.notEqual(recovered.token, original.token);
    const retry = await store.compareAndSet({ ...input, expected: { ...input.expected } });
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.checkpoint, recovered);
    assert.deepEqual(await store.read(), recovered);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});
