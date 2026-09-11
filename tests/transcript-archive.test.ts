import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import {
  ingestHostMessage,
  ingestTranscript,
  prepareTranscriptItems,
  type HostRetentionGuarantees,
} from "../src/canghai/ingest.js";
import {
  rebuildConversationFromArchive,
  type TranscriptMessageExport,
} from "../src/canghai/transcript-archive.js";
import type { HostInputSnapshot } from "../src/openclaw/host-input.js";
import { isRecord } from "../src/shared/type-guards.js";

const run = promisify(execFile);
const now = "2026-09-11T12:00:00Z";

const policy = {
  schemaVersion: "stella.source-policy/v1",
  id: "policy-transcript",
  ownerId: "owner-transcript",
  readPurposes: ["alpha"],
  derivePurposes: ["alpha"],
  deliveryScopes: ["synthetic"],
  retention: "retain",
  authorityEvidenceRefs: [],
};

const retainGuarantees: HostRetentionGuarantees = {
  transcript: true,
  staging: true,
  backup: true,
};

async function gitRepo(t: test.TestContext) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-transcript-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "work");
  const remote = path.join(parent, "remote.git");
  const branch = "synthetic-transcript";
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["init", "--quiet", "-b", branch, root]);
  await run("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await run("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  const policyBody = { ...policy, version: objectVersion(policy) };
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

function dialogue(): TranscriptMessageExport[] {
  return [
    {
      upstreamId: "msg-owner-1",
      parentUpstreamId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "主人原话。" }] },
      speaker: { id: "owner-transcript", role: "owner" },
    },
    {
      upstreamId: "msg-assistant-1",
      parentUpstreamId: "msg-owner-1",
      timestamp: "2026-09-11T12:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "助手推断回答。" }] },
    },
    {
      upstreamId: "msg-quote-1",
      parentUpstreamId: "msg-assistant-1",
      timestamp: "2026-09-11T12:00:02Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "引用别人：" },
          { type: "text", text: "外部作者原句。", quotation: true },
        ],
      },
      speaker: { id: "owner-transcript", role: "owner" },
    },
    {
      upstreamId: "msg-tool-1",
      parentUpstreamId: "msg-quote-1",
      timestamp: "2026-09-11T12:00:03Z",
      message: { role: "toolResult", content: [{ type: "text", text: "工具观察结果。" }] },
    },
    {
      upstreamId: "msg-edit-2",
      parentUpstreamId: "msg-owner-1",
      editedFromUpstreamId: "msg-owner-1",
      timestamp: "2026-09-11T12:00:04Z",
      message: { role: "user", content: [{ type: "text", text: "主人编辑后的原话。" }] },
      speaker: { id: "owner-transcript", role: "owner" },
    },
    {
      upstreamId: "msg-branch-side",
      parentUpstreamId: "msg-owner-1",
      timestamp: "2026-09-11T12:00:05Z",
      appendMode: "side",
      message: { role: "assistant", content: [{ type: "text", text: "侧分支助手回答。" }] },
    },
  ];
}

test("prepareTranscriptItems keeps owner/assistant/quotation/tool/edit/branch provenance", () => {
  const items = prepareTranscriptItems({
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-transcript",
    sessionKey: "agent:synthetic:transcript",
    messages: dialogue(),
  });
  assert.equal(items.length, 6);
  assert.equal(items[0]!.role, "owner");
  assert.equal(items[0]!.kind, "reported");
  assert.equal(items[1]!.role, "assistant");
  assert.notEqual(items[1]!.role, "owner");
  assert.equal(items[1]!.kind, "inference");
  assert.equal(items[2]!.kind, "quotation");
  assert.equal(items[3]!.role, "tool");
  assert.equal(items[3]!.kind, "direct_observation");
  assert.equal(items[4]!.editedFromUpstreamId, "msg-owner-1");
  assert.equal(items[5]!.parentUpstreamId, "msg-owner-1");
  assert.equal(items[5]!.envelope?.appendMode, "side");
});

