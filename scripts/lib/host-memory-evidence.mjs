import assert from "node:assert/strict";

export const SOURCE_AUDIENCE_SCENARIOS = Object.freeze(["owner", "visitor", "group", "channel", "cron", "subagent", "requester-denied", "revoked"]);
export const HOST_INGRESS_FIELDS = Object.freeze(["prependSystemContext", "appendSystemContext", "prependContext", "bootstrap"]);
export const HOST_MEMORY_BOUNDARY_FLAGS = Object.freeze([
  ...SOURCE_AUDIENCE_SCENARIOS.map(value => `--source-audience-${value}`),
  ...HOST_INGRESS_FIELDS.map(value => `--host-ingress-${value}`),
]);
export const NATIVE_MEMORY_CONSUMPTION_FLAGS = Object.freeze(["fts", "cache", "session", "wiki"].flatMap(family =>
  ["success", "stale", "mismatch"].map(state => `--native-memory-${family}-${state}`)));
const nativeProbes = family => NATIVE_MEMORY_CONSUMPTION_FLAGS.filter(flag => flag.startsWith(`--native-memory-${family}-`)).map(flag => flag.slice(2));

// This is an evidence index, never an admission receipt. A common final-input
// rejection proves that boundary, not every native producer upstream of it.
const coverage = {
  memory_index: { probes: ["fragment-skill", "source-audience-owner", "guarded-active-memory", ...nativeProbes("fts"), ...nativeProbes("cache")],
    gaps: ["Builtin FTS/vector are certified for retained exact fragments; QMD and arbitrary memory plugins remain unverified."] },
  session_summary: { probes: ["standalone-compact", "standalone-compact-stale", "history-view-followup", ...nativeProbes("session")],
    gaps: ["Evidence covers Core signed summaries, not every native summary producer."] },
  bootstrap: { probes: ["initialization", "host-ingress-bootstrap", "source-audience-owner"],
    gaps: ["Scoped to the pinned Host loader and initialized target workspace."] },
  session_replay: { probes: ["history-view-followup", "source-deletion-history", "outcome-history-recovery"],
    gaps: ["Scoped to signed target-session history; other transports are not certified."] },
  compaction: { probes: ["standalone-compact", "standalone-compact-stale", "standalone-compact-grant-denied", "standalone-compact-persist-failure"],
    gaps: ["Native sessions.compact remains rejected; success uses explicit Core compaction authority."] },
  prompt_cache: { probes: ["guarded-active-memory", "guarded-active-memory-stale", "guarded-provider-stale", ...nativeProbes("cache"), ...nativeProbes("wiki")],
    gaps: ["Embedding reindex cache and native Wiki reads are scoped evidence; remote provider prompt caches and arbitrary harness caches remain unverified."] },
  context_engine: { probes: ["managed-context-history", "managed-context-persistence-failure", "managed-context-native-control", "main-native-artifact-active-memory"],
    gaps: ["Only the selected managed engine and target Agent are governed; native control is diagnostic."] },
  harness_memory: { probes: ["host-ingress-prependSystemContext", "host-ingress-appendSystemContext", "host-ingress-prependContext"],
    gaps: ["Public hook injection is rejected; alternative harness memory producers remain unverified."] },
  internal_hooks: { probes: ["host-ingress-prependSystemContext", "host-ingress-appendSystemContext", "host-ingress-prependContext", "guarded-payload-transform", ...nativeProbes("session")],
    gaps: ["Observed prompt/payload hooks only; arbitrary plugin side calls are not certified."] },
};
const pluginCoverage = {
  "active-memory": ["guarded-active-memory", "guarded-active-memory-stale", "main-native-artifact-active-memory"],
  "memory-core": ["native-active-memory-artifact", "capability-acceptance", ...nativeProbes("fts"), ...nativeProbes("cache")],
  "dreaming": [], "session-memory": ["native-memory-producers", ...nativeProbes("session")],
  "memory-wiki": ["native-memory-producers", ...nativeProbes("wiki")],
};
export const HOST_MEMORY_EVIDENCE_PROBES = Object.freeze([...new Set([
  ...Object.values(coverage).flatMap(row => row.probes), ...Object.values(pluginCoverage).flat(),
  ...HOST_MEMORY_BOUNDARY_FLAGS.map(flag => flag.slice(2)),
])]);

