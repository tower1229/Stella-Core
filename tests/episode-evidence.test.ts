import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogError, CatalogReader, parseMemoryCatalog, selectTextEvidence, type CatalogGroup, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { SourceEvidenceReader, validateLearningChange, type EvidencePurpose } from "../src/canghai/evidence-reader.js";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import type { VersionedRef } from "../src/canghai/ref.js";
import type { ActionEvidenceClaim } from "../src/canghai/evidence-reader.js";
import { loadEvidenceBundle } from "../src/praxis/evidence-bundle.js";
import { syntheticBundle } from "./evidence-bundle-fixture.js";
import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";
import { createSourceAccessProvider } from "../src/canghai/source-access.js";

const now = "2026-09-06T00:00:00Z";
const purpose: EvidencePurpose = { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "gemini-evaluation", evidenceCutoff: now,
  trustedAdapters: { user_report: ["synthetic-host"], tool_observation: ["synthetic-tool"], system_event: ["synthetic-system"] } };
const emptyCatalog = (): MemoryCatalog => ({ schemaVersion: "stella.memory-catalog/v1", generationId: "generation-synthetic", parentGenerationId: null,
  sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] });
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { role?: string; kind?: string; authoredAt?: string; restricted?: boolean } = {}) {
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
  const policy = await put("policies", { schemaVersion: options.restricted ? "stella.source-policy/v2" : "stella.source-policy/v1", id: "policy-synthetic", ownerId: "owner-synthetic",
    readPurposes: ["alpha"], derivePurposes: ["alpha"], deliveryScopes: ["gemini-evaluation"], retention: "retain", authorityEvidenceRefs: [],
    ...(options.restricted ? { restrictions: { sensitivity: "sensitive", quotePolicy: "summarize_only", allowedScenarios: ["relationship_context"], forbiddenScenarios: ["relationship_judgment"] } } : {}) });
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
  const actual: ActionEvidenceClaim = { action: "询问了时间", occurredAt: null, recordedAt: now, source: "user_report", evidenceRefs: [evidence] };
  return { root, catalog, save, put, source, evidence, actual };
}
const verdict = (actual: ActionEvidenceClaim, supported = true) => ({ text: JSON.stringify({
  supported, action: actual.action, occurredAt: actual.occurredAt, source: actual.source, evidenceRefs: actual.evidenceRefs, rationale: "Synthetic semantic verdict" }) });

test("evidence read scopes separate concurrent operations, inherit nested reads and reject late metadata reads", async t => {
  const f = await fixture(t);
  const reader = await CatalogReader.load(f.root, "catalog.json");
  const resolver = new SourceEvidenceReader(reader, purpose, async () => { throw new Error("No inference"); });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = resolver.captureReads(async () => {
    await resolver.readMetadata(f.source);
    enter();
    await gate;
    const nested = await resolver.captureReads(() => resolver.readEvidence(f.evidence));
    assert.deepEqual(nested.originals.map(original => original.ref), [f.evidence]);
  });
  await entered;
  const second = await resolver.captureReads(() => resolver.readMetadata(f.catalog.policies[0]!));
  assert.deepEqual(second.originals, []);
  assert.deepEqual(second.metadata.map(ref => ref.id), [f.catalog.policies[0]!.id]);
  release();
  const captured = await first;
  assert.deepEqual(captured.metadata, [f.source]);
  assert.deepEqual(captured.originals.map(original => original.ref), [f.evidence]);
  let releaseLate!: () => void;
  const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
  let late!: Promise<unknown>;
  await resolver.captureReads(async () => { late = lateGate.then(() => resolver.readMetadata(f.source)); });
  releaseLate();
  await assert.rejects(late, /evidence_read_scope_expired/);
});

