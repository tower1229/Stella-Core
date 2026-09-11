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

const run = promisify(execFile);
const now = "2026-09-11T00:00:00Z";

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
