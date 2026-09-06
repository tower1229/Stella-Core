import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogReader, parseMemoryCatalog, selectTextEvidence, type CatalogGroup, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver, type EvidencePurpose } from "../src/praxis/episode-evidence.js";
import type { EpisodeV2, VersionedRef } from "../src/praxis/episode-v2.js";
import { EpisodeRepository } from "../src/praxis/episode-repository.js";
import { PraxisRuntimeMemory } from "../src/praxis/runtime-memory.js";
import { prepareEvidenceBoundOutcome } from "../src/praxis/outcome-preparation.js";
import { episodeVersion } from "../src/praxis/episode-repository.js";
import { prepareOutcomeTransaction } from "../src/praxis/outcome-transaction.js";
import { recoverPendingOutcome } from "../src/praxis/outcome-recovery.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEvidenceBundle } from "../src/praxis/evidence-bundle.js";
import { syntheticBundle } from "./evidence-bundle-fixture.js";
import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";

const now = "2026-09-06T00:00:00Z";
const purpose: EvidencePurpose = { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "gemini-evaluation", evidenceCutoff: now,
  trustedAdapters: { user_report: ["synthetic-host"], tool_observation: ["synthetic-tool"], system_event: ["synthetic-system"] } };
const emptyCatalog = (): MemoryCatalog => ({ schemaVersion: "stella.memory-catalog/v1", generationId: "generation-synthetic", parentGenerationId: null,
  sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] });
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { role?: string; kind?: string; authoredAt?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-original-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = emptyCatalog();
  const put = async (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[] = []) => {
    const version = objectVersion(object);
    const file = `${String(object.id)}.json`;
    const body = `${JSON.stringify({ ...object, version }, null, 2)}\n`;
    await writeFile(path.join(root, file), body);
    const ref = { id: String(object.id), version };
    catalog[group].push({ ...ref, locator: { path: file, sha256: bytesVersion(body) }, status: "current", dependencies });
    return ref;
  };
  const policy = await put("policies", { schemaVersion: "stella.source-policy/v1", id: "policy-synthetic", ownerId: "owner-synthetic",
    readPurposes: ["alpha"], derivePurposes: ["alpha"], deliveryScopes: ["gemini-evaluation"], retention: "retain", authorityEvidenceRefs: [] });
  const coverage = await put("coverage", { schemaVersion: "stella.archive-coverage/v1", id: "coverage-synthetic",
    adapterId: "synthetic-host", collectionId: "synthetic-session", upstreamSnapshot: "synthetic-snapshot",
    scope: { agentIds: ["synthetic-agent"], roots: [], branchPolicy: "declared_subset", declaredBranches: ["synthetic-branch"] },
    fromCursor: null, toCursor: "synthetic-message", expectedCount: 1, retainedCount: 1, excludedByPolicyCount: 0,
    missingItems: [], checkedAt: now, completeForDeclaredScope: true });
  const payload = Buffer.from(JSON.stringify({ report: "我已经询问了时间，对方确认周末有空。", assistant: "The model imagines a different action." }), "utf8");
  await writeFile(path.join(root, "original.json"), payload);
  const source = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "source-synthetic",
    origin: { adapterId: "synthetic-host", collectionId: "synthetic-session", upstreamId: "synthetic-message" },
    payloads: [{ path: "original.json", mediaType: "application/json", bytes: payload.length, sha256: bytesVersion(payload) }],
    capturedAt: now, policyRef: policy, coverageRef: coverage }, [policy, coverage]);
  const evidence = await put("evidence", { schemaVersion: "stella.memory-evidence/v1", id: "evidence-synthetic", source,
    payloadSha256: bytesVersion(payload), selector: { kind: "json_pointer", value: "/report" },
    speakerId: "owner-synthetic", role: options.role ?? "owner", kind: options.kind ?? "reported", occurredAt: null,
    authoredAt: options.authoredAt ?? now, capturedAt: now, independentOriginId: "event-synthetic", derivedFrom: [], policyRef: policy }, [source, policy]);
  const save = () => writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  await save();
  const actual: NonNullable<EpisodeV2["actual"]> = { action: "询问了时间", occurredAt: null, recordedAt: now, source: "user_report", evidenceRefs: [evidence] };
  return { root, catalog, save, put, source, evidence, actual };
}
const verdict = (actual: NonNullable<EpisodeV2["actual"]>, supported = true) => ({ text: JSON.stringify({
  supported, action: actual.action, occurredAt: actual.occurredAt, source: actual.source, evidenceRefs: actual.evidenceRefs, rationale: "Synthetic semantic verdict" }) });

