import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { fileManifest, sourceIdentity, assertSourceUnchanged, sha256, installedPackageRoot } from "./lib/package-evidence.mjs";
import { assertExperimentalReports, EXPERIMENTAL_SCOPE, NON_ACCEPTANCE } from "./lib/experimental-owner-chat-evidence.mjs";

assert.equal(process.argv.length, 2, "Usage: npm run verify:experimental");
assert.ok(process.env.npm_execpath, "Run through npm");
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const source = await sourceIdentity(root);
const base = path.join(root, ".artifacts/experimental-owner-chat"); await mkdir(base, { recursive: true, mode: 0o700 });
assert.equal(await realpath(base), base, "Artifacts must stay in the non-symlink project tree");
const out = path.join(base, `${Date.now()}-${process.pid}`); await mkdir(out, { mode: 0o700 });
const receipt = { schemaVersion: "stella.experimental-owner-chat-ci/v1", scope: EXPERIMENTAL_SCOPE, status: "running",
  coreRevision: source.coreRevision, sourceManifestSha256: source.digest, sourceClean: true,
  hostVersion: "2026.8.2", hostFullTreeVerified: false, fixture: "synthetic", finalModel: "loopback-synthetic",
  ...NON_ACCEPTANCE, experimentalOwnerChatAccepted: false, checks: [], steps: [], evidenceDirectory: out,
  completeCapabilityAssessment: { workflow: "Full capability assessment", status: "separate; not implied by this verdict" } };