test("restricted evidence fails before payload access without an admitted semantic context", async (t) => {
  const f = await fixture(t, { restricted: true });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  let reads = 0;
  const originalRead = reader.readPayload.bind(reader);
  reader.readPayload = async (...args) => { reads++; return originalRead(...args); };
  const resolver = new SourceEvidenceReader(reader, purpose, async () => { throw new Error("Must not call model"); });
  await assert.rejects(resolver.readEvidence(f.evidence), /source_access_context_required/);
  assert.equal(reads, 0);
  const permitted = new SourceEvidenceReader(reader, { ...purpose, sourceAccess: async () => ({
    judgment: { scenarios: ["relationship_context"], trigger: "user_requested", topicRequested: true, topicExplicitlyNamed: true, presentation: "summary" }, quoteGrants: [],
  }) }, resolver.complete);
  assert.match((await permitted.readEvidence(f.evidence)).text, /询问/);
  assert.equal(reads, 1);
});

test("the evidence reader applies semantic authorization to each source before reading original bytes", async t => {
  const f = await fixture(t, { restricted: true });
  const oldSource = JSON.parse(await readFile(path.join(f.root, "source-synthetic.json"), "utf8")) as Record<string, unknown>;
  delete oldSource.version;
  const secondSource = await f.put("sources", { ...oldSource, id: "source-unrequested" }, f.catalog.sources[0]!.dependencies);
  const oldEvidence = JSON.parse(await readFile(path.join(f.root, "evidence-synthetic.json"), "utf8")) as Record<string, unknown>;
  delete oldEvidence.version;
  const secondEvidence = await f.put("evidence", { ...oldEvidence, id: "evidence-unrequested", source: secondSource }, [secondSource, f.catalog.policies[0]!]);
  await f.save();
  const reader = await CatalogReader.load(f.root, "catalog.json");
  const request = "请回顾我指定的合成事件中，对方确认了什么。";
  const reads: string[] = [];
  const read = reader.readPayload.bind(reader);
  reader.readPayload = async (...args) => { reads.push(args[0].id); return read(...args); };
  const sourceAccess = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [],
    describe: async (_reader, target) => ({ ...target, description: "Synthetic topic descriptor; permission to process this metadata is provided by the test Host." }),
    complete: async input => {
      const binding = JSON.parse(input.prompt.split("\n").at(-1)!) as { requestHash: string; sourceRef: VersionedRef; policyRef: VersionedRef };
      assert.ok(!input.prompt.includes("对方确认周末有空"), "Access classifier must not see original payloads");
      return { text: JSON.stringify({ requestHash: binding.requestHash, sourceRef: binding.sourceRef, policyRef: binding.policyRef,
        applicable: true, scenarios: ["relationship_context"], topicRequested: binding.sourceRef.id === f.source.id,
        topicExplicitlyNamed: binding.sourceRef.id === f.source.id }) };
    } });
  const resolver = new SourceEvidenceReader(reader, { ...purpose, sourceAccess }, async () => { throw new Error("No action inference requested"); });
  assert.equal((await resolver.readEvidence(f.evidence)).text, "我已经询问了时间，对方确认周末有空。");
  await assert.rejects(resolver.readEvidence(secondEvidence), /source_topic_required/);
  assert.deepEqual(reads, [f.source.id]);
  const prepare = () => prepareQuestionEvidence({ requestId: "mixed-access", revision: "a".repeat(40), question: request,
    route: { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
      needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false }, priorContext: "", resolver,
    complete: async ({ prompt }) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!) as { excludedByAccess: unknown; originalEvidence: unknown[] };
      assert.deepEqual(input.excludedByAccess, { source_topic_required: 1 });
      assert.equal(input.originalEvidence.length, 1);
      assert.ok(!prompt.includes(secondSource.id));
      return { provider: "synthetic", model: "injected", text: JSON.stringify({ status: "sufficient", claims: [],
        unresolvedLeads: [], stoppingReason: "Only the authorized original was read; excluded history is unknown.",
        suggestedResponseKind: "answer" }) };
    } });
  const prepared = await prepare();
  assert.deepEqual(prepared.bundle.readEvidenceRefs, [f.evidence]);
  assert.deepEqual(prepared.bundle.excludedByAccess, { source_topic_required: 1 });
  assert.ok(reads.every(id => id === f.source.id), "Denied payload must remain unread");
  const readEvidence = resolver.readEvidence.bind(resolver);
  resolver.readEvidence = async ref => {
    if (ref.id === secondEvidence.id) throw new CatalogError("source_access_model_failed");
    return readEvidence(ref);
  };
  await assert.rejects(prepare(), /source_access_model_failed/);
});

