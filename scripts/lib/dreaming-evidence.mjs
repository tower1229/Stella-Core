import assert from "node:assert/strict";

export const DREAMING_SOURCE_SCENARIOS = Object.freeze([
  "changed-during-narrative", "deleted-during-narrative", "deleted-after-publication",
]);

// Diagnostic producer evidence cannot grant generation, semantic or business
// authority. In particular, a successful native job is not a Core receipt.
export function assertNativeDreamingReport(report, scenario) {
  assert.ok(DREAMING_SOURCE_SCENARIOS.includes(scenario));
  assert.equal(report.schemaVersion, "stella.native-dreaming-probe/v2");
  assert.equal(report.scenario, scenario);
  assert.equal(report.hostVersion, "2026.8.2");
  assert.equal(report.scope, "native-artifact-generation");
  assert.equal(report.model, "synthetic-loopback");
  for (const flag of ["dreamingEnabled", "dreamingExecuted", "nativeCronExecuted", "nativeNarrativeExecuted", "nativeSourceRead"]) assert.equal(report[flag], true);
  for (const flag of ["coreGenerationBound", "sourceEligibilityBound", "stellaReinjectionVerified", "fullMemoryAccepted", "privateMainAccepted", "realModelAccepted", "issue23Complete"]) assert.equal(report[flag], false);
  assert.equal(report.modelRequests, 1);
  assert.match(report.nativeSourceSha256, /^[a-f0-9]{64}$/);
  assert.match(report.artifactSha256, /^[a-f0-9]{64}$/);
  const mutation = report.nativeSourceMutation;
  assert.equal(mutation.afterNativeSourceRead, true);
  assert.equal(mutation.sourceBeforeSha256, report.nativeSourceSha256);
  assert.equal(mutation.sourceDeleted, scenario.startsWith("deleted"));
  if (mutation.sourceDeleted) assert.equal(mutation.sourceAfterSha256, null);
  else {
    assert.match(mutation.sourceAfterSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(mutation.sourceAfterSha256, mutation.sourceBeforeSha256);
  }
  assert.equal(mutation.stage, scenario.endsWith("during-narrative")
    ? "native_model_input_observed_before_response" : "after_native_publication_before_consumer");
  // This pins the observed limitation of the exact Host build. If the Host
  // begins rejecting stale publication, revise this diagnostic deliberately.
  assert.equal(report.nativeNarrativePublished, true);
  assert.equal(report.nativePublicationAfterMutation, scenario.endsWith("during-narrative"));
}

export function assertDreamingRejectionReport(report, artifactSha256) {
  assert.equal(report.schemaVersion, "stella.main-plugin-probe/v1");
  assert.equal(report.host, "2026.8.2");
  assert.equal(report.managedContextProbe, true);
  assert.equal(report.guardedProvider, true);
  assert.equal(report.terminalStatus, "error");
  assert.equal(report.finalAnswers, 0);
  assert.equal(report.providerRequests, 0);
  assert.equal(report.persistence.artifactKind, "dreaming-diary");
  assert.equal(report.persistence.generationArtifactSha256, artifactSha256);
  assert.ok(report.persistence.actualPromptHookInvocations > 0);
  assert.equal(report.persistence.finalInputRejected, true);
  assert.equal(report.persistence.draftNotDelivered, true);
}

export function assertDreamingCoRunReport(report, inventory) {
  assert.equal(report.schemaVersion, "stella.main-plugin-probe/v1");
  assert.equal(report.host, "2026.8.2");
  assert.equal(report.guardedProvider, true);
  const native = report.nativeDreaming;
  assert.equal(native.scope, "diagnostic");
  assert.equal(native.verified, false);
  assert.equal(native.managedJobExecuted, true);
  assert.ok(native.nativeSubruns > 0);
  assert.equal(native.unboundProjectionWritten, true);
  assert.equal(native.nextTurnStatus, "error");
  assert.equal(native.nextTurnBlocker, "projection_drift");
  assert.equal(native.modelRequestsAfterDreaming, 0);
  assert.equal(native.coreGenerationBound, false);
  assert.equal(native.sourceEligibilityBound, false);
  assert.equal(inventory.complete, false);
  assert.ok(inventory.blockers.includes("host_memory_consumption_unverifiable"));
  assert.ok(inventory.entries.some(entry => entry.kind === "dreaming" && entry.state === "unverifiable"));
}
