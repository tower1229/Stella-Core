import { CatalogError, type MemoryCatalog } from "./catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import type { MemoryFileChange, MemoryTransactionPlan } from "./memory-transaction.js";
import { isRecord } from "../shared/type-guards.js";
import { parseMemoryViews, parseViewRecipe, viewRecipePath, type MemoryView, type ViewRecipe } from "./view-recipe.js";

export type ViewRebuildAdmission = Readonly<{
  viewId: string;
  artifactPath: string;
  artifactBytes: string;
  signaturePath: string;
  signatureBytes: string;
  recipePath: string;
  recipeBytes: string;
  view: MemoryView;
}>;

export type ViewMigrationPlan = Readonly<{
  beforeGenerationId: string;
  afterGenerationId: string;
  views: readonly MemoryView[];
  reauthenticated: readonly string[];
  rebuilt: readonly string[];
  files: readonly MemoryFileChange[];
}>;

function check(value: unknown, category = "required_view_rebuild_required"): asserts value {
  if (!value) throw new CatalogError(category);
}

const evidenceGroups = ["sources", "evidence", "policies", "coverage"] as const;
const derivedGroups = ["works", "understandings", "changes", "bundles"] as const;

function refKey(ref: { id: string; version: string }): string {
  return canonicalJson({ id: ref.id, version: ref.version });
}

function groupOf(catalog: MemoryCatalog, id: string): string | undefined {
  for (const group of [...evidenceGroups, ...derivedGroups]) {
    if (catalog[group].some(entry => entry.id === id)) return group;
  }
  return undefined;
}

/** Refs whose catalog entries are new, rewritten, or no longer the current row. */
export function catalogChangedRefs(before: MemoryCatalog, after: MemoryCatalog): Set<string> {
  const changed = new Set<string>();
  for (const group of [...evidenceGroups, ...derivedGroups]) {
    const prior = new Map(before[group].map(entry => [refKey(entry), entry]));
    for (const entry of after[group]) {
      const key = refKey(entry);
      const existing = prior.get(key);
      if (!existing || canonicalJson(existing) !== canonicalJson(entry)) changed.add(key);
    }
    for (const entry of before[group]) {
      if (entry.status !== "current") continue;
      const current = after[group].find(candidate => candidate.id === entry.id && candidate.status === "current");
      if (!current || current.version !== entry.version) changed.add(refKey(entry));
    }
  }
  return changed;
}

function evidencePlaneChanged(before: MemoryCatalog, after: MemoryCatalog, changedRefs: ReadonlySet<string>): boolean {
  for (const key of changedRefs) {
    const ref = JSON.parse(key) as { id: string; version: string };
    const priorGroup = groupOf(before, ref.id);
    if (priorGroup && (evidenceGroups as readonly string[]).includes(priorGroup)) return true;
    if (priorGroup && (derivedGroups as readonly string[]).includes(priorGroup)) continue;
    const afterGroup = groupOf(after, ref.id);
    if (afterGroup && (evidenceGroups as readonly string[]).includes(afterGroup)) return true;
  }
  return false;
}

function viewNeedsRebuild(input: {
  view: MemoryView;
  before: MemoryCatalog;
  after: MemoryCatalog;
  changedRefs: ReadonlySet<string>;
  extraChangedPaths: ReadonlySet<string>;
}): boolean {
  if (input.view.sourceRefs.length === 0) {
    return evidencePlaneChanged(input.before, input.after, input.changedRefs) || input.extraChangedPaths.size > 0;
  }
  return input.view.sourceRefs.some(ref => input.changedRefs.has(refKey(ref)));
}

/** View ids that cannot reauthenticate across this before/after pair. */
export function viewsRequiringRebuild(input: {
  before: MemoryCatalog;
  after: MemoryCatalog;
  changedRefs?: ReadonlySet<string>;
  extraChangedPaths?: ReadonlySet<string>;
}): string[] {
  const changedRefs = input.changedRefs ?? catalogChangedRefs(input.before, input.after);
  const extraChangedPaths = input.extraChangedPaths ?? new Set<string>();
  return input.before.views
    .filter(view => viewNeedsRebuild({
      view, before: input.before, after: input.after, changedRefs, extraChangedPaths,
    }))
    .map(view => view.id);
}

