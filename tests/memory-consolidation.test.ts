import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { ownerDirectAuthority } from "./processing-authority-fixture.js";
import { learn, prepareCorrection } from "../src/learning/correction.js";
import { loadPersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";
import { parseMemoryConsolidation } from "../src/openclaw/memory-consolidation.js";
import { assertMemoryConsolidation, withMemoryConsolidation } from "../src/openclaw/memory-consolidation-scope.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";

const version = "core-consolidation:source-role,atomic-generation,recovery,invalidation:v1";
async function setup(t: Parameters<typeof personalMemoryFixture>[0]) {
  const f = await personalMemoryFixture(t);
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["owner-host"],
    modelRefs: ["synthetic/model"], viewProcessingModelRefs: ["synthetic/model"], operatorMemoryConsolidation: true,
    purpose: { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "synthetic/model" }, descriptors: [] };
  const grantPath = path.join(f.root, "access.json");
  await writeFile(grantPath, JSON.stringify(grant));
  let calls = 0;
  const input = { mode: "consolidation" as const, processingGrant: await loadPersonalContextAccess(f.root, "access.json"),
    operationId: "consolidate_fixture", request: "Organize these retained observations, preserving uncertainty.", ownerId: "owner",
    modelRef: "synthetic/model", recordedAt: "2026-09-07T00:00:00Z", evidenceRefs: [f.evidence], resolver: await f.resolver(),
    objectRoot: "objects", processingAuthority: ownerDirectAuthority(), assertProcessingCurrent: async () => {},
    complete: async ({ prompt, assertInputsCurrent }: { prompt: string; assertInputsCurrent?: () => Promise<void> }) => {
      calls++; await assertInputsCurrent?.();
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      const result = data.proposalHash ? { requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true }
        : { requestHash: data.requestHash, disposition: "update", rationale: "Synthetic scoped hypothesis, with unresolved question.",
          clarification: null, reviewedHandles: data.candidates.map((c: { handle: string }) => c.handle),
          replacements: [{ handle: null, group: "understandings", record: { kind: "hypothesis", status: "candidate",
            statement: "SYNTHETIC_CONSOLIDATED_CANDIDATE", scope: { workIds: ["work"], contexts: [], domains: [], global: false },
            supportRefs: data.ownerEvidence.map((e: { ref: object }) => e.ref), counterRefs: [], dependencyRefs: [] } }] };
      return { provider: "synthetic", model: "model", text: JSON.stringify(result) };
    } };
  const run = promisify(execFile), remote = await mkdtemp(path.join(os.tmpdir(), "stella-consolidation-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const git = (...args: string[]) => run("git", ["-c", "core.fsmonitor=false", "-C", f.root, ...args]);
  await git("init", "--quiet", "--initial-branch=main"); await git("config", "user.name", "Synthetic Test");
  await git("config", "user.email", "synthetic@example.invalid"); await git("add", "."); await git("commit", "--quiet", "-m", version);
  await run("git", ["init", "--bare", "--quiet", remote]); await git("remote", "add", "origin", remote); await git("push", "origin", "main");
  const durability = (onRevision?: (revision: string) => Promise<void>) => new GitCangHaiDurability({ root: f.root, remote: "origin", branch: "main",
    criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0, onRevision });
  return { f, input, calls: () => calls, grant, grantPath, durability, git };
}

test("Core consolidation publishes a candidate, preserves originals, is consumed after restart, and replays without synthesis", async t => {
  const { f, input, calls, durability, git } = await setup(t);
  const before = await preparePersonalViews({ ...input, question: input.request, requestId: "before", audience: "owner_direct", selection: "all_authorized" });
  const result = await learn({ ...input, durability: durability(), signal: new AbortController().signal });
  assert.equal(calls(), 2);
  await assert.rejects(before.assertCurrent(), /stale_generation/);
  const fresh = await preparePersonalViews({ ...input, resolver: await f.resolver(), question: input.request, requestId: "restarted",
    audience: "owner_direct", selection: "all_authorized" });
  const candidate = fresh.view.memory.find(c => c.record.statement === "SYNTHETIC_CONSOLIDATED_CANDIDATE")!;
  assert.equal(candidate.record.kind, "hypothesis"); assert.equal(candidate.record.status, "candidate");
  assert.equal(fresh.view.user.length, 0); assert.equal(candidate.originals[0]!.role, "owner");
  assert.deepEqual(await (await f.resolver()).reader.read(f.workRef, "works"), f.work);
  const replay = await learn({ ...input, resolver: await f.resolver(), durability: durability(), signal: new AbortController().signal,
    complete: async () => { throw new Error("Replay cannot synthesize"); } });
  assert.deepEqual(replay, result); assert.equal((await git("status", "--porcelain")).stdout, "");
});

for (const fault of ["modified", "deleted", "generation", "revoked", "cancelled"] as const) test(`Core consolidation rejects ${fault} during generation before publication`, async t => {
  const { f, input, grant, grantPath, durability } = await setup(t);
  const abort = new AbortController(); let changed = false;
  await assert.rejects(learn({ ...input, durability: durability(), signal: abort.signal,
    assertProcessingCurrent: async () => { abort.signal.throwIfAborted(); }, complete: async params => {
      const result = await input.complete(params);
      if (!changed) {
        changed = true;
        if (fault === "modified") await writeFile(path.join(f.root, "payload.json"), "modified synthetic source");
        if (fault === "deleted") await rm(path.join(f.root, "payload.json"));
        if (fault === "generation") { f.catalog.generationId = "two"; await f.save(); }
        if (fault === "revoked") await writeFile(grantPath, JSON.stringify({ ...grant, operatorMemoryConsolidation: false }));
        if (fault === "cancelled") abort.abort();
      }
      return result;
    } }), /stale_generation|payload|source_unavailable|personal_context_access_changed|aborted|correction_model_failed/i);
  assert.equal((await f.resolver()).reader.catalog.changes.length, 1);
  await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), /ENOENT/);
});

