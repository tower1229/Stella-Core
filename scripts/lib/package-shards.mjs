import assert from "node:assert/strict";
import { HOST_MEMORY_ACCEPTANCE_MATRIX, HOST_MEMORY_BOUNDARY_FLAGS, NATIVE_MEMORY_CONSUMPTION_FLAGS } from "./host-memory-evidence.mjs";

export const PACKAGE_PLAN_VERSION = "stella.package-shards/v2";
export const probeName = flag => flag === "--outcome-recovery" ? "outcome-recovery-unbound-history" : flag.slice(2);
export const PACKED_MAIN_FLAGS = ["--managed-context", "--managed-business-failure", "--guarded-active-memory", "--guarded-active-memory-stale",
    "--guarded-provider", "--guarded-payload-transform", "--guarded-semantic", "--guarded-provider-stale",
    "--initialization", "--fragment-skill", "--correction", "--correction-recovery", "--correction-output-rejected",
    "--admission-replay", "--cancel", "--cancel-preparation", "--managed", "--advice-revision", "--outcome", "--question-recovery",
    "--advice-evidence-recovery", "--advice-revision-recovery", "--outcome-recovery", "--outcome-history-recovery",
    "--standalone-compact", "--standalone-compact-stale", "--standalone-compact-grant-denied", "--standalone-compact-persist-failure",
    "--core-consolidation", "--core-consolidation-source-stale", "--core-consolidation-revoked", "--core-consolidation-recovery",
    "--history-view-followup", "--source-deletion-history", "--completion-lifecycle", "--completion-status-changed", ...HOST_MEMORY_BOUNDARY_FLAGS];
export const PACKAGE_SHARDS = Object.freeze({
  "memory-access": HOST_MEMORY_ACCEPTANCE_MATRIX.filter(entry => entry.provider === "memory-core").map(entry => entry.flag),
  // Keep native producers and their actual artifact consumers on one runner.
  "native-chain": ["native-active-memory-artifact", "native-memory-producers", "main-native-artifact-active-memory",
    ...HOST_MEMORY_ACCEPTANCE_MATRIX.filter(entry => entry.provider !== "memory-core").map(entry => entry.flag),
    ...["history", "persistence-failure", "native-control", "native-reinjection"].map(mode => `managed-context-${mode}`),
    ...NATIVE_MEMORY_CONSUMPTION_FLAGS.map(probeName)],
  ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`main-${index + 1}`, PACKED_MAIN_FLAGS.slice(index * 12, (index + 1) * 12).map(probeName)])),
  final: ["capability-acceptance", "archive-retention"],
});
export const PACKAGE_PROBE_NAMES = Object.freeze(Object.values(PACKAGE_SHARDS).flat());
assert.equal(PACKAGE_PROBE_NAMES.length, 152, "Update the explicit CI coverage contract when adding probes");
assert.equal(new Set(PACKAGE_PROBE_NAMES).size, 152, "Probe assignment must be unique");
export const INTEGRITY_CHECKS = Object.freeze(["sourceUnchanged", "workspaceHostUnchanged", "fixturesUnchanged", "buildUnchanged",
  "artifactUnchanged", "installedPackageUnchanged", "hostUnchanged", "dependenciesUnchanged", "consumerLockUnchanged"]);
export function probeHarness(name) {
  if (name.startsWith("memory-access-")) return "probe-host-memory-acceptance.mjs";
  if (name === "native-active-memory-artifact") return "probe-native-active-memory.mjs";
  if (name === "native-memory-producers") return "probe-native-memory-producers.mjs";
  if (["history", "persistence-failure", "native-control", "native-reinjection"].some(mode => name === `managed-context-${mode}`)) return "probe-managed-host-context.mjs";
  if (name === "capability-acceptance") return "probe-capability-acceptance.mjs";
  if (name === "archive-retention") return "probe-archive-retention.mjs";
  return "probe-main-plugin.mjs";
}
const identityKeys = ["coreRevision", "sourceManifestSha256", "artifactSha256", "compiledFixtureSha256", "compiledBuildSha256", "hostVersion", "packageIntegrity"];
const blocked = ["dreamingEnabled", "dreamingExecuted", "fullMemoryAccepted", "privateMainAccepted", "realModelAccepted", "issue23Complete"];

