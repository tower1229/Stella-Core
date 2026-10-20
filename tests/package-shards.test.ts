import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These scripts are the same orchestration consumed by CI; product probes are
// deliberately untouched and still validate their own real Host observations.
const shards = await import(new URL("../../scripts/lib/package-shards.mjs", import.meta.url).href);
const bundle = await import(new URL("../../scripts/lib/prepared-package.mjs", import.meta.url).href);
const evidence = await import(new URL("../../scripts/lib/package-evidence.mjs", import.meta.url).href);
const memory = await import(new URL("../../scripts/lib/host-memory-evidence.mjs", import.meta.url).href);
type Probe = Record<string, unknown> & { flag: string; passed: boolean; status: string };
type Receipt = Record<string, unknown> & { probes: Probe[] };
type Prepared = Record<string, unknown> & { checks: { script: string; passed: boolean }[] };
const jobResults = { prepare: { result: "success" }, probes: { result: "success" } };
function valid(): { prepared: Prepared; receipts: Receipt[] } {
  const identity = { coreRevision: "a".repeat(40), sourceManifestSha256: "b".repeat(64), artifactSha256: "c".repeat(64),
    compiledFixtureSha256: "d".repeat(64), compiledBuildSha256: "e".repeat(64), hostVersion: "2026.8.2", packageIntegrity: "sha512-package" };
  const source = { entries: [...new Set(shards.PACKAGE_PROBE_NAMES.map(shards.probeHarness))].map(harness => ({ path: `scripts/${harness}`, sha256: "f".repeat(64) })) };
  const integrity = Object.fromEntries(shards.INTEGRITY_CHECKS.map((key: string) => [key, true]));
  const prepared = { ...identity, ...integrity, source, schemaVersion: "stella.prepared-package/v1", status: "prepared",
    preparedSha256: "1".repeat(64), planVersion: shards.PACKAGE_PLAN_VERSION,
    checks: ["check", "check:schemas", "test"].map(script => ({ script, passed: true })) };
  const receipts = Object.entries(shards.PACKAGE_SHARDS).map(([shard, names]) => ({
    ...identity, ...integrity, shard, preparedSha256: prepared.preparedSha256, planVersion: shards.PACKAGE_PLAN_VERSION,
    schemaVersion: "stella.package-main-smoke/v3", status: "passed", sourceClean: true, profile: "dreaming-disabled",
    fixture: "synthetic", finalModel: "loopback-synthetic", dreamingEnabled: false, dreamingExecuted: false,
    fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false,
    installedArtifactTested: true, freshDependencyInstallTested: true, hostDeferredLifecycleCompleted: true,
    hostCodeUnchangedDuringInstall: true, installScriptsEnabled: false,
    hostTreeSha256: "2".repeat(64), installedPackageTreeSha256: "3".repeat(64), hostPackageIntegrity: "sha512-host",
    probes: (names as string[]).map(flag => ({ flag, passed: true, status: "passed", coreRevision: identity.coreRevision,
      artifactSha256: identity.artifactSha256, harness: shards.probeHarness(flag), harnessSha256: "f".repeat(64),
      startedAt: "2026-10-16T00:00:00Z", finishedAt: "2026-10-16T00:00:01Z", durationMs: 1000 })),
  }));
  return { prepared, receipts };
}
function rejects(change: (input: ReturnType<typeof valid>) => void) {
  const input = valid(); change(input);
  assert.throws(() => shards.collectPackageShards(input.prepared, input.receipts, jobResults));
}

