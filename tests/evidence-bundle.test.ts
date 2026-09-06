import assert from "node:assert/strict";
import test from "node:test";
import { objectVersion } from "../src/canghai/content-version.js";
import { loadEvidenceBundle, parseEvidenceBundle } from "../src/praxis/evidence-bundle.js";
import { bundleFixture, syntheticBundle } from "./evidence-bundle-fixture.js";

test("loads a persisted legal-empty evidence scope without inventing owner facts", async (t) => {
  const fixture = await bundleFixture(t);
  const result = await loadEvidenceBundle(await fixture.resolver(), fixture.answer("Clarify"));
  assert.deepEqual(result.bundle, fixture.bundle);
  assert.deepEqual(result.originalEvidence, []);
  assert.deepEqual(result.coverage, []);
});

test("rejects unsupported claims, unread refs, false sufficient status, duplicate refs and changed content", () => {
  const ref = { id: "not-read", version: `sha256:${"b".repeat(64)}` };
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ claims: [{ id: "claim", statement: "Owner acted", kind: "fact", scope: "synthetic", support: [], counter: [], unresolved: [] }] }, /unsupported_bundle_claim/],
    [{ claims: [{ id: "claim", statement: "Owner acted", kind: "fact", scope: "synthetic", support: [ref], counter: [], unresolved: [] }] }, /bundle_claim_evidence_not_read/],
    [{ status: "sufficient" }, /bundle_material_unknown_unresolved/],
    [{ unresolvedLeads: [] }, /bundle_material_unknown_missing/],
    [{ readEvidenceRefs: [ref, ref] }, /invalid_evidence_bundle/],
    [{ stopping: { reason: "Synthetic", modelRef: "", promptVersion: "v1" } }, /invalid_evidence_bundle/],
    [{ unexpected: true }, /invalid_evidence_bundle/],
  ];
  for (const [patch, error] of cases) {
    const bundle = { ...syntheticBundle(), ...patch };
    bundle.version = objectVersion(bundle);
    assert.throws(() => parseEvidenceBundle(bundle), error);
  }
  assert.throws(() => parseEvidenceBundle({ ...syntheticBundle(), requestId: "changed" }), /object_version_mismatch/);
});

test("binds persisted bundle to exact request, revision and generation", async (t) => {
  const fixture = await bundleFixture(t);
  for (const patch of [{ requestId: "other" }, { revision: "c".repeat(40) }, { generationId: "other" }]) {
    await assert.rejects(loadEvidenceBundle(await fixture.resolver(), { ...fixture.answer("answer"), ...patch }), /bundle_context_mismatch/);
  }
  const old = await fixture.resolver();
  fixture.catalog.generationId = "new";
  await fixture.save();
  await assert.rejects(loadEvidenceBundle(old, fixture.answer("answer")), /stale_generation/);
  await assert.rejects(loadEvidenceBundle(await fixture.resolver(), fixture.answer("answer")), /historical_catalog_unavailable|unsafe_historical_catalog/);
});

test("rejects bundle refs without declared dependencies before reading unverified originals", async (t) => {
  const fixture = await bundleFixture(t);
  fixture.bundle.readEvidenceRefs.push({ id: "missing", version: `sha256:${"b".repeat(64)}` });
  await fixture.save();
  await assert.rejects(loadEvidenceBundle(await fixture.resolver(), fixture.answer("answer")), /undeclared_object_dependency/);
});