test("persisted bundles reread original roles and reject unauthorized or modified evidence", async (t) => {
  const { root, catalog, save, put, evidence } = await fixture(t, { role: "assistant", kind: "inference" });
  const original = syntheticBundle();
  const coverageRef = { id: catalog.coverage[0]!.id, version: catalog.coverage[0]!.version };
  const bundle = { ...original, generationId: catalog.generationId, readEvidenceRefs: [evidence], searchedCoverageRefs: [coverageRef] };
  const bundleRef = await put("bundles", bundle, [evidence, coverageRef]);
  await save();
  const binding = { bundleRef, requestId: bundle.requestId, revision: bundle.revision, generationId: bundle.generationId };
  const reader = await CatalogReader.load(root, "catalog.json");
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("Reading must not promote an action"); });
  const result = await loadEvidenceBundle(resolver, binding);
  assert.equal(result.originalEvidence[0]!.role, "assistant");
  assert.equal(result.originalEvidence[0]!.kind, "inference");
  assert.equal(result.originalEvidence[0]!.occurredAt, null);
  assert.equal(result.originalEvidence[0]!.text, "我已经询问了时间，对方确认周末有空。");
  await assert.rejects(loadEvidenceBundle(new EpisodeEvidenceResolver(reader,
    { ...purpose, deliveryScope: "unapproved-service" }, resolver.complete), binding), /permission_denied/);
  await writeFile(path.join(root, "original.json"), "changed original");
  await assert.rejects(loadEvidenceBundle(resolver, binding), /payload_digest_mismatch/);
});

test("question preparation supplies original roles and rereads the source after model judgment", async (t) => {
  const { root, evidence } = await fixture(t, { role: "assistant", kind: "inference" });
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("No action verification here"); });
  let mutate = false;
  const prepare = () => prepareQuestionEvidence({ requestId: "question", revision: "a".repeat(40), question: "Evaluate this interpretation",
    route: { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
      needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false }, priorContext: "", resolver,
    complete: async ({ prompt }) => {
      assert.match(prompt, /我已经询问了时间/);
      assert.match(prompt, /"role":"assistant"/);
      assert.match(prompt, /"kind":"inference"/);
      if (mutate) await writeFile(path.join(root, "original.json"), "Changed during model judgment");
      return { provider: "synthetic", model: "injected", text: JSON.stringify({ status: "sufficient", claims: [], unresolvedLeads: [],
        stoppingReason: "Enough to discuss this as an assistant interpretation, not owner action", suggestedResponseKind: "answer" }) };
    } });
  const result = await prepare();
  assert.deepEqual(result.bundle.readEvidenceRefs, [evidence]);
  assert.equal(result.bundle.searchedCoverageRefs.length, 1);
  assert.equal(result.originalEvidence[0]!.role, "assistant");
  assert.equal(result.originalEvidence[0]!.occurredAt, null);
  mutate = true;
  await assert.rejects(prepare(), /payload_digest_mismatch/);
});

test("question evidence resolves model-selected handles to exact read versions without accepting invented refs", async (t) => {
  const { root, evidence } = await fixture(t);
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Not used"); });
  let selected: unknown[] = ["E1"];
  let observedPrompt = "";
  const prepare = () => prepareQuestionEvidence({ requestId: "selected-evidence", revision: "a".repeat(40), question: "What does the report say?",
    route: { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
      needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false }, priorContext: "", resolver,
    complete: async ({ prompt }) => {
      observedPrompt = prompt;
      return { provider: "synthetic", model: "injected", text: JSON.stringify({ status: "sufficient",
        claims: [{ id: "claim", statement: "The supplied original contains a report", kind: "fact", scope: "synthetic", support: selected, counter: [], unresolved: [] }],
        unresolvedLeads: [], stoppingReason: "Selected the read original", suggestedResponseKind: "answer" }) };
    } });
  const result = await prepare();
  assert.match(observedPrompt, /"handle":"E1"/);
  assert.deepEqual(result.bundle.claims[0]!.support, [evidence]);
  for (const invalid of [["E2"], ["E1", "E1"], [evidence]]) {
    selected = invalid;
    await assert.rejects(prepare(), /bundle_claim_evidence_not_read|invalid_bundle_claim_references/);
  }
});