// Only complete, unique, same-package shard receipts can reach the original Host alignment.
// In particular, a cancelled job with a partially green receipt cannot pass.
export function collectPackageShards(prepared, receipts, jobResults) {
  assert.equal(prepared.schemaVersion, "stella.prepared-package/v1");
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.planVersion, PACKAGE_PLAN_VERSION);
  for (const name of ["prepare", "probes"]) assert.equal(jobResults[name]?.result, "success", `CI job ${name} did not succeed`);
  assert.deepEqual(prepared.checks, ["check", "check:schemas", "test"].map(script => ({ script, passed: true })));
  for (const key of INTEGRITY_CHECKS.slice(0, 5)) assert.equal(prepared[key], true, `Preparation integrity missing: ${key}`);
  assert.equal(receipts.length, Object.keys(PACKAGE_SHARDS).length, "Missing or duplicate shard receipt");
  assert.match(prepared.coreRevision, /^[a-f0-9]{40}$/);
  for (const key of ["preparedSha256", "sourceManifestSha256", "artifactSha256", "compiledFixtureSha256", "compiledBuildSha256"])
    assert.match(prepared[key], /^[a-f0-9]{64}$/);
  const harnessHashes = new Map(prepared.source.entries.map(entry => [entry.path, entry.sha256]));
  const byShard = new Map(), probes = [];
  for (const receipt of receipts) {
    assert.ok(Object.hasOwn(PACKAGE_SHARDS, receipt.shard), "Unknown shard");
    assert.ok(!byShard.has(receipt.shard), "Duplicate shard receipt");
    byShard.set(receipt.shard, receipt);
    assert.equal(receipt.schemaVersion, "stella.package-main-smoke/v3");
    assert.equal(receipt.status, "passed", `Shard ${receipt.shard} did not pass`);
    assert.equal(receipt.preparedSha256, prepared.preparedSha256, "Prepared bundle mismatch");
    assert.equal(receipt.planVersion, PACKAGE_PLAN_VERSION);
    for (const key of identityKeys) assert.equal(receipt[key], prepared[key], `Shard identity mismatch: ${key}`);
    for (const key of blocked) assert.equal(receipt[key], false, `Unexpected product acceptance: ${key}`);
    assert.equal(receipt.sourceClean, true);
    assert.equal(receipt.fixture, "synthetic");
    assert.equal(receipt.finalModel, "loopback-synthetic");
    for (const key of ["hostTreeSha256", "installedPackageTreeSha256"]) assert.match(receipt[key], /^[a-f0-9]{64}$/);
    assert.match(receipt.hostPackageIntegrity, /^sha512-/);
    assert.equal(receipt.profile, "dreaming-disabled");
    assert.equal(receipt.installedArtifactTested, true);
    assert.equal(receipt.freshDependencyInstallTested, true);
    assert.equal(receipt.hostDeferredLifecycleCompleted, true);
    assert.equal(receipt.hostCodeUnchangedDuringInstall, true);
    assert.equal(receipt.installScriptsEnabled, false);
    for (const key of INTEGRITY_CHECKS) assert.equal(receipt[key], true, `Shard integrity missing: ${key}`);
    assert.deepEqual(receipt.probes.map(probe => probe.flag).sort(), [...PACKAGE_SHARDS[receipt.shard]].sort(), "Shard coverage mismatch");
    for (const probe of receipt.probes) {
      assert.equal(probe.status, "passed", `Probe ${probe.flag} was incomplete`);
      assert.equal(probe.passed, true);
      assert.equal(probe.coreRevision, prepared.coreRevision);
      assert.equal(probe.artifactSha256, prepared.artifactSha256);
      assert.equal(probe.harness, probeHarness(probe.flag));
      assert.match(probe.harnessSha256, /^[a-f0-9]{64}$/);
      assert.equal(probe.harnessSha256, harnessHashes.get(`scripts/${probe.harness}`), "Probe harness source mismatch");
      assert.ok(Number.isFinite(probe.durationMs) && probe.durationMs >= 0);
      assert.ok(Date.parse(probe.finishedAt) >= Date.parse(probe.startedAt));
      probes.push(probe);
    }
  }
  assert.deepEqual([...byShard.keys()].sort(), Object.keys(PACKAGE_SHARDS).sort());
  assert.deepEqual(probes.map(probe => probe.flag).sort(), [...PACKAGE_PROBE_NAMES].sort(), "Incomplete or duplicate package coverage");
  const first = receipts[0];
  for (const receipt of receipts) for (const key of ["hostPackageIntegrity", "hostTreeSha256", "installedPackageTreeSha256"])
    assert.equal(receipt[key], first[key], `Different installed bytes across shards: ${key}`);
  return probes;
}
