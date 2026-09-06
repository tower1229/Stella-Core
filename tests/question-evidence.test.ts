import assert from "node:assert/strict";
import test from "node:test";
import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";
import type { CortexRoute } from "../src/routing/router.js";
import { bundleFixture } from "./evidence-bundle-fixture.js";

const route: CortexRoute = { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
  needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false };
const decision = { status: "material_unknown", claims: [], unresolvedLeads: [{ question: "Which earlier exchange?", material: true, reason: "Original history is absent" }],
  stoppingReason: "Configured catalog is empty; no claim of absent interaction", suggestedResponseKind: "clarification" };

test("empty Alpha evidence permits a model-selected clarification without inventing history", async (t) => {
  const fixture = await bundleFixture(t);
  const result = await prepareQuestionEvidence({ requestId: "question", revision: "a".repeat(40), question: "Recall the previous conversation", route,
    priorContext: "Prior model interpretation, not owner evidence", resolver: await fixture.resolver(), complete: async ({ prompt }) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!) as { originalEvidence: unknown[] };
      assert.deepEqual(input.originalEvidence, []);
      assert.match(prompt, /does not prove all personal files/);
      assert.match(prompt, /model interpretations/);
      return { text: JSON.stringify(decision), provider: "synthetic", model: "injected" };
    } });
  assert.equal(result.bundle.status, "material_unknown");
  assert.equal(result.bundle.suggestedResponseKind, "clarification");
  assert.equal(result.bundle.stopping.modelRef, "synthetic/injected");
  assert.deepEqual(result.originalEvidence, []);
  assert.equal(fixture.catalog.bundles.length, 1);
});

test("question evidence rejects unsupported refs, missing model provenance and forced advice over unknowns", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "question", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ text: JSON.stringify(decision) }) }), /question_evidence_model_receipt_required/);
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ provider: "synthetic", model: "injected",
    text: JSON.stringify({ ...decision, suggestedResponseKind: "action_advice" }) }) }), /question_evidence_requires_clarification/);
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ provider: "synthetic", model: "injected",
    text: JSON.stringify({ ...decision, claims: [{ id: "claim", statement: "Unsupported owner fact", kind: "fact", scope: "synthetic",
      support: [{ id: "invented", version: `sha256:${"b".repeat(64)}` }], counter: [], unresolved: [] }] }) }) }), /bundle_claim_evidence_not_read/);
});

test("question evidence rejects cancellation, oversized context and model failure without a success bundle", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "question", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  let calls = 0;
  const complete = async () => { calls++; throw new Error("Synthetic private provider details"); };
  await assert.rejects(prepareQuestionEvidence({ ...input, complete, abortSignal: AbortSignal.abort() }), /operation_cancelled/);
  await assert.rejects(prepareQuestionEvidence({ ...input, complete, priorContext: "x".repeat(160_000) }), /resource_exhausted/);
  assert.equal(calls, 0);
  await assert.rejects(prepareQuestionEvidence({ ...input, complete }), (error: unknown) => {
    assert.match(String(error), /question_evidence_model_failed/);
    assert.doesNotMatch(String(error), /private provider details/);
    return true;
  });
});