test("evidence resolver rereads a genuine selected source span before semantic verification", async (t) => {
  const { root, actual } = await fixture(t);
  let calls = 0;
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async ({ prompt }) => {
    calls++;
    assert.match(prompt, /我已经询问了时间/);
    assert.doesNotMatch(prompt, /model imagines a different action/);
    return verdict(actual);
  });
  assert.equal(await resolver.verifyActionEvidence(actual), true);
  assert.equal(calls, 1);
});

test("source labels cannot turn assistant or inferred content into an actual action", async (t) => {
  for (const options of [{ role: "assistant" }, { kind: "inference" }]) {
    const { root, actual } = await fixture(t, options);
    const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Must not call model"); });
    await assert.rejects(resolver.verifyActionEvidence(actual), /unsupported_actual_evidence/);
  }
});

test("semantic ambiguity remains unsupported and invented evidence refs fail", async (t) => {
  const { root, actual } = await fixture(t);
  const reader = await CatalogReader.load(root, "catalog.json");
  assert.equal(await new EpisodeEvidenceResolver(reader, purpose, async () => verdict(actual, false)).verifyActionEvidence(actual), false);
  await assert.rejects(new EpisodeEvidenceResolver(reader, purpose, async () => verdict({ ...actual, evidenceRefs: [{ id: "invented", version: actual.evidenceRefs[0]!.version }] })).verifyActionEvidence(actual), /invalid_action_verdict/);
});

test("future evidence and unauthorized delivery are rejected before model access", async (t) => {
  const { root, actual } = await fixture(t, { authoredAt: "2026-09-07T00:00:00Z" });
  const reader = await CatalogReader.load(root, "catalog.json");
  const never = async () => { throw new Error("Must not call model"); };
  await assert.rejects(new EpisodeEvidenceResolver(reader, purpose, never).verifyActionEvidence(actual), /evidence_after_cutoff/);
  await assert.rejects(new EpisodeEvidenceResolver(reader, { ...purpose, deliveryScope: "unauthorized" }, never).verifyActionEvidence(actual), /permission_denied/);
});

test("outcomes require exact semantic support independently of actual-action support", async (t) => {
  const { root, actual, evidence } = await fixture(t);
  const outcome = { observations: ["对方确认周末有空"], result: "时间得到确认", observedAt: now, evidenceRefs: [evidence] };
  const reader = await CatalogReader.load(root, "catalog.json");
  const result = (supported: boolean, echoed = outcome) => ({ text: JSON.stringify({ supported, outcome: echoed, rationale: "Synthetic verdict" }) });
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async ({ prompt }) => {
    assert.match(prompt, /我已经询问了时间/);
    assert.match(prompt, /对方确认周末有空/);
    assert.doesNotMatch(prompt, /model imagines/);
    return result(true);
  });
  assert.equal(await resolver.verifyOutcomeEvidence(actual, outcome), true);
  assert.equal(await new EpisodeEvidenceResolver(reader, purpose, async () => result(false)).verifyOutcomeEvidence(actual, outcome), false);
  await assert.rejects(new EpisodeEvidenceResolver(reader, purpose, async () => result(true, { ...outcome, result: "changed claim" }))
    .verifyOutcomeEvidence(actual, outcome), /invalid_outcome_verdict/);
  await assert.rejects(new EpisodeEvidenceResolver(reader, purpose, async () => ({ text: '{}' }))
    .verifyOutcomeEvidence(actual, outcome), /invalid_outcome_verdict/);
});

test("unknown or inferred outcomes never reach the semantic verifier", async (t) => {
  for (const options of [{ role: "unknown" }, { role: "assistant" }, { kind: "inference" }]) {
    const { root, actual, evidence } = await fixture(t, options);
    const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose,
      async () => { assert.fail("Untrusted outcome must not reach model"); });
    await assert.rejects(resolver.verifyOutcomeEvidence(actual, { observations: [], result: "Unverified", observedAt: now, evidenceRefs: [evidence] }),
      /unsupported_outcome_evidence/);
  }
});

