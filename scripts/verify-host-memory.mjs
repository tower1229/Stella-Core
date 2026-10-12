import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Scoped candidate evidence. This does not replace test:package's clean-source
// gate, certify full_memory, invoke Dreaming, or issue any real-model request.
const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const run = (command, args, options = {}) => exec(command, args, { cwd: root, env: process.env,
  maxBuffer: 24 * 1024 * 1024, ...options });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
await mkdir(path.join(root, ".artifacts"), { recursive: true });
const evidence = await mkdtemp(path.join(root, ".artifacts/issue-23-host-memory-"));
const hostRoot = path.join(root, "node_modules/openclaw");
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
process.stderr.write(`Host memory evidence: ${evidence}\n`);
async function entry(base, relative) {
  const file = path.join(base, relative), info = await lstat(file);
  if (info.isSymbolicLink()) return { path: relative, link: await readlink(file) };
  assert.ok(info.isFile(), `Unsupported evidence entry ${relative}`);
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
const receipt = {
  schemaVersion: "stella.host-memory-verification/v1", status: "running",
  coreRevision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
  sourceClean: (await run("git", ["status", "--porcelain"])).stdout.trim() === "",
  sourceManifestSha256: source.digest, hostVersion: host.version,
  dreamingEnabled: false, fullMemoryAccepted: false, privateMainAccepted: false,
  realModelAccepted: false, issue23Complete: false, nativeStandaloneCompactionAdmitted: false,
  scope: "qualified guarded main consumption and explicitly authorized Core history compaction; full Host profile remains blocked",
  model: "loopback-synthetic", semanticJudgments: "injected fixtures",
  freshDependencyInstallTested: false, checks: [], probes: [],
};
const save = () => writeFile(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
await save();
async function capture(name, command, args, options = {}) {
  try {
    const result = await run(command, args, options);
    await writeFile(path.join(evidence, `${name}.stdout`), result.stdout);
    await writeFile(path.join(evidence, `${name}.stderr`), result.stderr);
    return result;
  } catch (error) {
    await writeFile(path.join(evidence, `${name}.stdout`), error.stdout ?? "");
    await writeFile(path.join(evidence, `${name}.stderr`), error.stderr ?? String(error));
    throw error;
  }
}
try {
  for (const script of ["check", "check:schemas", "test"]) {
    process.stderr.write(`Verify ${script}\n`);
    await capture(script.replaceAll(":", "-"), "npm", ["run", script, "--silent"]);
    receipt.checks.push({ script, passed: true });
    await save();
  }
  assert.equal((await sourceManifest()).digest, source.digest, "Source changed during checks");
  const fixtures = await treeManifest(path.join(root, ".test-dist"));
  receipt.compiledFixtureSha256 = fixtures.digest;
  await writeFile(path.join(evidence, "compiled-fixtures.json"), JSON.stringify(fixtures, null, 2));
  const cache = await mkdtemp(path.join(os.tmpdir(), "stella-memory-pack-cache-"));
  const [packed] = JSON.parse((await capture("pack", "npm", ["pack", "--json", "--pack-destination", evidence],
    { env: { ...process.env, npm_config_cache: cache } })).stdout);
  const artifact = path.join(evidence, packed.filename);
  receipt.artifactSha256 = sha256(await readFile(artifact));
  receipt.packageIntegrity = packed.integrity;
  assert.ok(packed.files.some(file => file.path === "dist/src/openclaw/host-history-compaction.js"));
  assert.ok(!packed.files.some(file => /^(tests|\.artifacts|dist\/tests)\//.test(file.path)));
  await capture("extract", "tar", ["-xzf", artifact, "-C", evidence]);
  const packageRoot = path.join(evidence, "package");
  const packaged = [];
  for (const file of packed.files) {
    if (file.path === "package.json") continue; // npm normalizes package metadata.
    const actual = await entry(packageRoot, file.path), expected = await entry(root, file.path);
    assert.deepEqual(actual, expected, `Packed file mismatch: ${file.path}`);
    packaged.push(actual);
  }
  receipt.packagedFilesSha256 = sha256(JSON.stringify(packaged));
  await writeFile(path.join(evidence, "packaged-files.json"), JSON.stringify(packaged, null, 2));
  await save();
  const env = { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot };
  const probes = [
    ...["--outcome-history-recovery", "--managed-context", "--standalone-compact", "--standalone-compact-stale", "--standalone-compact-grant-denied", "--standalone-compact-persist-failure",
      "--guarded-active-memory", "--guarded-active-memory-stale", "--history-view-followup", "--source-deletion-history",
      "--managed-business-failure", "--completion-lifecycle",
      "--completion-status-changed", "--cancel", "--cancel-preparation", "--guarded-payload-transform", "--guarded-provider-stale"]
      .map(flag => ({ name: flag.slice(2), script: "probe-main-plugin.mjs", args: [flag] })),
    ...["history", "persistence-failure", "native-control"].map(mode => ({ name: `context-${mode}`,
      script: "probe-managed-host-context.mjs", args: [], env: { STELLA_CONTEXT_FAIL_PERSISTENCE: mode === "persistence-failure" ? "1" : "0",
        STELLA_CONTEXT_NATIVE_CONTROL: mode === "native-control" ? "1" : "0", STELLA_NATIVE_ACTIVE_EVIDENCE: "", STELLA_NATIVE_DREAMING_EVIDENCE: "" } })),
    { name: "full-memory-gate", script: "probe-capability-acceptance.mjs", args: [] },
  ];
  // Separate synthetic repositories; bounded concurrency avoids rebuilding or
  // changing any artifact while a Host process is consuming it.
  let probeFailure;
  for (let index = 0; index < probes.length; index += 2) {
    const batch = probes.slice(index, index + 2);
    const results = await Promise.allSettled(batch.map(async probe => {
      process.stderr.write(`Probe ${probe.name}\n`);
      const result = await capture(probe.name, process.execPath, [path.join(root, "scripts", probe.script), ...probe.args],
        { env: { ...env, ...probe.env } });
      const report = JSON.parse(result.stdout);
      assert.equal(report.host ?? report.hostVersion, host.version);
      if (probe.name === "full-memory-gate") {
        assert.equal(report.hostMemoryConsumption, "blocked_unverifiable");
        assert.equal(report.modelCalls, 0);
      }
      const config = JSON.parse(await readFile(path.join(report.evidenceDirectory, "state/openclaw.json"), "utf8"));
      assert.equal(config.plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled, false,
        "Dreaming must stay explicitly disabled without disabling memory-core");
      return { name: probe.name, passed: true, report };
    }));
    results.forEach((result, offset) => receipt.probes.push(result.status === "fulfilled" ? result.value : {
      name: batch[offset].name, passed: false, error: String(result.reason.message ?? result.reason) }));
    await save();
    const failure = results.find(result => result.status === "rejected");
    if (failure) probeFailure ??= failure.reason;
  }
  assert.equal((await sourceManifest()).digest, source.digest, "Source changed during Host verification");
  assert.equal((await treeManifest(path.join(root, ".test-dist"))).digest, fixtures.digest, "Compiled fixtures changed during Host verification");
  assert.equal(sha256(await readFile(artifact)), receipt.artifactSha256, "Package bytes changed during Host verification");
  for (const file of packaged) assert.deepEqual(await entry(packageRoot, file.path), file, `Tested package changed: ${file.path}`);
  if (probeFailure) throw probeFailure;
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = String(error.message ?? error);
  throw error;
} finally {
  const hostAfter = await treeManifest(hostRoot);
  receipt.hostUnchanged = hostAfter.digest === hostBefore.digest;
  receipt.hostTreeSha256 = hostBefore.digest;
  await writeFile(path.join(evidence, "host-after.json"), JSON.stringify(hostAfter, null, 2));
  if (!receipt.hostUnchanged) receipt.status = "failed";
  await save();
}
assert.equal(receipt.hostUnchanged, true, "Original Host files changed");
process.stdout.write(`${JSON.stringify({ evidenceDirectory: evidence, status: receipt.status,
  artifactSha256: receipt.artifactSha256, sourceManifestSha256: source.digest, probes: receipt.probes.length })}\n`);
