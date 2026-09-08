import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogReader, CatalogError, type CatalogGroup, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { objectVersion, canonicalJson, bytesVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-personal-views-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  const put = async (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[] = []) => {
    const ref = { id: String(object.id), version: objectVersion(object) }, file = `${ref.id}-${ref.version.slice(7)}.json`;
    const body = canonicalJson(object);
    await writeFile(path.join(root, file), body);
    catalog[group].push({ ...ref, status: "current", dependencies, locator: { path: file, sha256: bytesVersion(body) } });
    return ref;
  };
  const now = "2026-09-01T00:00:00Z";
  const policy = await put("policies", { schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner",
    readPurposes: ["retrieve"], derivePurposes: ["answer"], deliveryScopes: ["synthetic/model"], retention: "retain", authorityEvidenceRefs: [] });
  const coverage = await put("coverage", { schemaVersion: "stella.archive-coverage/v1", id: "coverage",
    adapterId: "synthetic", collectionId: "one", upstreamSnapshot: "one",
    scope: { agentIds: ["main"], roots: [], branchPolicy: "declared_subset", declaredBranches: ["one"] },
    fromCursor: null, toCursor: "one", expectedCount: 1, retainedCount: 1, excludedByPolicyCount: 0,
    missingItems: [], checkedAt: now, completeForDeclaredScope: true });
  const payload = JSON.stringify({ report: "我希望这篇文章保留疑问，不要替我加上励志结尾。" });
  await writeFile(path.join(root, "payload.json"), payload);
  const source = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "source",
    origin: { adapterId: "synthetic", collectionId: "one", upstreamId: "one" },
    payloads: [{ path: "payload.json", mediaType: "application/json", bytes: Buffer.byteLength(payload), sha256: bytesVersion(payload) }],
    capturedAt: now, policyRef: policy, coverageRef: coverage }, [policy, coverage]);
  const evidence = await put("evidence", { schemaVersion: "stella.memory-evidence/v1", id: "evidence", source,
    payloadSha256: bytesVersion(payload), selector: { kind: "json_pointer", value: "/report" },
    role: "owner", speakerId: "owner", kind: "reported", independentOriginId: "one", derivedFrom: [],
    occurredAt: null, authoredAt: now, capturedAt: now, policyRef: policy }, [source, policy]);
  const understanding = await put("understandings", { schemaVersion: "stella.understanding/v1", id: "understanding",
    kind: "owner_statement", status: "active", statement: "本篇文章保留未决问题。",
    scope: { workIds: ["work"], contexts: [], domains: ["writing"], global: false },
    supportRefs: [evidence], counterRefs: [], dependencyRefs: [], originChangeId: "change", createdAt: now, updatedAt: now }, [evidence]);
  await put("changes", { schemaVersion: "stella.learning-change/v1", id: "change", operationId: "change",
    algorithmVersion: "synthetic", modelRef: "synthetic/model", promptVersion: "one", inputRefs: [evidence], targetRefs: [understanding],
    changes: [{ kind: "create", before: null, after: understanding, supportRefs: [evidence], counterRefs: [] }],
    rationale: "Synthetic authored premise", disposition: "update" }, [evidence, understanding]);
  const work = { schemaVersion: "stella.ongoing-work/v1", id: "work", kind: "writing", status: "active", goal: "继续共同梳理文章",
    sourceRefs: [source], confirmedPremises: [{ id: "p", text: "保留疑问", evidenceRefs: [evidence], acceptance: "confirmed" }],
    candidateIdeas: [{ id: "c", text: "尝试开放式收束", evidenceRefs: [evidence], acceptance: "proposed" }],
    rejectedInterpretations: [{ id: "r", text: "升华为励志结尾", evidenceRefs: [evidence], acceptance: "rejected" }],
    openQuestions: [{ id: "q", question: "最后一个论证是否成立？", evidenceRefs: [evidence], material: true }],
    nextStep: null, lastAppliedChangeId: null, createdAt: now, updatedAt: now };
  const workRef = await put("works", work, [source, evidence]);
  const save = () => writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  await save();
  const resolver = () => CatalogReader.load(root, "catalog.json").then(reader => new EpisodeEvidenceResolver(reader, {
    readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "synthetic/model", evidenceCutoff: "2026-09-08T00:00:00Z",
    trustedAdapters: { user_report: ["synthetic"], tool_observation: [], system_event: [] },
  }, async () => { throw new Error("No semantic action inference"); }));
  return { root, catalog, put, save, resolver, source, evidence, understanding, work, workRef };
}

