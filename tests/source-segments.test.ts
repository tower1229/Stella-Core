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
  await validatePersonalContextCatalog(reader, processing);
  await assert.rejects(validatePersonalContextCatalog(reader, { ...processing, descriptors: [
    { sourceRef: imported.sourceRef, policyRef: generalRef, description: "Broad whole-source description." },
  ] }), /personal_context_descriptor_required/);
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
  const ordinary = await resolver.readEvidence(imported.evidenceRefs[0]!);
  assert.equal(ordinary.text, "一般观察。\n"); assert.equal(ordinary.role, "unknown");
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
});
