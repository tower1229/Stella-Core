import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { installWorkspaceTestEntry } from "./workspace-test-entry-fixture.js";

const exec = promisify(execFile);
const { compiledTestSuite } = await import(new URL("../../scripts/lib/compiled-test-suite.mjs", import.meta.url).href);
const simple = "import test from 'node:test';test('synthetic extra file',()=>{});";

async function checkout(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-workspace-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installWorkspaceTestEntry(root, files);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", STELLA_TEST_COMPILE_CALLS: path.join(root, "calls.jsonl") };
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT; delete (env as NodeJS.ProcessEnv).NODE_OPTIONS;
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "offline entry fixture"]]) await exec("git", args, { cwd: root, env });
  return { root, env, run: () => exec(process.execPath, [path.join(root, "scripts/run-workspace-tests.mjs")], { cwd: root, env, timeout: 15_000 }) };
}

function owner(shutdownFailure = false) {
  return `import assert from 'node:assert/strict';import test,{after} from 'node:test';import {mkdtemp,writeFile} from 'node:fs/promises';import path from 'node:path';
import {requireOwnedTestRoot} from '../../scripts/lib/sdk-owner-supervisor.mjs';import {createOwnedWorkSummary} from '../../scripts/lib/owned-work-summary.mjs';
const root=await requireOwnedTestRoot(import.meta.url),summary=createOwnedWorkSummary();after(()=>summary.publish());
for(let i=0;i<2;i++)test('fixture '+i,async t=>{const fixture=summary.register();const directory=await mkdtemp(path.join(root,'fixture-'));assert.equal(path.dirname(directory),root);
await writeFile(path.join(directory,'synthetic-sdk-owner'),'retained until process exit');
t.after(()=>fixture.finish({stopFailures:${shutdownFailure}&&i===0?1:0}));assert.ok(true);});`;
}

test("workspace test entry compiles twice and supervises the complete native file set", async t => {
  const f = await checkout(t, { "ordinary.test.js": simple, "extra.test.js": simple, "nested/not-selected.test.js": "throw Error('Nested must not run')", "support.js": "throw Error('Support must not run')" });
  const { stdout, stderr } = await f.run();
  assert.match(stdout, /# tests 2\n# suites 0\n# pass 2\n# fail 0/);
  assert.deepEqual((await readFile(f.env.STELLA_TEST_COMPILE_CALLS, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["compile-build"], ["compile-test"]]);
  const result = JSON.parse(stderr.split("WORKSPACE_TEST_RESULT ")[1]!);
  assert.equal(result.passed, true); assert.equal(result.ownedWork, null);
  assert.deepEqual(result.cleanup, { root: null, status: "not_applicable", started: false });
  assert.equal(result.group.confirmedGone, true); assert.equal(result.stdioComplete, true);
  for (const output of ["dist", ".test-dist"]) assert.equal(JSON.parse(await readFile(path.join(f.root, output, "build-identity.json"), "utf8")).sourceClean, false);
});

test("either compilation failure blocks stale tests and supervision", async t => {
  for (const mode of ["build", "test"]) await t.test(mode, async t => {
    const f = await checkout(t, { "owned-resource.test.js": owner() });
    for (const output of ["dist", ".test-dist/tests"]) await mkdir(path.join(f.root, output), { recursive: true });
    await writeFile(path.join(f.root, ".test-dist/tests/owned-resource.test.js"), "throw Error('Stale file executed')");
    f.env = Object.assign(f.env, { STELLA_TEST_COMPILE_FAIL: mode });
    await assert.rejects(f.run(), (error: any) => {
      assert.equal(error.code, 1); assert.match(error.stderr, /TypeScript compiler failed \(7\)/); assert.doesNotMatch(error.stderr, /WORKSPACE_TEST_RESULT|Stale file executed/); return true;
    });
    assert.equal((await readFile(f.env.STELLA_TEST_COMPILE_CALLS, "utf8")).trim().split("\n").length, mode === "build" ? 1 : 2);
  });
});

test("compiled enumeration accepts ordinary tests without an owner and rejects empty or symlink sets", async t => {
  const f = await checkout(t, {}), directory = path.join(f.root, ".test-dist/tests"); await mkdir(directory, { recursive: true });
  await assert.rejects(compiledTestSuite(f.root), /compiled_test_suite_empty/);
  await writeFile(path.join(directory, "other.test.js"), simple);
  assert.deepEqual(await compiledTestSuite(f.root), { files: [path.join(directory, "other.test.js")] });
  await symlink(path.join(directory, "other.test.js"), path.join(directory, "linked.test.js"));
  await assert.rejects(compiledTestSuite(f.root), /compiled_test_file_invalid/);
});

test("workspace entry cancellation joins its compiler even when TERM produces exit0", { timeout: 10_000 }, async t => {
  const f = await checkout(t, {});
  await writeFile(path.join(f.root, "node_modules/typescript/bin/tsc"), `process.on('SIGTERM',()=>{process.stdout.write('COMPILER_TERM\\n');process.exit(0);});process.stdout.write('COMPILER_READY '+process.pid+'\\n');setInterval(()=>{},1000);`);
  const work = exec(process.execPath, [path.join(f.root, "scripts/run-workspace-tests.mjs")], { cwd: f.root, env: f.env, timeout: 8000 });
  const outcome = work.then(() => assert.fail("cancelled compilation cannot succeed"), error => error);
  let observed = "", compilerPid: number | undefined;
  work.child.stdout!.on("data", bytes => {
    observed += bytes;
    const match = /COMPILER_READY ([0-9]+)\n/.exec(observed);
    if (match && !compilerPid) { compilerPid = Number(match[1]); work.child.kill("SIGTERM"); }
  });
  const error = await outcome;
  assert.equal(error.code, 1); assert.ok(compilerPid); assert.match(error.stdout, /COMPILER_TERM/);
  assert.match(error.stderr, /WORKSPACE_TEST_ERROR/); assert.doesNotMatch(error.stderr, /WORKSPACE_TEST_RESULT/);
  assert.throws(() => process.kill(compilerPid!, 0), { code: "ESRCH" });
  t.diagnostic(JSON.stringify({ compilerPid, goneBeforeReturn: true, entryExit: error.code }));
});

test("direct owner without a legal supervisor root fails before fixture allocation", async t => {
  const f = await checkout(t, { "owned-resource.test.js": owner() });
  await exec(process.execPath, [path.join(f.root, "scripts/compile.mjs"), "test"], { cwd: f.root, env: f.env });
  const env = { ...f.env }; for (const key of ["STELLA_TEST_OWNER_ROOT", "STELLA_TEST_OWNER_RUN", "STELLA_TEST_OWNER_FILE"]) delete (env as NodeJS.ProcessEnv)[key];
  await assert.rejects(exec(process.execPath, ["--test", path.join(f.root, ".test-dist/tests/owned-resource.test.js")], { cwd: f.root, env }), (error: any) => {
    assert.match(error.stdout + error.stderr, /owned_test_root_required/); assert.doesNotMatch(error.stdout, /ok 1 - fixture/); return true;
  });
});