function selector(view: "user" | "memory" | "omit" = "memory") {
  return async ({ prompt }: { prompt: string }) => {
    const value = JSON.parse(prompt.split("\n").at(-1)!) as { requestHash: string; candidates: Array<{ handle: string; group: string }> };
    return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: value.requestHash,
      selections: value.candidates.map(item => ({ handle: item.handle, view })) }) };
  };
}
const request = { requestId: "run", question: "继续这篇文章", ownerId: "owner", modelRef: "synthetic/model", assertProcessingCurrent: async () => {} };

test("request-local writing views preserve corrections, candidates, scope and unresolved questions", async t => {
  const f = await fixture(t);
  const result = await preparePersonalViews({ ...request, resolver: await f.resolver(), complete: selector() });
  assert.equal(result.view.user.length, 0);
  assert.equal(result.view.memory.length, 2);
  const work = result.view.memory.find(item => item.group === "works")!.record;
  assert.deepEqual(work.confirmedPremises, f.work.confirmedPremises);
  assert.deepEqual(work.rejectedInterpretations, f.work.rejectedInterpretations);
  assert.deepEqual(work.openQuestions, f.work.openQuestions);
  assert.equal(work.status, "active");
  assert.equal(work.nextStep, null);
  assert.equal((result.view.memory[0]!.record.scope as { global: boolean }).global, false);
  assert.ok(result.context.includes("not independent evidence"));
  await result.assertCurrent();
  await writeFile(path.join(f.root, "payload.json"), "changed original");
  await assert.rejects(result.assertCurrent(), /payload_digest_mismatch/);
});

test("a corrected generation invalidates old views and a fresh session restores only the current work", async t => {
  const f = await fixture(t);
  const old = await preparePersonalViews({ ...request, resolver: await f.resolver(), complete: selector() });
  f.catalog.works[0]!.status = "superseded";
  const updated = await f.put("works", { ...f.work, goal: "先检查论证，暂不收束", updatedAt: "2026-09-02T00:00:00Z", lastAppliedChangeId: "work-correction" }, [f.source, f.evidence]);
  await f.put("changes", { schemaVersion: "stella.learning-change/v1", id: "work-correction", operationId: "correction",
    algorithmVersion: "synthetic", modelRef: "synthetic/model", promptVersion: "one", inputRefs: [f.evidence], targetRefs: [updated],
    changes: [{ kind: "revise", before: f.workRef, after: updated, supportRefs: [f.evidence], counterRefs: [] }],
    rationale: "Synthetic authored correction", disposition: "update" }, [f.evidence, updated]);
  f.catalog.parentGenerationId = f.catalog.generationId; f.catalog.generationId = "two"; await f.save();
  await assert.rejects(old.assertCurrent(), /stale_generation/);
  const fresh = await preparePersonalViews({ ...request, requestId: "new-session", resolver: await f.resolver(), complete: selector() });
  assert.equal(fresh.view.memory.find(item => item.group === "works")!.ref.version, updated.version);
  assert.ok(!fresh.context.includes(f.workRef.version));
  assert.ok(fresh.context.includes("先检查论证，暂不收束"));
});

