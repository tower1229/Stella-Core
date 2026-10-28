import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const exec = promisify(execFile), helper = new URL("../../scripts/lib/captured-command.mjs", import.meta.url).href;
const marker = "SYNTHETIC_PARTIAL_STDOUT", stderrMarker = "SYNTHETIC_PARTIAL_STDERR";
async function temporary(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-captured-command-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

/** Each helper runs in its own Node process so the test runner cannot keep an
 * otherwise unsettled top-level await alive. No npm, SDK or Host is executed. */
test("captured command settles normal, failure, timeout, cancellation and log-error paths without exit13", async t => {
  for (const mode of ["normal", "exit7", "exit13", "timeout", "timeout-exit0", "cancel", "cancel-exit0", "incomplete-stdio", "log-error", "exit7-log-error", "open-error", "maxBuffer", "drain-timeout"]) {
    await t.test(mode, async t => {
      const root = await temporary(t), stdoutPath = path.join(root, mode === "open-error" ? "missing/stdout" : "stdout"), stderrPath = path.join(root, "stderr");
      const worker = `${mode.endsWith("-exit0") ? "process.on('SIGTERM',()=>process.exit(0));" : ""}
process.stdout.write(${JSON.stringify(marker + "\n")});process.stderr.write(${JSON.stringify(stderrMarker + "\n")});
${mode.startsWith("exit7") ? "process.exitCode=7;" : mode === "exit13" ? "process.exitCode=13;" :
mode.startsWith("timeout") || mode.startsWith("cancel") ? "setInterval(()=>{},1000);" :
mode === "incomplete-stdio" ? "setTimeout(()=>process.exit(0),50);" :
mode === "maxBuffer" ? "setTimeout(()=>process.stdout.write('x'.repeat(131072)),30);" : ""}`;
      const script = `import {captureCommand} from ${JSON.stringify(helper)};
import {Writable} from 'node:stream';import {createWriteStream,appendFileSync} from 'node:fs';
process.on('unhandledRejection',error=>{console.error('UNHANDLED_REJECTION',error);process.exitCode=99;});
const children=new Set(), mode=${JSON.stringify(mode)}, out=${JSON.stringify(stdoutPath)}, err=${JSON.stringify(stderrPath)};
const createLog=file=>file===out&&(mode.includes('log-error')||mode==='drain-timeout')?new Writable({
write(chunk,encoding,done){try{appendFileSync(file,chunk);done();}catch(error){done(error);}},
final(done){if(mode!=='drain-timeout')setTimeout(()=>done(Object.assign(new Error('synthetic log failure'),{code:'ELOGTEST'})),30);}
}):createWriteStream(file);
const pending=captureCommand(process.execPath,['-e',${JSON.stringify(worker)}],{timeout:mode.startsWith('timeout')?1000:3000,maxBuffer:mode==='maxBuffer'?1024:1048576},
{stdoutPath:out,stderrPath:err,children,createLog,drainTimeoutMs:mode==='drain-timeout'?30:1000});
if(mode.startsWith('cancel'))[...children][0].stdout.once('data',()=>[...children][0].kill('SIGTERM'));
if(mode==='incomplete-stdio')[...children][0].stdout.once('data',()=>[...children][0].stdout.destroy());
try{const result=await pending;console.log(JSON.stringify({passed:true,capture:result.capture,children:children.size}));}
catch(error){console.log(JSON.stringify({passed:false,code:error.code,signal:error.signal,killed:error.killed,capture:error.capture,
partialStdoutPreserved:error.stdout?.includes(${JSON.stringify(marker)}),children:children.size}));process.exitCode=1;}`;
      let output = "", stderr = "", code = 0;
      try { const result = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 }); output = result.stdout; stderr = result.stderr; }
      catch (error: any) { output = error.stdout; stderr = error.stderr; code = error.code; }
      assert.equal(code, mode === "normal" ? 0 : 1, stderr);
      assert.doesNotMatch(stderr, /unsettled top-level await|UNHANDLED_REJECTION|UnhandledPromiseRejection/);
      const result = JSON.parse(output.trim()); assert.equal(result.children, 0); assert.equal(result.passed, mode === "normal");
      if (mode !== "open-error") {
        assert.ok((await readFile(stdoutPath, "utf8")).includes(marker));
        assert.ok((await readFile(stderrPath, "utf8")).includes(stderrMarker));
      } else assert.ok(result.capture.logErrors.some((error: any) => error.code === "ENOENT"));
      if (mode === "normal") assert.equal(result.capture.childExit.code, 0);
      if (mode.startsWith("exit7")) { assert.equal(result.code, 7); assert.equal(result.capture.childExit.code, 7); assert.equal(result.partialStdoutPreserved, true); }
      if (mode === "exit13") { assert.equal(result.code, 13); assert.equal(result.capture.childExit.code, 13); }
      if (mode === "timeout" || mode === "cancel") {
        assert.equal(result.code, null); assert.equal(result.signal, "SIGTERM"); assert.equal(result.killed, true);
        assert.equal(result.capture.childExit.signal, "SIGTERM"); assert.equal(result.partialStdoutPreserved, true);
      }
      if (mode === "timeout") assert.equal(result.capture.stdioComplete, false);
      if (mode.endsWith("-exit0")) {
        assert.equal(result.code, "ERR_CAPTURE_COMMAND_INTERRUPTED");
        assert.deepEqual(result.capture.childExit, { code: 0, signal: null, killed: true });
        assert.equal(result.capture.stdioComplete, mode === "cancel-exit0"); assert.equal(result.partialStdoutPreserved, true);
      }
      if (mode === "incomplete-stdio") {
        assert.equal(result.code, "ERR_CAPTURE_STDIO_INCOMPLETE");
        assert.deepEqual(result.capture.childExit, { code: 0, signal: null, killed: false });
        assert.equal(result.capture.stdioComplete, false); assert.equal(result.partialStdoutPreserved, true);
      }
      if (mode === "maxBuffer") { assert.equal(result.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"); assert.equal(result.partialStdoutPreserved, true); }
      if (mode.includes("log-error")) assert.ok(result.capture.logErrors.some((error: any) => error.code === "ELOGTEST"));
      if (mode === "log-error") { assert.equal(result.capture.childExit.code, 0); assert.equal(result.code, "ERR_CAPTURE_LOG_FAILURE"); }
      if (mode === "drain-timeout") assert.ok(result.capture.logErrors.some((error: any) => error.code === "ERR_CAPTURE_LOG_DRAIN_TIMEOUT"));
      assert.equal(result.capture.logsDrained, !mode.includes("log-error") && mode !== "drain-timeout" && mode !== "open-error");
    });
  }
});

async function runnerFixture(t: TestContext, mode: string) {
  const parent = await temporary(t), root = path.join(parent, "checkout"), host = path.join(root, "node_modules/openclaw");
  await mkdir(path.join(root, "scripts"), { recursive: true }); await mkdir(path.join(host, "dist/plugin-sdk"), { recursive: true });
  await cp(new URL("../../scripts/package-experimental-owner-chat.mjs", import.meta.url), path.join(root, "scripts/package-experimental-owner-chat.mjs"));
  await cp(new URL("../../scripts/lib", import.meta.url), path.join(root, "scripts/lib"), { recursive: true });
  // Only the copied test dependency shortens execution limits or injects I/O
  // faults. The unmodified runner must still supply its production defaults.
  await writeFile(path.join(root, "scripts/lib/captured-command.mjs"), `import assert from 'node:assert/strict';
import {Writable} from 'node:stream';import {appendFileSync,createWriteStream} from 'node:fs';
import {captureCommand as real} from ${JSON.stringify(helper)};
export function captureCommand(command,args,options,capture){
assert.equal(options.timeout,600000);assert.equal(options.maxBuffer,32*1024*1024);
const mode=${JSON.stringify(mode)},createLog=file=>mode==='log-error'&&file===capture.stdoutPath?new Writable({
write(chunk,encoding,done){appendFileSync(file,chunk);done();},
final(done){setTimeout(()=>done(Object.assign(new Error('synthetic runner log error'),{code:'ELOGTEST'})),30);}
}):createWriteStream(file);
return real(command,args,{...options,timeout:mode==='timeout'||mode==='timeout-exit0'&&args.includes('test')?1000:options.timeout,maxBuffer:mode==='maxBuffer'?1024:options.maxBuffer},{...capture,createLog});}`);
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n.artifacts/\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@tower1229/stella-core", version: "0.1.0-alpha.0",
    devDependencies: { openclaw: "2026.10.8" }, openclaw: { build: { openclawVersion: "2026.10.8", pluginSdkVersion: "2026.10.8" } } }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: {
    "": { name: "@tower1229/stella-core", version: "0.1.0-alpha.0", devDependencies: { openclaw: "2026.10.8" } }, "node_modules/openclaw": { version: "2026.10.8" },
  } }));
  await writeFile(path.join(host, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.8", exports: { "./plugin-sdk/plugin-entry": "./dist/plugin-sdk/plugin-entry.js" } }));
  await writeFile(path.join(host, "dist/plugin-sdk/plugin-entry.js"), "throw Error('Metadata fixture must not execute SDK');");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "runner fixture"]])
    await exec("git", args, { cwd: root, env });
  const fakeNpm = path.join(parent, "npm.cjs"), calls = path.join(parent, "npm-calls.jsonl");
  await writeFile(fakeNpm, `const args=process.argv.slice(2);require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(${JSON.stringify(mode)}==='timeout-exit0'){
if(args.length!==3||args[0]!=='run'||args[2]!=='--silent'||!['check','check:schemas','test'].includes(args[1]))throw Error('Unexpected command');
if(args[1]!=='test')process.exit(0);
}else if(JSON.stringify(args)!==JSON.stringify(['run','check','--silent']))throw Error('Unexpected command');
${mode.endsWith("-exit0") ? "process.on('SIGTERM',()=>process.exit(0));" : ""}
process.stdout.write(${JSON.stringify(marker + "\n")});process.stderr.write(${JSON.stringify(stderrMarker + "\n")});
${mode.startsWith("cancel") || mode.startsWith("timeout") ? "setInterval(()=>{},1000);" : mode === "maxBuffer"
    ? "setTimeout(()=>process.stdout.write('x'.repeat(131072)),30);" : mode === "log-error" ? "process.exitCode=0;" : "process.exitCode=13;"}`);
  return { parent, root, calls, env: { ...env, npm_execpath: fakeNpm } };
}

