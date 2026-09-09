import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { prepareCorrection, recoverCorrection } from "../src/learning/correction.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";

const request = "我希望这篇文章保留疑问，不要替我加上励志结尾。";
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];
async function setup(t: Parameters<typeof personalMemoryFixture>[0], interpretationRules = false) {
  const f = await personalMemoryFixture(t, interpretationRules);
  let calls = 0;
  const input = { operationId: "correction_test", request, revision: "a".repeat(40), ownerId: "owner", modelRef: "synthetic/model",
    recordedAt: "2026-09-03T00:00:00Z", evidenceRefs: [f.evidence], resolver: await f.resolver(), objectRoot: "objects",
    assertProcessingCurrent: async () => {}, complete: async ({ prompt }: { prompt: string }) => {
      calls++;
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      if (data.proposalHash) return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true }) };
      const work = data.candidates.find((item: { group: string }) => item.group === "works");
      return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: data.requestHash, disposition: "update",
        rationale: "保留作者提出的疑问和拒绝的结尾。", clarification: null,
        reviewedHandles: data.candidates.map((item: { handle: string }) => item.handle),
        replacements: [{ handle: work.handle, group: "works", record: { ...Object.fromEntries(editable.map(field => [field, work.record[field]])), goal: "保留疑问，先检查论证" } }] }) };
    } };
  return { f, input, calls: () => calls };
}

