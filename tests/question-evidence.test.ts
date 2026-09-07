import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";
import type { CortexRoute } from "../src/routing/router.js";
import { bundleFixture } from "./evidence-bundle-fixture.js";

const route: CortexRoute = { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
  needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false };
const decision = { status: "material_unknown", claims: [], unresolvedLeads: [{ question: "Which earlier exchange?", material: true, reason: "Original history is absent" }],
  stoppingReason: "Configured catalog is empty; no claim of absent interaction", suggestedResponseKind: "clarification" };

test("model output schema forbids the unsupported claims rejected by the evidence contract", async (t) => {
  const fixture = await bundleFixture(t);
  let modelSchema: object = {};
  await prepareQuestionEvidence({ requestId: "schema-parity", revision: "a".repeat(40), question: "What is known?", route,
    priorContext: "", resolver: await fixture.resolver(), complete: async ({ prompt }) => {
      modelSchema = JSON.parse(prompt.split("\n").find(line => line.startsWith("Output JSON Schema: "))!.slice("Output JSON Schema: ".length));
      return { text: JSON.stringify(decision), provider: "synthetic", model: "injected" };
    } });
  const validate = new Ajv({ strict: false }).compile(modelSchema);
  assert.equal(validate({ ...decision, suggestedResponseKind: "action_advice" }), false,
    "the model schema must reject material unknowns paired with advice");
  assert.equal(validate({ ...decision, suggestedResponseKind: "collaboration" }), false);
  assert.equal(validate(decision), true);
  const claim = { id: "claim", statement: "Unverified assertion", kind: "fact", scope: "synthetic", support: [], counter: [], unresolved: [] };
  assert.equal(validate({ ...decision, claims: [claim] }), false);
  assert.equal(validate({ ...decision, claims: [{ ...claim, kind: "inference" }] }), false);
  assert.equal(validate({ ...decision, claims: [{ ...claim, unresolved: ["Source provenance is unknown"] }] }), true);
  assert.equal(validate({ ...decision, claims: [{ ...claim, kind: "proposal" }] }), true);
});

test("empty Alpha evidence permits a model-selected clarification without inventing history", async (t) => {
  const fixture = await bundleFixture(t);
  const result = await prepareQuestionEvidence({ requestId: "question", revision: "a".repeat(40), question: "Recall the previous conversation", route,
    priorContext: "Prior model interpretation, not owner evidence", resolver: await fixture.resolver(), complete: async ({ prompt }) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!) as { originalEvidence: unknown[] };
      assert.deepEqual(input.originalEvidence, []);
      assert.match(prompt, /does not prove all personal files/);
      assert.match(prompt, /model interpretations/);
      assert.match(prompt, /No Markdown\/code fences/);
      const schema = JSON.parse(prompt.split("\n").find((line) => line.startsWith("Output JSON Schema: "))!.slice("Output JSON Schema: ".length));
      assert.deepEqual(schema.required, ["status", "claims", "unresolvedLeads", "stoppingReason", "suggestedResponseKind"]);
      return { text: JSON.stringify(decision), provider: "synthetic", model: "injected" };
    } });
  assert.equal(result.bundle.status, "material_unknown");
  assert.equal(result.bundle.suggestedResponseKind, "clarification");
  assert.equal(result.bundle.stopping.modelRef, "synthetic/injected");
  assert.deepEqual(result.originalEvidence, []);
  assert.equal(fixture.catalog.bundles.length, 1);
});

test("question evidence normalizes only a whole JSON fence without changing the semantic bundle", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "question", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  const plain = JSON.stringify(decision);
  const wrapped = `\u0060\u0060\u0060json\n${plain}\n\u0060\u0060\u0060`;
  const complete = (text: string) => async () => ({ text, provider: "synthetic", model: "injected" });
  const decodedPlain = await prepareQuestionEvidence({ ...input, complete: complete(plain) });
  const decodedWrapped = await prepareQuestionEvidence({ ...input, complete: complete(wrapped) });
  assert.deepEqual(decodedWrapped.bundle, decodedPlain.bundle);
  assert.equal(decodedWrapped.modelOutput.encoding, "markdown_json");
  assert.notEqual(decodedWrapped.modelOutput.sha256, decodedPlain.modelOutput.sha256);
  for (const text of ["PRIVATE MALFORMED", `Explanation\n${wrapped}`, `${wrapped}\nExtra prose`, `${wrapped}\n${wrapped}`, "```json\n{bad}\n```", `\u0060\u0060\u0060javascript\n${plain}\n\u0060\u0060\u0060`]) {
    await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ text, provider: "synthetic", model: "injected" }) }), /question_evidence_invalid_json/);
  }
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ text: JSON.stringify({ ...decision, extra: true }),
    provider: "synthetic", model: "injected" }) }), /question_evidence_invalid_envelope/);
});