test("persisted bundles reread original roles and reject unauthorized or modified evidence", async (t) => {
  const { root, catalog, save, put, evidence } = await fixture(t, { role: "assistant", kind: "inference" });
  const original = syntheticBundle();
  const coverageRef = { id: catalog.coverage[0]!.id, version: catalog.coverage[0]!.version };
  const bundle = { ...original, generationId: catalog.generationId, readEvidenceRefs: [evidence], searchedCoverageRefs: [coverageRef] };
  const bundleRef = await put("bundles", bundle, [evidence, coverageRef]);
  await save();
  const binding = { bundleRef, requestId: bundle.requestId, revision: bundle.revision, generationId: bundle.generationId };
  const reader = await CatalogReader.load(root, "catalog.json");
  const resolver = new SourceEvidenceReader(reader, purpose, async () => { throw new Error("Reading must not promote an action"); });
  const result = await loadEvidenceBundle(resolver, binding);
  assert.equal(result.originalEvidence[0]!.role, "assistant");
  assert.equal(result.originalEvidence[0]!.kind, "inference");
  assert.equal(result.originalEvidence[0]!.occurredAt, null);
  assert.equal(result.originalEvidence[0]!.text, "我已经询问了时间，对方确认周末有空。");
  await assert.rejects(loadEvidenceBundle(new SourceEvidenceReader(reader,
    { ...purpose, deliveryScope: "unapproved-service" }, resolver.complete), binding), /permission_denied/);
  await writeFile(path.join(root, "original.json"), "changed original");
  await assert.rejects(loadEvidenceBundle(resolver, binding), /payload_digest_mismatch/);
});

test("question preparation supplies original roles and rereads the source after model judgment", async (t) => {
  const { root, evidence } = await fixture(t, { role: "assistant", kind: "inference", restricted: true });
  const sourceAccess = createSourceAccessProvider({ request: "Evaluate this interpretation", trigger: "user_requested", presentation: "summary", quoteGrants: [],
    describe: async (_reader, target) => ({ ...target, description: "Synthetic interpretation of a requested interaction." }),
    complete: async ({ prompt }) => {
      const bound = JSON.parse(prompt.split("\n").at(-1)!) as { requestHash: string; sourceRef: VersionedRef; policyRef: VersionedRef };
      return { text: JSON.stringify({ requestHash: bound.requestHash, sourceRef: bound.sourceRef, policyRef: bound.policyRef,
        applicable: true, scenarios: ["relationship_context"], topicRequested: true, topicExplicitlyNamed: true }) };
    } });
  const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), { ...purpose, sourceAccess }, async () => { throw new Error("No action verification here"); });
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
  const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Not used"); });
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
  const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose, async ({ prompt }) => {
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
    const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Must not call model"); });
    await assert.rejects(resolver.verifyActionEvidence(actual), /unsupported_actual_evidence/);
  }
});

test("semantic ambiguity remains unsupported and invented evidence refs fail", async (t) => {
  const { root, actual } = await fixture(t);
  const reader = await CatalogReader.load(root, "catalog.json");
  assert.equal(await new SourceEvidenceReader(reader, purpose, async () => verdict(actual, false)).verifyActionEvidence(actual), false);
  await assert.rejects(new SourceEvidenceReader(reader, purpose, async () => verdict({ ...actual, evidenceRefs: [{ id: "invented", version: actual.evidenceRefs[0]!.version }] })).verifyActionEvidence(actual), /invalid_action_verdict/);
});

test("future evidence and unauthorized delivery are rejected before model access", async (t) => {
  const { root, actual } = await fixture(t, { authoredAt: "2026-09-07T00:00:00Z" });
  const reader = await CatalogReader.load(root, "catalog.json");
  const never = async () => { throw new Error("Must not call model"); };
  await assert.rejects(new SourceEvidenceReader(reader, purpose, never).verifyActionEvidence(actual), /evidence_after_cutoff/);
  await assert.rejects(new SourceEvidenceReader(reader, { ...purpose, deliveryScope: "unauthorized" }, never).verifyActionEvidence(actual), /permission_denied/);
});