function decodeRebuild(admission: ViewRebuildAdmission, generationId: string): { view: MemoryView; recipe: ViewRecipe } {
  check(admission.view.id === admission.viewId && admission.view.generationId === generationId && admission.view.required,
    "required_view_rebuild_invalid");
  check(admission.artifactPath.endsWith(".json") && admission.signaturePath === `${admission.artifactPath}.sig` &&
    Buffer.byteLength(admission.artifactBytes) <= 2 * 1024 * 1024 && admission.signatureBytes.trim() &&
    admission.recipePath.length > 0 && admission.artifactPath.length > 0, "required_view_rebuild_invalid");
  let snapshot: unknown;
  try { snapshot = JSON.parse(admission.artifactBytes); } catch { throw new CatalogError("required_view_rebuild_invalid"); }
  check(isRecord(snapshot) && snapshot.viewId === admission.viewId, "required_view_rebuild_invalid");
  let recipeValue: unknown;
  try { recipeValue = JSON.parse(admission.recipeBytes); } catch { throw new CatalogError("required_view_rebuild_invalid"); }
  check(isRecord(recipeValue), "required_view_rebuild_invalid");
  check(canonicalJson(recipeValue) === admission.recipeBytes, "required_view_rebuild_invalid");
  const recipe = parseViewRecipe(recipeValue, admission.view);
  check(objectVersion(recipeValue) === admission.view.recipeRef.version, "required_view_rebuild_invalid");
  if (recipe.adapterId === "stella.host-history") {
    check(typeof recipe.parameters.digest === "string" && recipe.parameters.digest === bytesVersion(admission.artifactBytes) &&
      typeof recipe.parameters.archiveRoot === "string", "required_view_rebuild_invalid");
  }
  return { view: structuredClone(admission.view), recipe };
}

/** Plan reauthentication and structured rebuild admissions for a generation bump.
 * Rebuild bytes are caller-supplied (already model-produced); recovery only replays them. */
export function planViewMigration(input: {
  before: MemoryCatalog;
  after: MemoryCatalog;
  changedRefs?: ReadonlySet<string>;
  rebuilds?: readonly ViewRebuildAdmission[];
  extraChangedPaths?: ReadonlySet<string>;
}): ViewMigrationPlan {
  check(typeof input.after.generationId === "string" && input.after.generationId.trim() &&
    input.after.generationId !== input.before.generationId, "invalid_catalog");
  check(input.after.parentGenerationId === input.before.generationId, "invalid_catalog");
  const changedRefs = input.changedRefs ?? catalogChangedRefs(input.before, input.after);
  const extraChangedPaths = input.extraChangedPaths ?? new Set<string>();
  const rebuilds = new Map((input.rebuilds ?? []).map(entry => [entry.viewId, entry]));
  check(rebuilds.size === (input.rebuilds ?? []).length, "required_view_rebuild_invalid");
  const reauthenticated: string[] = [];
  const rebuilt: string[] = [];
  const files: MemoryFileChange[] = [];
  const views: MemoryView[] = input.before.views.map(view => {
    check(view.generationId === input.before.generationId, "invalid_catalog_views");
    if (!viewNeedsRebuild({ view, before: input.before, after: input.after, changedRefs, extraChangedPaths })) {
      check(!rebuilds.has(view.id), "required_view_rebuild_invalid");
      reauthenticated.push(view.id);
      return { ...structuredClone(view), generationId: input.after.generationId };
    }
    const admission = rebuilds.get(view.id);
    check(admission, "required_view_rebuild_required");
    const decoded = decodeRebuild(admission, input.after.generationId);
    rebuilt.push(view.id);
    files.push(
      { path: admission.artifactPath, before: null, after: admission.artifactBytes },
      { path: admission.signaturePath, before: null, after: admission.signatureBytes },
      { path: admission.recipePath, before: null, after: admission.recipeBytes },
    );
    void decoded.recipe;
    return decoded.view;
  });
  check([...rebuilds.keys()].every(id => rebuilt.includes(id)), "required_view_rebuild_invalid");
  parseMemoryViews(views, input.after.generationId);
  return Object.freeze({
    beforeGenerationId: input.before.generationId,
    afterGenerationId: input.after.generationId,
    views: Object.freeze(views),
    reauthenticated: Object.freeze(reauthenticated),
    rebuilt: Object.freeze(rebuilt),
    files: Object.freeze(files),
  });
}

/** Reauthentication-only helper for writers that never supply rebuild admissions. */
export function planViewReauthentication(input: {
  before: MemoryCatalog;
  after: MemoryCatalog;
  changedRefs?: ReadonlySet<string>;
  extraChangedPaths?: ReadonlySet<string>;
}): ViewMigrationPlan {
  return planViewMigration(input);
}

/** Apply a verified migration plan onto a catalog that already carries the
 * destination generation id. Callers must not invent view rows here. */
export function applyViewMigration(catalog: MemoryCatalog, plan: ViewMigrationPlan): MemoryCatalog {
  check(catalog.generationId === plan.afterGenerationId, "host_context_generation_mismatch");
  check(plan.beforeGenerationId === catalog.parentGenerationId, "host_context_generation_mismatch");
  const next = structuredClone(catalog);
  next.views = structuredClone(plan.views) as MemoryView[];
  parseMemoryViews(next.views, next.generationId);
  return next;
}