test("actual Experimental runner saves failed/cancelled terminal receipts with original child facts", async t => {
  for (const mode of ["exit13", "timeout", "timeout-exit0", "cancel", "cancel-exit0", "log-error", "maxBuffer"]) await t.test(mode, async t => {
    const f = await runnerFixture(t, mode), base = path.join(f.root, ".artifacts/experimental-owner-chat");
    const pending = exec(process.execPath, [path.join(f.root, "scripts/package-experimental-owner-chat.mjs")], { cwd: f.root, env: f.env, timeout: 10_000 });
    const outcome = pending.then(result => ({ code: 0, ...result }), (error: any) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    try {
      if (mode.startsWith("cancel")) {
        let ready = false;
        for (let attempt = 0; attempt < 500 && pending.child.exitCode === null; attempt++) {
          try { const [directory] = await readdir(base); ready = (await readFile(path.join(base, directory!, "check.stdout"), "utf8")).includes(marker); } catch { /* Child has not opened the log yet. */ }
          if (ready) break; await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(ready, true); pending.child.kill("SIGTERM");
      }
      const ended = await outcome; assert.equal(ended.code, 1, ended.stderr);
      assert.doesNotMatch(ended.stderr, /unsettled top-level await|UNHANDLED_REJECTION|UnhandledPromiseRejection/);
      const [directory] = await readdir(base), out = path.join(base, directory!), receipt = JSON.parse(await readFile(path.join(out, "receipt.json"), "utf8"));
      assert.equal(receipt.status, mode.startsWith("cancel") ? "cancelled" : "failed"); assert.ok(Date.parse(receipt.endedAt));
      assert.equal(receipt.steps.length, mode === "timeout-exit0" ? 3 : 1); const step = receipt.steps.at(-1);
      assert.equal(step.status, receipt.status); assert.ok(Date.parse(step.endedAt)); assert.equal(step.capture.logsDrained, mode !== "log-error");
      if (mode === "exit13") { assert.equal(step.exitCode, 13); assert.equal(step.errorCode, 13); }
      if (mode === "cancel" || mode === "timeout") { assert.equal(step.exitCode, null); assert.equal(step.signal, "SIGTERM"); assert.equal(step.killed, true); }
      if (mode === "timeout") assert.equal(step.capture.stdioComplete, false);
      if (mode.endsWith("-exit0")) {
        assert.equal(step.exitCode, 0); assert.equal(step.signal, null); assert.equal(step.killed, true);
        assert.equal(step.errorCode, "ERR_CAPTURE_COMMAND_INTERRUPTED"); assert.equal(step.capture.stdioComplete, mode === "cancel-exit0");
      }
      if (mode === "log-error") { assert.equal(step.exitCode, 0); assert.equal(step.errorCode, "ERR_CAPTURE_LOG_FAILURE"); assert.ok(step.capture.logErrors.some((error: any) => error.code === "ELOGTEST")); }
      if (mode === "maxBuffer") assert.equal(step.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.equal(receipt.experimentalOwnerChatAccepted, false); assert.equal(receipt.fullMemoryAccepted, false); assert.equal(receipt.versions.consumer, null);
      assert.deepEqual(receipt.checks, mode === "timeout-exit0" ? [{ script: "check", passed: true }, { script: "check:schemas", passed: true }] : []);
      assert.equal(receipt.tests, undefined); assert.equal(receipt.testTotals, undefined);
      assert.deepEqual((await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
        (mode === "timeout-exit0" ? ["check", "check:schemas", "test"] : ["check"]).map(script => ["run", script, "--silent"]));
      assert.ok((await readFile(path.join(out, `${step.name}.stdout`), "utf8")).includes(marker));
      assert.ok((await readFile(path.join(out, `${step.name}.stderr`), "utf8")).includes(stderrMarker));
    } finally {
      if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill("SIGTERM");
      await outcome;
    }
  });
});
