import assert from "node:assert/strict";
import test from "node:test";
import { verifySourceInterpretation } from "../src/canghai/source-interpretation.js";
import { compileReviewedSourceConstraints } from "../src/canghai/source-policy-migration.js";
import type { OriginalEvidence } from "../src/praxis/episode-evidence.js";

test("derived source-use checks reject missed rules, semantic violations, changed authority and unbound model output", async () => {
  const original: OriginalEvidence = { ref: { id: "evidence", version: `sha256:${"1".repeat(64)}` }, text: "A historical synthetic observation.",
    role: "owner", kind: "reported", independentOriginId: "one", sourceAdapterId: "synthetic", occurredAt: null,
    authoredAt: null, capturedAt: "2026-01-01T00:00:00Z", coverageComplete: true,
    usageConstraints: [{ policyRef: { id: "policy", version: `sha256:${"2".repeat(64)}` }, rules: [{ id: "dated", requirement: "Do not infer current state." }] }] };
  for (const mode of ["allow", "reject", "missing", "duplicate", "unbound", "revoke", "model", "failure"] as const) {
    let current = true;
    const run = () => verifySourceInterpretation({ request: "Review the observation", originals: [original], artifact: { statement: "Synthetic derived statement" },
      modelRef: "synthetic/model", assertCurrent: async () => { if (!current) throw new Error("revoked"); }, complete: async ({ prompt }) => {
        assert.match(prompt, /Do not infer current state/);
        const data = JSON.parse(prompt.split("\n").at(-1)!);
        if (mode === "failure") throw new Error("PRIVATE_SENTINEL");
        if (mode === "revoke") current = false;
        const checks = [{ handle: "R1", satisfied: mode !== "reject" }];
        return { provider: "synthetic", model: mode === "model" ? "wrong" : "model", text: JSON.stringify({
          bindingHash: mode === "unbound" ? "wrong" : data.bindingHash,
          checks: mode === "missing" ? [] : mode === "duplicate" ? [...checks, ...checks] : checks }) };
      } });
    if (mode === "allow") await run();
    else await assert.rejects(run(), new RegExp(mode === "revoke" ? "revoked" : mode === "reject" ? "source_interpretation_rejected" :
      mode === "model" ? "source_interpretation_model_mismatch" : mode === "failure" ? "source_interpretation_model_failed" : "invalid_source_interpretation_verdict"));
  }
});

test("review compiler consumes explicit semantic ids and keeps implementation gaps blocking", () => {
  const result = compileReviewedSourceConstraints(["preserve_historical_scope", "enforce_source_specific_topic_request"]);
  assert.equal(result.implementationReady, true);
  assert.equal(result.usageRules.access.length, 1);
  assert.equal(result.usageRules.interpretation.length, 1);
  const pending = compileReviewedSourceConstraints(["segment_mixed_sensitivity_evidence", "verify_missing_audio_original_or_explicit_retention_exclusion"]);
  assert.equal(pending.implementationReady, false);
  assert.deepEqual(pending.requiredCapabilities, ["mixed_sensitivity_segmentation", "original_media_retention_verification"]);
  assert.throws(() => compileReviewedSourceConstraints(["unreviewed free text about history"]), /unsupported_review_constraint/);
  assert.throws(() => compileReviewedSourceConstraints(["preserve_historical_scope", "preserve_historical_scope"]), /invalid_review_constraint_ids/);
});