/** Recompute the only legal migration for this before/after pair and demand an
 * exact match, including rebuild file admissions when provided. */
export function assertViewMigration(
  before: MemoryCatalog,
  after: MemoryCatalog,
  plan: ViewMigrationPlan,
  options: {
    rebuilds?: readonly ViewRebuildAdmission[];
    extraChangedPaths?: ReadonlySet<string>;
  } = {},
): void {
  check(plan.beforeGenerationId === before.generationId && plan.afterGenerationId === after.generationId,
    "host_context_generation_mismatch");
  const expected = planViewMigration({
    before, after, rebuilds: options.rebuilds, extraChangedPaths: options.extraChangedPaths,
  });
  check(canonicalJson(expected) === canonicalJson(plan), "required_view_migration_mismatch");
  check(canonicalJson(after.views) === canonicalJson(plan.views), "required_view_migration_mismatch");
}

/** @deprecated Use assertViewMigration. Kept for call sites that only reauthenticate. */
export function assertViewReauthentication(
  before: MemoryCatalog,
  after: MemoryCatalog,
  plan: ViewMigrationPlan,
): void {
  assertViewMigration(before, after, plan);
}

/** Extract structured rebuild admissions from recorded view file bytes.
 * Reauthenticated views omit recipe/artifact files; every supplied path must be used. */
export function rebuildsFromViewFiles(
  after: MemoryCatalog,
  viewFiles: readonly { path: string; bytes: string }[],
  catalogPath: string,
): ViewRebuildAdmission[] {
  const byPath = new Map(viewFiles.map(file => [file.path, file.bytes]));
  check(byPath.size === viewFiles.length, "required_view_rebuild_invalid");
  const admissions: ViewRebuildAdmission[] = [];
  for (const view of after.views) {
    check(view.generationId === after.generationId, "required_view_rebuild_invalid");
    const recipePath = viewRecipePath(catalogPath, view.recipeRef);
    const recipeBytes = byPath.get(recipePath);
    if (recipeBytes === undefined) continue;
    let recipeValue: unknown;
    try { recipeValue = JSON.parse(recipeBytes); } catch { throw new CatalogError("required_view_rebuild_invalid"); }
    check(isRecord(recipeValue) && canonicalJson(recipeValue) === recipeBytes, "required_view_rebuild_invalid");
    const recipe = parseViewRecipe(recipeValue, view);
    check(recipe.adapterId === "stella.host-history" && typeof recipe.parameters.digest === "string" &&
      typeof recipe.parameters.archiveRoot === "string", "required_view_rebuild_invalid");
    const artifactPath = `${recipe.parameters.archiveRoot}/history-views/${String(recipe.parameters.digest).slice(7)}.json`;
    const artifactBytes = byPath.get(artifactPath);
    const signatureBytes = byPath.get(`${artifactPath}.sig`);
    check(typeof artifactBytes === "string" && typeof signatureBytes === "string", "required_view_rebuild_invalid");
    const admission: ViewRebuildAdmission = {
      viewId: view.id, view: structuredClone(view),
      artifactPath, artifactBytes,
      signaturePath: `${artifactPath}.sig`, signatureBytes,
      recipePath, recipeBytes,
    };
    decodeRebuild(admission, after.generationId);
    admissions.push(admission);
  }
  const used = new Set(admissions.flatMap(entry => [entry.artifactPath, entry.signaturePath, entry.recipePath]));
  check(viewFiles.every(file => used.has(file.path)) && used.size === viewFiles.length, "required_view_rebuild_invalid");
  return admissions;
}

/** Extract structured rebuild admissions from an already recorded transaction.
 * Recovery must replay these bytes; it never regenerates signed history views. */
export function rebuildsFromRecordedPlan(
  before: MemoryCatalog,
  after: MemoryCatalog,
  plan: MemoryTransactionPlan,
  catalogPath: string,
): ViewRebuildAdmission[] {
  const viewFiles = plan.files
    .filter(file => file.before === null && typeof file.after === "string" && isViewMigrationFile(file.path))
    .map(file => ({ path: file.path, bytes: file.after as string }));
  const admissions = rebuildsFromViewFiles(after, viewFiles, catalogPath);
  for (const view of after.views) {
    const prior = before.views.find(candidate => candidate.id === view.id);
    if (prior && canonicalJson({ ...prior, generationId: view.generationId }) === canonicalJson(view)) {
      check(!admissions.some(entry => entry.viewId === view.id), "required_view_rebuild_invalid");
      continue;
    }
    check(admissions.some(entry => entry.viewId === view.id), "required_view_rebuild_required");
  }
  return admissions;
}

/** Paths that carry signed history-view artifacts or versioned recipes. */
export function isViewMigrationFile(filePath: string): boolean {
  return /(?:^|\/)(?:history-views|view-recipes)\//.test(filePath);
}