for (const fault of ["modified", "deleted", "generation", "revoked"] as const) test(`Core consolidation rejects ${fault} between proposal and atomic publication`, async t => {
  const { f, input, grant, grantPath, durability } = await setup(t);
  const prepared = await prepareCorrection(input);
  if (fault === "modified") await writeFile(path.join(f.root, "payload.json"), "modified synthetic source");
  if (fault === "deleted") await rm(path.join(f.root, "payload.json"));
  if (fault === "generation") { f.catalog.generationId = "two"; await f.save(); }
  if (fault === "revoked") await writeFile(grantPath, JSON.stringify({ ...grant, requesterIds: [] }));
  await assert.rejects(prepared.persist(durability(), new AbortController().signal), /transaction_version_conflict|payload|source_unavailable|personal_context_access_changed/i);
  assert.equal((await f.resolver()).reader.catalog.changes.length, 1);
});

test("Core consolidation crash recovery reuses only the recorded plan and concurrent plans cannot both publish", async t => {
  const { f, input, durability } = await setup(t);
  const a = await prepareCorrection(input), b = await prepareCorrection({ ...input, operationId: "concurrent" });
  await assert.rejects(a.persist(durability(async () => { throw new Error("synthetic pointer crash"); }), new AbortController().signal), /synthetic pointer crash/);
  await assert.rejects((await f.resolver()).reader.assertCurrent(), /memory_transaction_pending/);
  await learn({ ...input, resolver: await f.resolver(), durability: durability(), signal: new AbortController().signal,
    complete: async () => { throw new Error("Recovery cannot synthesize"); } });
  await assert.rejects(b.persist(durability(), new AbortController().signal), /transaction_version_conflict/);
  assert.equal((await f.resolver()).reader.catalog.understandings.length, 2);
});

test("Core consolidation candidates fail current consumption after source deletion", async t => {
  const { f, input, durability } = await setup(t);
  await learn({ ...input, durability: durability(), signal: new AbortController().signal });
  await rm(path.join(f.root, "payload.json"));
  await assert.rejects(preparePersonalViews({ ...input, resolver: await f.resolver(), requestId: "after-deletion", question: input.request,
    audience: "owner_direct", selection: "all_authorized" }), /source_unavailable/);
});

for (const role of ["assistant", "other"] as const) test(`Core consolidation preserves ${role} original identity as candidate support`, async t => {
  const { f, input, durability, git } = await setup(t);
  const stored = await input.resolver.reader.read(f.evidence, "evidence");
  const evidence = await f.put("evidence", { ...stored, id: `evidence_${role}`, role, speakerId: role,
    kind: role === "assistant" ? "inference" : "reported" }, input.resolver.reader.entry(f.evidence).dependencies);
  await f.save(); await git("add", "."); await git("commit", "--quiet", "-m", `Synthetic ${role} original`); await git("push", "origin", "main");
  const result = await learn({ ...input, evidenceRefs: [evidence], resolver: await f.resolver(), durability: durability(), signal: new AbortController().signal });
  const reader = (await f.resolver()).reader;
  const change = await reader.read(result.changeRef, "changes");
  assert.deepEqual(change.inputRefs, [evidence]);
  const fresh = await preparePersonalViews({ ...input, resolver: await f.resolver(), requestId: "role-consumer", question: input.request,
    audience: "owner_direct", selection: "all_authorized" });
  const candidate = fresh.view.memory.find(c => c.record.statement === "SYNTHETIC_CONSOLIDATED_CANDIDATE")!;
  assert.equal(candidate.record.kind, "hypothesis"); assert.equal(candidate.record.status, "candidate");
  assert.ok(candidate.originals.some(original => original.ref.id === evidence.id && original.role === role));
  assert.equal(fresh.view.user.length, 0);
});

