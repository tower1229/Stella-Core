import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { ownerDirectAuthority } from "./processing-authority-fixture.js";
import { learn, prepareCorrection, recoverCorrection } from "../src/learning/correction.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { viewRecipePath } from "../src/canghai/view-recipe.js";

const request = "我希望这篇文章保留疑问，不要替我加上励志结尾。";
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];
async function setup(t: Parameters<typeof personalMemoryFixture>[0], interpretationRules = false) {
  const f = await personalMemoryFixture(t, interpretationRules);
  let calls = 0;
  const input = { operationId: "correction_test", request, revision: "a".repeat(40), ownerId: "owner", modelRef: "synthetic/model",
    recordedAt: "2026-09-03T00:00:00Z", evidenceRefs: [f.evidence], resolver: await f.resolver(), objectRoot: "objects",
    processingAuthority: ownerDirectAuthority({ purpose: { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "synthetic/model" } }),
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

async function learningDurability(t: Parameters<typeof personalMemoryFixture>[0], root: string) {
  const run = promisify(execFile), remote = await mkdtemp(path.join(os.tmpdir(), "stella-learning-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run("git", ["init", "--quiet", "--initial-branch=main", root]);
  const git = (...args: string[]) => run("git", ["-c", "core.fsmonitor=false", "-C", root, ...args]);
  await git("config", "user.name", "Synthetic Test"); await git("config", "user.email", "synthetic@example.invalid");
  await git("add", "."); await git("commit", "--quiet", "-m", "Synthetic writing baseline");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await git("remote", "add", "origin", remote); await git("push", "origin", "main");
  const restart = () => new GitCangHaiDurability({ root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0 });
  return { restart, git };
}

test("writing correction updates work and scoped understanding atomically and preserves their historical judgments", async t => {
  const { f, input } = await setup(t);
  const { restart, git } = await learningDurability(t, f.root);
  const old = await preparePersonalViews({ ...input, requestId: "before", question: request,
    audience: "owner_direct", selection: "all_authorized" });
  const complete: typeof input.complete = async args => {
    const result = await input.complete(args), proposal = JSON.parse(result.text);
    if (proposal.replacements) {
      const data = JSON.parse(args.prompt.split("\n").at(-1)!);
      const previous = data.candidates.find((item: { group: string }) => item.group === "understandings");
      proposal.replacements.push({ handle: previous.handle, group: "understandings", record: {
        kind: "owner_statement", status: "active", statement: "这篇文章先检查论证，仍保留疑问。",
        scope: { workIds: ["work"], contexts: [], domains: ["writing"], global: false },
        supportRefs: [f.evidence], counterRefs: [], dependencyRefs: [],
      } });
    }
    return { ...result, text: JSON.stringify(proposal) };
  };
  const result = await learn({ ...input, complete, durability: restart(), signal: new AbortController().signal });
  await assert.rejects(old.assertCurrent(), /stale_generation/);
  for (const requestId of ["current-turn", "next-turn", "new-session", "restarted"]) {
    const fresh = await preparePersonalViews({ ...input, resolver: await f.resolver(), requestId, question: request,
      audience: "owner_direct", selection: "all_authorized" });
    assert.equal(fresh.view.memory.find(item => item.group === "works")!.record.goal, "保留疑问，先检查论证");
    const understanding = fresh.view.memory.find(item => item.group === "understandings")!.record;
    assert.equal(understanding.statement, "这篇文章先检查论证，仍保留疑问。");
    assert.deepEqual(understanding.scope, { workIds: ["work"], contexts: [], domains: ["writing"], global: false });
    assert.equal(fresh.view.user.length, 0);
  }
  const reader = (await f.resolver()).reader;
  const change = await reader.read(result.changeRef, "changes");
  assert.equal((change.changes as unknown[]).length, 2);
  assert.deepEqual(change.inputRefs, [f.evidence]);
  assert.deepEqual(await reader.read(f.workRef, "works", "historical"), f.work);
  assert.equal((await reader.read(f.understanding, "understandings", "historical")).statement, "本篇文章保留未决问题。");
  const revision = (await git("rev-parse", "HEAD")).stdout;
  await assert.rejects(learn({ ...input, request: "another request", resolver: await f.resolver(),
    durability: restart(), signal: new AbortController().signal }), /correction_operation_conflict/);
  const replay = await learn({ ...input, resolver: await f.resolver(), durability: restart(), signal: new AbortController().signal,
    complete: async () => { throw new Error("Replay must not call the model"); } });
  assert.deepEqual(replay, result);
  assert.equal((await git("rev-parse", "HEAD")).stdout, revision);
  assert.equal((await git("status", "--porcelain")).stdout, "");
});

test("clarification survives learning restart and replay still enforces processing permission", async t => {
  const { f, input } = await setup(t);
  const { restart } = await learningDurability(t, f.root);
  const complete: typeof input.complete = async args => {
    const result = await input.complete(args), proposal = JSON.parse(result.text);
    if (proposal.replacements) Object.assign(proposal, { disposition: "needs_clarification", replacements: [], clarification: "你希望保留哪一个未决问题？" });
    return { ...result, text: JSON.stringify(proposal) };
  };
  const first = await learn({ ...input, complete, durability: restart(), signal: new AbortController().signal });
  const replay = await learn({ ...input, resolver: await f.resolver(), durability: restart(), signal: new AbortController().signal,
    complete: async () => { throw new Error("Replay must preserve the recorded question"); } });
  assert.deepEqual(replay, first);
  assert.equal(replay.clarification, "你希望保留哪一个未决问题？");
  assert.equal(replay.disposition, "needs_clarification");
  assert.deepEqual(await (await f.resolver()).reader.read(f.workRef, "works"), f.work);
  await assert.rejects(learn({ ...input, resolver: await f.resolver(), durability: restart(), signal: new AbortController().signal,
    processingAuthority: ownerDirectAuthority({ purpose: { readPurpose: "retrieve", derivePurpose: "forbidden", deliveryScope: "synthetic/model" } }) }),
  /permission_denied/);
});

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
    signal: new AbortController().signal, assertProcessingCurrent: async () => {}, processingAuthority: input.processingAuthority });
  await result.persist(durability, new AbortController().signal);
  assert.equal(calls(), 2, "persistence retries must not regenerate semantic changes");
  assert.equal(receipt.revision, (await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim());
  const fresh = await preparePersonalViews({ requestId: "new-session", question: request, ownerId: "owner", modelRef: "synthetic/model",
    audience: "owner_direct", processingAuthority: input.processingAuthority, resolver: await f.resolver(), selection: "all_authorized", assertProcessingCurrent: async () => {}, complete: input.complete });
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

async function seedHostHistoryView(f: Awaited<ReturnType<typeof personalMemoryFixture>>, sourceRefs: Array<{ id: string; version: string }>,
  viewId = "session-history") {
  const artifactBody = { schemaVersion: "stella.host-history-view/v1", viewId, text: "baseline" };
  const artifactBytes = canonicalJson(artifactBody);
  const digest = bytesVersion(artifactBytes);
  const recipeBody = { schemaVersion: "stella.view-recipe/v1", id: `history-view:${viewId}`, adapterId: "stella.host-history",
    adapterVersion: "1", hostTarget: "stella", inputRefs: sourceRefs, parameters: { archiveRoot: "retained-context", digest },
    modelRef: "synthetic/model", promptVersion: "stella.host-history-rebuild/v1" };
  const recipe = { ...recipeBody, version: objectVersion(recipeBody) };
  const view = { id: viewId, generationId: f.catalog.generationId, required: true,
    recipeRef: { id: recipe.id, version: recipe.version }, sourceRefs };
  const recipePath = viewRecipePath("catalog.json", view.recipeRef);
  const artifactPath = `retained-context/history-views/${digest.slice(7)}.json`;
  await mkdir(path.dirname(path.join(f.root, recipePath)), { recursive: true });
  await mkdir(path.dirname(path.join(f.root, artifactPath)), { recursive: true });
  await writeFile(path.join(f.root, recipePath), canonicalJson(recipe));
  await writeFile(path.join(f.root, artifactPath), artifactBytes);
  await writeFile(path.join(f.root, `${artifactPath}.sig`), "c2ln");
  f.catalog.views.push(view);
  await f.save();
  return { view, recipe, recipePath, artifactPath, artifactBytes, digest };
}

function hostHistoryAdmission(input: {
  viewId: string; generationId: string; sourceRefs: Array<{ id: string; version: string }>; text: string;
}) {
  const artifactBody = { schemaVersion: "stella.host-history-view/v1", viewId: input.viewId, text: input.text };
  const artifactBytes = canonicalJson(artifactBody);
  const digest = bytesVersion(artifactBytes);
  const recipeBody = { schemaVersion: "stella.view-recipe/v1", id: `history-view:${input.viewId}`, adapterId: "stella.host-history",
    adapterVersion: "1", hostTarget: "stella", inputRefs: input.sourceRefs, parameters: { archiveRoot: "retained-context", digest },
    modelRef: "synthetic/model", promptVersion: "stella.host-history-rebuild/v1" };
  const recipe = { ...recipeBody, version: objectVersion(recipeBody) };
  const view = { id: input.viewId, generationId: input.generationId, required: true,
    recipeRef: { id: recipe.id, version: recipe.version }, sourceRefs: input.sourceRefs };
  return {
    viewId: input.viewId, view,
    artifactPath: `retained-context/history-views/${digest.slice(7)}.json`, artifactBytes,
    signaturePath: `retained-context/history-views/${digest.slice(7)}.json.sig`, signatureBytes: "c2ln",
    recipePath: viewRecipePath("catalog.json", view.recipeRef), recipeBytes: canonicalJson(recipe),
  };
}

test("correction reauthenticates an evidence-bound required view when only derived cognition changes", async t => {
  const { f, input } = await setup(t);
  await seedHostHistoryView(f, [f.evidence]);
  const { restart } = await learningDurability(t, f.root);
  const resolver = await f.resolver();
  const result = await learn({ ...input, resolver, durability: restart(), signal: new AbortController().signal });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.equal(reader.catalog.generationId, result.generationId);
  assert.equal(reader.catalog.views.length, 1);
  assert.equal(reader.catalog.views[0]?.generationId, result.generationId);
  assert.deepEqual(reader.catalog.views[0]?.sourceRefs, [f.evidence]);
  const replay = await learn({ ...input, resolver: await f.resolver(), durability: restart(), signal: new AbortController().signal,
    complete: async () => { throw new Error("Replay must not call the model"); } });
  assert.deepEqual(replay, result);
});

test("correction rebuilds a work-bound required view from recorded admissions without rerunning a model", async t => {
  const { f, input } = await setup(t);
  await seedHostHistoryView(f, [f.workRef]);
  const { restart } = await learningDurability(t, f.root);
  const resolver = await f.resolver();
  await assert.rejects(prepareCorrection({ ...input, resolver }), /required_view_rebuild_required/);
  const result = await learn({
    ...input, resolver, durability: restart(), signal: new AbortController().signal,
    viewRebuilds: (generationId) => [hostHistoryAdmission({
      viewId: "session-history", generationId, sourceRefs: [f.evidence], text: "rebuilt-after-correction",
    })],
  });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.equal(reader.catalog.views[0]?.generationId, result.generationId);
  assert.deepEqual(reader.catalog.views[0]?.sourceRefs, [f.evidence]);
  const recipe = await reader.readViewRecipe("session-history");
  assert.equal(recipe.adapterId, "stella.host-history");
  assert.equal(recipe.parameters.digest, bytesVersion(hostHistoryAdmission({
    viewId: "session-history", generationId: result.generationId, sourceRefs: [f.evidence], text: "rebuilt-after-correction",
  }).artifactBytes));
  const replay = await learn({
    ...input, resolver: await f.resolver(), durability: restart(), signal: new AbortController().signal,
    complete: async () => { throw new Error("Replay must not regenerate history views"); },
    viewRebuilds: () => { throw new Error("Replay must read rebuild bytes from the recorded plan"); },
  });
  assert.deepEqual(replay, result);
});