test("denied dependencies never enter the selector; technical failures remain failures", async t => {
  const f = await fixture(t), resolver = await f.resolver();
  resolver.assertSourceAccess = async () => { throw new CatalogError("permission_denied"); };
  let calls = 0, payloadReads = 0;
  resolver.reader.readPayload = async () => { payloadReads++; throw new Error("Must not read"); };
  const result = await preparePersonalViews({ ...request, resolver, complete: async () => { calls++; throw new Error("Must not call"); } });
  assert.equal(calls, 0); assert.equal(payloadReads, 0);
  assert.deepEqual(result.view.exclusions, { permission_denied: 2 });
  assert.ok(!result.context.includes("励志"));
  resolver.assertSourceAccess = async () => { throw new CatalogError("source_access_model_failed"); };
  await assert.rejects(preparePersonalViews({ ...request, resolver, complete: selector() }), /source_access_model_failed/);
});

test("selection cannot invent refs, promote work to USER, or survive processing revocation", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePersonalViews({ ...request, resolver: await f.resolver(), complete: selector("user") }), /personal_view_owner_support_required/);
  await assert.rejects(preparePersonalViews({ ...request, resolver: await f.resolver(), complete: async () => ({
    provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: bytesVersion(request.question),
      selections: [{ handle: "V999", view: "memory" }, { handle: "V2", view: "memory" }] }),
  }) }), /invalid_personal_view_selection/);
  let revoked = false;
  await assert.rejects(preparePersonalViews({ ...request, resolver: await f.resolver(),
    assertProcessingCurrent: async () => { if (revoked) throw new CatalogError("processing_revoked"); },
    complete: async input => { revoked = true; return selector()(input); },
  }), /processing_revoked/);
});

test("malformed work acceptance and undeclared evidence cannot become a view", async t => {
  const f = await fixture(t);
  f.catalog.works = [];
  await f.put("works", { ...f.work, confirmedPremises: [{ ...f.work.confirmedPremises[0], acceptance: "proposed" }] }, [f.source, f.evidence]);
  await f.save();
  await assert.rejects(preparePersonalViews({ ...request, resolver: await f.resolver(), complete: selector() }), /invalid_work_premise/);
  f.catalog.works = [];
  await f.put("works", f.work, [f.source]); await f.save();
  await assert.rejects(preparePersonalViews({ ...request, resolver: await f.resolver(), complete: selector() }), /undeclared_object_dependency/);
});


test("USER retains an owner statement's work scope; per-question omission does not change stored memory", async t => {
  const f = await fixture(t);
  const selected = await preparePersonalViews({ ...request, resolver: await f.resolver(), complete: async ({ prompt }) => {
    const value = JSON.parse(prompt.split("\n").at(-1)!) as { requestHash: string; candidates: Array<{ handle: string; group: string }> };
    return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: value.requestHash,
      selections: value.candidates.map(item => ({ handle: item.handle, view: item.group === "understandings" ? "user" : "memory" })) }) };
  } });
  assert.equal(selected.view.user.length, 1);
  assert.deepEqual(selected.view.user[0]!.record.scope, { workIds: ["work"], contexts: [], domains: ["writing"], global: false });
  const omitted = await preparePersonalViews({ ...request, question: "另一个无关问题", resolver: await f.resolver(), complete: selector("omit") });
  assert.equal(omitted.view.user.length + omitted.view.memory.length, 0);
  assert.equal((await f.resolver()).reader.catalog.understandings[0]!.version, f.understanding.version);
});

test("unrecognized Understanding fields are rejected before model disclosure", async t => {
  const f = await fixture(t);
  await f.put("understandings", { schemaVersion: "stella.understanding/v1", id: "extra",
    kind: "owner_statement", status: "active", statement: "Synthetic statement",
    scope: { workIds: [], contexts: [], domains: ["writing"], global: false },
    supportRefs: [f.evidence], counterRefs: [], dependencyRefs: [], originChangeId: "change",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    unclassifiedPrivateNotes: "MUST_NOT_REACH_MODEL" }, [f.evidence]);
  await f.save();
  let calls = 0;
  await assert.rejects(preparePersonalViews({ ...request, resolver: await f.resolver(),
    complete: async input => { calls++; return selector()(input); },
  }), /invalid_personal_view_understanding/);
  assert.equal(calls, 0);
});