for (const fault of ["source", "grant"] as const) test(`Core consolidation rechecks ${fault} after critical synchronization and keeps the fence`, async t => {
  const { f, input, grant, grantPath, durability } = await setup(t);
  await assert.rejects(learn({ ...input, durability: durability(async () => {
    if (fault === "source") await rm(path.join(f.root, "payload.json"));
    else await writeFile(grantPath, JSON.stringify({ ...grant, requesterIds: [] }));
  }), signal: new AbortController().signal }), fault === "source" ? /source_unavailable/ : /personal_context_access_changed/);
  await assert.rejects((await f.resolver()).reader.assertCurrent(), /memory_transaction_pending/);
});

test("Core consolidation requires the actual persistent grant and cannot elevate an interpretation to an owner fact", async t => {
  const { input, calls } = await setup(t);
  await assert.rejects(prepareCorrection({ ...input, processingGrant: {} }), /personal_context_binding_unbound/);
  assert.equal(calls(), 0);
  await assert.rejects(prepareCorrection({ ...input, complete: async params => {
    const output = await input.complete(params), data = JSON.parse(output.text);
    if (data.replacements) data.replacements[0].record.kind = "owner_statement";
    return { ...output, text: JSON.stringify(data) };
  } }), /consolidation_candidate_required/);
  for (const audience of ["group", "channel", "cron", "subagent", "unknown"] as const)
    await assert.rejects(prepareCorrection({ ...input, processingAuthority: { ...input.processingAuthority, audience, privateContextAllowed: false } }), /private_context_audience_forbidden/);
});

for (const changedPolicy of ["source", "evidence"] as const) test(`Core consolidation rejects a foreign ${changedPolicy} policy before any original read or model call`, async t => {
  const { f, input, calls } = await setup(t);
  const reader = input.resolver.reader;
  const stored = await reader.read(f.evidence, "evidence");
  const source = await reader.read(f.source, "sources");
  const policy = await reader.read(stored.policyRef as typeof f.evidence, "policies");
  const foreign = await f.put("policies", { ...policy, id: "foreign-policy", ownerId: "another-owner" });
  const sourceRef = changedPolicy === "source" ? await f.put("sources", { ...source, id: "foreign-source", policyRef: foreign },
    [foreign, source.coverageRef as typeof f.evidence]) : f.source;
  const evidenceRef = await f.put("evidence", { ...stored, id: "foreign-evidence", source: sourceRef,
    policyRef: changedPolicy === "evidence" ? foreign : stored.policyRef }, [sourceRef, changedPolicy === "evidence" ? foreign : stored.policyRef as typeof f.evidence]);
  await f.save();
  const resolver = await f.resolver(); let originalReads = 0;
  const read = resolver.readEvidence.bind(resolver);
  resolver.readEvidence = async ref => { originalReads++; return read(ref); };
  await assert.rejects(prepareCorrection({ ...input, resolver, evidenceRefs: [evidenceRef] }), /personal_context_owner_mismatch/);
  assert.equal(originalReads, 0); assert.equal(calls(), 0);
});

test("Core consolidation rejects unknown RPC fields and expired/cancelled maintenance lifetimes", async () => {
  const valid = { operationId: "public_fixture", request: "Organize", evidenceRefs: [{ id: "e", version: bytesVersion("e") }] };
  assert.deepEqual(parseMemoryConsolidation(valid), valid);
  assert.throws(() => parseMemoryConsolidation({ ...valid, allowNativeDreaming: true }), /invalid_memory_consolidation_request/);
  const request = snapshotTurnRequest({ agentId: "stella", sessionId: "maintenance", sessionKey: "agent:stella:consolidation",
    prompt: "Synthetic maintenance", senderIsOwner: true, senderId: "owner-host", chatType: "direct" }, "fixture");
  const abort = new AbortController(); let late!: () => void;
  await withMemoryConsolidation({ request, signal: abort.signal }, async () => { late = () => assertMemoryConsolidation(request); });
  assert.throws(late, /not_admitted/);
  abort.abort();
  await assert.rejects(withMemoryConsolidation({ request, signal: abort.signal }, async () => {}), /aborted/i);
  assert.equal(canonicalJson(valid).includes("private"), false);
});
