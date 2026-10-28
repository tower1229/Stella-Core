import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";

const supervisor = new URL("../../scripts/lib/sdk-owner-supervisor.mjs", import.meta.url).href;
const summary = new URL("../../scripts/lib/owned-work-summary.mjs", import.meta.url).href;
const { superviseOwnerTest, superviseOwnerSuite } = await import(supervisor);
function output(onText?: (text: string) => Error | void) {
  let text = "";
  return { stream: new Writable({ write(bytes, _encoding, done) { text += bytes; done(onText?.(text) ?? undefined); } }), text: () => text };
}
async function temporary(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-owner-suite-")), cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const close of cleanup) await close(); await rm(root, { recursive: true, force: true }); });
  return { root, cleanup };
}
function retain(f: Awaited<ReturnType<typeof temporary>>, result: any) {
  if (result.cleanup.status === "retained") f.cleanup.push(async () => {
    if (result.group && !result.group.confirmedGone) throw new Error(`Unconfirmed group root retained: ${result.cleanup.root}`);
    await rm(result.cleanup.root, { recursive: true });
  });
}
function totals(text: string) {
  return Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(key => {
    const found = new RegExp(`^# ${key} (\\d+)$`, "m").exec(text); assert.ok(found, text); return [key, Number(found[1])];
  }));
}
async function baseline(files: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--test", "--test-concurrency=4", "--test-reporter=tap", ...files], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const [code, signal] = await once(child, "close"); return { code, signal, stdout, stderr };
}

test("file summary publishes once after all fixtures and cannot erase stop/pending/missing work", async t => {
  for (const mode of ["complete", "stop", "pending", "missing", "sealed"]) await t.test(mode, async t => {
    const f = await temporary(t), file = path.join(f.root, "summary.test.mjs");
    await writeFile(file, `import test,{after} from 'node:test';import assert from 'node:assert/strict';import {access} from 'node:fs/promises';import path from 'node:path';
import {createOwnedWorkSummary} from ${JSON.stringify(summary)};
const owner=createOwnedWorkSummary();
test('first fixture completes',()=>{const fixture=owner.register();fixture.finish();});
test('second fixture retains its own result',async()=>{
 await assert.rejects(access(path.join(process.env.STELLA_TEST_OWNER_ROOT,'owned-work.json')),{code:'ENOENT'});
 const fixture=owner.register();${mode === "missing" || mode === "sealed" ? "" : `fixture.finish(${mode === "stop" ? "{stopFailures:1}" : mode === "pending" ? "{pendingFailures:2}" : ""});`}
 ${mode === "sealed" ? "const published=owner.publish();assert.equal(owner.publish(),published);await published;assert.throws(()=>fixture.finish(),/sealed/);assert.throws(()=>owner.register(),/sealed/);" : ""}
});

test('later successful fixture cannot overwrite another',()=>{${mode === "sealed" ? "" : "owner.register().finish();"}});
after(()=>owner.publish());`);
    const stdout = output(), stderr = output();
    const result = await superviseOwnerTest({ args: ["--test-reporter=tap", file], stdout: stdout.stream, stderr: stderr.stream, timeoutMs: 10_000 }); retain(f, result);
    assert.equal(result.child.exitCode, 0, stdout.text() + stderr.text()); assert.equal(totals(stdout.text()).pass, 3);
    assert.equal(result.passed, mode === "complete"); assert.equal(result.cleanup.status, mode === "complete" ? "removed" : "retained");
    assert.equal(result.ownedWork.pending, mode === "missing" || mode === "sealed" ? 1 : 0);
    assert.equal(result.ownedWork.stopFailures, mode === "stop" ? 1 : 0);
    assert.equal(result.ownedWork.pendingFailures, mode === "pending" ? 2 : 0);
  });
});