export function assertHostMemoryBoundaryReport(report, flag) {
  assert.equal(report.schemaVersion, "stella.host-memory-boundary-probe/v1");
  assert.equal(report.dreamingEnabled, false);
  assert.equal(report.fullMemoryAccepted, false);
  assert.equal(report.realModelAccepted, false);
  assert.equal(report.unknownInputConsumed, false);
  assert.equal(report.dispatch.length, 1);
  const scenario = flag.startsWith("--source-audience-") ? flag.slice("--source-audience-".length) : undefined;
  const field = flag.startsWith("--host-ingress-") ? flag.slice("--host-ingress-".length) : undefined;
  assert.equal(report.audienceScenario, scenario);
  assert.equal(report.ingressField, field);
  assert.equal(report.terminalStatus, scenario === "owner" ? "ok" : "error");
  assert.equal(report.providerRequests, scenario === "owner" ? 3 : scenario === "revoked" ? 2 : 0);
  assert.equal(report.finalAnswers, scenario === "owner" ? 1 : 0);
  if (scenario === "owner") {
    assert.equal(report.authorizedFragmentConsumed, true);
    assert.ok(report.sourceAccessCalls > 0 && report.outputChecks > 0);
  } else if (scenario === "revoked") {
    assert.equal(report.revokedBeforeContinuation, true);
    assert.equal(report.modelRequestsAfterRevocation, 0);
  } else if (scenario) assert.equal(report.semanticCalls, 0);
}

export function assertNativeMemoryConsumptionReport(report, flag) {
  const [family, state] = flag.slice("--native-memory-".length).split("-");
  assert.equal(report.schemaVersion, "stella.native-memory-consumption/v1");
  assert.equal(report.nativeFamily, family); assert.equal(report.nativeState, state);
  assert.equal(report.dreamingEnabled, false); assert.equal(report.fullMemoryAccepted, false);
  assert.equal(report.realModelAccepted, false); assert.equal(report.unknownInputConsumed, false);
  assert.equal(report.nativeReadExecuted, true); assert.equal(report.nativeReads.length, 1);
  assert.equal(report.providerRequests, state === "success" ? 3 : 2);
  assert.equal(report.terminalStatus, state === "success" ? "ok" : "error");
  assert.equal(report.finalAnswers, state === "success" ? 1 : 0);
  assert.equal(report.actualNativeBytesConsumed, state === "success");
  assert.equal(report.nativeFinalToolOriginalConsumed, state === "success");
  assert.ok(report.sourceAccessCalls > 0);
  if (state === "success") assert.ok(report.outputChecks > 0);
  else assert.equal(report.modelRequestsAfterInvalidation, 0);
  if (state === "stale") assert.equal(report.staleNativeArtifactRetained, true);
  if (state === "mismatch") assert.equal(report.changedNativeBytesRejected, true);
  if (family === "cache") {
    assert.equal(report.embeddingCacheReuseVerified, true);
    assert.ok(report.nativePreparation.cold.cache.entries > 0 && report.nativePreparation.warm.cache.entries > 0);
    assert.ok(report.embeddingRequests > 0);
  }
  if (family === "wiki") {
    assert.equal(report.wikiCompiledClaimCacheRequired, true);
    assert.equal(typeof report.nativeSource.claimId, "string");
    assert.ok(report.nativeSource.claimId.length > 0);
    if (state === "mismatch") {
      assert.equal(report.nativeReadFailure, "native_memory_read_unverifiable");
      assert.equal(report.nativeReads[0].result, null);
    }
  }
}

