import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DREAMING_SOURCE_SCENARIOS, assertNativeDreamingReport, assertDreamingRejectionReport, assertDreamingCoRunReport } from "./lib/dreaming-evidence.mjs";

// Opt-in diagnostic, separate from the Dreaming-disabled package profile.
// Every cron, source mutation and model endpoint belongs to a disposable Host.
const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, env = process.env) => exec(command, args, { cwd: root, env, maxBuffer: 24 * 1024 * 1024 });
await mkdir(path.join(root, ".artifacts"), { recursive: true });
const evidence = await mkdtemp(path.join(root, ".artifacts/issue23-dreaming-"));
const temporary = path.join(evidence, "tmp");
await mkdir(temporary);
const hostRoot = await realpath(path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw")));
assert.equal(JSON.parse(await readFile(path.join(hostRoot, "package.json"))).version, "2026.8.2");
async function entry(base, relative) {
  const file = path.join(base, relative), info = await lstat(file);
  if (info.isSymbolicLink()) return { path: relative, link: await readlink(file) };
  assert.ok(info.isFile());
  return { path: relative, sha256: sha256(await readFile(file)) };
}
async function sourceManifest() {
  const files = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  const entries = await Promise.all([...new Set(files)].sort().map(relative => entry(root, relative)));
  return { digest: sha256(JSON.stringify(entries)), entries };
}
async function treeManifest(base) {
  const entries = [];
  async function walk(relative) {
    for (const name of (await readdir(path.join(base, relative))).sort()) {
      const file = path.join(relative, name), info = await lstat(path.join(base, file));
      if (info.isDirectory()) await walk(file); else entries.push(await entry(base, file));
    }
  }
  await walk("");
  return { digest: sha256(JSON.stringify(entries)), entries };
}
const source = await sourceManifest(), hostBefore = await treeManifest(hostRoot);
await writeFile(path.join(evidence, "source-manifest.json"), JSON.stringify(source, null, 2));
await writeFile(path.join(evidence, "host-before.json"), JSON.stringify(hostBefore, null, 2));
const receipt = { schemaVersion: "stella.dreaming-boundary-verification/v1", caseVersion: "native-source-mutation-and-unbound-consumption/v1",
  status: "running", scope: "diagnostic native producer and guarded rejection; no qualified Dreaming success",
  coreRevision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
  sourceClean: (await run("git", ["status", "--porcelain"])).stdout.trim() === "",
  sourceManifestSha256: source.digest, hostVersion: "2026.8.2", model: "synthetic-loopback", semanticJudgments: "injected fixtures",
  fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false,
  coreGenerationBound: false, sourceEligibilityBound: false, freshDependencyInstallTested: false,
  testConcurrency: 4,
  blockers: ["native_dreaming_generation_binding_unavailable", "host_memory_consumption_unverifiable"], checks: [], probes: [] };
const save = () => writeFile(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
await save();
process.stderr.write(`Dreaming boundary evidence: ${evidence}\n`);
async function capture(name, command, args, env) {
  try {
    const result = await run(command, args, env);
    await writeFile(path.join(evidence, `${name}.stdout`), result.stdout);
    await writeFile(path.join(evidence, `${name}.stderr`), result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(path.join(evidence, `${name}.stdout`), error.stdout ?? "");
    await writeFile(path.join(evidence, `${name}.stderr`), error.stderr ?? String(error));
    throw error;
  }
}
try {
  for (const script of ["check", "check:schemas"]) {
    process.stderr.write(`Check ${script}\n`);
    await capture(script.replaceAll(":", "-"), "npm", ["run", script, "--silent"]);
    receipt.checks.push({ script, passed: true }); await save();
  }
  // Same compilation and complete file set as npm test, with bounded process
  // concurrency. Node does not permit this option through NODE_OPTIONS.
  process.stderr.write("Check test\n");
  for (const mode of ["build", "test"]) await capture(`compile-${mode}`, process.execPath, ["scripts/compile.mjs", mode]);
  const tests = (await readdir(path.join(root, ".test-dist/tests"))).filter(name => name.endsWith(".test.js")).sort()
    .map(name => path.join(".test-dist/tests", name));
  assert.ok(tests.length > 0);
  await capture("test", process.execPath, ["--test", `--test-concurrency=${receipt.testConcurrency}`, ...tests]);
  receipt.checks.push({ script: "test", passed: true, testFiles: tests.length }); await save();
  const fixtures = await treeManifest(path.join(root, ".test-dist"));
  receipt.compiledFixtureSha256 = fixtures.digest;
  await writeFile(path.join(evidence, "compiled-fixtures.json"), JSON.stringify(fixtures, null, 2));
  const [packed] = JSON.parse(await capture("pack", "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", evidence],
    { ...process.env, npm_config_cache: path.join(temporary, "npm-cache") }));
  const artifact = path.join(evidence, packed.filename);
  receipt.artifactSha256 = sha256(await readFile(artifact)); receipt.packageIntegrity = packed.integrity;
  await capture("extract", "tar", ["-xzf", artifact, "-C", evidence]);
  const packageRoot = path.join(evidence, "package"), packaged = [];
  for (const file of packed.files) {
    if (file.path === "package.json") continue; // npm normalizes metadata.
    const actual = await entry(packageRoot, file.path);
    assert.deepEqual(actual, await entry(root, file.path), `Package bytes differ: ${file.path}`);
    packaged.push(actual);
  }
  receipt.packagedFilesSha256 = sha256(JSON.stringify(packaged));
  await writeFile(path.join(evidence, "packaged-files.json"), JSON.stringify(packaged, null, 2));
  const env = { ...process.env, TMPDIR: temporary, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot };
  delete env.STELLA_LIVE_HOST_CONFIG;
  const probe = async (name, script, args = []) => {
    process.stderr.write(`Probe ${name}\n`);
    const report = JSON.parse(await capture(name, process.execPath, [path.join(root, "scripts", script), ...args], env));
    assert.ok((await realpath(report.evidenceDirectory)).startsWith((await realpath(temporary)) + path.sep));
    return report;
  };
  for (const scenario of DREAMING_SOURCE_SCENARIOS) {
    const producer = await probe(`native-${scenario}`, "probe-native-dreaming.mjs", [`--source-${scenario}`]);
    assertNativeDreamingReport(producer, scenario);
    const raw = await readFile(path.join(producer.evidenceDirectory, "native-dreams.md"));
    assert.equal(sha256(raw), producer.artifactSha256);
    const consumer = await probe(`reject-${scenario}`, "probe-main-plugin.mjs", ["--native-artifact", path.join(producer.evidenceDirectory, "native-dreaming.json")]);
    assertDreamingRejectionReport(consumer, producer.artifactSha256);
    receipt.probes.push({ scenario, passed: true, producer, consumer }); await save();
  }
  const coRun = await probe("guarded-dreaming", "probe-main-plugin.mjs", ["--guarded-dreaming"]);
  const inventory = JSON.parse(await readFile(path.join(coRun.evidenceDirectory, "native-dreaming-inventory.json")));
  assertDreamingCoRunReport(coRun, inventory);
  receipt.probes.push({ scenario: "native-co-run-rejection", passed: true, report: coRun, inventory });
  assert.equal((await sourceManifest()).digest, source.digest, "Source changed during verification");
  assert.equal((await treeManifest(path.join(root, ".test-dist"))).digest, fixtures.digest, "Fixtures changed during verification");
  assert.equal(sha256(await readFile(artifact)), receipt.artifactSha256);
  for (const file of packaged) assert.deepEqual(await entry(packageRoot, file.path), file);
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed"; receipt.error = String(error.message ?? error); throw error;
} finally {
  const hostAfter = await treeManifest(hostRoot);
  receipt.hostTreeSha256 = hostBefore.digest; receipt.hostUnchanged = hostBefore.digest === hostAfter.digest;
  await writeFile(path.join(evidence, "host-after.json"), JSON.stringify(hostAfter, null, 2));
  if (!receipt.hostUnchanged) receipt.status = "failed";
  await save();
}
assert.equal(receipt.hostUnchanged, true, "Original Host changed");
process.stdout.write(JSON.stringify({ evidenceDirectory: evidence, status: receipt.status, coreRevision: receipt.coreRevision,
  sourceManifestSha256: source.digest, artifactSha256: receipt.artifactSha256, issue23Complete: false }) + "\n");