test("question evidence rejects unsupported refs, missing model provenance and forced advice over unknowns", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "question", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ text: JSON.stringify(decision) }) }), /question_evidence_model_receipt_required/);
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ provider: "synthetic", model: "injected",
    text: JSON.stringify({ ...decision, suggestedResponseKind: "action_advice" }) }) }), /question_evidence_requires_clarification/);
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => ({ provider: "synthetic", model: "injected",
    text: JSON.stringify({ ...decision, claims: [{ id: "claim", statement: "Unsupported owner fact", kind: "fact", scope: "synthetic",
      support: ["not-supplied"], counter: [], unresolved: [] }] }) }) }), /bundle_claim_evidence_not_read/);
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

test("question evidence repairs one malformed claim with explicit feedback, not a semantic fallback", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "shape-repair", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  const malformed = { ...decision, claims: [{ statement: "Synthetic proposal" }] };
  let calls = 0;
  const result = await prepareQuestionEvidence({ ...input, complete: async ({ prompt }) => {
    calls++;
    if (calls === 2) {
      assert.match(prompt, /invalid_bundle_claim_shape/);
      assert.match(prompt, /Previous rejected output/);
      assert.match(prompt, /Synthetic proposal/);
    }
    return { text: JSON.stringify(calls === 1 ? malformed : decision), provider: "synthetic", model: "injected" };
  } });
  assert.equal(calls, 2);
  assert.equal(result.bundle.status, "material_unknown");
  assert.deepEqual(result.modelOutput.attempts.map(({ category }) => category), ["invalid_bundle_claim_shape", "accepted"]);
  assert.equal(result.modelOutput.attempts.every(({ sha256 }) => /^sha256:[a-f0-9]{64}$/.test(sha256)), true);
  calls = 0;
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => {
    calls++;
    return { text: JSON.stringify(malformed), provider: "synthetic", model: "injected" };
  } }), /invalid_bundle_claim_shape/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => {
    calls++;
    return { text: JSON.stringify({ ...decision, claims: [{ id: "claim", statement: "Unsupported", kind: "fact", scope: "synthetic", support: [], counter: [], unresolved: [] }] }), provider: "synthetic", model: "injected" };
  } }), /unsupported_bundle_claim/);
  assert.equal(calls, 2);
});

test("schema basis correction preserves an explicit provenance limit without inventing evidence", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "basis-repair", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  const claim = { id: "claim", statement: "An unverified assertion", kind: "fact", scope: "current request only", support: [], counter: [], unresolved: [] as string[] };
  let calls = 0;
  const result = await prepareQuestionEvidence({ ...input, complete: async () => {
    calls++;
    return { text: JSON.stringify({ ...decision, claims: [{ ...claim, unresolved: calls === 1 ? [] : ["Only asserted in the request; not independently verified"] }] }), provider: "synthetic", model: "injected" };
  } });
  assert.equal(calls, 2);
  assert.equal(result.bundle.status, "material_unknown");
  assert.deepEqual(result.bundle.claims[0]!.support, []);
  assert.deepEqual(result.bundle.claims[0]!.unresolved, ["Only asserted in the request; not independently verified"]);
  assert.deepEqual(result.modelOutput.attempts.map(({ category }) => category), ["unsupported_bundle_claim", "accepted"]);
  calls = 0;
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => {
    calls++;
    return { text: JSON.stringify({ ...decision, claims: [{ ...claim, support: ["E1"] }] }), provider: "synthetic", model: "injected" };
  } }), /bundle_claim_evidence_not_read/);
  assert.equal(calls, 1);
});

test("question evidence cancels before a structural correction and rejects changed evidence generations", async (t) => {
  const fixture = await bundleFixture(t);
  const input = { requestId: "repair-fences", revision: "a".repeat(40), question: "Question", route, priorContext: "", resolver: await fixture.resolver() };
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(prepareQuestionEvidence({ ...input, abortSignal: controller.signal, complete: async () => {
    calls++; controller.abort();
    return { text: "{", provider: "synthetic", model: "injected" };
  } }), /operation_cancelled/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(prepareQuestionEvidence({ ...input, complete: async () => {
    calls++;
    fixture.catalog.generationId = "changed";
    await fixture.save();
    return { text: "{", provider: "synthetic", model: "injected" };
  } }), /stale_generation/);
  assert.equal(calls, 1);
});
