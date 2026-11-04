import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixtures/ordinary-source-read.js";
import { migrationSourceFixture } from "./fixtures/migration-source-export.js";
import { prepareMigratedRepositorySource, type MigratedRepositorySourceInput } from "../src/canghai/repository-source.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";

async function setup(t: TestContext, index = 0) {
  const f = await fixture(t, 0);
  const sample = structuredClone(migrationSourceFixture.samples[index]!);
  for (const [file, bytes] of Object.entries(sample.files)) await f.put(file, bytes);
  const ref = (entry: { id: string; version: string }) => ({ id: entry.id, version: entry.version });
  const input: MigratedRepositorySourceInput = { root: f.root, receipt: sample.receipt,
    sourceRevision: migrationSourceFixture.sourceRevision, sourceId: sample.receipt.identity.value,
    collectionId: "synthetic-MIG02-records", originalPath: sample.originalPath,
    capturedAt: "2026-09-01T00:00:00Z", policyRef: ref(f.catalog.policies[0]!),
    objectRoot: "runtime-export/objects", reviewedSegments: [
      { start: 0, end: Buffer.byteLength(sample.originalText), policyRef: ref(f.catalog.policies[1]!) },
    ] };
  const publish = async (prepared: Awaited<ReturnType<typeof prepareMigratedRepositorySource>>) => {
    for (const item of prepared.objects) {
      for (const old of f.catalog[item.group]) if (old.id === item.ref.id && old.status === "current") old.status = "superseded";
      await f.put(item.entry.locator.path, item.bytes); f.catalog[item.group].push(item.entry);
    }
    f.catalog.parentGenerationId = f.catalog.generationId;
    f.catalog.generationId = `export-${prepared.sourceRef.version}`;
    f.manifest.sourceBaseline.commit = input.sourceRevision;
    f.manifest.identity.runtimeProfileRef = "path:runtime-export/profile.json";
    f.manifest.runtimeState.runtimeProfileRef = f.manifest.identity.runtimeProfileRef;
    f.profile.memory.catalog_ref = "path:runtime-export/catalog.json";
    await f.put("runtime-export/manifest.json", canonicalJson(f.manifest));
    await f.put("runtime-export/profile.json", canonicalJson(f.profile));
    await f.put("runtime-export/catalog.json", canonicalJson(f.catalog));
    const revision = await f.commit();
    f.binding.manifestPath = "runtime-export/manifest.json"; f.binding.revision = revision;
    return revision;
  };
  return { f, sample, input, publish };
}