test("v3 source constraints reach correction verification and rejected learning never becomes a transaction", async t => {
  const { f, input } = await setup(t, true);
  const original = await input.resolver.readEvidence(f.evidence);
  assert.equal(original.usageConstraints?.[0]?.rules[0]?.id, "preserve_author_intent");
  const complete = input.complete;
  let ruleCalls = 0;
  await assert.rejects(prepareCorrection({ ...input, complete: async ({ prompt }) => {
    const data = JSON.parse(prompt.split("\n").at(-1)!);
    if (!data.bindingHash) return complete({ prompt });
    ruleCalls++;
    assert.match(prompt, /Preserve the owner's unresolved question/);
    return { provider: "synthetic", model: "model", text: JSON.stringify({ bindingHash: data.bindingHash,
      checks: data.data.requirements.map((rule: { handle: string }) => ({ handle: rule.handle, satisfied: false })) }) };
  } }), /source_interpretation_rejected/);
  assert.equal(ruleCalls, 1);
  const reader = (await f.resolver()).reader;
  assert.equal(reader.catalog.generationId, "one");
  assert.equal(reader.catalog.changes.length, 1);
  await reader.assertCurrent();
});

test("owner correction synchronizes immutable work and change, then fresh readers preserve author intent", async t => {
  const { f, input, calls } = await setup(t);
  const run = promisify(execFile);
  const remote = await mkdtemp(path.join(os.tmpdir(), "stella-correction-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const git = (...args: string[]) => run("git", ["-c", "core.fsmonitor=false", "-C", f.root, ...args]);
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Test"); await git("config", "user.email", "synthetic@example.invalid");
  await git("add", "."); await git("commit", "--quiet", "-m", "Synthetic baseline");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await git("remote", "add", "origin", remote); await git("push", "origin", "main");
  input.revision = (await git("rev-parse", "HEAD")).stdout.trim();
  const result = await prepareCorrection(input);
  assert.equal(calls(), 2);
  assert.equal((await f.resolver()).reader.catalog.generationId, "one");
  let failPointer = true;
  const durability = new GitCangHaiDurability({ root: f.root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
    onRevision: async () => { if (failPointer) throw new Error("Synthetic pointer failure"); } });
  await assert.rejects(result.persist(durability, new AbortController().signal), /Synthetic pointer failure/);
  await assert.rejects((await CatalogReader.load(f.root, "catalog.json")).assertCurrent(), /memory_transaction_pending/);
  failPointer = false;
  // Reconstruct from the durable journal and a new durability instance, as after restart.
  const restartedDurability = new GitCangHaiDurability({ root: f.root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0, onRevision: async () => {} });
  const receipt = await recoverCorrection({ root: f.root, operationId: result.plan.operationId, catalogPath: "catalog.json", objectRoot: "objects",
    ownerId: "owner", modelRef: "synthetic/model", purpose: input.resolver.purpose, durability: restartedDurability,
    signal: new AbortController().signal, assertProcessingCurrent: async () => {} });
  await result.persist(durability, new AbortController().signal);
  assert.equal(calls(), 2, "persistence retries must not regenerate semantic changes");
  assert.equal(receipt.revision, (await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim());
  const fresh = await preparePersonalViews({ requestId: "new-session", question: request, ownerId: "owner", modelRef: "synthetic/model",
    resolver: await f.resolver(), selection: "all_authorized", assertProcessingCurrent: async () => {}, complete: input.complete });
  const work = fresh.view.memory.find(item => item.group === "works")!.record;
  assert.equal(work.goal, "保留疑问，先检查论证");
  assert.equal(work.status, "active");
  assert.deepEqual(work.rejectedInterpretations, f.work.rejectedInterpretations);
  assert.deepEqual(work.openQuestions, f.work.openQuestions);
  assert.equal((await f.resolver()).reader.eligible(f.workRef), false);
  assert.equal((await git("status", "--porcelain")).stdout.trim(), "");
});

test("correction rejects non-owner evidence and semantic verification failures before mutation", async t => {
  const { f, input } = await setup(t);
  await assert.rejects(prepareCorrection({ ...input, ownerId: "other" }), /correction_owner_evidence_required/);
  await assert.rejects(prepareCorrection({ ...input, request: "different" }), /correction_request_evidence_mismatch/);
  await assert.rejects(prepareCorrection({ ...input, complete: async args => {
    const result = await input.complete(args), data = JSON.parse(result.text);
    return { ...result, text: JSON.stringify({ ...data, ...(Object.hasOwn(data, "valid") ? { valid: false } : {}) }) };
  } }), /correction_semantic_verification_failed/);
  assert.equal((await f.resolver()).reader.catalog.generationId, "one");
});

test("changed dependencies outside the authorized correction batch cannot stay usable", async t => {
  const { f, input } = await setup(t);
  f.catalog.understandings[0]!.dependencies.push(f.workRef);
  await f.save();
  await assert.rejects(prepareCorrection({ ...input, resolver: await f.resolver() }), /correction_dependency_scope_incomplete/);
  assert.equal((await f.resolver()).reader.catalog.generationId, "one");
});

test("unread references and changes to originals during correction inference are rejected", async t => {
  const { f, input } = await setup(t);
  await assert.rejects(prepareCorrection({ ...input, complete: async args => {
    const result = await input.complete(args), data = JSON.parse(result.text);
    if (data.replacements) data.replacements[0].record.sourceRefs.push({ id: "unread-source", version: `sha256:${"0".repeat(64)}` });
    return { ...result, text: JSON.stringify(data) };
  } }), /correction_reference_not_read/);
  const { writeFile } = await import("node:fs/promises");
  await assert.rejects(prepareCorrection({ ...input, complete: async args => {
    const result = await input.complete(args);
    await writeFile(path.join(f.root, "payload.json"), "changed original");
    return result;
  } }), /payload_digest_mismatch/);
});

test("clarification records no invented replacement or completed work", async t => {
  const { input } = await setup(t);
  const result = await prepareCorrection({ ...input, complete: async args => {
    const result = await input.complete(args), data = JSON.parse(result.text);
    if (data.replacements) {
      data.disposition = "needs_clarification"; data.replacements = []; data.clarification = "你希望保留哪一个未决问题？";
    }
    return { ...result, text: JSON.stringify(data) };
  } });
  assert.equal(result.disposition, "needs_clarification");
  assert.equal(result.targets.length, 0);
  assert.equal(result.plan.files.length, 3);
});

test("Host correction archives exact owner input before inference and restores a failed custody transaction", async t => {
  const { f, input, calls } = await setup(t);
  const { archiveCorrectionInput, applyHostCorrection } = await import("../src/learning/host-correction.js");
  const { HOST_INPUT_ARCHIVE_ADAPTER } = await import("../src/canghai/host-input-archive.js");
  const { snapshotTurnRequest } = await import("../src/openclaw/turn-request.js");
  const { readFile } = await import("node:fs/promises");
  const run = promisify(execFile), remote = await mkdtemp(path.join(os.tmpdir(), "stella-host-correction-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const git = (...args: string[]) => run("git", ["-c", "core.fsmonitor=false", "-C", f.root, ...args]);
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Test"); await git("config", "user.email", "synthetic@example.invalid");
  await git("add", "."); await git("commit", "--quiet", "-m", "Synthetic baseline");
  await run("git", ["init", "--bare", "--quiet", remote]); await git("remote", "add", "origin", remote); await git("push", "origin", "main");
  let fail = true;
  const durability = new GitCangHaiDurability({ root: f.root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0, onRevision: async () => { if (fail) throw new Error("Synthetic custody pointer failure"); } });
  const bound = snapshotTurnRequest({ agentId: "main", sessionId: "session", sessionKey: "agent:main:correction", prompt: request,
    senderId: "trusted-sender", senderIsOwner: true, chatType: "direct" }, "host_correction_test");
  const original = { schemaVersion: "stella.host-input-snapshot/v1" as const, hostVersion: "2026.8.2", agentId: "main", sessionId: "session",
    sessionKey: bound.sessionKey, entryId: "original-message", logicalTurnId: "logical-turn", generation: "host-generation", rawSeq: 1,
    parentId: null, text: request, event: { type: "message", id: "original-message", parentId: null, timestamp: input.recordedAt,
      message: { role: "user", content: request } } };
  const purpose = { ...input.resolver.purpose, trustedAdapters: { ...input.resolver.purpose.trustedAdapters, user_report: ["synthetic", HOST_INPUT_ARCHIVE_ADAPTER] } };
  const params = { request: bound, original, ownerId: "owner", reader: input.resolver.reader,
    archive: { policyRef: { id: f.catalog.policies[0]!.id, version: f.catalog.policies[0]!.version }, objectRoot: "objects", payloadRoot: "originals" },
    purpose, durability, signal: new AbortController().signal, assertCurrent: async () => {}, modelRef: input.modelRef, complete: input.complete };
  await assert.rejects(applyHostCorrection({ ...params, request: { ...bound, senderIsOwner: false } }), /correction_host_request_mismatch/);
  await assert.rejects(applyHostCorrection(params), /Synthetic custody pointer failure/);
  assert.equal(calls(), 0, "No inference before critical input custody");
  await assert.rejects((await CatalogReader.load(f.root, "catalog.json")).assertCurrent(), /memory_transaction_pending/);
  fail = false;
  const restored = await archiveCorrectionInput(params);
  assert.equal((await restored.resolver.readEvidence(restored.evidenceRefs[0]!)).text, request);
  const result = await applyHostCorrection(params);
  assert.equal(result.disposition, "update"); assert.equal(calls(), 2);
  assert.equal(result.writeOperationIds.length, 2);
  const fresh = new (await import("../src/praxis/episode-evidence.js")).EpisodeEvidenceResolver(await CatalogReader.load(f.root, "catalog.json"), purpose, input.complete);
  const views = await preparePersonalViews({ resolver: fresh, requestId: "next-session", question: request, ownerId: "owner", modelRef: input.modelRef,
    selection: "all_authorized", assertProcessingCurrent: async () => {}, complete: input.complete });
  assert.equal(views.view.memory.find(item => item.group === "works")!.record.goal, "保留疑问，先检查论证");
  await views.assertCurrentForGeneration(result.generationId);
  const archivedSource = await fresh.reader.read((await fresh.reader.read(restored.evidenceRefs[0]!, "evidence")).source as { id: string; version: string }, "sources");
  const payload = archivedSource.payloads as Array<{ path: string }>;
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, payload[0]!.path), "utf8")).event, original.event);
  assert.equal((await git("status", "--porcelain")).stdout.trim(), "");
});


test("authenticated ingress archive keeps original custody without inventing a transcript event", async () => {
  const { prepareHostRequestArchive } = await import("../src/canghai/host-request-archive.js");
  const { snapshotTurnRequest } = await import("../src/openclaw/turn-request.js");
  const bound = snapshotTurnRequest({ agentId: "main", sessionId: "session", sessionKey: "agent:main:test",
    senderId: "owner", senderIsOwner: true, chatType: "direct", prompt: request }, "run-ingress");
  const snapshot = { schemaVersion: "stella.host-request-snapshot/v1" as const, request: bound, capturedAt: "2026-09-08T00:00:00Z" };
  const config = { policyRef: { id: "policy-owner", version: `sha256:${"a".repeat(64)}` }, objectRoot: "objects", payloadRoot: "raw", ownerId: "owner" };
  const archive = prepareHostRequestArchive(snapshot, config);
  assert.deepEqual(JSON.parse(archive.payload.bytes), snapshot);
  const evidence = archive.objects.find(item => item.group === "evidence")!.object;
  assert.equal(evidence.authoredAt, null);
  assert.equal(evidence.occurredAt, null);
  assert.deepEqual(evidence.selector, { kind: "json_pointer", value: "/request/prompt" });
  assert.throws(() => prepareHostRequestArchive({ ...snapshot, request: { ...bound, senderIsOwner: false } }, config), /invalid_host_request_snapshot/);
  assert.throws(() => prepareHostRequestArchive({ ...snapshot, request: { ...bound, requestHash: "wrong" } }, config), /invalid_host_request_snapshot/);
});