test("outcome verification rejects a catalog changed during model inference", async (t) => {
  const { root, actual, evidence, catalog, save } = await fixture(t);
  const outcome = { observations: [], result: "时间得到确认", observedAt: now, evidenceRefs: [evidence] };
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => {
    catalog.sources[0]!.status = "removed";
    await save();
    return { text: JSON.stringify({ supported: true, outcome, rationale: "Synthetic verdict" }) };
  });
  await assert.rejects(resolver.verifyOutcomeEvidence(actual, outcome), /stale_generation/);
});

test("deleted source blocks original text and dependent evidence without fetching history", async (t) => {
  const { root, source, evidence, catalog, save } = await fixture(t);
  catalog.sources[0]!.status = "removed";
  await save();
  const reader = await CatalogReader.load(root, "catalog.json");
  assert.equal(reader.eligible(evidence), false);
  await assert.rejects(reader.read(source, "sources", "historical"), /source_removed/);
  await assert.rejects(reader.read(evidence, "evidence"), /evidence_not_currently_eligible/);
});

test("catalog and source mutation during model judgment revoke write eligibility", async (t) => {
  const first = await fixture(t);
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(first.root, "catalog.json"), purpose, async () => {
    await writeFile(path.join(first.root, "original.json"), "Changed original");
    return verdict(first.actual);
  });
  await assert.rejects(resolver.verifyActionEvidence(first.actual), /payload_digest_mismatch/);
  const second = await fixture(t);
  const changed = new EpisodeEvidenceResolver(await CatalogReader.load(second.root, "catalog.json"), purpose, async () => {
    second.catalog.generationId = "another-generation";
    await second.save();
    return verdict(second.actual);
  });
  await assert.rejects(changed.verifyActionEvidence(second.actual), /stale_generation/);
});

test("reference versions and locator byte hashes are verified independently", async (t) => {
  const { root, catalog, evidence, save } = await fixture(t);
  const file = path.join(root, catalog.evidence[0]!.locator.path);
  const object = JSON.parse(await readFile(file, "utf8"));
  object.role = "assistant";
  const changed = JSON.stringify(object);
  await writeFile(file, changed);
  catalog.evidence[0]!.locator.sha256 = bytesVersion(changed);
  await save();
  const reader = await CatalogReader.load(root, "catalog.json");
  await assert.rejects(reader.read(evidence), /object_version_mismatch/);
});

test("canonical versions ignore source location but retain payload content and semantic dependencies", () => {
  const source = { schemaVersion: "stella.memory-source/v1", id: "source", payloads: [{ path: "old.txt", revision: "a".repeat(40), sha256: bytesVersion("content"), mediaType: "text/plain", bytes: 7 }] };
  assert.equal(objectVersion(source), objectVersion({ ...source, version: "ignored", payloads: [{ ...source.payloads[0], path: "new.txt", revision: "b".repeat(40) }] }));
  assert.notEqual(objectVersion(source), objectVersion({ ...source, payloads: [{ ...source.payloads[0], sha256: bytesVersion("changed") }] }));
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), '{"a":[2,3],"b":1}');
  assert.throws(() => canonicalJson({ value: Infinity }));
  assert.throws(() => canonicalJson(new Array(2)));
});

test("selectors enforce UTF-8 boundaries, JSON pointer escapes and real nodes", () => {
  const bytes = Buffer.from("甲乙");
  assert.equal(selectTextEvidence(bytes, { kind: "utf8_bytes", value: "0:3" }), "甲");
  assert.throws(() => selectTextEvidence(bytes, { kind: "utf8_bytes", value: "1:3" }), /invalid_utf8/);
  assert.throws(() => selectTextEvidence(bytes, { kind: "utf8_bytes", value: "0:7" }), /invalid_selector/);
  const json = Buffer.from(JSON.stringify({ "a/b": { "~": ["真实片段"] } }));
  assert.equal(selectTextEvidence(json, { kind: "json_pointer", value: "/a~1b/~0/0" }), "真实片段");
  assert.throws(() => selectTextEvidence(json, { kind: "json_pointer", value: "/a~1b/~0/00" }), /invalid_selector/);
  assert.throws(() => selectTextEvidence(json, { kind: "json_pointer", value: "/missing" }), /selector_unavailable/);
});

