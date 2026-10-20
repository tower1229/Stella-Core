import assert from "node:assert/strict";
import test from "node:test";

const evidence = await import(new URL("../../scripts/lib/dreaming-evidence.mjs", import.meta.url).href) as {
  DREAMING_SOURCE_SCENARIOS: string[];
  assertNativeDreamingReport(report: unknown, scenario: string): void;
  assertDreamingRejectionReport(report: unknown, hash: string): void;
  assertDreamingCoRunReport(report: unknown, inventory: unknown): void;
};
function producer(scenario: string) {
  const deleted = scenario.startsWith("deleted"), during = scenario.endsWith("during-narrative");
  return { schemaVersion: "stella.native-dreaming-probe/v2", scenario, hostVersion: "2026.8.2", scope: "native-artifact-generation",
    model: "synthetic-loopback", dreamingEnabled: true, dreamingExecuted: true, nativeCronExecuted: true,
    nativeNarrativeExecuted: true, nativeSourceRead: true, coreGenerationBound: false, sourceEligibilityBound: false,
    stellaReinjectionVerified: false, fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false,
    issue23Complete: false, modelRequests: 1, nativeSourceSha256: "a".repeat(64), artifactSha256: "b".repeat(64),
    nativeNarrativePublished: true, nativePublicationAfterMutation: during,
    nativeSourceMutation: { stage: during ? "native_model_input_observed_before_response" : "after_native_publication_before_consumer",
      afterNativeSourceRead: true, sourceBeforeSha256: "a".repeat(64), sourceAfterSha256: deleted ? null : "c".repeat(64), sourceDeleted: deleted } };
}
test("Dreaming evidence distinguishes native generation from qualified Core lineage", () => {
  for (const scenario of evidence.DREAMING_SOURCE_SCENARIOS) {
    evidence.assertNativeDreamingReport(producer(scenario), scenario);
    for (const patch of [{ nativeSourceRead: false }, { modelRequests: 0 }, { nativeNarrativePublished: false },
      { coreGenerationBound: true }, { sourceEligibilityBound: true }, { issue23Complete: true }, { realModelAccepted: true }]) {
      assert.throws(() => evidence.assertNativeDreamingReport({ ...producer(scenario), ...patch }, scenario));
    }
    const input = producer(scenario); input.nativeSourceMutation.afterNativeSourceRead = false;
    assert.throws(() => evidence.assertNativeDreamingReport(input, scenario));
  }
});
test("native diary rejection requires the same artifact and zero model requests or answers", () => {
  const hash = "b".repeat(64);
  const report = { schemaVersion: "stella.main-plugin-probe/v1", host: "2026.8.2", managedContextProbe: true,
    guardedProvider: true, terminalStatus: "error", finalAnswers: 0, providerRequests: 0,
    persistence: { artifactKind: "dreaming-diary", generationArtifactSha256: hash, actualPromptHookInvocations: 1,
      finalInputRejected: true, draftNotDelivered: true } };
  evidence.assertDreamingRejectionReport(report, hash);
  for (const patch of [{ providerRequests: 1 }, { finalAnswers: 1 }, { terminalStatus: "ok" }, { managedContextProbe: false }]) {
    assert.throws(() => evidence.assertDreamingRejectionReport({ ...report, ...patch }, hash));
  }
  assert.throws(() => evidence.assertDreamingRejectionReport(report, "c".repeat(64)));
});
test("co-run diagnostics retain a blocked inventory and cannot turn fallback writes into verified generation", () => {
  const report = { schemaVersion: "stella.main-plugin-probe/v1", host: "2026.8.2", guardedProvider: true,
    nativeDreaming: { scope: "diagnostic", verified: false, managedJobExecuted: true, nativeSubruns: 1,
      unboundProjectionWritten: true, nextTurnStatus: "error", nextTurnBlocker: "projection_drift",
      modelRequestsAfterDreaming: 0, coreGenerationBound: false, sourceEligibilityBound: false } };
  const inventory = { complete: false, blockers: ["host_memory_consumption_unverifiable"], entries: [{ kind: "dreaming", state: "unverifiable" }] };
  evidence.assertDreamingCoRunReport(report, inventory);
  for (const patch of [{ nativeSubruns: 0 }, { verified: true }, { modelRequestsAfterDreaming: 1 }, { nextTurnStatus: "ok" }]) {
    assert.throws(() => evidence.assertDreamingCoRunReport({ ...report, nativeDreaming: { ...report.nativeDreaming, ...patch } }, inventory));
  }
  assert.throws(() => evidence.assertDreamingCoRunReport(report, { ...inventory, entries: [{ kind: "dreaming", state: "disabled" }] }));
});