for (const [index, label] of ["rewritten link with retained BOM/CRLF original", "unchanged original"].entries()) {
  test(`fixed MIG02 producer receipt exports ${label} through current runtime entry`, async t => {
    const { f, sample, input, publish } = await setup(t, index);
    const before = await f.git("status", "--porcelain");
    const prepared = await prepareMigratedRepositorySource(input);
    assert.equal(await f.git("status", "--porcelain"), before, "preparation writes no objects or config");
    assert.equal(prepared.migration.processingPermissionGranted, false);
    assert.equal(prepared.migration.runtimeActivated, false);
    assert.equal(prepared.migration.sourceRevision, migrationSourceFixture.sourceRevision);
    assert.equal(prepared.migration.normalizationChangedBytes, index === 0);
    assert.deepEqual(await readFile(path.join(f.root, sample.originalPath)), Buffer.from(sample.originalText));
    const revision = await publish(prepared);
    assert.notEqual(revision, migrationSourceFixture.sourceRevision, "final export commit is not the original producer baseline");
    const listed = await f.execute({ action: "list" }); assert.equal(listed.status, "listed");
    assert.deepEqual(listed.items.map(item => item.ref), prepared.evidenceRefs);
    const read = await f.execute({ action: "read", ref: prepared.evidenceRefs[0] }); assert.equal(read.status, "read");
    assert.equal(read.original.text, sample.originalText); assert.equal(read.revision, revision);
    assert.equal(read.original.role, "unknown"); assert.equal(read.original.kind, "unknown");
    assert.equal(read.original.occurredAt, null); assert.equal(read.original.authoredAt, null);
    assert.equal(read.provenance.speakerId, null);
    assert.equal(read.provenance.origin.upstreamId, input.sourceId);
    for (const key of ["manifestHash", "profileHash", "catalogHash"] as const) assert.match(read[key], /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(f.catalog.understandings, []); assert.deepEqual(f.catalog.works, []);
  });
}

test("a normalized link rewrite cannot be substituted for the selected original bytes", async t => {
  const { input, sample } = await setup(t);
  const normalized = sample.receipt.targetFiles.find(file => file.endsWith("/source.md") && !file.includes("/original/"))!;
  await assert.rejects(prepareMigratedRepositorySource({ ...input, originalPath: normalized }), /repository_source_changed/);
});

test("migration aggregate manifest and mapping cannot stand in for a document receipt", async t => {
  const { input } = await setup(t);
  for (const receipt of [{ schemaVersion: "canghai.evidence-migration-receipt/v1", planDigest: "x", files: [] },
    { schemaVersion: "canghai.evidence-migration-receipt/v1", entries: [], sourceRevision: input.sourceRevision }]) {
    await assert.rejects(prepareMigratedRepositorySource({ ...input, receipt }), /migration_document_receipt_required/);
  }
});

test("provisional identities, mismatched record IDs and pending version review remain explicit failures", async t => {
  const { input, sample } = await setup(t);
  for (const receipt of [
    { ...sample.receipt, identity: { kind: "provisional_origin_path", path: "note.md" }, requiresIdentityReview: true },
    { ...sample.receipt, requiresIdentityReview: true },
    { ...sample.receipt, identity: { kind: "existing_source_id", value: "different-record" } },
  ]) await assert.rejects(prepareMigratedRepositorySource({ ...input, receipt }), /migration_stable_identity_required/);
  await assert.rejects(prepareMigratedRepositorySource({ ...input, receipt: { ...sample.receipt, requiresSourceVersionReview: true } }), /migration_source_version_review_required/);
  await assert.rejects(prepareMigratedRepositorySource({ ...input, sourceRevision: "b".repeat(40) }), /migration_source_revision_mismatch/);
});

test("inactive candidate flags are not a grant, and unsupported dispositions do not become text evidence", async t => {
  const { input, sample } = await setup(t);
  for (const change of [{ modelReadPermissionGranted: true }, { activeCatalogChanged: true }, { semanticallyAdmitted: true },
    { disposition: "opaque_original_preserved" }, { disposition: "native_domain_preserved_candidate" }, { reasons: ["unresolved_local_reference"] }]) {
    await assert.rejects(prepareMigratedRepositorySource({ ...input, receipt: { ...sample.receipt, ...change } }), /migration_document_receipt_required/);
  }
});

test("explicit original membership, size, payload digest and reviewed segmentation are required", async t => {
  const { f, input, sample } = await setup(t);
  await assert.rejects(prepareMigratedRepositorySource({ ...input, originalPath: "not-in-the-receipt.md" }), /migration_original_not_declared/);
  await assert.rejects(prepareMigratedRepositorySource({ ...input, reviewedSegments: [] }), /migration_reviewed_segments_required/);
  await assert.rejects(prepareMigratedRepositorySource({ ...input, reviewedSegments: [{ ...input.reviewedSegments[0]!, end: 1 }] }), /source_segment_coverage_incomplete/);
  await assert.rejects(prepareMigratedRepositorySource({ ...input, receipt: { ...sample.receipt, originBytes: sample.receipt.originBytes + 1 } }), /migration_original_size_mismatch/);
  await f.put(input.originalPath, "tampered fictional original");
  await assert.rejects(prepareMigratedRepositorySource(input), /repository_source_changed/);
});

for (const [label, originMode] of [
  ["numeric regular mode", 100644], ["numeric executable mode", 100755],
  ["array regular mode", ["100644"]], ["array executable mode", ["100755"]],
] as const) {
  test(`MIG02 rejects ${label} without coercing it to a string`, async t => {
    const { input, sample } = await setup(t);
    await assert.rejects(prepareMigratedRepositorySource({ ...input,
      receipt: { ...sample.receipt, originMode } }), /migration_original_metadata_invalid/);
  });
}

for (const originMode of ["100644", "100755"]) {
  test(`MIG02 accepts the exact string mode ${originMode}`, async t => {
    const { input, sample } = await setup(t);
    const prepared = await prepareMigratedRepositorySource({ ...input, receipt: { ...sample.receipt, originMode } });
    assert.equal(prepared.migration.originalSha256, `sha256:${sample.receipt.originSha256}`);
  });
}

test("source updates retain record identity but require a new export pin and reject old evidence/cursors", async t => {
  const { f, input, sample, publish } = await setup(t, 1);
  const first = await prepareMigratedRepositorySource(input); const beforeRevision = await publish(first);
  const listed = await f.execute({ action: "list" }); assert.equal(listed.status, "listed");
  const nextText = sample.originalText + "Fictional revision: choose August instead.\n";
  await f.put(input.originalPath, nextText);
  input.sourceRevision = await f.commit();
  // A manually constructed synthetic update, not a second MIG02 producer run or a grant.
  const receipt = { ...sample.receipt, sourceRevision: input.sourceRevision,
    originBlob: (await f.git("hash-object", input.originalPath)).trim(),
    originBytes: Buffer.byteLength(nextText), originSha256: bytesVersion(nextText).slice(7),
    normalizedSha256: bytesVersion(nextText).slice(7) };
  const second = await prepareMigratedRepositorySource({ ...input, receipt,
    reviewedSegments: [{ ...input.reviewedSegments[0]!, end: Buffer.byteLength(nextText) }] });
  assert.equal(second.sourceRef.id, first.sourceRef.id); assert.notEqual(second.sourceRef.version, first.sourceRef.version);
  await publish(second); const afterRevision = f.binding.revision; f.binding.revision = beforeRevision;
  await assert.rejects(f.execute({ action: "list" }), /source_revision_mismatch/); f.binding.revision = afterRevision;
  await assert.rejects(f.execute({ action: "list", cursor: { catalogHash: listed.catalogHash, offset: 0 } }), /source_cursor_stale/);
  await assert.rejects(f.execute({ action: "read", ref: first.evidenceRefs[0] }));
  const read = await f.execute({ action: "read", ref: second.evidenceRefs[0] }); assert.equal(read.status, "read");
  assert.equal(read.original.text, nextText); assert.equal(read.revision, afterRevision);
});

test("receipt and returned preparation do not bypass ordinary source admission", async t => {
  const { f, input, publish } = await setup(t);
  const prepared = await prepareMigratedRepositorySource(input); await publish(prepared);
  const denied = { ...f.admission, assertMetadata: async () => false as const };
  const listed = await f.execute({ action: "list" }, denied); assert.equal(listed.status, "listed"); assert.deepEqual(listed.items, []);
  await assert.rejects(f.execute({ action: "read", ref: prepared.evidenceRefs[0] }, denied), /source_descriptor_scope_denied/);
});
