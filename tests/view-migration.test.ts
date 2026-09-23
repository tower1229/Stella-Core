import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryCatalog } from "../src/canghai/catalog-reader.js";
import { canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import {
  applyViewMigration, assertViewReauthentication, catalogChangedRefs, planViewReauthentication,
} from "../src/canghai/view-migration.js";
import type { MemoryView } from "../src/canghai/view-recipe.js";

function catalog(views: MemoryView[] = [], extras: Partial<ReturnType<typeof parseMemoryCatalog>> = {}) {
  return parseMemoryCatalog({
    schemaVersion: "stella.memory-catalog/v1", generationId: "generation-one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [],
    views, ...extras,
  });
}

function view(partial: Partial<MemoryView> & Pick<MemoryView, "id" | "sourceRefs">): MemoryView {
  const recipeRef = partial.recipeRef ?? { id: `recipe:${partial.id}`, version: objectVersion({ id: partial.id }) };
  return { id: partial.id, generationId: partial.generationId ?? "generation-one", recipeRef,
    required: partial.required ?? true, sourceRefs: partial.sourceRefs };
}

test("unchanged declared inputs reauthenticate across a bundle-only generation bump", () => {
  const sourceRef = { id: "source", version: "sha256:" + "a".repeat(64) };
  const before = catalog([view({ id: "session", sourceRefs: [sourceRef] })]);
  const after = structuredClone(before);
  after.parentGenerationId = before.generationId;
  after.generationId = "generation-two";
  after.bundles.push({ id: "bundle", version: "sha256:" + "b".repeat(64), status: "current", dependencies: [],
    locator: { path: "bundle.json", sha256: "sha256:" + "c".repeat(64) } });
  const plan = planViewReauthentication({ before, after });
  assert.deepEqual(plan.reauthenticated, ["session"]);
  assert.equal(plan.views[0]?.generationId, "generation-two");
  const migrated = applyViewMigration(after, plan);
  assertViewReauthentication(before, migrated, plan);
  assert.equal(catalogChangedRefs(before, migrated).size, 1);
});

test("touched sourceRefs and open evidence-plane changes require rebuild", () => {
  const sourceRef = { id: "source", version: "sha256:" + "a".repeat(64) };
  const before = catalog([view({ id: "session", sourceRefs: [sourceRef] })], {
    sources: [{ id: "source", version: sourceRef.version, status: "current", dependencies: [],
      locator: { path: "source.json", sha256: "sha256:" + "d".repeat(64) } }],
  });
  const touched = structuredClone(before);
  touched.parentGenerationId = before.generationId;
  touched.generationId = "generation-two";
  touched.sources[0]!.status = "superseded";
  touched.sources.push({ id: "source", version: "sha256:" + "e".repeat(64), status: "current", dependencies: [],
    locator: { path: "source-2.json", sha256: "sha256:" + "f".repeat(64) } });
  assert.throws(() => planViewReauthentication({ before, after: touched }), /required_view_rebuild_required/);

  const open = catalog([view({ id: "open", sourceRefs: [] })], {
    sources: [{ id: "source", version: sourceRef.version, status: "current", dependencies: [],
      locator: { path: "source.json", sha256: "sha256:" + "d".repeat(64) } }],
  });
  const widened = structuredClone(open);
  widened.parentGenerationId = open.generationId;
  widened.generationId = "generation-two";
  widened.sources.push({ id: "new-source", version: "sha256:" + "g".repeat(64), status: "current", dependencies: [],
    locator: { path: "new.json", sha256: "sha256:" + "h".repeat(64) } });
  assert.throws(() => planViewReauthentication({ before: open, after: widened }), /required_view_rebuild_required/);
});

test("forged migration plans are rejected by exact recomputation", () => {
  const before = catalog([view({ id: "session", sourceRefs: [{ id: "source", version: "sha256:" + "a".repeat(64) }] })]);
  const after = structuredClone(before);
  after.parentGenerationId = before.generationId;
  after.generationId = "generation-two";
  const plan = planViewReauthentication({ before, after });
  const forged = { ...plan, views: plan.views.map(item => ({ ...item, required: false })) };
  const migrated = applyViewMigration(after, plan);
  assert.throws(() => assertViewReauthentication(before, migrated, forged), /required_view_migration_mismatch/);
  assert.equal(canonicalJson(migrated.views), canonicalJson(plan.views));
});
