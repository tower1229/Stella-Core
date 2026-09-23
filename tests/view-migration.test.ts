import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryCatalog } from "../src/canghai/catalog-reader.js";
import { canonicalJson, objectVersion, bytesVersion } from "../src/canghai/content-version.js";
import {
  applyViewMigration, assertViewMigration, assertViewReauthentication, catalogChangedRefs,
  planViewMigration, planViewReauthentication, rebuildsFromRecordedPlan,
} from "../src/canghai/view-migration.js";
import { parseViewRecipe, viewRecipePath, type MemoryView } from "../src/canghai/view-recipe.js";

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
  assert.deepEqual(plan.rebuilt, []);
  assert.equal(plan.files.length, 0);
  assert.equal(plan.views[0]?.generationId, "generation-two");
  const migrated = applyViewMigration(after, plan);
  assertViewReauthentication(before, migrated, plan);
  assert.equal(catalogChangedRefs(before, migrated).size, 1);
});

test("open views rebuild when non-catalog episode paths change even if catalog evidence is untouched", () => {
  const before = catalog([view({ id: "open", sourceRefs: [] })]);
  const after = structuredClone(before);
  after.parentGenerationId = before.generationId;
  after.generationId = "generation-two";
  assert.throws(() => planViewReauthentication({
    before, after, extraChangedPaths: new Set(["episodes/one/episode.json"]),
  }), /required_view_rebuild_required/);
});

test("structured rebuild admissions replace touched views without rerunning a model", () => {
  const sourceRef = { id: "source", version: "sha256:" + "a".repeat(64) };
  const before = catalog([view({ id: "session", sourceRefs: [sourceRef] })], {
    sources: [{ id: "source", version: sourceRef.version, status: "current", dependencies: [],
      locator: { path: "source.json", sha256: "sha256:" + "d".repeat(64) } }],
  });
  const after = structuredClone(before);
  after.parentGenerationId = before.generationId;
  after.generationId = "generation-two";
  after.sources[0]!.status = "superseded";
  const nextSource = { id: "source", version: "sha256:" + "e".repeat(64), status: "current" as const, dependencies: [],
    locator: { path: "source-2.json", sha256: "sha256:" + "f".repeat(64) } };
  after.sources.push(nextSource);
  const nextRef = { id: nextSource.id, version: nextSource.version };
  const artifactBody = { schemaVersion: "stella.host-history-view/v1", viewId: "session", text: "rebuilt" };
  const artifactBytes = canonicalJson(artifactBody);
  const digest = bytesVersion(artifactBytes);
  const recipeBody = { schemaVersion: "stella.view-recipe/v1", id: "history-view:session", adapterId: "stella.host-history",
    adapterVersion: "1", hostTarget: "stella", inputRefs: [nextRef], parameters: { archiveRoot: "retained-context", digest },
    modelRef: "synthetic/model", promptVersion: "stella.host-history-rebuild/v1" };
  const recipe = { ...recipeBody, version: objectVersion(recipeBody) };
  const rebuiltView = view({ id: "session", generationId: "generation-two", sourceRefs: [nextRef],
    recipeRef: { id: recipe.id, version: recipe.version } });
  const admission = {
    viewId: "session", view: rebuiltView,
    artifactPath: `retained-context/history-views/${digest.slice(7)}.json`, artifactBytes,
    signaturePath: `retained-context/history-views/${digest.slice(7)}.json.sig`, signatureBytes: "c2ln",
    recipePath: "view-recipes/x/y.json", recipeBytes: canonicalJson(recipe),
  };
  const plan = planViewMigration({ before, after, rebuilds: [admission] });
  assert.deepEqual(plan.rebuilt, ["session"]);
  assert.equal(plan.files.length, 3);
  const migrated = applyViewMigration(after, plan);
  assertViewMigration(before, migrated, plan, { rebuilds: [admission] });
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

test("recorded rebuild admissions replay without regenerating signed history bytes", () => {
  const sourceRef = { id: "source", version: "sha256:" + "a".repeat(64) };
  const before = catalog([view({ id: "session", sourceRefs: [sourceRef] })], {
    sources: [{ id: "source", version: sourceRef.version, status: "current", dependencies: [],
      locator: { path: "source.json", sha256: "sha256:" + "d".repeat(64) } }],
  });
  const after = structuredClone(before);
  after.parentGenerationId = before.generationId;
  after.generationId = "generation-two";
  after.sources[0]!.status = "superseded";
  const nextSource = { id: "source", version: "sha256:" + "e".repeat(64), status: "current" as const, dependencies: [],
    locator: { path: "source-2.json", sha256: "sha256:" + "f".repeat(64) } };
  after.sources.push(nextSource);
  const nextRef = { id: nextSource.id, version: nextSource.version };
  const artifactBody = { schemaVersion: "stella.host-history-view/v1", viewId: "session", text: "rebuilt" };
  const artifactBytes = canonicalJson(artifactBody);
  const digest = bytesVersion(artifactBytes);
  const recipeBody = { schemaVersion: "stella.view-recipe/v1", id: "history-view:session", adapterId: "stella.host-history",
    adapterVersion: "1", hostTarget: "stella", inputRefs: [nextRef], parameters: { archiveRoot: "retained-context", digest },
    modelRef: "synthetic/model", promptVersion: "stella.host-history-rebuild/v1" };
  const recipe = { ...recipeBody, version: objectVersion(recipeBody) };
  const rebuiltView = view({ id: "session", generationId: "generation-two", sourceRefs: [nextRef],
    recipeRef: { id: recipe.id, version: recipe.version } });
  const recipePath = viewRecipePath("catalog.json", rebuiltView.recipeRef);
  const admission = {
    viewId: "session", view: rebuiltView,
    artifactPath: `retained-context/history-views/${digest.slice(7)}.json`, artifactBytes,
    signaturePath: `retained-context/history-views/${digest.slice(7)}.json.sig`, signatureBytes: "c2ln",
    recipePath, recipeBytes: canonicalJson(recipe),
  };
  const plan = planViewMigration({ before, after, rebuilds: [admission] });
  const migrated = applyViewMigration(after, plan);
  const recorded = {
    operationId: "sync_test",
    journalPath: "operations/sync_test.transaction.json",
    files: [...plan.files, { path: "catalog.json", before: canonicalJson(before), after: canonicalJson(migrated) }],
  };
  const recovered = rebuildsFromRecordedPlan(before, migrated, recorded, "catalog.json");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.artifactBytes, artifactBytes);
  assert.equal(recovered[0]?.recipePath, recipePath);
  assertViewMigration(before, migrated, plan, { rebuilds: recovered });
  parseViewRecipe(JSON.parse(recovered[0]!.recipeBytes), recovered[0]!.view);
});