export function alignHostMemoryEvidence({ nativeEntrances, pluginIds, probes, coreRevision, artifactSha256 }) {
  assert.deepEqual([...nativeEntrances].sort(), Object.keys(coverage).sort(), "Every declared native entrance needs an explicit evidence row");
  assert.deepEqual([...pluginIds].sort(), Object.keys(pluginCoverage).sort(), "Every named memory plugin needs an explicit evidence row");
  const byName = new Map();
  for (const probe of probes) {
    assert.equal(probe.passed, true);
    assert.equal(probe.coreRevision, coreRevision, "Evidence commit mismatch");
    assert.equal(probe.artifactSha256, artifactSha256, "Evidence package mismatch");
    assert.ok(!byName.has(probe.flag), "Duplicate probe evidence");
    byName.set(probe.flag, probe);
  }
  const references = names => names.map(name => {
    assert.ok(byName.has(name), `Missing required Host evidence: ${name}`);
    return { probe: name, stdout: `${name}.stdout`, evidenceDirectory: byName.get(name).report.evidenceDirectory };
  });
  for (const flag of HOST_MEMORY_BOUNDARY_FLAGS) {
    const name = flag.slice(2);
    references([name]);
    assertHostMemoryBoundaryReport(byName.get(name).report, flag);
  }
  for (const flag of NATIVE_MEMORY_CONSUMPTION_FLAGS) {
    references([flag.slice(2)]);
    assertNativeMemoryConsumptionReport(byName.get(flag.slice(2)).report, flag);
  }
  const producer = byName.get("native-memory-producers")?.report;
  assert.equal(producer?.nativeSessionNewExecuted, true); assert.equal(producer?.nativeWikiCompileExecuted, true);
  assert.equal(producer?.nativeCompiledClaimRead, true);
  assert.equal(producer?.dreamingEnabled, false);
  const inventories = probes.filter(probe => probe.report.memoryInventory).map(probe => ({
    probe: probe.flag, inventory: probe.report.memoryInventory,
  }));
  assert.ok(inventories.length > 0, "Actual Host inventory is required");
  const observed = new Map();
  for (const { probe, inventory } of inventories) {
    assert.equal(inventory.complete, false);
    assert.ok(inventory.blockers.includes("host_memory_consumption_unverifiable"));
    for (const entry of inventory.entries) {
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(entry.identityHash));
      const key = entry.identityHash;
      const row = observed.get(key) ?? { identityHash: key, kind: entry.kind, observations: [] };
      assert.equal(row.kind, entry.kind, "Inventory identity kind changed");
      row.observations.push({ probe, state: entry.state, configurationHash: inventory.configurationHash });
      observed.set(key, row);
    }
  }
  for (const kind of nativeEntrances) assert.ok([...observed.values()].some(row => row.kind === kind), `Host inventory omitted ${kind}`);
  const native = nativeEntrances.map(kind => ({ kind, status: "scoped_evidence", evidence: references(coverage[kind].probes), gaps: coverage[kind].gaps }));
  const plugins = pluginIds.map(kind => ({ kind,
    status: kind === "dreaming" ? "disabled_profile" : pluginCoverage[kind].length ? "scoped_evidence" : "unverified",
    evidence: references(kind === "dreaming" ? HOST_MEMORY_BOUNDARY_FLAGS.map(flag => flag.slice(2)) : pluginCoverage[kind]),
    gaps: kind === "dreaming" ? ["Enabled Dreaming is outside this profile; no generator or cron.run was executed."]
      : ["Enabled state, native producer coverage and source-bound final consumption are separate facts."] }));
  return { schemaVersion: "stella.host-memory-evidence-alignment/v1", coreRevision, artifactSha256,
    scope: "declared entrances; Dreaming-disabled synthetic exact Host", aligned: true, complete: false,
    fullMemoryAccepted: false, issue23Complete: false, blockers: ["host_memory_consumption_unverifiable"],
    native, plugins, observedEntries: [...observed.values()].map(row => ({ ...row, status: "observed_only",
      ...(row.kind === "additional_plugin" ? { gaps: ["Opaque installed plugin has no producer-specific consumption proof; preserve the complete-profile blocker."] } : {}) })),
    audiences: SOURCE_AUDIENCE_SCENARIOS.map(kind => ({ kind, evidence: references([`source-audience-${kind}`]) })),
  };
}