test("catalog rejects duplicate current identities and missing collections", async (t) => {
  const { catalog } = await fixture(t);
  assert.throws(() => parseMemoryCatalog({ ...catalog, coverage: undefined }), /invalid_catalog/);
  assert.throws(() => parseMemoryCatalog({ ...catalog, sources: [...catalog.sources, { ...catalog.sources[0]!, version: bytesVersion("other") }] }), /ambiguous_current_version/);
});

test("real evidence resolver gates the v2 write and persists only a supported closure", async (t) => {
  const { root, actual, evidence } = await fixture(t);
  let supported = false;
  let outcomeSupported = false;
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async ({ prompt }) =>
    prompt.includes("reported-outcome evidence verifier")
      ? { text: JSON.stringify({ supported: outcomeSupported, outcome: closed.outcome, rationale: "Synthetic injected verdict" }) }
      : verdict(actual, supported));
  const repository = new EpisodeRepository(root, "episodes", {
    resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
    resolveLearning: (ref) => resolver.resolveLearning(ref), verifyActionEvidence: (claim) => resolver.verifyActionEvidence(claim),
    verifyOutcomeEvidence: (action, outcome) => resolver.verifyOutcomeEvidence(action, outcome),
    isCurrentlyEligible: (episode) => resolver.isCurrentlyEligible(episode), async persist() {},
  });
  const open: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "praxis-evidence-bound", status: "open",
    createdAt: now, updatedAt: now, recoveryPriority: "important", historicalInputRefs: [evidence], provenance: {},
    situation: { summary: "Synthetic social decision", domains: ["social"], observations: [] } };
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: open });
  const recommended: EpisodeV2 = { ...open, status: "recommended", decision: { recommendation: "Synthetic earlier advice", rationale: [] } };
  const advised = await repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended });
  const closed: EpisodeV2 = { ...recommended, status: "closed", actual,
    outcome: { result: "Synthetic reported response", observations: [], observedAt: now, evidenceRefs: [evidence] },
    learning: { algorithmVersion: "synthetic-test", predictionAssessment: "unresolved", evidenceRefs: [evidence], twin: [], praxis: [] } };
  const operation = { operationId: "op-close", expectedVersion: advised.version, episode: closed };
  await assert.rejects(repository.apply(operation), /unsupported_actual_action/);
  assert.equal((await repository.read(open.id)).episode.status, "recommended");
  supported = true;
  await assert.rejects(repository.apply(operation), /unsupported_reported_outcome/);
  assert.equal((await repository.read(open.id)).episode.status, "recommended");
  outcomeSupported = true;
  assert.equal((await repository.apply(operation)).episode.status, "closed");
  assert.equal((await repository.read(open.id)).episode.actual?.occurredAt, null);
});

