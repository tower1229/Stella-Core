import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ExclusiveFileLockError, ownsExclusiveFileLock, withExclusiveFileLock } from "../src/canghai/exclusive-file-lock.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function category(expected: string) { return (error: unknown): boolean => { assert.ok(error instanceof ExclusiveFileLockError); assert.equal(error.category, expected); return true; }; }
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp("/tmp/stella-exclusive-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "protected-state");
}
test("exclusive lease reenters only its async chain and preserves business failures", async t => {
  const target = await fixture(t), entered = deferred<void>(), finish = deferred<void>();
  const held = withExclusiveFileLock(target, async () => {
    assert.equal(await ownsExclusiveFileLock(target), true);
    const before = await readFile(target + ".lock", "utf8");
    await withExclusiveFileLock(target, async () => { assert.equal(await readFile(target + ".lock", "utf8"), before); });
    entered.resolve(); await finish.promise;
  });
  await entered.promise;
  assert.equal(await ownsExclusiveFileLock(target), false);
  await assert.rejects(withExclusiveFileLock(target, async () => assert.fail("parallel admission")), category("lock_busy"));
  finish.resolve(); await held;
  await assert.rejects(readFile(target + ".lock"), { code: "ENOENT" });
  const failure = new Error("Synthetic business rejection");
  await assert.rejects(withExclusiveFileLock(target, async () => { throw failure; }), error => error === failure);
  await assert.rejects(readFile(target + ".lock"), { code: "ENOENT" });
});

test("expired async closure cannot reuse a released lease or disturb a new owner", async t => {
  const target = await fixture(t), oldGate = deferred<void>(); let late!: Promise<void>;
  await withExclusiveFileLock(target, async () => {
    late = (async () => { await oldGate.promise; await assert.rejects(withExclusiveFileLock(target, async () => assert.fail()), category("lock_ownership_lost")); })();
  });
  await withExclusiveFileLock(target, async () => {
    const bytes = await readFile(target + ".lock", "utf8"); oldGate.resolve(); await late;
    assert.equal(await readFile(target + ".lock", "utf8"), bytes); assert.equal(await ownsExclusiveFileLock(target), true);
  });
});

async function child(t: TestContext, target: string, mode: "hold" | "attempt") {
  const moduleUrl = new URL("../src/canghai/exclusive-file-lock.js", import.meta.url).href;
  const source = `import {withExclusiveFileLock} from ${JSON.stringify(moduleUrl)};
    try { await withExclusiveFileLock(process.argv[1], async()=> { process.send({stage:'entered',pid:process.pid});
      if(process.argv[2]==='hold') await new Promise(resolve=>process.once('message',resolve)); }); process.send({stage:'released'}); }
    catch(error) { process.send({stage:'rejected',category:error.category}); } process.disconnect();`;
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", source, target, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: Array<{ stage: string; category?: string; pid?: number }> = [];
  const waiters = new Set<() => void>();
  processChild.on("message", message => { messages.push(message as typeof messages[number]); for (const wake of waiters) wake(); });
  const exited = new Promise<void>(resolve => { processChild.once("exit", () => resolve()); processChild.once("error", () => resolve()); });
  t.diagnostic(`owned child pid=${processChild.pid}, mode=${mode}`);
  t.after(async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); await exited; });
  async function next(stage: string) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(wake); reject(new Error("Owned child handshake timeout")); }, 5000);
      const wake = () => { if (messages.some(message => message.stage === stage)) { clearTimeout(timer); waiters.delete(wake); resolve(); } };
      waiters.add(wake); wake();
    });
    return messages.find(message => message.stage === stage)!;
  }
  return { process: processChild, messages, exited, next };
}
test("two OS processes cannot both enter; killed holder leaves a lock that a new process refuses", async t => {
  const target = await fixture(t), first = await child(t, target, "hold"); await first.next("entered");
  const original = await readFile(target + ".lock", "utf8"), second = await child(t, target, "attempt");
  assert.equal((await second.next("rejected")).category, "lock_busy"); await second.exited;
  assert.ok(!second.messages.some(message => message.stage === "entered"));
  first.process.kill("SIGKILL"); await first.exited;
  const third = await child(t, target, "attempt"); assert.equal((await third.next("rejected")).category, "lock_busy"); await third.exited;
  assert.equal(await readFile(target + ".lock", "utf8"), original);
});

test("empty, corrupt, symlink and hardlink occupants are never reclaimed", async t => {
  const target = await fixture(t), lock = target + ".lock", other = target + ".other";
  await writeFile(other, "fixture");
  for (const setup of [() => writeFile(lock, ""), () => writeFile(lock, "corrupt"), () => symlink(other, lock), () => link(other, lock)]) {
    await setup();
    await assert.rejects(withExclusiveFileLock(target, async () => assert.fail("existing lock admitted")), category("lock_busy"));
    await unlink(lock);
  }
});
test("nonce tampering, path replacement and hardlinks prevent release and preserve evidence", async t => {
  for (const scenario of ["nonce", "replacement", "hardlink"] as const) await t.test(scenario, async subtest => {
    const target = await fixture(subtest), lock = target + ".lock";
    await assert.rejects(withExclusiveFileLock(target, async () => {
      if (scenario === "nonce") await writeFile(lock, "modified nonce");
      else if (scenario === "replacement") { await rename(lock, target + ".old"); await writeFile(lock, "new occupant"); }
      else await link(lock, target + ".alias");
      await assert.rejects(ownsExclusiveFileLock(target), category("lock_ownership_lost"));
    }), category("lock_ownership_lost"));
    assert.ok((await readFile(lock)).length > 0);
  });
});
test("symlink parents and failed admission never run work", async t => {
  const target = await fixture(t), parent = path.dirname(target), real = path.join(parent, "real"), alias = path.join(parent, "alias");
  await mkdir(real); await symlink(real, alias);
  await assert.rejects(withExclusiveFileLock(path.join(alias, "state"), async () => assert.fail()), category("lock_unsafe_path"));
  await assert.rejects(withExclusiveFileLock(path.join(parent, "missing", "state"), async () => assert.fail()), category("lock_io_failed"));
});


test("work settling revokes a reentry still awaiting ownership validation", async t => {
  const target = await fixture(t); let nested!: Promise<void>, entered = false;
  await withExclusiveFileLock(target, async () => {
    // assertOwned has already started async filesystem validation when this work settles.
    nested = assert.rejects(withExclusiveFileLock(target, async () => { entered = true; }), category("lock_ownership_lost"));
  });
  await nested; assert.equal(entered, false);
});
test("business and cleanup failures retain the primary cause and cleanup evidence", async t => {
  const target = await fixture(t), primary = new Error("Synthetic admission failure");
  await assert.rejects(withExclusiveFileLock(target, async () => { await writeFile(target + ".lock", "changed"); throw primary; }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary); assert.equal(error.errors[0], primary);
    assert.ok(error.errors[1] instanceof ExclusiveFileLockError); assert.equal(error.errors[1].category, "lock_ownership_lost"); return true;
  });
  assert.equal(await readFile(target + ".lock", "utf8"), "changed");
});
