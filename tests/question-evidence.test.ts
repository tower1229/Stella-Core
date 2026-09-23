import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import { prepareQuestionEvidence, readPreparedQuestionContext } from "../src/praxis/question-evidence.js";
import type { CortexRoute } from "../src/routing/router.js";
import { bundleFixture } from "./evidence-bundle-fixture.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";

const route: CortexRoute = { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
  needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false };
const decision = { status: "material_unknown", claims: [], unresolvedLeads: [{ question: "Which earlier exchange?", material: true, reason: "Original history is absent" }],
  stoppingReason: "Configured catalog is empty; no claim of absent interaction", suggestedResponseKind: "clarification" };

test("question context receipts pin model input, reject copied and changed results, and retain generation checks", async t => {
  const fixture = await bundleFixture(t);
  const resolver = await fixture.resolver();
  const input = { requestId: "receipt-request", revision: "a".repeat(40), question: "Original question",
    route: structuredClone(route), priorContext: "Original prior context", resolver,
    complete: async () => {
      input.question = "Changed during inference";
      input.priorContext = "Injected during inference";
      input.route.domains.push("injected");
      return { text: JSON.stringify(decision), provider: "synthetic", model: "injected" };
    },
  };
  const prepared = await prepareQuestionEvidence(input);
  const binding = await readPreparedQuestionContext(prepared);
  assert.equal(binding.priorContext, "Original prior context");
  assert.deepEqual(binding.provisionalRoute.domains, ["general"]);
  assert.equal(binding.context, canonicalJson(prepared));
  assert.equal(binding.requestHash, bytesVersion("Original question"));
  await assert.rejects(readPreparedQuestionContext({ ...prepared }), /question_context_unbound/);
  const originalReason = prepared.bundle.stopping.reason;
  prepared.bundle.stopping.reason = "Unbound old understanding";
  await assert.rejects(readPreparedQuestionContext(prepared), /question_context_changed/);
  prepared.bundle.stopping.reason = originalReason;
  binding.provisionalRoute.domains.push("mutated returned binding");
  assert.deepEqual((await readPreparedQuestionContext(prepared)).provisionalRoute.domains, ["general"]);
  fixture.catalog.generationId = "next-generation";
  await fixture.save();
  await assert.rejects(readPreparedQuestionContext(prepared), /stale_generation/);
});

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

test("prepareQuestionEvidence throws schema retrieval checkpoint when semantic budget exhausts", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { CatalogReader, parseMemoryCatalog, CatalogError } = await import("../src/canghai/catalog-reader.js");
  const { bytesVersion, canonicalJson, objectVersion } = await import("../src/canghai/content-version.js");
  const { prepareRepositorySource } = await import("../src/canghai/repository-source.js");
  const { EpisodeEvidenceResolver } = await import("../src/praxis/episode-evidence.js");
  const { parseRetrievalCheckpoint } = await import("../src/canghai/retrieve.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-pqe-retrieve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, bytes: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  };
  const policy = { schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner", readPurposes: ["read"], derivePurposes: ["derive"], deliveryScopes: ["direct"], retention: "retain", authorityEvidenceRefs: [] };
  const policyRef = { id: policy.id, version: objectVersion(policy) };
  await put("policy.json", canonicalJson(policy));
  const catalog = parseMemoryCatalog({ schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null,
    sources: [], evidence: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [],
    policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(canonicalJson(policy)) } }] });
  const bytes = "Counterevidence text";
  await put("original-1.txt", bytes);
  const imported = await prepareRepositorySource({ root, collectionId: "fixture", sourceId: "1", relativePath: "original-1.txt",
    expectedSha256: bytesVersion(bytes), capturedAt: "2026-08-01T00:00:00Z", objectRoot: "objects", policyRef });
  for (const object of imported.objects) { await put(object.entry.locator.path, object.bytes); catalog[object.group].push(object.entry); }
  await put("catalog.json", canonicalJson(catalog));
  const reader = await CatalogReader.load(root, "catalog.json");
  const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
    evidenceCutoff: "2026-09-09T00:00:00Z", trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No judgment"); });
  const descriptors = [{ sourceRef: imported.sourceRef, policyRef, description: "desc" }];
  const retrievalConfig = { schemaVersion: "stella.semantic-retrieval/v1" as const, pageSize: 16, maxRounds: 1, maxSelected: 4, maxOriginalChars: 96000 };
  await assert.rejects(prepareQuestionEvidence({ requestId: "exhaust", revision: "a".repeat(40), question: "Need more", route, priorContext: "",
    resolver, temporalScope: "current",
    retrieval: { descriptors, modelRef: "synthetic/model", ownerId: "owner", config: retrievalConfig, assertProcessingCurrent: async () => {} },
    complete: async ({ prompt }) => {
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      if (data.candidates) return { provider: "synthetic", model: "model", text: JSON.stringify({ selected: [] }) };
      return { provider: "synthetic", model: "model", text: JSON.stringify({ stopped: false, nextIntents: ["More"], reason: "Need more" }) };
    },
  }), (error: unknown) => {
    if (!(error instanceof CatalogError) || error.category !== "resource_exhausted") return false;
    return "checkpoint" in error && parseRetrievalCheckpoint((error as { checkpoint: unknown }).checkpoint).schemaVersion === "stella.retrieval-checkpoint/v1";
  });
});
