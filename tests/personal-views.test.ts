import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CatalogReader, CatalogError } from "../src/canghai/catalog-reader.js";
import { objectVersion, canonicalJson, bytesVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";

import { personalMemoryFixture as fixture } from "./personal-memory-fixture.js";

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

test("final delivery revalidation permits unrelated generation additions but refuses changed evidence", async t => {
  const f = await fixture(t);
  const views = await preparePersonalViews({ ...request, resolver: await f.resolver(), complete: selector() });
  f.catalog.parentGenerationId = f.catalog.generationId;
  f.catalog.generationId = "unrelated-new-generation";
  await f.save();
  await assert.rejects(views.assertCurrent(), /stale_generation/);
  await views.assertCurrentForGeneration("unrelated-new-generation");
  await assert.rejects(views.assertCurrentForGeneration("wrong-generation"), /stale_generation/);
  await writeFile(path.join(f.root, "payload.json"), "changed original");
  await assert.rejects(views.assertCurrentForGeneration("unrelated-new-generation"), /payload_digest_mismatch/);
});