test("outcomes require exact semantic support independently of actual-action support", async (t) => {
  const { root, actual, evidence } = await fixture(t);
  const outcome = { observations: ["对方确认周末有空"], result: "时间得到确认", observedAt: now, evidenceRefs: [evidence] };
  const reader = await CatalogReader.load(root, "catalog.json");
  const result = (supported: boolean, echoed = outcome) => ({ text: JSON.stringify({ supported, outcome: echoed, rationale: "Synthetic verdict" }) });
  const resolver = new SourceEvidenceReader(reader, purpose, async ({ prompt }) => {
    assert.match(prompt, /我已经询问了时间/);
    assert.match(prompt, /对方确认周末有空/);
    assert.doesNotMatch(prompt, /model imagines/);
    return result(true);
  });
  assert.equal(await resolver.verifyOutcomeEvidence(actual, outcome), true);
  assert.equal(await new SourceEvidenceReader(reader, purpose, async () => result(false)).verifyOutcomeEvidence(actual, outcome), false);
  await assert.rejects(new SourceEvidenceReader(reader, purpose, async () => result(true, { ...outcome, result: "changed claim" }))
    .verifyOutcomeEvidence(actual, outcome), /invalid_outcome_verdict/);
  await assert.rejects(new SourceEvidenceReader(reader, purpose, async () => ({ text: '{}' }))
    .verifyOutcomeEvidence(actual, outcome), /invalid_outcome_verdict/);
});

test("unknown or inferred outcomes never reach the semantic verifier", async (t) => {
  for (const options of [{ role: "unknown" }, { role: "assistant" }, { kind: "inference" }]) {
    const { root, actual, evidence } = await fixture(t, options);
    const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose,
      async () => { assert.fail("Untrusted outcome must not reach model"); });
    await assert.rejects(resolver.verifyOutcomeEvidence(actual, { observations: [], result: "Unverified", observedAt: now, evidenceRefs: [evidence] }),
      /unsupported_outcome_evidence/);
  }
});