test("CI shards retain all 152 unique cases and colocate native producers with consumers", () => {
  const { prepared, receipts } = valid();
  assert.equal(shards.collectPackageShards(prepared, receipts.reverse(), jobResults).length, 152);
  const native = shards.PACKAGE_SHARDS["native-chain"];
  assert.ok(native.includes("native-active-memory-artifact") && native.includes("native-memory-producers"));
  for (const name of shards.PACKAGE_PROBE_NAMES.filter((name: string) => name.startsWith("native-memory-") || name === "managed-context-native-reinjection"))
    assert.ok(native.includes(name));
  for (const { provider, flag } of memory.HOST_MEMORY_ACCEPTANCE_MATRIX)
    assert.ok(shards.PACKAGE_SHARDS[provider === "memory-core" ? "memory-access" : "native-chain"].includes(flag));
  const assigned = shards.PACKAGE_PROBE_NAMES.filter((name: string) => name.startsWith("memory-access-"));
  assert.deepEqual(assigned.sort(), memory.HOST_MEMORY_ACCEPTANCE_MATRIX.map((entry: { flag: string }) => entry.flag).sort());
  assert.equal(shards.PACKED_MAIN_FLAGS.length, 48);
});
test("aggregate rejects missing, duplicate, extra, misassigned and unstarted cases", () => {
  rejects(input => { input.receipts.pop(); });
  rejects(input => { input.receipts[1] = input.receipts[0]!; });
  rejects(input => { input.receipts[0]!.probes.pop(); });
  rejects(input => { input.receipts[0]!.probes.push(input.receipts[0]!.probes[0]); });
  rejects(input => { input.receipts[0]!.probes[0].flag = "unknown-case"; });
  rejects(input => { input.receipts[0]!.probes[0].status = "running"; });
  rejects(input => { input.receipts[0]!.probes[0].status = "not-run"; });
});
test("failed and cancelled jobs or cases cannot be converted into green coverage", () => {
  const { prepared, receipts } = valid();
  for (const name of ["prepare", "probes"]) for (const result of ["failure", "cancelled", "skipped", "timed_out", undefined]) {
    assert.throws(() => shards.collectPackageShards(prepared, receipts, { ...jobResults, [name]: { result } }));
  }
  for (const status of ["failed", "cancelled", "running"]) rejects(input => { input.receipts[0]!.status = status; });
  rejects(input => { input.receipts[0]!.probes[0].passed = false; });
  rejects(input => { input.receipts[0]!.probes[0].status = "cancelled"; });
  rejects(input => { input.prepared.checks[2].passed = false; });
});
test("aggregate binds every shard and case to source, package, compiled harness and Host", () => {
  for (const key of ["coreRevision", "sourceManifestSha256", "artifactSha256", "compiledFixtureSha256", "compiledBuildSha256", "hostVersion", "packageIntegrity", "preparedSha256", "hostTreeSha256", "installedPackageTreeSha256", "hostPackageIntegrity"])
    rejects(input => { input.receipts[0]![key] = "different"; });
  for (const key of ["coreRevision", "artifactSha256", "harness", "harnessSha256"])
    rejects(input => { input.receipts[0]!.probes[0][key] = "different"; });
  rejects(input => { input.receipts[0]!.probes[0].harnessSha256 = "0".repeat(64); });
  for (const key of shards.INTEGRITY_CHECKS) rejects(input => { delete input.receipts[0]![key]; });
});
test("orchestration cannot change Dreaming profile or claim product acceptance", () => {
  for (const key of ["dreamingEnabled", "dreamingExecuted", "fullMemoryAccepted", "privateMainAccepted", "realModelAccepted", "issue23Complete"])
    rejects(input => { input.receipts[0]![key] = true; });
  rejects(input => { input.receipts[0]!.profile = "full_memory"; });
  rejects(input => { input.receipts[0]!.installScriptsEnabled = true; });
  rejects(input => { input.receipts[0]!.freshDependencyInstallTested = false; });
});

