import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installWorkspaceTestEntry } from "./workspace-test-entry-fixture.js";

const exec = promisify(execFile), scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test("direct test invocation in copied acceptance runners preserves cancellation, timeout and failure receipts", { timeout: 30_000 }, async t => {
  for (const [runner, mode] of [["experimental", "signal"], ["experimental", "timeout"], ["smoke", "signal"]]) await t.test(`${runner}/${mode}`, async t => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "stella-runner-chain-")), root = path.join(parent, "checkout"), host = path.join(root, "node_modules/openclaw");
    await mkdir(path.join(root, "scripts"), { recursive: true }); await mkdir(path.join(host, "dist/plugin-sdk"), { recursive: true });
    await cp(path.join(scripts, "lib"), path.join(root, "scripts/lib"), { recursive: true });
    const entry = runner === "experimental" ? "package-experimental-owner-chat.mjs" : "package-smoke.mjs";
    await cp(path.join(scripts, entry), path.join(root, "scripts", entry));
    const probeResult = path.join(parent, "supervisor-result.json"), readyFile = path.join(parent, "file-ready.json"), term = path.join(parent, "file-term.json"), calls = path.join(parent, "calls.jsonl");
    await installWorkspaceTestEntry(root, { "checkpoint-agent-supply.test.js": `import test from 'node:test';import fs from 'node:fs';import {recordOwnedWorkState,requireOwnedTestRoot} from '../../scripts/lib/sdk-owner-supervisor.mjs';
await requireOwnedTestRoot(import.meta.url);
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(term)},JSON.stringify({pid:process.pid,termReceived:true}));process.exit(0);});
test('synthetic waiting owner',async()=>{await recordOwnedWorkState({status:'complete'});fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({pid:process.pid}));process.kill(${process.pid},'SIGWINCH');await new Promise(()=>setInterval(()=>{},1000));});`,
      "other.test.js": "import test from 'node:test';test('second native file',()=>{});" });
    if (mode === "timeout") {
      const actual = new URL("../../scripts/lib/captured-command.mjs", import.meta.url).href;
      await writeFile(path.join(root, "scripts/lib/captured-command.mjs"), `import assert from 'node:assert/strict';import {captureCommand as real} from ${JSON.stringify(actual)};
export function captureCommand(command,args,options,capture){assert.equal(options.timeout,600000);assert.equal(options.maxBuffer,32*1024*1024);
return real(command,args,{...options,timeout:capture.stdoutPath.endsWith('test.stdout')?1500:options.timeout},capture);}`);
    }
    const cliFile = path.join(root, "scripts/run-workspace-tests.mjs");
    const cliBody = await readFile(cliFile, "utf8");
    await writeFile(cliFile, `import {writeFileSync,appendFileSync} from 'node:fs';process.env.STELLA_TEST_COMPILE_CALLS=${JSON.stringify(calls)};appendFileSync(${JSON.stringify(calls)},JSON.stringify(['test-direct'])+'\\n');\n` +
      cliBody.replace('  process.stderr.write(`WORKSPACE_TEST_RESULT', `  writeFileSync(${JSON.stringify(probeResult)},JSON.stringify(result));process.kill(${process.pid},'SIGWINCH');\n  process.stderr.write(\`WORKSPACE_TEST_RESULT`));
    await writeFile(path.join(root, "scripts/check.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');`);
    const pkg = { name: "@tower1229/stella-core", type: "module", version: "0.1.0-alpha.0", devDependencies: { openclaw: "2026.10.8" },
      openclaw: { build: { openclawVersion: "2026.10.8", pluginSdkVersion: "2026.10.8" } },
      scripts: { check: `${quote(process.execPath)} scripts/check.cjs check`, "check:schemas": `${quote(process.execPath)} scripts/check.cjs schemas`,
        test: "node scripts/run-workspace-tests.mjs" } };
    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "": { name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies }, "node_modules/openclaw": { version: "2026.10.8" } } }));
    await writeFile(path.join(host, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.8", exports: { "./plugin-sdk/plugin-entry": "./dist/plugin-sdk/plugin-entry.js" } }));
    await writeFile(path.join(host, "dist/plugin-sdk/plugin-entry.js"), "throw Error('Synthetic metadata must not load SDK');");
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n.artifacts/\ndist/\n.test-dist/\n");
    await writeFile(path.join(root, ".npmrc"), "offline=true\nupdate-notifier=false\n");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: parent, TMPDIR: parent, npm_config_offline: "true", npm_config_update_notifier: "false",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", STELLA_TEST_COMPILE_CALLS: calls, npm_execpath: path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js") };
    for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "runner chain fixture"]]) await exec("git", args, { cwd: root, env });
    const command = path.join(root, "scripts", entry), args = runner === "smoke" ? [command, "--dreaming-disabled", "--prepare", path.join(parent, "prepared")] : [command];
    let ack = false, ready = false, child: ReturnType<typeof spawn>, resolveAck!: (value: any) => void;
    const acknowledged = new Promise<any>(resolve => { resolveAck = resolve; });
    const listener = () => { void readFile(probeResult, "utf8").then(text => { ack = true; resolveAck(JSON.parse(text)); }, async () => {
      try { await readFile(readyFile); if (!ready) { ready = true; if (mode === "signal") child.kill("SIGTERM"); } } catch { /* This signal belongs to another synthetic observation. */ }
    }); };
    process.on("SIGWINCH", listener);
    child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const ended = once(child, "close"); let stderr = "";
    child.stdout!.resume(); child.stderr!.on("data", bytes => { stderr += bytes; });
    t.after(async () => {
      if (!ack) try { process.kill(-child.pid!, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
      await ended; process.removeListener("SIGWINCH", listener); await rm(parent, { recursive: true, force: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([acknowledged, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`No terminal supervisor acknowledgement; ready=${ready}; ${stderr}`)), 5000);
    })]).finally(() => clearTimeout(timer));
    const [code, signal] = await ended;
    assert.equal(ready, true, stderr); assert.equal(code, 1, stderr); assert.equal(signal, null);
    assert.equal(result.passed, false); assert.equal(result.interrupted, "cancelled"); assert.equal(result.cleanup.status, "retained");
    assert.equal(JSON.parse(await readFile(term, "utf8")).termReceived, true);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["check"], ["schemas"], ["test-direct"], ["compile-build"], ["compile-test"]]);
    const ownerPid = JSON.parse(await readFile(readyFile, "utf8")).pid;
    assert.throws(() => process.kill(ownerPid, 0), { code: "ESRCH" });
    const base = runner === "experimental" ? path.join(root, ".artifacts/experimental-owner-chat") : parent;
    const directory = runner === "experimental" ? (await readdir(base))[0]! : (await readdir(base)).find(name => name.startsWith("stella-core-package-smoke-"))!;
    const receipt = JSON.parse(await readFile(path.join(base, directory, runner === "experimental" ? "receipt.json" : "package-smoke.json"), "utf8"));
    assert.equal(receipt.status, mode === "timeout" ? "failed" : "cancelled"); assert.equal(receipt.fullMemoryAccepted, false); assert.equal(receipt.versions.consumer, null);
    assert.deepEqual(receipt.checks, [{ script: "check", passed: true }, { script: "check:schemas", passed: true }]);
    t.diagnostic(JSON.stringify({ runner, mode, receiptStatus: receipt.status, fileReceivedTerm: true, supervisor: result.child, interrupted: result.interrupted, rootRetained: true }));
  });
});