const save = async () => { await writeFile(path.join(out, "receipt.json.partial"), JSON.stringify(receipt, null, 2)); await rename(path.join(out, "receipt.json.partial"), path.join(out, "receipt.json")); };
const exec = promisify(execFile), children = new Set();
for (const name of ["home", "tmp", "cache"]) await mkdir(path.join(out, name), { mode: 0o700 });
// Match ordinary OS temp semantics for extensionless CommonJS test executables.
await writeFile(path.join(out, "tmp/package.json"), JSON.stringify({ type: "commonjs" }));
for (const name of ["npm-user.conf", "npm-global.conf"]) await writeFile(path.join(out, name), "");
// Deliberately do not forward provider keys, proxies, user npmrc or Host state.
const env = { PATH: process.env.PATH, LANG: "en_US.UTF-8", HOME: path.join(out, "home"), TMPDIR: path.join(out, "tmp"),
  XDG_CACHE_HOME: path.join(out, "cache"), npm_config_cache: process.env.STELLA_EXPERIMENTAL_NPM_CACHE ?? path.join(out, "cache/npm"),
  npm_config_userconfig: path.join(out, "npm-user.conf"), npm_config_globalconfig: path.join(out, "npm-global.conf"),
  npm_config_audit: "false", npm_config_fund: "false", NODE_DISABLE_COMPILE_CACHE: "1",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
  OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_CRON: "1", OPENCLAW_NO_AUTO_UPDATE: "1",
  ...(process.env.GITHUB_ACTIONS === "true" ? { GITHUB_ACTIONS: "true" } : {}) };
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = signal; for (const child of children) child.kill(signal);
});
async function run(name, command, args, extra = {}) {
  assert.equal(interrupted, undefined, `Interrupted: ${interrupted}`);
  const step = { name, command, args, status: "running", startedAt: new Date().toISOString() };
  receipt.steps.push(step); await save(); process.stderr.write(`${name} started\n`);
  const logs = [createWriteStream(path.join(out, `${name}.stdout`)), createWriteStream(path.join(out, `${name}.stderr`))];
  const pending = exec(command, args, { cwd: root, env, timeout: 600_000, maxBuffer: 32 * 1024 * 1024, ...extra });
  const child = pending.child; children.add(child); child.stdout.pipe(logs[0]); child.stderr.pipe(logs[1]);
  try { const result = await pending; step.status = "passed"; return result.stdout; }
  catch (error) { step.status = "failed"; step.exitCode = error.code; throw error; }
  finally { children.delete(child); await Promise.all(logs.map(log => finished(log))); step.endedAt = new Date().toISOString(); await save(); process.stderr.write(`${name} ${step.status}\n`); }
}
const npm = (name, args, extra) => run(name, process.execPath, [process.env.npm_execpath, ...args], extra);
let artifact, packed, installed, installedBefore;
try {
  await save();
  for (const script of ["check", "check:schemas", "test"]) {
    await npm(script.replaceAll(":", "-"), ["run", script, "--silent"]); receipt.checks.push({ script, passed: true });
  }
  await assertSourceUnchanged(root, source);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "dist/build-identity.json"), "utf8")), { coreRevision: source.coreRevision, sourceClean: true });
  [packed] = JSON.parse(await npm("pack", ["pack", "--json", "--ignore-scripts", "--pack-destination", out]));
  artifact = path.join(out, packed.filename); receipt.artifactSha256 = sha256(await readFile(artifact)); receipt.packageIntegrity = packed.integrity;
  const files = packed.files.map(entry => entry.path);
  for (const required of ["dist/src/plugin.js", "docs/EXPERIMENTAL-OWNER-CHAT.md", "docs/CHECKPOINT-WORK-SUPPLY.md", "docs/CHECKPOINT-UNDERSTANDING-SUPPLY.md", "docs/CHECKPOINT-CORRECTION-WRITER.md"]) assert.ok(files.includes(required), `Required installed package file missing: ${required}`);
  assert.ok(!files.some(file => /^(tests|\.artifacts|dist\/tests)\//.test(file)));
  const consumer = path.join(out, "consumer"); await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await npm("install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", artifact, "openclaw@2026.8.2"], { cwd: consumer });
  installed = await installedPackageRoot(consumer, "@tower1229/stella-core");
  const hostRoot = await installedPackageRoot(consumer, "openclaw");
  const lock = JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@tower1229/stella-core"].integrity, packed.integrity);
  assert.equal(lock.packages["node_modules/openclaw"].version, receipt.hostVersion);
  assert.match(lock.packages["node_modules/openclaw"].integrity, /^sha512-/);
  receipt.hostPackageIntegrity = lock.packages["node_modules/openclaw"].integrity;
  receipt.consumerLockSha256 = sha256(await readFile(path.join(consumer, "package-lock.json")));
  await cp(path.join(consumer, "package-lock.json"), path.join(out, "consumer-package-lock.json"));
  installedBefore = await fileManifest(installed, files);
  assert.deepEqual(await fileManifest(root, files.filter(file => file !== "package.json")), await fileManifest(installed, files.filter(file => file !== "package.json")));
  assert.deepEqual(JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")), JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  receipt.installedPackageRoot = installed; receipt.installedFilesSha256 = installedBefore.digest;
  const hostFiles = ["package.json", "openclaw.mjs"], hostBefore = await fileManifest(hostRoot, hostFiles);
  receipt.hostPublicFiles = hostBefore;
  const isolatedEnv = async name => {
    const state = path.join(out, `state-${name}`), home = path.join(out, `home-${name}`);
    for (const dir of [state, home, path.join(state, "tmp"), path.join(state, "cache")]) await mkdir(dir, { mode: 0o700 });
    return { ...env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      TMPDIR: path.join(state, "tmp"), XDG_CACHE_HOME: path.join(state, "cache"), STELLA_PROBE_HOST_ROOT: hostRoot,
      STELLA_AGENT_SUPPLY_ARTIFACTS: out, STELLA_AGENT_SUPPLY_COMPILED: path.join(root, ".test-dist"), STELLA_AGENT_SUPPLY_PACKAGE_ROOT: installed,
      STELLA_V3_ARTIFACTS: out, STELLA_V3_ATTEMPT: "a1" };
  };
  // Complete the stock public launcher's deferred installation before probing.
  const version = await run("host-version", process.execPath, [path.join(hostRoot, "openclaw.mjs"), "--version"], { env: await isolatedEnv("version") });
  assert.ok(version.includes(receipt.hostVersion)); receipt.hostVersionOutput = version.trim();
  const reports = {};
  for (const [name, script, args, reportPath] of [
    ["continuous", "probe-checkpoint-agent-supply.mjs", ["ci", "a1", "continuous_chat"], "host-probe-ci/result.json"],
    ["v3", "probe-checkpoint-v3-installed.mjs", [], "host-v3-a1/result.json"],
  ]) {
    await run(`host-${name}`, process.execPath, [path.join(root, "scripts", script), ...args], { env: await isolatedEnv(name) });
    reports[name] = JSON.parse(await readFile(path.join(out, reportPath), "utf8"));
    receipt[`${name}Report`] = { path: reportPath, sha256: sha256(await readFile(path.join(out, reportPath))) };
  }
  await run("host-snapshot-import", process.execPath, [path.join(root, "scripts/probe-checkpoint-v3-installed.mjs")], {
    env: { ...await isolatedEnv("snapshot-import"), STELLA_V3_ATTEMPT: "a2", STELLA_V3_SNAPSHOT_IMPORT: "1" } });
  reports.snapshotImport = JSON.parse(await readFile(path.join(out, "host-v3-a2/result.json"), "utf8"));
  receipt.snapshotImportReport = { path: "host-v3-a2/result.json", sha256: sha256(await readFile(path.join(out, "host-v3-a2/result.json"))) };
  for (const [name, attempt, budget] of [["skill", "skill", "normal"], ["budgetFile", "budgetfile", "file"], ["budgetTotal", "budgettotal", "total"]]) {
    await run(`host-${name}`, process.execPath, [path.join(root, "scripts/probe-checkpoint-agent-supply.mjs"), attempt, "a1", "materialization"], {
      env: { ...await isolatedEnv(name), STELLA_MATERIALIZATION_BUDGET: budget } });
    const reportPath = `host-probe-${attempt}/result.json`;
    reports[name] = JSON.parse(await readFile(path.join(out, reportPath), "utf8"));
    receipt[`${name}Report`] = { path: reportPath, sha256: sha256(await readFile(path.join(out, reportPath))) };
  }
  await run("host-work", process.execPath, [path.join(root, "scripts/probe-checkpoint-work-installed.mjs")], {
    env: { ...await isolatedEnv("work"), STELLA_WORK_ARTIFACTS: out, STELLA_WORK_ATTEMPT: "a1", STELLA_WORK_PACKAGE_ARTIFACT: artifact } });
  const workReportPath = "host-work-a1/result.json";
  reports.work = JSON.parse(await readFile(path.join(out, workReportPath), "utf8"));
  // Load only this probe's fully captured synthetic request set. The helper
  // independently checks content, constraints and the closed per-case windows.
  reports.work.providerWires = await Promise.all(reports.work.requests.map(async request => {
    const body = await readFile(path.join(out, `host-work-a1/provider-${request.index}.json`), "utf8");
    return { index: request.index, body, sha256: sha256(body) };
  }));
  receipt.workReport = { path: workReportPath, sha256: sha256(await readFile(path.join(out, workReportPath))),
    providerFiles: reports.work.providerWires.map(wire => ({ path: `host-work-a1/provider-${wire.index}.json`, sha256: wire.sha256 })) };
  await run("host-correction", process.execPath, [path.join(root, "scripts/probe-checkpoint-correction-installed.mjs")], {
    env: { ...await isolatedEnv("correction"), STELLA_CORRECTION_ARTIFACTS: out, STELLA_CORRECTION_ATTEMPT: "a1", STELLA_CORRECTION_PACKAGE_ARTIFACT: artifact } });
  const correctionReportPath = "host-correction-a1/result.json";
  reports.correction = JSON.parse(await readFile(path.join(out, correctionReportPath), "utf8"));
  reports.correction.providerWires = await Promise.all(reports.correction.requests.map(async request => {
    const body = await readFile(path.join(out, `host-correction-a1/provider-${request.index}.json`), "utf8");
    const responseBody = await readFile(path.join(out, `host-correction-a1/provider-${request.index}-response.json`), "utf8");
    return { index: request.index, body, sha256: sha256(body), responseBody, responseSha256: sha256(responseBody) };
  }));
  receipt.correctionReport = { path: correctionReportPath, sha256: sha256(await readFile(path.join(out, correctionReportPath))),
    providerFiles: reports.correction.providerWires.map(wire => ({ path: `host-correction-a1/provider-${wire.index}.json`, sha256: wire.sha256,
      responsePath: `host-correction-a1/provider-${wire.index}-response.json`, responseSha256: wire.responseSha256 })) };
  await run("host-understanding", process.execPath, [path.join(root, "scripts/probe-checkpoint-understanding-installed.mjs")], {
    env: { ...await isolatedEnv("understanding"), STELLA_UNDERSTANDING_ARTIFACTS: out, STELLA_UNDERSTANDING_ATTEMPT: "a1", STELLA_UNDERSTANDING_PACKAGE_ARTIFACT: artifact } });
  const understandingReportPath = "host-understanding-a1/result.json";
  reports.understanding = JSON.parse(await readFile(path.join(out, understandingReportPath), "utf8"));
  reports.understanding.providerWires = await Promise.all(reports.understanding.requests.map(async request => {
    const body = await readFile(path.join(out, `host-understanding-a1/provider-${request.index}.json`), "utf8");
    const responseBody = await readFile(path.join(out, `host-understanding-a1/provider-${request.index}-response.json`), "utf8");
    return { index: request.index, body, sha256: sha256(body), responseBody, responseSha256: sha256(responseBody) };
  }));
  receipt.understandingReport = { path: understandingReportPath, sha256: sha256(await readFile(path.join(out, understandingReportPath))),
    providerFiles: reports.understanding.providerWires.map(wire => ({ path: `host-understanding-a1/provider-${wire.index}.json`, sha256: wire.sha256,
      responsePath: `host-understanding-a1/provider-${wire.index}-response.json`, responseSha256: wire.responseSha256 })) };
  receipt.capabilities = assertExperimentalReports(reports, { packageRoot: installed, hostRoot, artifact,
    artifactSha256: receipt.artifactSha256, packageIntegrity: packed.integrity, consumerLockSha256: receipt.consumerLockSha256,
    coreRevision: source.coreRevision, buildIdentitySha256: sha256(await readFile(path.join(installed, "dist/build-identity.json"))) });
  for (let i = 1; i <= 9; i++) assert.ok(JSON.parse(await readFile(path.join(out, `host-probe-ci/provider-${i}.json`), "utf8")).contents);
  assert.deepEqual(await fileManifest(hostRoot, hostFiles), hostBefore, "Known Host metadata/launcher changed");
  assert.equal(sha256(await readFile(path.join(consumer, "package-lock.json"))), receipt.consumerLockSha256);
  assert.equal(interrupted, undefined, `Interrupted: ${interrupted}`);
  receipt.status = "passed"; receipt.experimentalOwnerChatAccepted = true;
} catch (error) { receipt.status = interrupted ? "cancelled" : "failed"; receipt.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  try {
    if (installedBefore) assert.deepEqual(await fileManifest(installed, packed.files.map(entry => entry.path)), installedBefore, "Installed package changed");
    if (artifact) assert.equal(sha256(await readFile(artifact)), receipt.artifactSha256, "Frozen package changed");
    await assertSourceUnchanged(root, source);
  } catch (error) { receipt.status = "failed"; receipt.error ??= String(error.stack ?? error); process.exitCode = 1; }
  if (receipt.status !== "passed") receipt.experimentalOwnerChatAccepted = false;
  receipt.endedAt = new Date().toISOString(); await save();
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
    `## Experimental owner chat: ${receipt.status}\n\nScope: installed package + stock OpenClaw + synthetic loopback only.\n\nFull memory, private main, real model and Issue #23 remain **not accepted**. The independent Full capability assessment retains all 152 cases and its own failed/incomplete status.\n\nSource: ${source.coreRevision}\nPackage SHA256: ${receipt.artifactSha256 ?? "not built"}\n`, { flag: "a" });
  console.log(JSON.stringify(receipt));
}
