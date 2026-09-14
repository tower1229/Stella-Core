import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import {
  EXPLICIT_RECORD_ADAPTER,
  ingest,
  ingestExplicitRecord,
  ingestHostMessage,
  IngestError,
  prepareExplicitRecordItems,
  prepareHostMessageItems,
  type HostRetentionGuarantees,
} from "../src/canghai/ingest.js";
import { HOST_INPUT_ARCHIVE_ADAPTER, prepareHostInputArchive } from "../src/canghai/host-input-archive.js";
import { persistHostInputArchive } from "../src/canghai/archive-writer.js";
import { CatalogError } from "../src/canghai/catalog-reader.js";
import { isRecord } from "../src/shared/type-guards.js";
import type { HostInputSnapshot } from "../src/openclaw/host-input.js";
import { ingestMaterials, synchronizeRepositoryImports, type MaterialImport } from "../src/canghai/material-ingest.js";

const run = promisify(execFile);
const now = "2026-09-11T00:00:00Z";

test("file import retains exact original bytes, unknown authorship and idempotent source identity", async (t) => {
  const repo = await gitRepo(t);
  const original = Buffer.from("旧资料\r\n混合原话与未审查分析。\r\n");
  const material: MaterialImport = {
    upstreamId: "legacy-1", capturedAt: now, provenance: { type: "unknown" },
    original: { mediaType: "text/plain", bytes: original, sha256: bytesVersion(original) },
  };
  const input = { operationId: "op-files", expectedRevision: repo.revision, collectionId: "legacy",
    entry: "files" as const, snapshotId: "export-1", materials: [material], policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" } };
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  const result = await ingestMaterials(input, ports);
  assert.equal(result.state, "synchronized");
  assert.equal(result.evidenceRefs.length, 1, "archive metadata is not an additional author statement");
  const current = await CatalogReader.load(repo.root, "catalog.json");
  assert.deepEqual((await current.readPayload(result.sourceRefs[0]!, bytesVersion(original))).bytes, original);
  for (const ref of result.evidenceRefs) {
    const evidence = await current.read(ref, "evidence");
    assert.equal(evidence.role, "unknown");
    assert.equal(evidence.kind, "unknown");
    assert.equal(evidence.speakerId, null);
  }
  const repeated = await ingestMaterials(input, { ...ports, reader: current });
  assert.deepEqual(repeated.sourceRefs, result.sourceRefs);
  const newOperation = await ingestMaterials({ ...input, operationId: "op-files-again",
    expectedRevision: repeated.durability.localRevision }, { ...ports, reader: current });
  assert.deepEqual(newOperation.sourceRefs, result.sourceRefs);
  assert.equal((await CatalogReader.load(repo.root, "catalog.json")).catalog.sources.length, 1);
});

test("skill product retains model attribution, skill version and source evidence without becoming owner words", async (t) => {
  const repo = await gitRepo(t);
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  const purpose = { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" };
  const record = await ingestExplicitRecord({ operationId: "skill-input", expectedRevision: repo.revision,
    collectionId: "answers", record: { upstreamId: "answer-1", text: "我还没有决定。", role: "owner",
      speakerId: "owner-ingest", capturedAt: now }, policyRef: repo.policyRef, purpose }, ports);
  const original = Buffer.from("模型提出的候选解释。");
  const input = { operationId: "skill-output", expectedRevision: record.durability.localRevision,
    collectionId: "skill-results", entry: "skill" as const, snapshotId: "invocation-1", policyRef: repo.policyRef, purpose,
    materials: [{ upstreamId: "product-1", capturedAt: now, provenance: { type: "generated" as const, producerId: "model-test" },
      original: { bytes: original, sha256: bytesVersion(original), mediaType: "text/plain" },
      skill: { id: "understand-owner", version: bytesVersion("skill-body") }, derivedFrom: record.evidenceRefs }] };
  const result = await ingestMaterials(input, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  const current = await CatalogReader.load(repo.root, "catalog.json");
  for (const ref of result.evidenceRefs) {
    const evidence = await current.read(ref, "evidence");
    assert.equal(evidence.role, "assistant");
    assert.equal(evidence.kind, "inference");
    assert.equal(evidence.speakerId, "model-test");
    assert.deepEqual(evidence.derivedFrom, record.evidenceRefs);
    const parent = await current.read(record.evidenceRefs[0]!, "evidence");
    assert.equal(evidence.independentOriginId, parent.independentOriginId);
  }
  const source = await current.read(result.sourceRefs[0]!, "sources");
  assert.ok(Array.isArray(source.payloads) && isRecord(source.payloads[0]));
  const metadata = JSON.parse((await current.readPayload(result.sourceRefs[0]!, String(source.payloads[0].sha256))).bytes.toString());
  assert.deepEqual(metadata.skill, input.materials[0]!.skill);
  assert.deepEqual((await ingestMaterials(input, { ...ports, reader: current })).sourceRefs, result.sourceRefs);
});

test("external research keeps available originals and marks summary-only imports incomplete", async (t) => {
  const repo = await gitRepo(t);
  const input = { operationId: "external-summary", expectedRevision: repo.revision,
    collectionId: "research", entry: "external" as const, snapshotId: "research-1", policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    materials: [{ upstreamId: "page-1", capturedAt: now,
      provenance: { type: "generated" as const, producerId: "research-tool" }, original: null,
      summary: "工具返回的摘要。", sourceUrl: "https://example.org/source", personalRelation: "用于主人提出的研究问题" }] };
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  const result = await ingestMaterials(input, ports);
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const coverage = await current.read(result.coverageRef!, "coverage");
  assert.equal(coverage.completeForDeclaredScope, false);
  assert.deepEqual(coverage.missingItems, [{ upstreamId: "page-1#original", reason: "attachment_missing", retryable: false }]);
  const evidence = await current.read(result.evidenceRefs[0]!, "evidence");
  assert.equal(evidence.role, "assistant");
  assert.equal(evidence.kind, "inference");
  assert.deepEqual((await ingestMaterials(input, { ...ports, reader: current })).sourceRefs, result.sourceRefs);
  const original = Buffer.from("外部作者实际原文。");
  const retained = await ingestMaterials({ ...input, operationId: "external-original", expectedRevision: result.durability.localRevision,
    snapshotId: "research-2", materials: [{ ...input.materials[0]!, upstreamId: "page-2", summary: undefined,
      provenance: { type: "authored", authorId: "external-writer", role: "external_author" },
      original: { bytes: original, sha256: bytesVersion(original), mediaType: "text/plain" } }] },
  { ...ports, reader: current });
  const updated = await CatalogReader.load(repo.root, "catalog.json");
  assert.deepEqual((await updated.readPayload(retained.sourceRefs[0]!, bytesVersion(original))).bytes, original);
  assert.equal((await updated.read(retained.coverageRef!, "coverage")).completeForDeclaredScope, true);
});

test("repository synchronization ingests a committed original in place and rejects changed or missing sources", async (t) => {
  const repo = await gitRepo(t);
  const original = Buffer.from("Obsidian 原件\r\n");
  await mkdir(path.join(repo.root, "notes"));
  await writeFile(path.join(repo.root, "notes", "draft.md"), original);
  await run("git", ["-C", repo.root, "add", "notes"]);
  await run("git", ["-C", repo.root, "commit", "--quiet", "-m", "add source"]);
  await run("git", ["-C", repo.root, "push", "--quiet", "origin", `HEAD:refs/heads/${repo.branch}`]);
  const revision = (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim();
  const input = { operationId: "repository-import", expectedRevision: revision, sourceRevision: revision,
    collectionId: "notes", capturedAt: now, policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    files: [{ upstreamId: "stable-draft", relativePath: "notes/draft.md", mediaType: "text/markdown",
      sha256: bytesVersion(original), provenance: { type: "unknown" as const } }] };
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  const result = await synchronizeRepositoryImports(input, ports);
  const current = await CatalogReader.load(repo.root, "catalog.json");
  assert.deepEqual((await current.readPayload(result.sourceRefs[0]!, bytesVersion(original))).bytes, original);
  assert.deepEqual(await readFile(path.join(repo.root, "notes/draft.md")), original);
  assert.deepEqual((await synchronizeRepositoryImports(input, { ...ports, reader: current })).sourceRefs, result.sourceRefs);
  await writeFile(path.join(repo.root, "notes/draft.md"), "changed");
  await assert.rejects(synchronizeRepositoryImports(input, { ...ports, reader: current }), /repository_source_changed/);
  await rm(path.join(repo.root, "notes/draft.md"));
  await assert.rejects(synchronizeRepositoryImports(input, { ...ports, reader: current }), /source_unavailable/);
});

for (const entry of ["files", "skill", "external"] as const) {
  test(`${entry} rejects damaged or absent original and preserves retention admission`, async (t) => {
    const repo = await gitRepo(t, "do_not_retain");
    const bytes = Buffer.from("不得留存的原件");
    const input = { operationId: `denied-${entry}`, expectedRevision: repo.revision, entry,
      collectionId: "imports", snapshotId: "snapshot-1", policyRef: repo.policyRef,
      purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
      materials: [{ upstreamId: "item-1", capturedAt: now, provenance: { type: "unknown" as const },
        skill: { id: "skill-1", version: bytesVersion("skill") },
        sourceUrl: "https://example.org/original", personalRelation: "用户请求",
        original: { bytes, sha256: bytesVersion(bytes), mediaType: "application/octet-stream" } }] };
    const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
      durability: durability(repo.root, repo.remote, repo.branch),
      retentionGuarantees: { transcript: false, staging: false, backup: false },
      objectRoot: "memory/objects", payloadRoot: "experience/imports" };
    await assert.rejects(ingestMaterials({ ...input, materials: [{ ...input.materials[0]!,
      original: { ...input.materials[0]!.original, bytes: Buffer.from("corrupted") } }] }, ports), /material_original_mismatch/);
    await assert.rejects(ingestMaterials({ ...input, materials: [{ ...input.materials[0]!, original: null }] }, ports), /material_original_missing/);
    await assert.rejects(ingestMaterials(input, ports), /retention_guarantee_unavailable/);
    assert.equal((await run("git", ["-C", repo.root, "status", "--porcelain"])).stdout, "");
    const retained = await ingestMaterials(input, { ...ports, retentionGuarantees: retainGuarantees });
    assert.deepEqual(retained.sourceRefs, []);
    assert.equal((await CatalogReader.load(repo.root, "catalog.json")).catalog.sources.length, 0);
  });
}

test("file batch preserves empty and binary originals; invalid attribution is explicitly rejected", async (t) => {
  const repo = await gitRepo(t);
  const input = { operationId: "binary-import", expectedRevision: repo.revision, entry: "files" as const,
    collectionId: "binary", snapshotId: "binary-snapshot", policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    materials: [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0, 1])].map((bytes, index) => ({
      upstreamId: `binary-${index}`, capturedAt: now, provenance: { type: "unknown" as const },
      original: { bytes, sha256: bytesVersion(bytes), mediaType: "application/octet-stream" },
    })) };
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  await assert.rejects(ingestMaterials({ ...input, materials: [{ ...input.materials[0]!,
    provenance: { type: "generated", producerId: "" } }] }, ports), /invalid_material_provenance/);
  const result = await ingestMaterials(input, ports);
  const current = await CatalogReader.load(repo.root, "catalog.json");
  for (let index = 0; index < input.materials.length; index++) {
    const original = input.materials[index]!.original;
    assert.deepEqual((await current.readPayload(result.sourceRefs[index]!, original.sha256)).bytes, original.bytes);
  }
  assert.equal((await current.read(result.coverageRef!, "coverage")).completeForDeclaredScope, true);
});

test("multi-source skill derivation preserves exactly the parent's independent origins and rejects unavailable evidence", async (t) => {
  const repo = await gitRepo(t);
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  const purpose = { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" };
  const parents = await ingest({ operationId: "parents", expectedRevision: repo.revision, adapterId: EXPLICIT_RECORD_ADAPTER,
    collectionId: "parents", cursor: null, policyRef: repo.policyRef, purpose,
    items: ["first", "second"].flatMap(upstreamId => prepareExplicitRecordItems({ upstreamId, text: upstreamId,
      role: "owner", speakerId: "owner-ingest", capturedAt: now })) }, ports);
  const original = Buffer.from("两条资料的模型总结");
  const input = { operationId: "multi-product", expectedRevision: parents.durability.localRevision,
    collectionId: "skill", entry: "skill" as const, snapshotId: "invocation-multi", policyRef: repo.policyRef, purpose,
    materials: [{ upstreamId: "product", capturedAt: now, provenance: { type: "generated" as const, producerId: "model" },
      skill: { id: "summarizer", version: bytesVersion("skill") }, derivedFrom: parents.evidenceRefs,
      original: { bytes: original, sha256: bytesVersion(original), mediaType: "text/plain" } }] };
  const before = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(ingestMaterials({ ...input, materials: [{ ...input.materials[0]!,
    derivedFrom: [{ id: "missing-evidence", version: bytesVersion("missing") }] }] }, { ...ports, reader: before }));
  assert.equal((await run("git", ["-C", repo.root, "status", "--porcelain"])).stdout, "");
  const product = await ingestMaterials(input, { ...ports, reader: before });
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const parentOrigins = await Promise.all(parents.evidenceRefs.map(async ref => (await current.read(ref, "evidence")).independentOriginId));
  const productOrigins = await Promise.all(product.evidenceRefs.map(async ref => (await current.read(ref, "evidence")).independentOriginId));
  assert.deepEqual(productOrigins.sort(), parentOrigins.sort());
});

test("skill import rejects a hash-valid parent evidence whose original fragment is absent", async (t) => {
  const repo = await gitRepo(t);
  const ports = { reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch), retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects", payloadRoot: "experience/imports" };
  const purpose = { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" };
  const parent = await ingestExplicitRecord({ operationId: "parent", expectedRevision: repo.revision,
    collectionId: "parent", record: { upstreamId: "record", text: "真实片段", role: "owner", speakerId: "owner-ingest",
      capturedAt: now }, policyRef: repo.policyRef, purpose }, ports);
  // Import fixture: structurally valid, correctly hashed Evidence, but invalid source selector.
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const evidence = await current.read(parent.evidenceRefs[0]!, "evidence");
  const malformed: Record<string, unknown> = { ...evidence, selector: { kind: "json_pointer", value: "/missing" } };
  malformed.version = objectVersion(malformed);
  const entry = current.catalog.evidence[0]!;
  entry.version = String(malformed.version);
  entry.locator.sha256 = bytesVersion(canonicalJson(malformed));
  await writeFile(path.join(repo.root, entry.locator.path), canonicalJson(malformed));
  await writeFile(path.join(repo.root, "catalog.json"), canonicalJson(current.catalog));
  await run("git", ["-C", repo.root, "add", "."]);
  await run("git", ["-C", repo.root, "commit", "--quiet", "-m", "malformed fragment fixture"]);
  await run("git", ["-C", repo.root, "push", "--quiet", "origin", `HEAD:refs/heads/${repo.branch}`]);
  const revision = (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim();
  const original = Buffer.from("候选模型解释");
  await assert.rejects(ingestMaterials({ operationId: "bad-fragment", expectedRevision: revision, entry: "skill",
    collectionId: "skill", snapshotId: "invocation", policyRef: repo.policyRef, purpose,
    materials: [{ upstreamId: "product", capturedAt: now, provenance: { type: "generated", producerId: "model" },
      original: { bytes: original, sha256: bytesVersion(original), mediaType: "text/plain" },
      skill: { id: "summarizer", version: bytesVersion("skill") }, derivedFrom: [{ id: entry.id, version: entry.version }] }] },
  { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch) }), /selector_unavailable/);
  assert.equal((await run("git", ["-C", repo.root, "status", "--porcelain"])).stdout, "");
});

const policy = {
  schemaVersion: "stella.source-policy/v1",
  id: "policy-ingest",
  ownerId: "owner-ingest",
  readPurposes: ["alpha"],
  derivePurposes: ["alpha"],
  deliveryScopes: ["synthetic"],
  retention: "retain",
  authorityEvidenceRefs: [],
};
const policyRef = { id: policy.id, version: objectVersion(policy) };

const retainGuarantees: HostRetentionGuarantees = {
  transcript: true,
  staging: true,
  backup: true,
};

function snapshot(overrides: Partial<HostInputSnapshot> & { entryId?: string; text?: string } = {}): HostInputSnapshot {
  const entryId = overrides.entryId ?? "message-ingest-1";
  const text = overrides.text ?? "原始报告。";
  return {
    schemaVersion: "stella.host-input-snapshot/v1",
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-ingest",
    sessionKey: "agent:synthetic:ingest",
    entryId,
    logicalTurnId: "logical-ingest",
    generation: "generation-ingest",
    rawSeq: 3,
    parentId: "parent-ingest",
    text,
    event: {
      type: "message",
      id: entryId,
      parentId: "parent-ingest",
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
    },
    ...overrides,
  };
}

async function gitRepo(t: test.TestContext, retention: "retain" | "do_not_retain" = "retain") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-ingest-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "work");
  const remote = path.join(parent, "remote.git");
  const branch = "synthetic-ingest";
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["init", "--quiet", "-b", branch, root]);
  await run("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await run("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  const policyBody = { ...policy, retention, version: objectVersion({ ...policy, retention }) };
  const policyBytes = canonicalJson(policyBody);
  const catalog = {
    schemaVersion: "stella.memory-catalog/v1",
    generationId: "generation-base",
    parentGenerationId: null,
    sources: [],
    evidence: [],
    coverage: [],
    policies: [{
      id: policyBody.id,
      version: policyBody.version,
      status: "current",
      dependencies: [],
      locator: { path: "policy.json", sha256: bytesVersion(policyBytes) },
    }],
    understandings: [],
    works: [],
    changes: [],
    bundles: [],
    views: [],
  };
  await writeFile(path.join(root, "policy.json"), policyBytes);
  await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "--quiet", "-m", "baseline"]);
  await run("git", ["-C", root, "remote", "add", "origin", remote]);
  await run("git", ["-C", root, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  const { stdout } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  return {
    root,
    remote,
    branch,
    revision: stdout.trim(),
    policyRef: { id: policyBody.id, version: policyBody.version },
  };
}

function durability(root: string, remote: string, branch: string) {
  return new GitCangHaiDurability({
    root,
    remote: "origin",
    branch,
    criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately",
    maxNormalRpoSeconds: 0,
  });
}

test("Host message ingest walks received→staged→validated→local_committed→synchronized with provenance", async (t) => {
  const repo = await gitRepo(t);
  const reader = await CatalogReader.load(repo.root, "catalog.json");
  const phases: string[] = [];
  const host = snapshot();
  const result = await ingestHostMessage({
    operationId: "op-host-1",
    expectedRevision: repo.revision,
    snapshot: host,
    speaker: { id: "owner-ingest", role: "owner" },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader,
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
    onPhase: (phase) => { phases.push(phase); },
  });
  assert.deepEqual(phases, ["received", "staged", "validated", "local_committed", "synchronized"]);
  assert.equal(result.state, "synchronized");
  assert.equal(result.sourceRefs.length, 1);
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const source = await current.read(result.sourceRefs[0]!, "sources");
  assert.ok(isRecord(source.origin));
  assert.equal(source.origin.adapterId, HOST_INPUT_ARCHIVE_ADAPTER);
  assert.equal(source.origin.upstreamId, host.entryId);
  assert.deepEqual(source.policyRef, repo.policyRef);
  assert.equal(current.catalog.evidence.length, 1);
  const evidence = await current.read(current.catalog.evidence[0]!, "evidence");
  assert.equal(evidence.role, "owner");
  assert.equal(evidence.speakerId, "owner-ingest");
  assert.ok(Array.isArray(source.payloads) && isRecord(source.payloads[0]));
  const payload = await current.readPayload(result.sourceRefs[0]!, String(source.payloads[0].sha256));
  assert.match(payload.bytes.toString("utf8"), /原始报告。/);
  assert.equal(result.durability.localRevision, result.durability.synchronizedRevision);
  assert.doesNotMatch(JSON.stringify(result), /owner-ingest@|\/Users\//);
});

test("explicit record and Host message share the same ingest contract surface", async (t) => {
  const repo = await gitRepo(t);
  const reader = await CatalogReader.load(repo.root, "catalog.json");
  const result = await ingestExplicitRecord({
    operationId: "op-explicit-1",
    expectedRevision: repo.revision,
    collectionId: "explicit-notes",
    record: {
      upstreamId: "record-note-1",
      text: "显式记录原文。",
      role: "owner",
      speakerId: "owner-ingest",
      capturedAt: now,
    },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader,
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/explicit-records",
  });
  assert.equal(result.state, "synchronized");
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const source = await current.read(result.sourceRefs[0]!, "sources");
  assert.ok(isRecord(source.origin));
  assert.equal(source.origin.adapterId, EXPLICIT_RECORD_ADAPTER);
  assert.equal(source.origin.upstreamId, "record-note-1");
  const evidence = await current.read(current.catalog.evidence[0]!, "evidence");
  assert.equal(evidence.role, "owner");
  assert.equal(evidence.kind, "reported");
});

test("identical operationId retry returns original evidence; changed input conflicts", async (t) => {
  const repo = await gitRepo(t);
  const ports = {
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  };
  const host = snapshot();
  const input = {
    operationId: "op-retry-1",
    expectedRevision: repo.revision,
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: host.sessionId,
    cursor: host.parentId,
    policyRef: repo.policyRef,
    items: prepareHostMessageItems(host, { id: "owner-ingest", role: "owner" as const }),
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  };
  const first = await ingest(input, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  const second = await ingest(input, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  assert.deepEqual(second.sourceRefs, first.sourceRefs);
  assert.equal(second.state, "synchronized");
  const afterFirst = await CatalogReader.load(repo.root, "catalog.json");
  assert.equal(afterFirst.catalog.evidence.length, 1);
  const changed = {
    ...input,
    items: prepareHostMessageItems(snapshot({ text: "改过的原文。" }), { id: "owner-ingest", role: "owner" }),
  };
  const conflictReader = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(
    () => ingest(changed, { ...ports, reader: conflictReader }),
    (error: unknown) => error instanceof IngestError && error.category === "idempotency_conflict",
  );
  const afterConflict = await CatalogReader.load(repo.root, "catalog.json");
  assert.equal(afterConflict.catalog.evidence.length, 1);
});

test("upstream identity: edit creates a new source version; same text on different events stays separate", async (t) => {
  const repo = await gitRepo(t);
  const ports = {
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  };
  const firstHost = snapshot({ entryId: "message-a", text: "同一句话。" });
  const first = await ingest({
    operationId: "op-event-a",
    expectedRevision: repo.revision,
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: firstHost.sessionId,
    cursor: firstHost.parentId,
    policyRef: repo.policyRef,
    items: prepareHostMessageItems(firstHost, { id: "owner-ingest", role: "owner" }),
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });

  const otherHost = snapshot({ entryId: "message-b", text: "同一句话。" });
  const other = await ingest({
    operationId: "op-event-b",
    expectedRevision: (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim(),
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: otherHost.sessionId,
    cursor: otherHost.parentId,
    policyRef: repo.policyRef,
    items: prepareHostMessageItems(otherHost, { id: "owner-ingest", role: "owner" }),
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  assert.notEqual(other.sourceRefs[0]!.id, first.sourceRefs[0]!.id);
  assert.notEqual(other.sourceRefs[0]!.version, first.sourceRefs[0]!.version);

  const editedHost = snapshot({ entryId: "message-a", text: "编辑后的原话。" });
  const edited = await ingest({
    operationId: "op-event-a-edit",
    expectedRevision: (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim(),
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: editedHost.sessionId,
    cursor: editedHost.parentId,
    policyRef: repo.policyRef,
    items: prepareHostMessageItems(editedHost, { id: "owner-ingest", role: "owner" }),
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  assert.equal(edited.sourceRefs[0]!.id, first.sourceRefs[0]!.id);
  assert.notEqual(edited.sourceRefs[0]!.version, first.sourceRefs[0]!.version);

  const catalog = (await CatalogReader.load(repo.root, "catalog.json")).catalog;
  const versions = catalog.sources.filter((entry) => entry.id === first.sourceRefs[0]!.id);
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((entry) => entry.status === "current").length, 1);
  assert.equal(versions.filter((entry) => entry.status === "superseded").length, 1);
  assert.equal(catalog.sources.filter((entry) => entry.status === "current").length, 2);
});

test("do_not_retain blocks before any disk write when Host cannot guarantee surfaces", async (t) => {
  const repo = await gitRepo(t, "do_not_retain");
  const before = await run("git", ["-C", repo.root, "rev-parse", "HEAD"]);
  const listingBefore = await readdir(repo.root, { recursive: true });
  const host = snapshot();
  const blockedReader = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(
    () => ingest({
      operationId: "op-dnr-block",
      expectedRevision: repo.revision,
      adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
      collectionId: host.sessionId,
      cursor: host.parentId,
      policyRef: repo.policyRef,
      items: prepareHostMessageItems(host, { id: "owner-ingest", role: "owner" }),
      purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    }, {
      reader: blockedReader,
      durability: durability(repo.root, repo.remote, repo.branch),
      retentionGuarantees: { transcript: false, staging: true, backup: true },
      objectRoot: "memory/objects",
      payloadRoot: "experience/conversations",
    }),
    (error: unknown) => error instanceof IngestError && error.category === "retention_guarantee_unavailable",
  );
  const after = await run("git", ["-C", repo.root, "rev-parse", "HEAD"]);
  assert.equal(after.stdout, before.stdout);
  const listingAfter = await readdir(repo.root, { recursive: true });
  assert.deepEqual(listingAfter.sort(), listingBefore.sort());
  await assert.rejects(
    () => readFile(path.join(repo.root, "memory")),
    /ENOENT/,
  );
});

test("admitted do_not_retain records content-free operation status without payload or evidence", async (t) => {
  const repo = await gitRepo(t, "do_not_retain");
  const host = snapshot({ text: "不得留存的原文。" });
  const result = await ingest({
    operationId: "op-dnr-admit",
    expectedRevision: repo.revision,
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: host.sessionId,
    cursor: host.parentId,
    policyRef: repo.policyRef,
    items: prepareHostMessageItems(host, { id: "owner-ingest", role: "owner" }),
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });
  assert.equal(result.state, "synchronized");
  assert.deepEqual(result.sourceRefs, []);
  const current = await CatalogReader.load(repo.root, "catalog.json");
  assert.equal(current.catalog.sources.length, 0);
  assert.equal(current.catalog.evidence.length, 0);
  const tree = await readdir(repo.root, { recursive: true });
  assert.equal(tree.some((entry) => String(entry).includes("experience/conversations")), false);
  const operationBytes = await readFile(
    path.join(repo.root, path.dirname("catalog.json"), "operations", "op-dnr-admit.json"),
    "utf8",
  );
  assert.doesNotMatch(operationBytes, /不得留存的原文/);
  assert.match(operationBytes, /do_not_retain/);
});

test("prepareHostInputArchive and ingestHostMessage share the same sourceRef.id", async (t) => {
  const repo = await gitRepo(t);
  const host = snapshot();
  const prepared = prepareHostInputArchive(host, {
    policyRef: repo.policyRef,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
    speaker: { id: "owner-ingest", role: "owner" },
  });
  const result = await ingestHostMessage({
    operationId: "op-identity-align",
    expectedRevision: repo.revision,
    snapshot: host,
    speaker: { id: "owner-ingest", role: "owner" },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });
  assert.equal(result.sourceRefs[0]!.id, prepared.sourceRef.id);
});

test("G-03 role slice: assistant/unknown evidence is not owner; owner text stays recoverable", async (t) => {
  const repo = await gitRepo(t);
  const ports = {
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  };
  const ownerHost = snapshot({ entryId: "role-owner", text: "主人原话。" });
  const owner = await ingestHostMessage({
    operationId: "op-role-owner",
    expectedRevision: repo.revision,
    snapshot: ownerHost,
    speaker: { id: "owner-ingest", role: "owner" },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  const assistantHost = snapshot({ entryId: "role-assistant", text: "助手可见原文。" });
  const assistant = await ingestHostMessage({
    operationId: "op-role-assistant",
    expectedRevision: (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim(),
    snapshot: assistantHost,
    speaker: { id: "assistant-1", role: "assistant" },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  const unknownHost = snapshot({ entryId: "role-unknown", text: "身份未辨原文。" });
  const unknown = await ingestHostMessage({
    operationId: "op-role-unknown",
    expectedRevision: (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim(),
    snapshot: unknownHost,
    speaker: { id: null, role: "unknown" },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, { ...ports, reader: await CatalogReader.load(repo.root, "catalog.json") });
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const ownerEvidence = await current.read(owner.evidenceRefs[0]!, "evidence");
  const assistantEvidence = await current.read(assistant.evidenceRefs[0]!, "evidence");
  const unknownEvidence = await current.read(unknown.evidenceRefs[0]!, "evidence");
  assert.equal(ownerEvidence.role, "owner");
  assert.equal(assistantEvidence.role, "assistant");
  assert.notEqual(assistantEvidence.role, "owner");
  assert.equal(unknownEvidence.role, "unknown");
  assert.notEqual(unknownEvidence.role, "owner");
  const ownerSource = await current.read(owner.sourceRefs[0]!, "sources");
  assert.ok(Array.isArray(ownerSource.payloads) && isRecord(ownerSource.payloads[0]));
  const payload = await current.readPayload(owner.sourceRefs[0]!, String(ownerSource.payloads[0].sha256));
  assert.match(payload.bytes.toString("utf8"), /主人原话。/);
});

test("archiveCorrectionInput walks ingest phases and retries without new evidence", async (t) => {
  const { archiveCorrectionInput } = await import("../src/learning/host-correction.js");
  const { snapshotTurnRequest } = await import("../src/openclaw/turn-request.js");
  const repo = await gitRepo(t);
  const text = "纠正入口原话。";
  const host = snapshot({ entryId: "correction-message", text });
  const bound = snapshotTurnRequest({
    agentId: host.agentId,
    sessionId: host.sessionId,
    sessionKey: host.sessionKey,
    prompt: text,
    senderId: "owner-ingest",
    senderIsOwner: true,
    chatType: "direct",
  }, "correction-run-1");
  const portsBase = {
    request: bound,
    original: host,
    ownerId: "owner-ingest",
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    archive: { policyRef: repo.policyRef, objectRoot: "memory/objects", payloadRoot: "experience/conversations" },
    purpose: {
      readPurpose: "alpha",
      derivePurpose: "alpha",
      deliveryScope: "synthetic",
      evidenceCutoff: now,
      trustedAdapters: { user_report: [HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] },
    },
    durability: durability(repo.root, repo.remote, repo.branch),
    signal: new AbortController().signal,
    assertCurrent: async () => {},
    retentionGuarantees: retainGuarantees,
  };
  const first = await archiveCorrectionInput(portsBase);
  assert.equal(first.evidenceRefs.length, 1);
  assert.equal((await first.resolver.readEvidence(first.evidenceRefs[0]!)).text, text);
  const phasePath = path.join(repo.root, "operations", `${first.operationId}.phase.json`);
  const phase = JSON.parse(await readFile(phasePath, "utf8"));
  assert.equal(phase.schemaVersion, "stella.ingest-phase/v1");
  assert.equal(phase.phase, "synchronized");
  const op = JSON.parse(await readFile(path.join(repo.root, "operations", `${first.operationId}.json`), "utf8"));
  assert.equal(op.schemaVersion, "stella.memory-operation/v1");
  assert.equal(op.kind, "ingest");
  const beforeCount = (await CatalogReader.load(repo.root, "catalog.json")).catalog.evidence.length;
  const second = await archiveCorrectionInput({
    ...portsBase,
    reader: await CatalogReader.load(repo.root, "catalog.json"),
  });
  assert.deepEqual(second.evidenceRefs, first.evidenceRefs);
  assert.equal((await CatalogReader.load(repo.root, "catalog.json")).catalog.evidence.length, beforeCount);
});

test("archiveCorrectionInput and persistHostInputArchive block do_not_retain before any disk write", async (t) => {
  const { archiveCorrectionInput } = await import("../src/learning/host-correction.js");
  const { snapshotTurnRequest } = await import("../src/openclaw/turn-request.js");
  const repo = await gitRepo(t, "do_not_retain");
  const before = await run("git", ["-C", repo.root, "rev-parse", "HEAD"]);
  const listingBefore = await readdir(repo.root, { recursive: true });
  const text = "不得落盘的纠正原文。";
  const host = snapshot({ entryId: "dnr-correction", text });
  const bound = snapshotTurnRequest({
    agentId: host.agentId,
    sessionId: host.sessionId,
    sessionKey: host.sessionKey,
    prompt: text,
    senderId: "owner-ingest",
    senderIsOwner: true,
    chatType: "direct",
  }, "correction-dnr-run");
  const dnrReader = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(
    () => archiveCorrectionInput({
      request: bound,
      original: host,
      ownerId: "owner-ingest",
      reader: dnrReader,
      archive: { policyRef: repo.policyRef, objectRoot: "memory/objects", payloadRoot: "experience/conversations" },
      purpose: {
        readPurpose: "alpha",
        derivePurpose: "alpha",
        deliveryScope: "synthetic",
        evidenceCutoff: now,
        trustedAdapters: { user_report: [HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] },
      },
      durability: durability(repo.root, repo.remote, repo.branch),
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    }),
    (error: unknown) => error instanceof CatalogError && error.category === "retention_guarantee_unavailable",
  );
  const archive = prepareHostInputArchive(host, {
    policyRef: repo.policyRef,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
    speaker: { id: "owner-ingest", role: "owner" },
  });
  const ports = {
    async persist() { throw new Error("persist must not run"); },
    async confirmPreviouslyCommitted() { throw new Error("confirm must not run"); },
  };
  const writerReader = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(
    () => persistHostInputArchive({
      reader: writerReader,
      archive,
      operationId: "op-writer-dnr",
      purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    }, ports),
    (error: unknown) => error instanceof CatalogError && error.category === "retention_guarantee_unavailable",
  );
  const after = await run("git", ["-C", repo.root, "rev-parse", "HEAD"]);
  assert.equal(after.stdout, before.stdout);
  assert.deepEqual((await readdir(repo.root, { recursive: true })).sort(), listingBefore.sort());
});

test("new ingest rejects stale expectedRevision; corrupt operation replay fails closed", async (t) => {
  const repo = await gitRepo(t);
  const ports = {
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  };
  const host = snapshot();
  const staleReader = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(
    () => ingestHostMessage({
      operationId: "op-stale-rev",
      expectedRevision: "0".repeat(40),
      snapshot: host,
      speaker: { id: "owner-ingest", role: "owner" },
      policyRef: repo.policyRef,
      purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    }, { ...ports, reader: staleReader }),
    (error: unknown) => error instanceof IngestError && error.category === "write_conflict",
  );
  await mkdir(path.join(repo.root, "operations"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(repo.root, "operations", "op-corrupt.json"), canonicalJson({
    schemaVersion: "stella.memory-operation/v1",
    id: "op-corrupt",
    kind: "ingest",
    inputDigest: bytesVersion("{}"),
  }));
  const corruptReader = await CatalogReader.load(repo.root, "catalog.json");
  await assert.rejects(
    () => ingest({
      operationId: "op-corrupt",
      expectedRevision: repo.revision,
      adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
      collectionId: host.sessionId,
      cursor: host.parentId,
      policyRef: repo.policyRef,
      items: prepareHostMessageItems(host, { id: "owner-ingest", role: "owner" }),
      purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
    }, { ...ports, reader: corruptReader }),
    (error: unknown) => error instanceof IngestError && error.category === "invalid_record",
  );
});