test("learning resolves a scoped strategy and its exact supported LearningChange", async (t) => {
  const { root, evidence, put, save, catalog } = await fixture(t);
  const strategy = await put("understandings", { schemaVersion: "stella.understanding/v1", id: "strategy-synthetic",
    statement: "Synthetic context-scoped strategy", kind: "strategy", status: "active",
    scope: { workIds: [], contexts: ["synthetic-context"], domains: ["social"], global: false },
    supportRefs: [evidence], counterRefs: [], dependencyRefs: [evidence], originChangeId: "change-synthetic", createdAt: now, updatedAt: now }, [evidence]);
  await put("changes", { schemaVersion: "stella.learning-change/v1", id: "change-synthetic", operationId: "op-learning",
    algorithmVersion: "synthetic-learning-v2", modelRef: "synthetic-model", promptVersion: "synthetic-prompt-v2",
    inputRefs: [evidence], targetRefs: [strategy], changes: [{ kind: "create", before: null, after: strategy, supportRefs: [evidence], counterRefs: [] }],
    disposition: "update", rationale: "Synthetic evidence supports this scoped strategy" }, [evidence, strategy]);
  await save();
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => ({ text: "unused" }));
  await resolver.resolveLearning(strategy);
  await assert.rejects(resolver.resolveLearning(evidence), /reference_unavailable/);
  await mkdir(path.join(root, "episodes"));
  const runtimeFor = (current: EpisodeEvidenceResolver) => new PraxisRuntimeMemory(new EpisodeRepository(root, "episodes", {
    resolveHistorical: (ref) => current.resolveHistorical(ref), resolveEvidence: (ref) => current.resolveEvidence(ref),
    resolveLearning: (ref) => current.resolveLearning(ref), verifyActionEvidence: (actual) => current.verifyActionEvidence(actual),
    verifyOutcomeEvidence: (actual, outcome) => current.verifyOutcomeEvidence(actual, outcome),
    isCurrentlyEligible: (episode) => current.isCurrentlyEligible(episode), async persist() {},
  }), current);
  const runtime = runtimeFor(resolver);
  const memory = await runtime.listMemory();
  assert.deepEqual(memory.openEpisodes, []);
  assert.equal(memory.learningItems.length, 1);
  assert.deepEqual(await runtime.selectedLearning(memory.learningItems[0]!.ref), strategy);
  const recalled = JSON.parse(memory.learningItems[0]!.content) as Record<string, unknown>;
  assert.deepEqual(recalled.scope, { workIds: [], contexts: ["synthetic-context"], domains: ["social"], global: false });
  assert.deepEqual(recalled.supportRefs, [evidence]);
  catalog.sources[0]!.status = "removed";
  await save();
  const removed = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Removed sources must not reach the model"); });
  assert.deepEqual((await runtimeFor(removed).listMemory()).learningItems, []);
});

test("outcome planning binds the exact Episode and original evidence without writing or fabricating learning", async (t) => {
  const { root, actual, evidence } = await fixture(t);
  const episode: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "episode-plan", status: "recommended",
    createdAt: now, updatedAt: now, recoveryPriority: "normal", provenance: {}, historicalInputRefs: [],
    situation: { summary: "确认周末时间", domains: ["social"], observations: [] }, decision: { recommendation: "询问时间", rationale: [] } };
  const outcome = { observations: ["对方确认周末有空"], result: "时间得到确认", observedAt: now, evidenceRefs: [evidence] };
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async ({ prompt }) =>
    prompt.includes("reported-outcome evidence verifier")
      ? { text: JSON.stringify({ supported: true, outcome, rationale: "Synthetic" }) } : verdict(actual));
  const proposal = { disposition: "ready", actual: { action: actual.action, occurredAt: null, source: actual.source, evidenceRefs: [evidence] },
    outcome, predictionAssessment: "unresolved", learning: { disposition: "no_change", rationale: "This event does not establish a reusable change.", evidenceRefs: [evidence] } };
  const selected = { episode, version: episodeVersion(episode) };
  const originalCatalog = await readFile(path.join(root, "catalog.json"));
  const prepare = (value: unknown) => prepareEvidenceBoundOutcome({ request: "请记录结果", selected, recordedAt: now, resolver,
    complete: async ({ prompt }) => { assert.match(prompt, /我已经询问了时间/); assert.match(prompt, /episode-plan/); return { text: JSON.stringify(value), provider: "synthetic", model: "injected" }; } });
  const planned = await prepare(proposal);
  assert.equal(planned.disposition, "ready");
  assert.ok(planned.disposition === "ready");
  assert.equal(planned.expectedVersion, selected.version);
  assert.equal(planned.episode.actual?.occurredAt, null);
  assert.equal(planned.episode.twin?.prediction, undefined);
  assert.deepEqual(planned.episode.learning?.praxis, []);
  assert.equal(planned.learning.disposition, "no_change");
  assert.deepEqual(await readFile(path.join(root, "catalog.json")), originalCatalog);
  assert.equal(episode.status, "recommended");
  await assert.rejects(prepare({ ...proposal, actual: { ...proposal.actual, evidenceRefs: [{ ...evidence, id: "invented" }] } }), /invented_outcome_evidence/);
  await assert.rejects(prepare({ ...proposal, predictionAssessment: "supported" }), /schema validation failed/);
  assert.deepEqual(await prepare({ disposition: "needs_clarification", question: "这份结果属于哪次邀约？" }),
    { disposition: "needs_clarification", question: "这份结果属于哪次邀约？" });
  const strategy = await prepare({ ...proposal, learning: { ...proposal.learning, disposition: "propose_strategy",
    strategy: { statement: "先核对具体时间", scope: { workIds: [], contexts: ["周末邀约"], domains: ["social"], global: false } } } });
  assert.ok(strategy.disposition === "ready");
  assert.equal(strategy.learning.disposition, "propose_strategy");
  assert.deepEqual(strategy.episode.learning?.praxis, []);
});

