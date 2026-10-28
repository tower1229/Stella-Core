import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const helper = new URL("../../scripts/lib/sdk-owner-supervisor.mjs", import.meta.url).href;
const cli = fileURLToPath(new URL("../../scripts/run-sdk-owner-test.mjs", import.meta.url));
const { superviseOwnerTest } = await import(helper);
const cleanupByTest = new WeakMap<TestContext, Array<() => Promise<unknown>>>();
const prelude = `import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile,rename,symlink,chmod} from 'node:fs/promises';import {writeFileSync} from 'node:fs';
import path from 'node:path';import {recordOwnedWorkState} from ${JSON.stringify(helper)};
const root=process.env.STELLA_TEST_OWNER_ROOT;
console.log('OWNER_ROOT '+JSON.stringify(root));\n`;

function output(onChunk?: (chunk: string) => Promise<void> | void) {
  let text = "";
  const stream = new Writable({ write(bytes, _encoding, done) {
    const chunk = String(bytes); text += chunk;
    Promise.resolve().then(() => onChunk?.(text)).then(() => done(), done);
  } });
  return { stream, text: () => text };
}

async function fixture(t: TestContext, code: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stella-owner-test-case-"));
  const file = path.join(directory, "synthetic.test.mjs"); await writeFile(file, prelude + code);
  const cleanups: Array<() => Promise<unknown>> = []; cleanupByTest.set(t, cleanups);
  t.after(async () => {
    const errors: unknown[] = [];
    for (const clean of cleanups) try { await clean(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Synthetic supervisor fixture cleanup failed");
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file };
}

async function disposeRetained(t: TestContext, result: any) {
  if (result.cleanup.status === "retained") cleanupByTest.get(t)!.push(async () => {
    const stat = await lstat(result.cleanup.root);
    if (stat.isSymbolicLink()) await unlink(result.cleanup.root);
    else await rm(result.cleanup.root, { recursive: true, force: true });
  });
}

const run = (file: string, extra: Record<string, unknown> = {}) => {
  const stdout = output(), stderr = output();
  return { stdout, stderr, result: superviseOwnerTest({ args: ["--test-reporter=tap", file],
    timeoutMs: 10_000, stdout: stdout.stream, stderr: stderr.stream, ...extra }) };
};

test("SDK owner root remains until the file process and its late writing thread terminate", { timeout: 15_000 }, async t => {
  const f = await fixture(t, `import {Worker} from 'node:worker_threads';
test('native thread barrier',t=>{
 const worker=new Worker(\`const {parentPort,workerData}=require('node:worker_threads');
 const fs=require('node:fs'),path=require('node:path');
 parentPort.once('message',()=>{parentPort.once('message',()=>{
 fs.writeFileSync(path.join(workerData,'late-body'),'synthetic');console.log('THREAD_WROTE');parentPort.close();});
 console.log('THREAD_READY '+JSON.stringify({root:workerData,pid:process.pid}));});\`,{eval:true,workerData:root});
 t.after(async()=>{await recordOwnedWorkState({status:'complete'});
 process.once('SIGUSR2',()=>worker.postMessage('release'));worker.postMessage('body finished');});
});`);
  let ready = 0, completed = false;
  const stdout = output(async text => {
    const marker = /THREAD_READY (.+)\n/.exec(text);
    if (ready || !marker) return;
    const { root, pid } = JSON.parse(marker[1]!);
    ready++; assert.equal(completed, false);
    const stat = await lstat(root); assert.equal(stat.mode & 0o777, 0o700); assert.equal(stat.isSymbolicLink(), false);
    await assert.rejects(readFile(path.join(root, "late-body")), { code: "ENOENT" });
    process.kill(pid, "SIGUSR2");
  });
  const stderr = output(), result = await superviseOwnerTest({ args: ["--test-reporter=tap", f.file], timeoutMs: 10_000,
    stdout: stdout.stream, stderr: stderr.stream }); completed = true;
  assert.equal(ready, 1); assert.equal(result.passed, true, JSON.stringify(result) + stderr.text() + stdout.text());
  assert.match(stdout.text(), /THREAD_WROTE/); assert.match(stdout.text(), /# tests 1/);
  assert.match(stdout.text(), /# pass 1/); assert.equal(result.cleanup.status, "removed");
  await assert.rejects(lstat(result.cleanup.root), { code: "ENOENT" });
});

test("native assertion failure preserves counts, bytes and exit code but may release a clean owner root", async t => {
  const f = await fixture(t, `test('native assertion retained',t=>{
 t.after(()=>recordOwnedWorkState({status:'complete'}));console.error('NATIVE_STDERR');assert.fail('synthetic assertion');});`);
  const fRun = run(f.file), result = await fRun.result;
  assert.equal(result.passed, false); assert.equal(result.child.exitCode, 1); assert.equal(result.child.signal, null);
  assert.equal(result.cleanup.status, "removed"); assert.match(fRun.stdout.text(), /not ok 1 - native assertion retained/);
  assert.match(fRun.stdout.text(), /# fail 1/); assert.match(fRun.stderr.text(), /NATIVE_STDERR/);
});

test("stop/pending failure is durable and cannot be replaced with a successful cleanup receipt", async t => {
  for (const reason of ["stop", "pending", "unsettled"]) await t.test(reason, async t => {
    const state = reason === "stop" ? "stopFailures:1" : reason === "pending" ? "pendingFailures:1" : "pending:1";
    const f = await fixture(t, `test('owned shutdown state',async()=>{
 await recordOwnedWorkState({status:'shutdown_failed',${state}});
 await recordOwnedWorkState({status:'complete'});});`);
    const result = await run(f.file).result; await disposeRetained(t, result);
    assert.equal(result.child.exitCode, 0); assert.equal(result.passed, false);
    assert.equal(result.ownedWork.status, "shutdown_failed"); assert.equal(result.cleanup.status, "retained");
  });
});

const waiting = `process.on('SIGTERM',()=>process.exit(0));
process.on('exit',code=>writeFileSync(path.join(root,'exit-code'),String(code)));
test('wait for cancellation',async()=>{await recordOwnedWorkState({status:'complete'});
 console.log('CANCEL_READY');await new Promise(()=>{setInterval(()=>{},1000);});});`;

test("cancel and timeout stay failed when the supervised file handles SIGTERM with exit0", { timeout: 15_000 }, async t => {
  for (const mode of ["cancel", "timeout"]) await t.test(mode, async t => {
    const f = await fixture(t, waiting), controller = new AbortController(); let ready = false;
    const stdout = output(text => { if (!ready && text.includes("CANCEL_READY\n")) { ready = true; if (mode === "cancel") controller.abort(); } });
    const result = await run(f.file, { stdout: stdout.stream, signal: controller.signal, timeoutMs: mode === "timeout" ? 1000 : 10_000 }).result;
    await disposeRetained(t, result);
    assert.equal(ready, true); assert.equal(result.passed, false); assert.equal(result.child.exitCode, 0);
    assert.equal(result.child.signal, null); assert.equal(result.child.killed, true);
    assert.equal(result.interrupted, mode === "cancel" ? "cancelled" : "timeout");
    assert.equal(result.timedOut, mode === "timeout"); assert.equal(result.cleanup.status, "retained");
    assert.equal(await readFile(path.join(result.cleanup.root, "exit-code"), "utf8"), "0");
  });
});

test("log failure cannot become success even when its SIGTERM child exits0", async t => {
  const f = await fixture(t, waiting);
  const stdout = new Writable({ write(bytes, _encoding, done) {
    done(String(bytes).includes("CANCEL_READY") ? Object.assign(new Error("synthetic log error"), { code: "ELOGTEST" }) : undefined);
  } });
  const result = await run(f.file, { stdout }).result; await disposeRetained(t, result);
  assert.equal(result.passed, false); assert.equal(result.child.exitCode, 0); assert.equal(result.interrupted, "log_failure");
  assert.ok(result.logErrors.includes("ELOGTEST")); assert.equal(result.cleanup.status, "retained");
});

test("an unacknowledged log write settles as failure after the file exits", { timeout: 10_000 }, async t => {
  const f = await fixture(t, `test('stalled log',async()=>{await recordOwnedWorkState({status:'complete'});console.log('LOG_STALL');});`);
  const stdout = new Writable({ write(_bytes, _encoding, _done) { /* Deliberately never acknowledges. */ } });
  const result = await run(f.file, { stdout }).result; stdout.destroy(); await disposeRetained(t, result);
  assert.equal(result.passed, false); assert.equal(result.child.exitCode, 0); assert.equal(result.timedOut, false);
  assert.equal(result.interrupted, "log_failure"); assert.ok(result.logErrors.includes("owner_log_drain_timeout"));
  assert.equal(result.cleanup.status, "retained");
});

test("a signal exit and a missing cleanup report remain distinct raw failure facts", async t => {
  const f = await fixture(t, `test('raw signal',async()=>{process.kill(process.pid,'SIGTERM');});`);
  const result = await run(f.file).result; await disposeRetained(t, result);
  assert.equal(result.passed, false); assert.equal(result.child.exitCode, null); assert.equal(result.child.signal, "SIGTERM");
  assert.equal(result.ownedWork, null); assert.equal(result.cleanup.status, "retained");
});

test("unowned deletion targets and unsafe runner options are refused before launch", async t => {
  const f = await fixture(t, `test('unused',()=>assert.fail('must not run'));`);
  await assert.rejects(superviseOwnerTest({ args: [f.file], root: f.directory }), { code: "owner_options_invalid" });
  for (const option of ["--watch", "--test-isolation=none", "--test-isolation=process", "--test-force-exit", "--force-exit", "--import=other.mjs", "--test-only"]) {
    await assert.rejects(superviseOwnerTest({ args: [option, f.file] }), { code: "owner_test_option_unsupported" });
  }
  for (const args of [["npm", "run", "test"], ["/bin/sh", "-c", "node test.js"], [f.file, f.file]])
    await assert.rejects(superviseOwnerTest({ args }), { code: "owner_test_file_required" });
  await assert.rejects(superviseOwnerTest({ args: [f.file], env: { NODE_OPTIONS: "--test-isolation=none" } }), { code: "owner_node_options_unsupported" });
  await assert.rejects(superviseOwnerTest({ args: [f.file, "--test-name-pattern=unused"] }), { code: "owner_test_option_order_invalid" });
});

test("missing, mismatched and symlink cleanup reports cannot authorize root removal", async t => {
  for (const kind of ["missing", "wrong-run", "extra-target", "symlink"]) await t.test(kind, async t => {
    const f = await fixture(t, ""), victim = path.join(f.directory, "victim"); await writeFile(victim, "keep");
    const change = kind === "missing" ? "" : kind === "symlink"
      ? `await symlink(${JSON.stringify(victim)},path.join(root,'owned-work.json'));`
      : `await recordOwnedWorkState({status:'complete'});
const target=path.join(root,'owned-work.json'),state=JSON.parse(await (await import('node:fs/promises')).readFile(target,'utf8'));
${kind === "wrong-run" ? "state.runId='another-run';" : `state.deletionTarget=${JSON.stringify(victim)};`}
await writeFile(target,JSON.stringify(state));`;
    await writeFile(f.file, prelude + `test('invalid owned report',async()=>{${change}});`);
    const result = await run(f.file).result; await disposeRetained(t, result);
    assert.equal(result.child.exitCode, 0); assert.equal(result.passed, false); assert.equal(result.ownedWork, null);
    assert.equal(result.cleanup.status, "retained"); assert.equal(await readFile(victim, "utf8"), "keep");
  });
});

test("root mode or symlink replacement never permits deletion of a replacement/victim", async t => {
  for (const mode of ["mode", "symlink"]) await t.test(mode, async t => {
    const f = await fixture(t, ""), victim = path.join(f.directory, "victim"); await mkdir(victim); await writeFile(path.join(victim, "keep"), "keep");
    await writeFile(f.file, prelude + `test('root substitution',async()=>{await recordOwnedWorkState({status:'complete'});
 ${mode === "mode" ? "await chmod(root,0o755);" : `await rename(root,root+'-original');await symlink(${JSON.stringify(victim)},root);`}});`);
    const result = await run(f.file).result; await disposeRetained(t, result);
    if (mode === "symlink") cleanupByTest.get(t)!.push(() => rm(result.cleanup.root + "-original", { recursive: true, force: true }));
    assert.equal(result.passed, false); assert.ok(result.errors.includes("owner_root_identity_invalid"));
    assert.equal(result.cleanup.status, "retained"); assert.equal(await readFile(path.join(victim, "keep"), "utf8"), "keep");
  });
});

test("concurrent runs use distinct captured roots and ignore an environment deletion target", async t => {
  const f = await fixture(t, `test('native independent',async()=>{await recordOwnedWorkState({status:'complete'});});`);
  const victim = path.join(f.directory, "keep"); await writeFile(victim, "keep");
  const results = await Promise.all([run(f.file, { env: { ...process.env, STELLA_TEST_OWNER_ROOT: victim } }).result, run(f.file).result]);
  assert.notEqual(results[0].cleanup.root, results[1].cleanup.root);
  for (const result of results) { assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.cleanup.status, "removed"); }
  assert.equal(await readFile(victim, "utf8"), "keep");
});

test("CLI cancellation through actual npm/shell owned process groups stays failed and retains roots", { timeout: 30_000 }, async t => {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const layer of ["shell", "npm"]) await t.test(layer, async t => {
    const f = await fixture(t, waiting), command = [process.execPath, cli, "--test-reporter=tap", f.file].map(quote).join(" ");
    await writeFile(path.join(f.directory, "package.json"), JSON.stringify({ scripts: { owner: command } }));
    const userConfig = path.join(f.directory, "npm-user.conf"), globalConfig = path.join(f.directory, "npm-global.conf");
    await writeFile(userConfig, ""); await writeFile(globalConfig, "");
    const npm = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    const env = { PATH: process.env.PATH, HOME: f.directory, TMPDIR: f.directory, npm_config_offline: "true",
      npm_config_cache: path.join(f.directory, "npm-cache"), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_update_notifier: "false" };
    const child = layer === "npm" ? spawn(process.execPath, [npm, "run", "--silent", "owner"], { cwd: f.directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("/bin/sh", ["-c", command + " & child=$!; wait \"$child\""], { cwd: f.directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", sent = false;
    const ended = once(child, "close");
    child.stdout.on("data", bytes => { stdout += bytes; if (!sent && stdout.includes("CANCEL_READY")) { sent = true; process.kill(-child.pid!, "SIGTERM"); } });
    child.stderr.on("data", bytes => { stderr += bytes; });
    cleanupByTest.get(t)!.unshift(async () => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
      await ended;
    });
    const [code, signal] = await ended; assert.equal(sent, true, stderr); assert.ok(code !== 0 || signal !== null);
    const line = stderr.split("\n").find(value => value.startsWith("SDK_OWNER_RESULT "));
    assert.ok(line, stderr); const result = JSON.parse(line.slice(17)); await disposeRetained(t, result);
    assert.equal(result.passed, false); assert.equal(result.interrupted, "cancelled");
    assert.equal(result.cleanup.status, "retained"); assert.equal(result.child.exitCode, 0);
  });
});

/** Inject in an isolated probe process, not the test runner. The real lstat/rm,
 * supervisor, file process and receipt are used; only event ordering is forced. */
async function cleanupWindow(t: TestContext, mode: "cancel" | "log-error", phase: "before" | "after") {
  const f = await fixture(t, `test('synthetic complete',async()=>{await recordOwnedWorkState({status:'complete'});});`);
  const probe = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';import {Writable} from 'node:stream';
import {superviseOwnerTest} from ${JSON.stringify(helper)};
const actualLstat=fs.promises.lstat,actualRm=fs.promises.rm,controller=new AbortController(),observed=[];
const stdout=new Writable({write(_bytes,_encoding,done){done();}}),stderr=new Writable({write(_bytes,_encoding,done){done();}});
stdout.on('error',error=>observed.push(error.code));
let rootChecks=0,removalCalls=0,injected=false;
const isRoot=target=>path.basename(String(target)).startsWith('stella-sdk-owner-');
const inject=()=>{injected=true;${mode === "cancel" ? "controller.abort();" : "stdout.emit('error',Object.assign(new Error('synthetic late log error'),{code:'SYNTHETIC_PRE_DELETE_LOG_ERROR'}));"}};
fs.promises.lstat=async function(target,...rest){const value=await actualLstat.call(this,target,...rest);
if(isRoot(target)){rootChecks++;if(rootChecks===3&&${JSON.stringify(phase)}==='before')inject();}return value;};
fs.promises.rm=function(target,...rest){if(isRoot(target)){removalCalls++;const pending=actualRm.call(this,target,...rest);
if(${JSON.stringify(phase)}==='after')inject();return pending;}return actualRm.call(this,target,...rest);};
syncBuiltinESMExports();let result;
try{result=await superviseOwnerTest({args:['--test-reporter=tap',${JSON.stringify(f.file)}],signal:controller.signal,stdout,stderr,timeoutMs:5000});}
finally{fs.promises.lstat=actualLstat;fs.promises.rm=actualRm;syncBuiltinESMExports();stdout.destroy();stderr.destroy();}
let rootExists;try{await actualLstat(result.cleanup.root);rootExists=true;}catch(error){if(error.code!=='ENOENT')throw error;rootExists=false;}
console.log(JSON.stringify({rootChecks,removalCalls,injected,observed,rootExists,result}));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const [code, signal] = await once(child, "close"); assert.equal(code, 0, stderr); assert.equal(signal, null);
  const observed = JSON.parse(stdout);
  t.diagnostic(JSON.stringify({ cleanupWindow: { mode, phase, ...observed } }));
  await disposeRetained(t, observed.result); return observed;
}

for (const mode of ["cancel", "log-error"] as const) test(`last root validation ${mode} forbids starting deletion`, async t => {
  const observed = await cleanupWindow(t, mode, "before"), result = observed.result;
  assert.equal(observed.injected, true); assert.equal(observed.rootChecks, 3);
  assert.equal(result.child.exitCode, 0); assert.equal(result.child.closeObserved, true);
  assert.equal(result.passed, false); assert.equal(result.interrupted, mode === "cancel" ? "cancelled" : "log_failure");
  assert.equal(result.cleanup.status, "retained"); assert.equal(result.cleanup.started, false);
  assert.equal(observed.removalCalls, 0); assert.equal(observed.rootExists, true);
  if (mode === "log-error") {
    assert.deepEqual(observed.observed, ["SYNTHETIC_PRE_DELETE_LOG_ERROR"]);
    assert.ok(result.logErrors.includes("SYNTHETIC_PRE_DELETE_LOG_ERROR"));
  }
});

for (const mode of ["cancel", "log-error"] as const) test(`after removal starts ${mode} reports failure and actual cleanup`, async t => {
  const observed = await cleanupWindow(t, mode, "after"), result = observed.result;
  assert.equal(observed.injected, true); assert.equal(observed.rootChecks, 3); assert.equal(result.child.exitCode, 0);
  assert.equal(result.passed, false); assert.equal(result.interrupted, mode === "cancel" ? "cancelled" : "log_failure");
  assert.equal(result.cleanup.started, true); assert.equal(result.cleanup.status, "removed");
  assert.equal(observed.removalCalls, 1); assert.equal(observed.rootExists, false);
  if (mode === "log-error") assert.ok(result.logErrors.includes("SYNTHETIC_PRE_DELETE_LOG_ERROR"));
});