test("frozen bundle verifies actual bytes and refuses changed source, tarball or compiled fixtures", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "stella-ci-bundle-test-"));
  try {
    const root = path.join(temp, "checkout"), directory = path.join(temp, "prepared");
    await mkdir(root); await mkdir(directory);
    const source = { coreRevision: "a".repeat(40), sourceClean: true, digest: "b".repeat(64), entries: [] };
    const trees: Record<string, { digest: string; entries: unknown[] }> = {};
    for (const name of ["compiled-fixtures", "compiled-build"]) {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, "build-identity.json"), JSON.stringify({ coreRevision: source.coreRevision, sourceClean: true }));
      trees[name] = await evidence.treeManifest(path.join(directory, name));
    }
    const artifact = path.join(directory, "package.tgz"); await writeFile(artifact, "frozen-test-bytes");
    const prepared = { schemaVersion: "stella.prepared-package/v1", status: "prepared", planVersion: shards.PACKAGE_PLAN_VERSION,
      source, coreRevision: source.coreRevision, sourceManifestSha256: source.digest, packed: { filename: "package.tgz", files: [] },
      artifactSha256: evidence.sha256(await readFile(artifact)), fixtures: trees["compiled-fixtures"], build: trees["compiled-build"],
      compiledFixtureSha256: trees["compiled-fixtures"].digest, compiledBuildSha256: trees["compiled-build"].digest, extracted: { entries: [] } };
    await writeFile(path.join(directory, "prepared.json"), JSON.stringify(prepared));
    await bundle.loadPreparedPackage(directory, root, source, { restore: true });
    await assert.rejects(bundle.loadPreparedPackage(directory, root, { ...source, coreRevision: "c".repeat(40) }));
    await assert.rejects(bundle.loadPreparedPackage(directory, root, { ...source, digest: "d".repeat(64) }));
    await writeFile(artifact, "changed-test-bytes");
    await assert.rejects(bundle.loadPreparedPackage(directory, root, source), /tarball changed/);
    await writeFile(artifact, "frozen-test-bytes");
    await writeFile(path.join(directory, "compiled-fixtures", "build-identity.json"), "{}");
    await assert.rejects(bundle.loadPreparedPackage(directory, root, source), /compiled-fixtures changed/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("aggregate CLI preserves a failed verdict when required artifacts never arrived", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "stella-ci-aggregate-test-"));
  try {
    const result = spawnSync(process.execPath, [new URL("../../scripts/package-ci-aggregate.mjs", import.meta.url).pathname,
      path.join(temp, "missing"), path.join(temp, "output")], { encoding: "utf8", env: { ...process.env, STELLA_CI_JOB_RESULTS: JSON.stringify(jobResults) } });
    assert.equal(result.status, 1);
    const report = JSON.parse(await readFile(path.join(temp, "output/aggregate.json"), "utf8"));
    assert.equal(report.status, "failed"); assert.ok(report.error);
    assert.equal(report.issue23Complete, false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("SIGTERM preserves an atomic cancelled receipt and already streamed child output", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "stella-ci-cancel-test-"));
  // Exercise the real clean-source gate in an independent synthetic checkout,
  // even while the developer's candidate has uncommitted changes.
  const checkout = path.join(temp, "checkout");
  await mkdir(path.join(checkout, "scripts"), { recursive: true });
  await cp(new URL("../../scripts/package-smoke.mjs", import.meta.url), path.join(checkout, "scripts/package-smoke.mjs"));
  await cp(new URL("../../scripts/lib/", import.meta.url), path.join(checkout, "scripts/lib"), { recursive: true });
  await writeFile(path.join(checkout, ".gitignore"), "node_modules/\n");
  const host = path.join(checkout, "node_modules/openclaw");
  await mkdir(host, { recursive: true });
  await writeFile(path.join(host, "package.json"), JSON.stringify({ version: "2026.8.2" }));
  for (const args of [["init", "--quiet"], ["add", "."],
    ["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "synthetic cancellation fixture"]]) {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const receiptPath = path.join(temp, "receipt.json"), fakeNpm = path.join(temp, "fake-npm.cjs");
  await writeFile(fakeNpm, 'process.stdout.write("synthetic interruption marker\\n"); setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [path.join(checkout, "scripts/package-smoke.mjs"),
    "--dreaming-disabled", "--prepare", path.join(temp, "prepared")], {
    stdio: "ignore", env: { ...process.env, npm_execpath: fakeNpm, STELLA_ACCEPTANCE_RECEIPT_PATH: receiptPath },
  });
  const exited = once(child, "exit");
  try {
    let observed = false;
    for (let attempt = 0; attempt < 600 && child.exitCode === null; attempt++) {
      try { observed = (await readFile(path.join(temp, "check.stdout"), "utf8")).includes("synthetic interruption marker"); } catch { /* File not created yet. */ }
      if (observed) break;
      await delay(25);
    }
    assert.equal(observed, true, "The real orchestration must start and stream the synthetic child");
    child.kill("SIGTERM"); await exited;
    const report = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(report.status, "cancelled"); assert.match(report.error, /SIGTERM/);
    assert.deepEqual(report.checks, []); assert.equal(report.issue23Complete, false);
    assert.match(await readFile(path.join(temp, "check.stdout"), "utf8"), /synthetic interruption marker/);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    await rm(temp, { recursive: true, force: true });
  }
});