test("outcome planning clarifies unknown authorship without treating the request as action proof", async (t) => {
  const { root } = await fixture(t, { role: "unknown" });
  const episode: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "unknown-owner-plan", status: "recommended",
    createdAt: now, updatedAt: now, recoveryPriority: "normal", provenance: {}, historicalInputRefs: [],
    situation: { summary: "Synthetic", domains: [], observations: [] }, decision: { recommendation: "Synthetic", rationale: [] } };
  const never = async () => { assert.fail("Unknown authorship must not become model-verified owner evidence"); };
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, never);
  const result = await prepareEvidenceBoundOutcome({ request: "我做了而且很成功", selected: { episode, version: episodeVersion(episode) },
    recordedAt: now, resolver, complete: never });
  assert.equal(result.disposition, "needs_clarification");
});

test("transaction preview cannot replace original evidence or authorize fabricated object bytes", async (t) => {
  const { root } = await fixture(t);
  const reader = await CatalogReader.load(root, "catalog.json");
  await assert.rejects(reader.validatePreview({ ...reader.catalog, sources: [] }, [], async () => { assert.fail("Replaced origins must not reach semantic validation"); }),
    /preview_original_evidence_changed/);
  await assert.rejects(reader.validatePreview(reader.catalog, [{ path: "invented.json", bytes: "{}" }], async () => {}), /invalid_preview_object/);
  await reader.assertCurrent();
});