test("M-01 transcript ingest archives roles without promoting assistant text to owner evidence", async (t) => {
  const repo = await gitRepo(t);
  const result = await ingestTranscript({
    operationId: "op-transcript-roles",
    expectedRevision: repo.revision,
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-transcript",
    sessionKey: "agent:synthetic:transcript",
    messages: dialogue(),
    branchPolicy: "all_retained",
    declaredBranches: [],
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });
  assert.equal(result.state, "synchronized");
  assert.equal(result.sourceRefs.length, 6);
  assert.ok(result.coverageRef);
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const coverage = await current.read(result.coverageRef!, "coverage");
  assert.ok(isRecord(coverage.scope));
  assert.equal(coverage.scope.branchPolicy, "all_retained");
  assert.equal(coverage.completeForDeclaredScope, true);
  assert.deepEqual(coverage.missingItems, []);
  const roles = [];
  for (const ref of result.evidenceRefs) {
    const evidence = await current.read(ref, "evidence");
    roles.push(evidence.role);
    if (evidence.role === "assistant" || evidence.role === "tool") {
      assert.notEqual(evidence.role, "owner");
    }
  }
  assert.ok(roles.includes("owner"));
  assert.ok(roles.includes("assistant"));
  assert.ok(roles.includes("tool"));
  const kinds = await Promise.all(result.evidenceRefs.map(async (ref) => (await current.read(ref, "evidence")).kind));
  assert.ok(kinds.includes("quotation"));
  assert.ok(kinds.includes("inference"));
  assert.ok(kinds.includes("direct_observation"));
});

test("attachment originals land in the repo copy; external URL alone is reported missing", async (t) => {
  const repo = await gitRepo(t);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const withBytes: TranscriptMessageExport[] = [
    {
      upstreamId: "msg-with-file",
      parentUpstreamId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "带附件。" }] },
      speaker: { id: "owner-transcript", role: "owner" },
      attachments: [{
        upstreamId: "att-present",
        mediaType: "image/png",
        fileName: "shot.png",
        bytes: png,
      }],
    },
  ];
  const present = await ingestTranscript({
    operationId: "op-transcript-attach-ok",
    expectedRevision: repo.revision,
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-attach",
    sessionKey: "agent:synthetic:attach",
    messages: withBytes,
    branchPolicy: "declared_subset",
    declaredBranches: ["msg-with-file"],
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const source = await current.read(present.sourceRefs[0]!, "sources");
  assert.ok(Array.isArray(source.payloads) && source.payloads.length >= 2);
  const media = source.payloads.find((payload: unknown) => isRecord(payload) && payload.mediaType === "image/png");
  assert.ok(isRecord(media));
  const loaded = await current.readPayload(present.sourceRefs[0]!, String(media.sha256));
  assert.deepEqual(Uint8Array.from(loaded.bytes), png);
  assert.doesNotMatch(String(media.path), /^https?:\/\//);

  const missingOnly: TranscriptMessageExport[] = [
    {
      upstreamId: "msg-missing-file",
      parentUpstreamId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "缺附件。" }] },
      speaker: { id: "owner-transcript", role: "owner" },
      attachments: [{
        upstreamId: "att-missing",
        mediaType: "image/png",
        fileName: "gone.png",
        externalUrl: "https://example.invalid/gone.png",
      }],
    },
  ];
  const revision = (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim();
  const missing = await ingestTranscript({
    operationId: "op-transcript-attach-missing",
    expectedRevision: revision,
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-missing",
    sessionKey: "agent:synthetic:missing",
    messages: missingOnly,
    branchPolicy: "declared_subset",
    declaredBranches: ["msg-missing-file"],
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });
  const after = await CatalogReader.load(repo.root, "catalog.json");
  const coverage = await after.read(missing.coverageRef!, "coverage");
  assert.equal(coverage.completeForDeclaredScope, false);
  assert.ok(Array.isArray(coverage.missingItems));
  assert.ok(coverage.missingItems.some((item: unknown) =>
    isRecord(item) && item.upstreamId === "att-missing" && item.reason === "attachment_missing" && item.retryable === true));
});

