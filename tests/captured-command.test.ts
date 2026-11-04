import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      // Hold the second stream until the parent acknowledges the first. This
      // forces both legal stream orders without depending on scheduler delays.
      const firstStream = mode === "cancel-exit0" ? "stderr" : "stdout", secondStream = firstStream === "stdout" ? "stderr" : "stdout";
      const markers = { stdout: marker, stderr: stderrMarker };
      const writes = mode.startsWith("cancel")
        ? `process.${firstStream}.write(${JSON.stringify(markers[firstStream] + "\n")});process.stdin.once('data',()=>{process.${secondStream}.write(${JSON.stringify(markers[secondStream] + "\n")});process.stdin.pause();});`
        : `process.stdout.write(${JSON.stringify(marker + "\n")});process.stderr.write(${JSON.stringify(stderrMarker + "\n")});`;
      const worker = `${mode.endsWith("-exit0") ? "process.on('SIGTERM',()=>process.exit(0));" : ""}
${writes}
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
const cancelReadiness={stdout:false,stderr:false,signalsSent:0};
if(mode.startsWith('cancel')){
 const child=[...children][0],seen={stdout:'',stderr:''},markers={stdout:${JSON.stringify(marker)},stderr:${JSON.stringify(stderrMarker)}};let released=false;
 for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{
  seen[stream]+=chunk;cancelReadiness[stream]=seen[stream].includes(markers[stream]);
  if(!released&&(cancelReadiness.stdout||cancelReadiness.stderr)){released=true;child.stdin.end('release second marker');}
  if(cancelReadiness.stdout&&cancelReadiness.stderr&&!cancelReadiness.signalsSent){cancelReadiness.signalsSent++;child.kill('SIGTERM');}
 });
}
if(mode==='incomplete-stdio')[...children][0].stdout.once('data',()=>[...children][0].stdout.destroy());
try{const result=await pending;console.log(JSON.stringify({passed:true,capture:result.capture,children:children.size,cancelReadiness}));}
catch(error){console.log(JSON.stringify({passed:false,code:error.code,signal:error.signal,killed:error.killed,capture:error.capture,
partialStdoutPreserved:error.stdout?.includes(${JSON.stringify(marker)}),children:children.size,cancelReadiness}));process.exitCode=1;}`;
      let output = "", stderr = "", code = 0;
      try { const result = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 }); output = result.stdout; stderr = result.stderr; }
      catch (error: any) { output = error.stdout; stderr = error.stderr; code = error.code; }
      assert.equal(code, mode === "normal" ? 0 : 1, stderr);
      assert.doesNotMatch(stderr, /unsettled top-level await|UNHANDLED_REJECTION|UnhandledPromiseRejection/);
      const result = JSON.parse(output.trim()); assert.equal(result.children, 0); assert.equal(result.passed, mode === "normal");
      if (mode.startsWith("cancel")) assert.deepEqual(result.cancelReadiness, { stdout: true, stderr: true, signalsSent: 1 });
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