test("native multi-file suite preserves the exact file set, failures, totals and concurrency four", { timeout: 30_000 }, async t => {
  const f = await temporary(t), files: string[] = [];
  for (let index = 0; index < 6; index++) {
    const file = path.join(f.root, `case-${index}.test.mjs`); files.push(file);
    await writeFile(file, `import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {createOwnedWorkSummary} from ${JSON.stringify(summary)};
const owner=createOwnedWorkSummary();
${index === 0 ? "after(()=>process.env.STELLA_TEST_OWNER_ROOT?owner.publish():undefined);" : ""}
test('native-case-${index}',{timeout:5000},async()=>{
 const fixture=${index === 0 ? "owner.register()" : "null"};
 const root=process.env.BARRIER_DIR,wave=path.join(root,'wave-${index < 4 ? 0 : 1}');
 let release;const barrier=new Promise(resolve=>{release=resolve;});process.on('SIGWINCH',()=>release());
 fs.appendFileSync(path.join(root,'events'),JSON.stringify({kind:'enter',index:${index}})+'\\n');
 fs.writeFileSync(path.join(wave,'pid-'+process.pid),'ready');
 const members=fs.readdirSync(wave).filter(name=>/^pid-[0-9]+$/.test(name));
 if(members.length===${index < 4 ? 4 : 2}){let leader=false;try{fs.mkdirSync(path.join(wave,'leader'));leader=true;}catch(error){if(error.code!=='EEXIST')throw error;}
 if(leader)for(const name of members)process.kill(Number(name.slice(4)),'SIGWINCH');}
 await barrier;fs.appendFileSync(path.join(root,'events'),JSON.stringify({kind:'leave',index:${index}})+'\\n');
 fixture?.finish();console.error('NATIVE_STDERR_${index}');assert.notEqual(${index},3,'synthetic native failure');
});`);
  }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  for (const key of ["STELLA_TEST_OWNER_ROOT", "STELLA_TEST_OWNER_RUN", "STELLA_TEST_OWNER_FILE"]) delete env[key];
  async function barrierDirectory(name: string) {
    const directory = path.join(f.root, name); await mkdir(directory);
    for (const wave of ["wave-0", "wave-1"]) await mkdir(path.join(directory, wave)); return directory;
  }
  const a = await barrierDirectory("baseline"), b = await barrierDirectory("supervised");
  const original = await baseline(files, { ...env, BARRIER_DIR: a });
  const stdout = output(), stderr = output();
  const result = await superviseOwnerSuite({ files, ownerFile: files[0], env: { ...env, BARRIER_DIR: b }, stdout: stdout.stream, stderr: stderr.stream, timeoutMs: 15_000 }); retain(f, result);
  assert.equal(original.code, 1, original.stdout + original.stderr); assert.equal(result.child.exitCode, original.code);
  assert.equal(result.child.signal, original.signal); assert.equal(result.passed, false); assert.equal(result.cleanup.status, "removed");
  assert.deepEqual(totals(stdout.text()), totals(original.stdout)); assert.equal(totals(stdout.text()).tests, 6); assert.equal(totals(stdout.text()).fail, 1);
  for (let index = 0; index < 6; index++) {
    assert.match(stdout.text(), new RegExp(`native-case-${index}`)); assert.match(stdout.text() + stderr.text(), new RegExp(`NATIVE_STDERR_${index}`));
  }
  for (const root of [a, b]) {
    const events = (await readFile(path.join(root, "events"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    let active = 0, peak = 0;
    for (const event of events) { active += event.kind === "enter" ? 1 : -1; peak = Math.max(peak, active); }
    assert.equal(events.length, 12); assert.equal(active, 0); assert.equal(peak, 4);
  }
});

test("suite refuses omitted/duplicate files and non-owner terminal reports", async t => {
  const f = await temporary(t), owner = path.join(f.root, "owner.test.mjs"), other = path.join(f.root, "other.test.mjs");
  await writeFile(owner, `import test,{after} from 'node:test';import {recordOwnedWorkState} from ${JSON.stringify(supervisor)};test('owner file',()=>{});after(()=>recordOwnedWorkState({status:'complete'}));`);
  await writeFile(other, `import test from 'node:test';import assert from 'node:assert/strict';import {recordOwnedWorkState} from ${JSON.stringify(supervisor)};test('foreign file',async()=>{await assert.rejects(recordOwnedWorkState({status:'complete'}),{code:'owned_work_file_mismatch'});});`);
  await assert.rejects(superviseOwnerSuite({ files: [owner, owner], ownerFile: owner }), { code: "owner_suite_duplicate_file" });
  await assert.rejects(superviseOwnerSuite({ files: [other], ownerFile: owner }), { code: "owner_suite_file_missing" });
  const stdout = output(), stderr = output(), result = await superviseOwnerSuite({ files: [owner, other], ownerFile: owner, stdout: stdout.stream, stderr: stderr.stream, timeoutMs: 10_000 });
  assert.equal(result.passed, true, JSON.stringify(result) + stdout.text() + stderr.text()); assert.equal(totals(stdout.text()).pass, 2);
});

test("TODO keeps native results without overriding ordinary failure, cancellation or log failure", async t => {
  for (const mode of ["todo", "ordinary", "cancel", "log"]) await t.test(mode, async t => {
    const ordinaryFailure = mode === "ordinary";
    const f = await temporary(t), file = path.join(f.root, "todo.test.mjs");
    await writeFile(file, `import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {recordOwnedWorkState} from ${JSON.stringify(supervisor)};
test('expected TODO',{todo:'planned'},()=>assert.fail('synthetic TODO'));
${ordinaryFailure ? "test('ordinary failure',()=>assert.fail('ordinary synthetic failure'));" : ""}
after(()=>process.env.STELLA_TEST_OWNER_ROOT?recordOwnedWorkState({status:'complete'}):undefined);`);
    const env = { ...process.env }; for (const key of ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "STELLA_TEST_OWNER_ROOT", "STELLA_TEST_OWNER_RUN", "STELLA_TEST_OWNER_FILE"]) delete env[key];
    const original = await baseline([file], env), controller = new AbortController(); let injected = false;
    const stdout = output(text => {
      if (!injected && text.includes("# todo 1\n") && (mode === "cancel" || mode === "log")) {
        injected = true;
        if (mode === "cancel") controller.abort();
        else return Object.assign(new Error("synthetic TODO log failure"), { code: "TODO_LOG_ERROR" });
      }
    }), stderr = output();
    const result = await superviseOwnerSuite({ files: [file], ownerFile: file, signal: controller.signal, stdout: stdout.stream, stderr: stderr.stream, timeoutMs: 5000 }); retain(f, result);
    assert.equal(original.code, ordinaryFailure ? 1 : 0);
    if (mode === "todo" || mode === "ordinary") assert.equal(result.child.exitCode, original.code);
    else {
      assert.equal(injected, true); assert.equal(result.interrupted, mode === "cancel" ? "cancelled" : "log_failure");
      assert.equal(result.cleanup.status, "retained"); if (mode === "log") assert.ok(result.logErrors.includes("TODO_LOG_ERROR"));
    }
    assert.equal(result.passed, mode === "todo", JSON.stringify(result)); assert.equal(result.group.confirmedGone, true);
    assert.deepEqual(totals(stdout.text()), totals(original.stdout)); assert.equal(totals(stdout.text()).todo, 1);
    assert.equal(totals(stdout.text()).fail, ordinaryFailure ? 1 : 0);
  });
});

function alive(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid);
  try { process.kill(pid, 0); return true; } catch (error: any) { if (error.code !== "ESRCH") throw error; return false; }
}

test("four native files including a TERM-ignoring owner are gone before cancellation settles, even if leader exits first", { timeout: 20_000 }, async t => {
  for (const leaderFirst of [false, true]) await t.test(String(leaderFirst), async t => {
    const f = await temporary(t), files: string[] = [], readyDirectory = path.join(f.root, "ready"); await mkdir(readyDirectory);
    const controller = new AbortController(); let releaseReady!: () => void;
    const ready = new Promise<void>(resolve => { releaseReady = resolve; });
    const onReady = () => { void readdir(readyDirectory).then(names => { if (names.length === 4) releaseReady(); }); };
    process.on("SIGWINCH", onReady); f.cleanup.push(async () => { process.removeListener("SIGWINCH", onReady); });
    for (let index = 0; index < 4; index++) {
      const file = path.join(f.root, `stubborn-${index}.test.mjs`); files.push(file);
      await writeFile(file, `import test from 'node:test';import fs from 'node:fs';import path from 'node:path';
import {recordOwnedWorkState} from ${JSON.stringify(supervisor)};
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(path.join(f.root, `term-${index}`))},'TERM');${index === 0 ? "" : "process.exit(0);"}});
test('native controlled file ${index}',async()=>{${index === 0 ? "await recordOwnedWorkState({status:'complete'});" : ""}
fs.writeFileSync(path.join(${JSON.stringify(readyDirectory)},'${index}.json'),JSON.stringify({pid:process.pid,leader:process.ppid}));
if(fs.readdirSync(${JSON.stringify(readyDirectory)}).length===4)process.kill(${process.pid},'SIGWINCH');
await new Promise(()=>setInterval(()=>{},1000));});`);
    }
    const stdout = output(), stderr = output();
    const pending = superviseOwnerSuite({ files, ownerFile: files[0], stdout: stdout.stream, stderr: stderr.stream,
      signal: AbortSignal.any([controller.signal, t.signal]), timeoutMs: 10_000 });
    await ready;
    const records = await Promise.all([0, 1, 2, 3].map(async index => JSON.parse(await readFile(path.join(readyDirectory, `${index}.json`), "utf8"))));
    const leader = records[0].leader; assert.ok(records.every(record => record.leader === leader && alive(record.pid)));
    if (leaderFirst) { assert.ok(alive(leader)); process.kill(leader, "SIGTERM"); } else controller.abort();
    const result = await pending; retain(f, result);
    // Failure-only fixture safety, never counted as supervisor success.
    f.cleanup.unshift(async () => {
      if (["EPERM", "EACCES"].includes(result.group?.error)) throw new Error("Owned group control denied; no PID cleanup bypass");
      const leftovers = [leader, ...records.map(record => record.pid)].filter(alive);
      if (leftovers.length) {
        t.diagnostic(`MANUAL_FAILURE_CLEANUP ${JSON.stringify(leftovers)}`);
        for (const pid of leftovers) process.kill(pid, "SIGKILL");
        const deadline = performance.now() + 1000;
        while (leftovers.some(alive) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(leftovers.some(alive), false);
      }
    });
    assert.equal(result.passed, false); assert.equal(result.group.pid, leader); assert.equal(result.group.confirmedGone, true, JSON.stringify(result));
    assert.equal(result.group.escalated, true); assert.deepEqual(result.group.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.cleanup.status, "retained"); assert.equal(records.some(record => alive(record.pid)), false);
    assert.equal(await readFile(path.join(f.root, "term-0"), "utf8"), "TERM");
    if (leaderFirst) assert.equal(result.group.unexpectedSurvivors, true);
    t.diagnostic(JSON.stringify({ leaderFirst, pids: records.map(record => record.pid), allGoneBeforeTeardown: true, group: result.group, child: result.child }));
  });
});

test("cancelling one owned suite does not signal or remove a concurrent suite", { timeout: 15_000 }, async t => {
  const f = await temporary(t), controller = new AbortController(), readyPaths = [0, 1].map(index => path.join(f.root, `ready-${index}`));
  let releaseReady!: () => void;
  const ready = new Promise<void>(resolve => { releaseReady = resolve; });
  const onReady = () => { void Promise.all(readyPaths.map(file => readFile(file, "utf8"))).then(() => releaseReady(), () => {}); };
  process.on("SIGWINCH", onReady); f.cleanup.push(async () => { process.removeListener("SIGWINCH", onReady); });
  const files = [];
  for (let index = 0; index < 2; index++) {
    const file = path.join(f.root, `concurrent-${index}.test.mjs`); files.push(file);
    await writeFile(file, `import test from 'node:test';import fs from 'node:fs';import {recordOwnedWorkState} from ${JSON.stringify(supervisor)};
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(path.join(f.root, `term-${index}`))},'TERM');${index ? "process.exit(0);" : ""}});
test('concurrent owned file ${index}',async()=>{await recordOwnedWorkState({status:'complete'});
let release;const barrier=new Promise(resolve=>{release=resolve;});process.on('SIGWINCH',()=>release());
fs.writeFileSync(${JSON.stringify(readyPaths[index])},JSON.stringify({pid:process.pid,root:process.env.STELLA_TEST_OWNER_ROOT}));process.kill(${process.pid},'SIGWINCH');
const interval=setInterval(()=>{},1000);await barrier;clearInterval(interval);});`);
  }
  const logs = [output(), output()], errors = [output(), output()];
  const pending = files.map((file, index) => superviseOwnerSuite({ files: [file], ownerFile: file, stdout: logs[index]!.stream, stderr: errors[index]!.stream,
    signal: index === 0 ? AbortSignal.any([controller.signal, t.signal]) : t.signal, timeoutMs: 10_000 }));
  await ready;
  const records = await Promise.all(readyPaths.map(async file => JSON.parse(await readFile(file, "utf8"))));
  controller.abort();
  let a: any, b: any;
  try {
    a = await pending[0]; retain(f, a); assert.equal(a.group.confirmedGone, true); assert.equal(alive(records[0].pid), false);
    assert.equal(alive(records[1].pid), true); await assert.rejects(readFile(path.join(f.root, "term-1")), { code: "ENOENT" });
  } finally { if (alive(records[1].pid)) process.kill(records[1].pid, "SIGWINCH"); b = await pending[1]; retain(f, b); }
  assert.equal(a.passed, false); assert.equal(b.passed, true, JSON.stringify(b)); assert.notEqual(a.group.pid, b.group.pid);
  assert.equal(b.group.confirmedGone, true); assert.equal(b.group.terminationRequested, false); assert.equal(alive(records[1].pid), false);
  assert.notEqual(records[0].root, records[1].root);
  t.diagnostic(JSON.stringify({ cancelledGroup: a.group, otherGroup: b.group, bothFilesGoneBeforeTeardown: true }));
});
