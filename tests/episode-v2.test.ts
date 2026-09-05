import assert from "node:assert/strict";
import test from "node:test";
import { parseEpisodeV2, validateEpisodeV2References, validateEpisodeV2Transition, type EpisodeV2 } from "../src/praxis/episode-v2.js";

const evidence = { id: "evidence-test", version: `sha256:${"a".repeat(64)}` };
function open(): EpisodeV2 {
  return { schemaVersion: "stella.praxis-episode/v2", id: "episode-test", status: "open",
    createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", recoveryPriority: "normal",
    historicalInputRefs: [evidence], provenance: {},
    situation: { summary: "Synthetic decision", domains: ["relationship"], observations: [] } };
}
function recommended(): EpisodeV2 {
  return { ...open(), status: "recommended", decision: { recommendation: "Wait for clarification", rationale: [] } };
}
function closed(): EpisodeV2 {
  return { ...recommended(), status: "closed",
    actual: { action: "Waited", occurredAt: null, recordedAt: "2026-09-05T01:00:00Z", source: "user_report", evidenceRefs: [evidence] },
    outcome: { observations: [], result: "Reported outcome", observedAt: "2026-09-05T01:00:00Z", evidenceRefs: [evidence] },
    learning: { algorithmVersion: "test-v1", predictionAssessment: "unresolved", evidenceRefs: [evidence], twin: [], praxis: [] } };
}
test("v2 accepts a meaningful no-prediction lifecycle without fabricated learning", async () => {
  await validateEpisodeV2Transition(open(), recommended());
  await validateEpisodeV2Transition(recommended(), closed());
  await validateEpisodeV2Transition(closed(), closed());
});
test("v2 rejects inferred actions and missing original evidence", async () => {
  const item = closed();
  await assert.rejects(parseEpisodeV2({ ...item, actual: { ...item.actual, source: "inferred" } }));
  await assert.rejects(parseEpisodeV2({ ...item, actual: { ...item.actual, evidenceRefs: [] } }));
  await assert.rejects(parseEpisodeV2({ ...item, learning: { ...item.learning, predictionAssessment: "supported" } }), /schema validation failed/);
});
test("v2 requires normalized sealed predictions and rejects their revision", async () => {
  const item = { ...recommended(), twin: { prediction: { possibleActions: { wait: 0.7, ask: 0.3 }, likelyInterpretations: [], keyFactors: [] } } };
  await parseEpisodeV2(item);
  await assert.rejects(parseEpisodeV2({ ...item, twin: { prediction: { ...item.twin.prediction, possibleActions: { wait: 0.7 } } } }), /prediction_not_normalized/);
  await assert.rejects(validateEpisodeV2Transition(item, { ...closed(), twin: { prediction: { ...item.twin.prediction, possibleActions: { wait: 0.6, ask: 0.4 } } } }), /sealed_prediction_changed/);
});
test("v2 rejects terminal reopening and replaced historical references", async () => {
  await assert.rejects(validateEpisodeV2Transition(closed(), recommended()), /illegal_transition/);
  await assert.rejects(validateEpisodeV2Transition(open(), { ...recommended(), historicalInputRefs: [] }), /historical_inputs_changed/);
});
test("v2 resolves exact historical versions independently and requires semantic action support", async () => {
  const seen: string[] = [];
  const ports = {
    async resolveHistorical(ref: typeof evidence) { seen.push(ref.version); },
    async resolveEvidence() {}, async resolveLearning() {},
    async verifyActionEvidence() { return true; },
  };
  await validateEpisodeV2References(closed(), ports);
  assert.deepEqual(seen, [evidence.version]);
  await assert.rejects(validateEpisodeV2References(closed(), { ...ports, async verifyActionEvidence() { return false; } }), /unsupported_actual_action/);
});