test("entry ingest and transcript share upstream identity; rebuild reports missing attachments", async (t) => {
  const repo = await gitRepo(t);
  const entryId = "msg-shared-entry";
  const text = "入口与 transcript 同一消息。";
  const host: HostInputSnapshot = {
    schemaVersion: "stella.host-input-snapshot/v1",
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-shared",
    sessionKey: "agent:synthetic:shared",
    entryId,
    logicalTurnId: "logical-shared",
    generation: "generation-shared",
    rawSeq: 2,
    parentId: null,
    text,
    event: {
      type: "message",
      id: entryId,
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
    },
  };
  const entry = await ingestHostMessage({
    operationId: "op-entry-shared",
    expectedRevision: repo.revision,
    snapshot: host,
    speaker: { id: "owner-transcript", role: "owner" },
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });

  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
  const revision = (await run("git", ["-C", repo.root, "rev-parse", "HEAD"])).stdout.trim();
  const transcript = await ingestTranscript({
    operationId: "op-transcript-shared",
    expectedRevision: revision,
    hostVersion: "2026.8.2",
    agentId: "synthetic",
    sessionId: "session-shared",
    sessionKey: "agent:synthetic:shared",
    messages: [
      {
        upstreamId: entryId,
        parentUpstreamId: null,
        timestamp: now,
        message: { role: "user", content: [{ type: "text", text }] },
        speaker: { id: "owner-transcript", role: "owner" },
        attachments: [
          { upstreamId: "att-ok", mediaType: "image/png", fileName: "ok.png", bytes: png },
          { upstreamId: "att-gap", mediaType: "application/pdf", fileName: "gap.pdf", externalUrl: "https://example.invalid/gap.pdf" },
        ],
      },
      {
        upstreamId: "msg-assistant-shared",
        parentUpstreamId: entryId,
        timestamp: "2026-09-11T12:00:10Z",
        message: { role: "assistant", content: [{ type: "text", text: "后续助手回答。" }] },
      },
    ],
    branchPolicy: "all_retained",
    declaredBranches: [],
    policyRef: repo.policyRef,
    purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" },
  }, {
    reader: await CatalogReader.load(repo.root, "catalog.json"),
    durability: durability(repo.root, repo.remote, repo.branch),
    retentionGuarantees: retainGuarantees,
    objectRoot: "memory/objects",
    payloadRoot: "experience/conversations",
  });

  assert.equal(
    transcript.sourceRefs.find((ref) => ref.id === entry.sourceRefs[0]!.id)?.id,
    entry.sourceRefs[0]!.id,
  );
  const current = await CatalogReader.load(repo.root, "catalog.json");
  const sourcesForEntry = current.catalog.sources.filter((entryRow) => entryRow.id === entry.sourceRefs[0]!.id);
  assert.ok(sourcesForEntry.length >= 1);
  assert.equal(sourcesForEntry.filter((row) => row.status === "current").length, 1);

  const rebuilt = await rebuildConversationFromArchive({
    reader: current,
    coverageRef: transcript.coverageRef!,
  });
  assert.equal(rebuilt.messages.length, 2);
  assert.equal(rebuilt.messages[0]!.upstreamId, entryId);
  assert.equal(rebuilt.messages[0]!.role, "owner");
  assert.equal(rebuilt.messages[1]!.role, "assistant");
  assert.equal(rebuilt.completeForDeclaredScope, false);
  assert.deepEqual(
    rebuilt.missingAttachments.map((item) => ({ upstreamId: item.upstreamId, reason: item.reason })),
    [{ upstreamId: "att-gap", reason: "attachment_missing" }],
  );
  assert.ok(rebuilt.messages[0]!.attachmentRefs.some((ref) => ref.upstreamId === "att-ok" && ref.present));
  assert.ok(rebuilt.messages[0]!.attachmentRefs.some((ref) => ref.upstreamId === "att-gap" && !ref.present));
  assert.doesNotMatch(await readFile(path.join(repo.root, "catalog.json"), "utf8"), /example\.invalid/);
});
