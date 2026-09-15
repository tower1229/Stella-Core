import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { sourceSegments, assertEvidenceSegment } from "../src/canghai/source-segments.js";
import { bytesVersion, objectVersion, canonicalJson } from "../src/canghai/content-version.js";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { validatePersonalContextCatalog, type PersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { createFragmentReadTool } from "../src/openclaw/fragment-read-tool.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";

test("reviewed segments preserve originals and independent origin while enforcing narrower fragment policy before payload access", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-segments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("一般观察。\n医疗记录。\n"), boundary = Buffer.byteLength("一般观察。\n");
  await writeFile(path.join(root, "source.txt"), bytes);
  const general = { schemaVersion: "stella.source-policy/v1", id: "general", ownerId: "owner", readPurposes: ["retrieve"],
    derivePurposes: ["answer"], deliveryScopes: ["owner-direct"], retention: "retain", authorityEvidenceRefs: [] };
  const medical = { ...general, schemaVersion: "stella.source-policy/v3", id: "medical",
    restrictions: { sensitivity: "sensitive", quotePolicy: "never_quote", allowedScenarios: ["health_recovery"], forbiddenScenarios: ["medical_advice"] },
    usageRules: { access: [], interpretation: [{ id: "dated", requirement: "Keep dated observations historical." }] } };
  const generalRef = { id: general.id, version: objectVersion(general) }, medicalRef = { id: medical.id, version: objectVersion(medical) };
  const input = { root, sourceId: "synthetic-source", collectionId: "synthetic", relativePath: "source.txt", expectedSha256: bytesVersion(bytes),
    capturedAt: "2026-09-01T00:00:00Z", policyRef: generalRef, objectRoot: "objects",
    reviewedSegments: [{ start: 0, end: boundary, policyRef: generalRef }, { start: boundary, end: bytes.length, policyRef: medicalRef }] };
  const imported = await prepareRepositorySource(input);
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  for (const object of imported.objects) {
    const file = path.join(root, object.entry.locator.path);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, object.bytes);
    catalog[object.group].push(object.entry);
  }
  for (const policy of [general, medical]) {
    const body = canonicalJson(policy), ref = { id: policy.id, version: objectVersion(policy) };
    await writeFile(path.join(root, `${policy.id}.json`), body);
    catalog.policies.push({ ...ref, status: "current", dependencies: [], locator: { path: `${policy.id}.json`, sha256: bytesVersion(body) } });
  }
  await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  const reader = await CatalogReader.load(root, "catalog.json");
  const processing: PersonalContextAccess = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["owner"],
    modelRefs: ["synthetic/model"], purpose: { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "owner-direct" },
    descriptors: [{ sourceRef: imported.sourceRef, policyRef: medicalRef, description: "Synthetic medical fragment." }] };
  await assert.rejects(validatePersonalContextCatalog(reader, processing), /personal_context_segment_descriptor_required/);
  processing.descriptors = [
    { sourceRef: imported.sourceRef, policyRef: generalRef, description: "Synthetic general fragment.",
      segment: { payloadSha256: input.expectedSha256, start: 0, end: boundary } },
    { sourceRef: imported.sourceRef, policyRef: medicalRef, description: "Synthetic medical fragment.",
      segment: { payloadSha256: input.expectedSha256, start: boundary, end: bytes.length } },
  ];
  processing.descriptors.push({ sourceRef: imported.sourceRef, policyRef: generalRef, description: "Synthetic medical fragment under its parent policy.",
    segment: { payloadSha256: input.expectedSha256, start: boundary, end: bytes.length } });
  await validatePersonalContextCatalog(reader, processing);
  await assert.rejects(validatePersonalContextCatalog(reader, { ...processing, descriptors: [
    { sourceRef: imported.sourceRef, policyRef: generalRef, description: "Broad whole-source description." },
  ] }), /personal_context_segment_descriptor_required/);
  await assert.rejects(validatePersonalContextCatalog(reader, { ...processing, descriptors: [...processing.descriptors,
    { sourceRef: { id: "stale-source", version: imported.sourceRef.version }, policyRef: medicalRef, description: "Stale." },
  ] }), /personal_context_descriptor_not_current/);
  await assert.rejects(validatePersonalContextCatalog(reader, { ...processing, ownerId: "other" }), /personal_context_owner_mismatch/);
  let payloadReads = 0, trigger: "proactive" | "user_requested" = "proactive", presentation: "summary" | "quote" = "summary";
  const readPayload = reader.readPayload.bind(reader);
  reader.readPayload = async (...args) => { payloadReads++; return readPayload(...args); };
  const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "owner-direct",
    evidenceCutoff: "2026-09-02T00:00:00Z", trustedAdapters: { user_report: [], tool_observation: [], system_event: [] },
    sourceAccess: async () => ({ judgment: { trigger, presentation, topicRequested: true, topicExplicitlyNamed: true, scenarios: ["health_recovery"] }, quoteGrants: [medicalRef] }),
  }, async () => { throw new Error("No semantic action inference"); });
  const noContext = new EpisodeEvidenceResolver(reader, { ...resolver.purpose, sourceAccess: undefined }, resolver.complete);
  await assert.rejects(noContext.readEvidence(imported.evidenceRefs[0]!), /source_access_context_required/);
  const ordinary = await resolver.readEvidence(imported.evidenceRefs[0]!);
  assert.equal(ordinary.text, "一般观察。\n"); assert.equal(ordinary.role, "unknown");
  const tool = createFragmentReadTool({ resolver, descriptors: processing.descriptors, originals: [ordinary], assertCurrent: async () => {} });
  const listed = await tool.execute("list", { action: "list" });
  assert.equal(JSON.stringify(listed).includes("医疗记录"), false);
  assert.equal(JSON.stringify(listed).includes("source.txt"), false);
  const read = await tool.execute("read", { action: "read", handle: "F1" });
  assert.equal(read.details.original?.text, "一般观察。\n");
  await assert.rejects(tool.execute("read", { action: "read", handle: "F2" }), /fragment_handle_not_available/);
  await assert.rejects(tool.execute("read", { action: "read", handle: "F1", path: "source.txt" }), /invalid_fragment_request/);

  const beforeDenied = payloadReads;
  await assert.rejects(resolver.readEvidence(imported.evidenceRefs[1]!), /source_trigger_forbidden/);
  assert.equal(payloadReads, beforeDenied);
  await assert.rejects(resolver.assertSourceAccess(imported.sourceRef, generalRef), /segmented_source_requires_evidence/);
  trigger = "user_requested";
  const sensitive = await resolver.readEvidence(imported.evidenceRefs[1]!);
  assert.equal(sensitive.text, "医疗记录。\n");
  assert.equal(sensitive.independentOriginId, ordinary.independentOriginId);
  assert.equal(sensitive.usageConstraints?.[0]?.rules[0]?.id, "dated");
  presentation = "quote";
  await assert.rejects(resolver.readEvidence(imported.evidenceRefs[1]!), /source_quote_forbidden/);
  assert.deepEqual(await readFile(path.join(root, "source.txt")), bytes);
  for (const reviewedSegments of [
    [{ start: 1, end: bytes.length, policyRef: generalRef }],
    [{ start: 0, end: boundary, policyRef: generalRef }],
    [{ start: 0, end: boundary, policyRef: generalRef }, { start: boundary - 1, end: bytes.length, policyRef: medicalRef }],
    [{ start: 0, end: 1, policyRef: generalRef }, { start: 1, end: bytes.length, policyRef: medicalRef }],
  ]) await assert.rejects(prepareRepositorySource({ ...input, reviewedSegments }));
  await assert.rejects(prepareRepositorySource({ ...input, expectedSha256: `sha256:${"0".repeat(64)}` }), /repository_source_changed/);
  const source = imported.objects.find(object => object.group === "sources")!.object;
  const segments = sourceSegments(source);
  assert.throws(() => assertEvidenceSegment(segments, { selector: { kind: "utf8_bytes", value: `0:${bytes.length}` }, policyRef: generalRef, payloadSha256: input.expectedSha256 }), /evidence_segment_policy_mismatch/);
  assert.throws(() => assertEvidenceSegment(segments, { selector: { kind: "utf8_bytes", value: `${boundary}:${bytes.length}` }, policyRef: generalRef, payloadSha256: input.expectedSha256 }), /evidence_segment_policy_mismatch/);
  assert.throws(() => sourceSegments({ ...source, schemaVersion: "stella.memory-source/v1" }), /source_segmentation_migration_required/);
  const payloads = source.payloads as Array<Record<string, unknown>>;
  assert.equal(objectVersion({ ...source, payloads: [{ ...payloads[0], path: "relocated.txt" }] }), objectVersion(source));
  // A forged whole-file Evidence must fail at the learning and output boundaries,
  // even if its catalog entry and content digest are structurally valid.
  const whole = { ...imported.objects.find(object => object.group === "evidence")!.object, id: "whole-source",
    selector: { kind: "utf8_bytes", value: `0:${bytes.length}` } };
  const wholeRef = { id: whole.id, version: objectVersion(whole) }, wholeBody = canonicalJson({ ...whole, version: wholeRef.version });
  await writeFile(path.join(root, "whole.json"), wholeBody);
  catalog.evidence.push({ ...wholeRef, status: "current", dependencies: [imported.sourceRef, generalRef],
    locator: { path: "whole.json", sha256: bytesVersion(wholeBody) } });
  catalog.generationId = "two";
  await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  const forgedResolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), resolver.purpose, resolver.complete);
  const { prepareCorrection } = await import("../src/learning/correction.js");
  const { prepareSourceOutputCheck } = await import("../src/canghai/source-output.js");
  const noModel = async (): Promise<never> => { throw new Error("Unauthorized content must not reach inference"); };
  await assert.rejects(prepareCorrection({ operationId: "forged", request: "Correction", ownerId: "owner", modelRef: "synthetic/model",
    recordedAt: "2026-09-02T00:00:00Z", evidenceRefs: [wholeRef], resolver: forgedResolver, objectRoot: "objects",
    assertProcessingCurrent: async () => {}, complete: noModel }), /evidence_segment_policy_mismatch/);
  await assert.rejects(prepareSourceOutputCheck({ question: "Quote this", originals: [{ ...ordinary, ref: wholeRef }], resolver: forgedResolver,
    modelRef: "synthetic/model", assertCurrent: async () => {}, complete: noModel }), /evidence_segment_policy_mismatch/);
  await assert.rejects(tool.execute("read", { action: "read", handle: "F1" }), /stale_generation/);

});