test("evidence-bound closure atomically commits learning, retries pointer failure, and restores without promoting a candidate", async (t) => {
  for (const propose of [false, true]) {
    const { root, actual, evidence } = await fixture(t);
    const external = await mkdtemp(path.join(os.tmpdir(), "stella-outcome-remote-"));
    t.after(() => rm(external, { recursive: true, force: true }));
    const outcome = { observations: ["对方确认周末有空"], result: "时间得到确认", observedAt: now, evidenceRefs: [evidence] };
    const complete = async ({ prompt }: { prompt: string }) => prompt.includes("reported-outcome evidence verifier")
      ? { text: JSON.stringify({ supported: true, outcome, rationale: "Synthetic" }) } : verdict(actual);
    const runtimeAt = async (directory: string) => {
      const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(directory, "catalog.json"), purpose, complete);
      return new PraxisRuntimeMemory(new EpisodeRepository(directory, "episodes", {
        resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
        resolveLearning: (ref) => resolver.resolveLearning(ref), verifyActionEvidence: (claim) => resolver.verifyActionEvidence(claim),
        verifyOutcomeEvidence: (action, report) => resolver.verifyOutcomeEvidence(action, report),
        isCurrentlyEligible: (episode) => resolver.isCurrentlyEligible(episode), async persist() {},
      }), resolver);
    };
    const runtime = await runtimeAt(root);
    const episode: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "episode-atomic-outcome", status: "open",
      createdAt: now, updatedAt: now, recoveryPriority: "normal", provenance: {}, historicalInputRefs: [evidence],
      situation: { summary: "确认周末时间", domains: ["social"], observations: [] } };
    const advised = await runtime.recommend({ operationId: "initial", episode, decision: { recommendation: "询问时间", rationale: [] }, recordedAt: now });
    const run = promisify(execFile);
    await run("git", ["init", "--quiet", "--initial-branch=main", root]);
    for (const [key, value] of [["user.name", "Synthetic Test"], ["user.email", "synthetic@example.invalid"], ["core.autocrlf", "false"]]) {
      await run("git", ["-C", root, "config", key!, value!]);
    }
    await run("git", ["-C", root, "add", "."]);
    await run("git", ["-C", root, "commit", "--quiet", "-m", "Synthetic baseline"]);
    const remote = path.join(external, "remote.git");
    await run("git", ["init", "--quiet", "--bare", remote]);
    await run("git", ["-C", root, "remote", "add", "origin", remote]);
    await run("git", ["-C", root, "push", "origin", "main"]);
    const initial = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    let fail = true;
    const pointer = path.join(external, "pointer.txt");
    const durability = new GitCangHaiDurability({ root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
      onRevision: async (revision) => { if (fail) throw new Error("Synthetic pointer failure"); await writeFile(pointer, revision); } });
    const transaction = await prepareOutcomeTransaction({ operationId: "report", requestId: "report", revision: initial, runtime, objectRoot: "objects", prepared: {
      disposition: "ready", expectedVersion: advised.version, modelRef: "synthetic/injected", promptVersion: "synthetic/v1",
      readEvidenceRefs: [evidence], searchedCoverageRefs: [],
      episode: { ...advised.episode, status: "closed", actual, outcome,
        learning: { algorithmVersion: "stella-outcome-preparation/v1", predictionAssessment: "unresolved", evidenceRefs: [evidence], twin: [], praxis: [] } },
      learning: { disposition: propose ? "propose_strategy" : "no_change", rationale: "Synthetic scoped evaluation", evidenceRefs: [evidence],
        ...(propose ? { strategy: { statement: "先确认具体时间", scope: { workIds: [], contexts: ["周末邀约"], domains: ["social"], global: false as const } } } : {}) },
    } });
    const signal = new AbortController().signal;
    await assert.rejects(transaction.persist(durability, signal), /Synthetic pointer failure/);
    await assert.rejects(runtime.repository.read(episode.id), /memory_transaction_pending/);
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), initial);
    fail = false;
    const restartedDurability = new GitCangHaiDurability({ root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0, onRevision: async (revision) => { await writeFile(pointer, revision); } });
    const recovery = { root, operationId: transaction.plan.operationId, catalogPath: "catalog.json", episodeRoot: "episodes", objectRoot: "objects",
      purpose, complete, durability: restartedDurability, abortSignal: signal };
    await assert.rejects(recoverPendingOutcome({ ...recovery, objectRoot: "unrelated" }), /outcome_recovery_plan_invalid/);
    await assert.rejects(recoverPendingOutcome({ ...recovery, operationId: "wrong-operation" }), /invalid_transaction_journal/);
    const receipt = await recoverPendingOutcome(recovery);
    assert.deepEqual(await recoverPendingOutcome(recovery), receipt);
    assert.deepEqual(await transaction.persist(restartedDurability, signal), receipt);
    assert.equal((await run("git", ["-C", root, "rev-list", "--count", "HEAD"])).stdout.trim(), "2");
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), receipt.revision);
    assert.equal(await readFile(pointer, "utf8"), receipt.revision);
    const restored = path.join(external, "restored");
    await run("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--branch", "main", remote, restored]);
    const recovered = await runtimeAt(restored);
    const closed = await recovered.repository.read(episode.id);
    assert.equal(closed.version, transaction.version);
    assert.equal(closed.episode.status, "closed");
    assert.equal(closed.episode.actual?.occurredAt, null);
    const change = await recovered.evidence.reader.read(transaction.changeRef, "changes");
    const bundle = await loadEvidenceBundle(recovered.evidence, { bundleRef: transaction.bundleRef, requestId: "report",
      revision: initial, generationId: transaction.bundle.generationId });
    assert.equal(bundle.validatedGenerationId, receipt.generationId);
    assert.deepEqual(bundle.bundle, transaction.bundle);
    assert.equal(bundle.originalEvidence[0]!.text, "我已经询问了时间，对方确认周末有空。");
    assert.equal(bundle.bundle.claims.some((claim) => claim.id === "candidate-strategy"), propose);
    assert.equal(change.disposition, propose ? "update" : "no_change");
    assert.equal(change.modelRef, "synthetic/injected");
    if (transaction.strategyRef) assert.equal((await recovered.evidence.reader.read(transaction.strategyRef, "understandings")).status, "candidate");
    assert.deepEqual((await recovered.listMemory()).learningItems, []);
    assert.equal((await run("git", ["-C", root, "status", "--porcelain"])).stdout.trim(), "");
  }
});
