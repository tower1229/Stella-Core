import { personalMemoryFixture } from "./personal-memory-fixture.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CatalogReader, parseMemoryCatalog } from "../src/canghai/catalog-reader.js";
import { canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { baseline } from "../src/canghai/synchronization-plan.js";
import { parseViewRecipe, viewRecipePath, type MemoryView } from "../src/canghai/view-recipe.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-view-recipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = "memory/catalog.json";
  const body = { schemaVersion: "stella.view-recipe/v1", id: "synthetic-session", adapterId: "synthetic-history",
    adapterVersion: "1", hostTarget: "stella-context", inputRefs: [], parameters: { scope: "synthetic-owner" },
    modelRef: "synthetic/model", promptVersion: "1" };
  const recipe = { ...body, version: objectVersion(body) };
  const view: MemoryView = { id: "synthetic-history", generationId: "generation-one", required: true,
    recipeRef: { id: recipe.id, version: recipe.version }, sourceRefs: [] };
  const catalog = parseMemoryCatalog({ schemaVersion: "stella.memory-catalog/v1", generationId: "generation-one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [view] });
  const recipePath = viewRecipePath(catalogPath, view.recipeRef);
  await mkdir(path.dirname(path.join(root, recipePath)), { recursive: true });
  await writeFile(path.join(root, recipePath), canonicalJson(recipe));
  await writeFile(path.join(root, catalogPath), canonicalJson(catalog));
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.name", "Synthetic Recipe Test");
  await git("config", "user.email", "recipe@example.invalid");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Synthetic view recipe");
  return { root, catalogPath, catalog, view, recipe, recipePath, git, revision: await git("rev-parse", "HEAD") };
}

test("view recipes have a real versioned locator and recovery reads the selected revision", async t => {
  const f = await fixture(t);
  const reader = await CatalogReader.load(f.root, f.catalogPath);
  assert.deepEqual(await reader.readViewRecipe(f.view.id), f.recipe);
  assert.deepEqual((await baseline(f.root, f.revision, f.catalogPath)).recipes.get(f.view.id), f.recipe);
  await writeFile(path.join(f.root, f.recipePath), canonicalJson({ ...f.recipe, parameters: { scope: "another-owner" } }));
  await assert.rejects(reader.readViewRecipe(f.view.id), /view_recipe_version_mismatch/);
  assert.deepEqual((await baseline(f.root, f.revision, f.catalogPath)).recipes.get(f.view.id), f.recipe,
    "A working-tree replacement cannot change a selected historical recipe");
  await rm(path.join(f.root, f.recipePath));
  await assert.rejects(reader.readViewRecipe(f.view.id), /view_recipe_unavailable/);
  await f.git("add", "-u");
  await f.git("commit", "--quiet", "-m", "Remove declared recipe");
  await assert.rejects(baseline(f.root, await f.git("rev-parse", "HEAD"), f.catalogPath), /view_recipe_unavailable/);
});

test("view declarations reject stale generations, duplicate identities and unbound recipe inputs", async t => {
  const f = await fixture(t);
  assert.throws(() => parseMemoryCatalog({ ...f.catalog, views: [{ ...f.view, generationId: "old-generation" }] }), /invalid_catalog_views/);
  assert.throws(() => parseMemoryCatalog({ ...f.catalog, views: [f.view, f.view] }), /invalid_catalog_views/);
  assert.throws(() => parseMemoryCatalog({ ...f.catalog, views: [{}] }), /invalid_catalog_views/);
  const ref = { id: "synthetic-source", version: objectVersion({ text: "Synthetic source" }) };
  assert.throws(() => parseViewRecipe(f.recipe, { ...f.view, sourceRefs: [ref] }), /view_recipe_inputs_mismatch/);
  assert.throws(() => parseMemoryCatalog({ ...f.catalog, views: [{ ...f.view, sourceRefs: [ref, ref] }] }), /invalid_view_recipe/);
  const { promptVersion: _prompt, ...missingPrompt } = f.recipe;
  assert.throws(() => parseViewRecipe(missingPrompt, f.view), /invalid_view_recipe/);
  assert.throws(() => parseViewRecipe({ ...f.recipe, locator: "unbound-override" }, f.view), /invalid_view_recipe/);
  assert.throws(() => viewRecipePath("../catalog.json", f.view.recipeRef), /unsafe_locator/);
  assert.throws(() => viewRecipePath(".git/catalog.json", f.view.recipeRef), /unsafe_locator/);
  assert.match(viewRecipePath(f.catalogPath, { ...f.view.recipeRef, id: "../../an-id-is-not-a-path" }), /^memory\/view-recipes\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
  const reader = await CatalogReader.load(f.root, f.catalogPath);
  await writeFile(path.join(f.root, f.catalogPath), canonicalJson({ ...f.catalog, generationId: "changed", views: [] }));
  await assert.rejects(reader.readViewRecipe(f.view.id), /stale_generation/);
  assert.equal(await readFile(path.join(f.root, f.recipePath), "utf8"), canonicalJson(f.recipe));
});

test("a nonempty recipe preserves the exact declared evidence set regardless of declaration order", async t => {
  const f = await personalMemoryFixture(t);
  const body = { schemaVersion: "stella.view-recipe/v1", id: "source-bound-history", adapterId: "synthetic-history",
    adapterVersion: "1", hostTarget: "stella-context", inputRefs: [f.source, f.evidence], parameters: {},
    modelRef: "synthetic/model", promptVersion: "1" };
  const recipe = { ...body, version: objectVersion(body) };
  const view: MemoryView = { id: "source-bound-history", generationId: f.catalog.generationId, required: true,
    recipeRef: { id: recipe.id, version: recipe.version }, sourceRefs: [f.evidence, f.source] };
  const file = viewRecipePath("catalog.json", view.recipeRef);
  await mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
  await writeFile(path.join(f.root, file), canonicalJson(recipe));
  f.catalog.views.push(view);
  await f.save();
  const resolver = await f.resolver();
  assert.ok((await resolver.readEvidence(f.evidence)).text.length > 0);
  assert.equal(resolver.reader.eligible(f.source), true);
  assert.deepEqual(await resolver.reader.readViewRecipe(view.id), recipe);
  assert.throws(() => parseViewRecipe(recipe, { ...view, sourceRefs: [f.source] }), /view_recipe_inputs_mismatch/);
});