test("shared-policy fragments use their own descriptions and cannot reuse a neighbor's semantic verdict", async t => {
  const { personalMemoryFixture } = await import("./personal-memory-fixture.js");
  const { createPersonalContextAccess } = await import("../src/canghai/personal-context-access.js");
  const { retrieveCatalogEvidence } = await import("../src/canghai/semantic-retrieval.js");
  const f = await personalMemoryFixture(t, true);
  const base = await f.resolver(), policyRef = { id: f.catalog.policies[0]!.id, version: f.catalog.policies[0]!.version };
  const payload = "First context.\nDifferent context.\n";
  await writeFile(path.join(f.root, "shared.txt"), payload);
  const imported = await prepareRepositorySource({ root: f.root, collectionId: "shared", sourceId: "shared", relativePath: "shared.txt",
    expectedSha256: bytesVersion(payload), capturedAt: "2026-09-01T00:00:00Z", policyRef, objectRoot: "objects",
    reviewedSegments: [{ start: 0, end: 15, policyRef }, { start: 15, end: Buffer.byteLength(payload), policyRef }] });
  for (const object of imported.objects) {
    await mkdir(path.dirname(path.join(f.root, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(f.root, object.entry.locator.path), object.bytes); f.catalog[object.group].push(object.entry);
  }
  await f.save();
  const descriptors: PersonalContextAccess["descriptors"] = [
    { sourceRef: f.source, policyRef, description: "Original owner writing request" },
    ...[0, 15].map((start, index) => ({ sourceRef: imported.sourceRef, policyRef,
      description: index ? "The distinct second context" : "The first context",
      segment: { payloadSha256: bytesVersion(payload), start, end: index ? Buffer.byteLength(payload) : 15 } })),
  ];
  const prompt = "Compare these contexts", modelRef = "synthetic/model";
  let replayNeighbor = false, persistence = false;
  const provider = createPersonalContextAccess({ request: { prompt, requestHash: bytesVersion(prompt), agentId: "main", runId: "run",
    sessionId: "session", sessionKey: "agent:main:session", senderId: "owner", senderIsOwner: true, chatType: "direct" }, modelRef,
    binding: { config: { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["owner"], modelRefs: [modelRef],
      purpose: { readPurpose: base.purpose.readPurpose, derivePurpose: base.purpose.derivePurpose, deliveryScope: base.purpose.deliveryScope }, descriptors }, assertCurrent: async () => {} }, assertRequestCurrent: () => {},
    isPersistenceRevalidation: () => persistence,
    complete: async ({ prompt: query }) => {
      const data = JSON.parse(query.split("\n").at(-1)!);
      assert.equal(data.sourceDescription, data.segment.start ? "The distinct second context" : "The first context");
      return { text: JSON.stringify({ requestHash: data.requestHash, sourceRef: data.sourceRef, policyRef: data.policyRef,
        segment: replayNeighbor ? descriptors[1]!.segment : data.segment,
        applicable: true, scenarios: ["writing"], topicRequested: true, topicExplicitlyNamed: true }) };
    },
  });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  const resolver = new EpisodeEvidenceResolver(reader, { ...base.purpose, sourceAccess: provider }, base.complete);
  assert.equal((await resolver.readEvidence(imported.evidenceRefs[0]!)).text, "First context.\n");
  persistence = true;
  await assert.rejects(resolver.readEvidence(imported.evidenceRefs[1]!), /source_access_revalidation_receipt_required/);
  persistence = false; replayNeighbor = true;
  await assert.rejects(resolver.readEvidence(imported.evidenceRefs[1]!), /invalid_source_access_verdict/);
  replayNeighbor = false;
  assert.equal((await resolver.readEvidence(imported.evidenceRefs[1]!)).text, "Different context.\n");
  const retrieved = await retrieveCatalogEvidence({ question: prompt, resolver, descriptors, ownerId: "owner", modelRef,
    config: { schemaVersion: "stella.semantic-retrieval/v1", pageSize: 16, maxRounds: 1, maxSelected: 3, maxOriginalChars: 8000 },
    assertProcessingCurrent: async () => {}, complete: async ({ prompt: query }) => {
      const data = JSON.parse(query.split("\n").at(-1)!);
      if (data.candidates) {
        assert.deepEqual(data.candidates.map((candidate: { description: string }) => candidate.description),
          ["Original owner writing request", "The first context", "The distinct second context"]);
        return { provider: "synthetic", model: "model", text: '{"selected":["E3"]}' };
      }
      assert.equal(data.originals[0].original.text, "Different context.\n");
      return { provider: "synthetic", model: "model", text: '{"stopped":true,"nextIntents":[],"reason":"Selected original reviewed"}' };
    } });
  assert.deepEqual(retrieved.refs, [imported.evidenceRefs[1]]);
});


test("restricted parent policies authorize personal views through their evidence fragment", async t => {
  const { personalMemoryFixture } = await import("./personal-memory-fixture.js");
  const { createSourceAccessProvider } = await import("../src/canghai/source-access.js");
  const { preparePersonalViews } = await import("../src/praxis/personal-views.js");
  const f = await personalMemoryFixture(t, true, true), base = await f.resolver();
  const access = createSourceAccessProvider({ request: "Continue writing", trigger: "user_requested", presentation: "summary", quoteGrants: [],
    describe: async (_reader, target) => ({ ...target, description: "The owner's writing intention fragment" }),
    complete: async ({ prompt }) => {
      const value = JSON.parse(prompt.split("\n").at(-1)!);
      assert.ok(value.segment, "Source metadata must not be authorized as a whole-file body");
      return { text: JSON.stringify({ requestHash: value.requestHash, sourceRef: value.sourceRef, policyRef: value.policyRef,
        segment: value.segment, applicable: true, scenarios: ["writing"], topicRequested: true, topicExplicitlyNamed: true }) };
    } });
  const resolver = new EpisodeEvidenceResolver(base.reader, { ...base.purpose, sourceAccess: access }, base.complete);
  const views = await preparePersonalViews({ requestId: "view", question: "Continue writing", ownerId: "owner", modelRef: "synthetic/model", resolver,
    assertProcessingCurrent: async () => {}, complete: async ({ prompt }) => {
      const value = JSON.parse(prompt.split("\n").at(-1)!);
      assert.equal(value.candidates.length, 2);
      return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: value.requestHash,
        selections: value.candidates.map((candidate: { handle: string }) => ({ handle: candidate.handle, view: "memory" })) }) };
    } });
  assert.equal(views.view.memory.length, 2);
  await views.assertCurrent();
});