test("outcome verification rejects a catalog changed during model inference", async (t) => {
  const { root, actual, evidence, catalog, save } = await fixture(t);
  const outcome = { observations: [], result: "时间得到确认", observedAt: now, evidenceRefs: [evidence] };
  const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose, async () => {
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
  const resolver = new SourceEvidenceReader(await CatalogReader.load(first.root, "catalog.json"), purpose, async () => {
    await writeFile(path.join(first.root, "original.json"), "Changed original");
    return verdict(first.actual);
  });
  await assert.rejects(resolver.verifyActionEvidence(first.actual), /payload_digest_mismatch/);
  const second = await fixture(t);
  const changed = new SourceEvidenceReader(await CatalogReader.load(second.root, "catalog.json"), purpose, async () => {
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

test("byte selectors preserve BOM characters at the file or selected-fragment start without changing JSON parsing", () => {
  for (const prefix of ["", "前文\n"]) {
    const selected = "\uFEFF合成原文\r\n保留 e\u0301。", bytes = Buffer.from(prefix + selected + "\n后文");
    const start = Buffer.byteLength(prefix), end = start + Buffer.byteLength(selected);
    const text = selectTextEvidence(bytes, { kind: "utf8_bytes", value: `${start}:${end}` });
    assert.equal(text, selected);
    assert.deepEqual(Buffer.from(text), bytes.subarray(start, end));
    assert.throws(() => selectTextEvidence(bytes, { kind: "utf8_bytes", value: `${start + 1}:${end}` }), /invalid_utf8/);
  }
  const json = Buffer.from("\uFEFF" + JSON.stringify({ text: "\uFEFF合成字符串" }));
  assert.equal(selectTextEvidence(json, { kind: "json_pointer", value: "/text" }), "\uFEFF合成字符串");
});

test("catalog rejects duplicate current identities and missing collections", async (t) => {
  const { catalog } = await fixture(t);
  assert.throws(() => parseMemoryCatalog({ ...catalog, coverage: undefined }), /invalid_catalog/);
  assert.throws(() => parseMemoryCatalog({ ...catalog, sources: [...catalog.sources, { ...catalog.sources[0]!, version: bytesVersion("other") }] }), /ambiguous_current_version/);
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
  const resolver = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose, async () => ({ text: "unused" }));
  await resolver.resolveLearning(strategy);
  await assert.rejects(resolver.resolveLearning(evidence), /reference_unavailable/);
  const recalled = await resolver.reader.read(strategy, "understandings");
  assert.deepEqual(recalled.scope, { workIds: [], contexts: ["synthetic-context"], domains: ["social"], global: false });
  assert.deepEqual(recalled.supportRefs, [evidence]);
  catalog.sources[0]!.status = "removed";
  await save();
  const removed = new SourceEvidenceReader(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Removed sources must not reach the model"); });
  await assert.rejects(removed.resolveLearning(strategy), /evidence_not_currently_eligible/);
});

test("transaction preview cannot replace original evidence or authorize fabricated object bytes", async (t) => {
  const { root } = await fixture(t);
  const reader = await CatalogReader.load(root, "catalog.json");
  await assert.rejects(reader.validatePreview({ ...reader.catalog, sources: [] }, [], async () => { assert.fail("Replaced origins must not reach semantic validation"); }),
    /preview_original_evidence_changed/);
  await assert.rejects(reader.validatePreview(reader.catalog, [{ path: "invented.json", bytes: "{}" }], async () => {}), /invalid_preview_object/);
  await reader.assertCurrent();
});


test("evidence capture records nested model calls and rejects late calls before model disclosure", async t => {
  const f = await fixture(t);
  let calls = 0;
  const resolver = new SourceEvidenceReader(await CatalogReader.load(f.root, "catalog.json"), purpose,
    async () => { calls++; return { text: "Synthetic", provider: "synthetic", model: "verifier" }; });
  const outer = await resolver.captureReads(async () => {
    const inner = await resolver.captureReads(() => resolver.complete({ prompt: "Synthetic verifier input", maxTokens: 10 }));
    assert.deepEqual(inner.models, [{ provider: "synthetic", model: "verifier" }]);
  });
  assert.deepEqual(outer.models, [{ provider: "synthetic", model: "verifier" }]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let late: Promise<unknown> | undefined;
  await resolver.captureReads(async () => { late = gate.then(() => resolver.complete({ prompt: "Expired input", maxTokens: 10 })); });
  release();
  await assert.rejects(late!, /evidence_read_scope_expired/);
  assert.equal(calls, 1);
});

test("Learning Change disposition and target shape agree without a native provider", async t => {
  const memory = await personalMemoryFixture(t), initial = await memory.resolver();
  const base = await initial.reader.read(initial.reader.currentRef("change", "changes"), "changes");
  const cases: Array<{ disposition: string; legal: boolean; value: Record<string, unknown>; ref: typeof memory.understanding }> = [];
  for (const disposition of ["update", "no_change", "needs_clarification"]) for (const legal of [false, true]) {
    const hasTargets = legal ? disposition === "update" : disposition !== "update";
    const targets = hasTargets ? [memory.understanding] : [];
    const value = { ...base, id: `state-${disposition}-${legal}`, disposition, targetRefs: targets,
      changes: targets.map(after => ({ kind: "create", before: null, after, supportRefs: [memory.evidence], counterRefs: [] })) };
    cases.push({ disposition, legal, value, ref: await memory.put("changes", value, [memory.evidence, ...targets]) });
  }
  await memory.save();
  for (const example of cases) await t.test(`${example.disposition}: ${example.legal ? "legal shape accepted" : "contradictory targets rejected"}`, async () => {
    if (!example.legal) {
      assert.throws(() => validateLearningChange(example.value), /learning_change_target_mismatch/);
    } else {
      assert.doesNotThrow(() => validateLearningChange(example.value));
    }
  });
});
