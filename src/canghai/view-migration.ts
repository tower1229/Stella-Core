import { CatalogError, type MemoryCatalog } from "./catalog-reader.js";
import { canonicalJson } from "./content-version.js";
import { parseMemoryViews, type MemoryView } from "./view-recipe.js";

export type ViewMigrationPlan = Readonly<{
  beforeGenerationId: string;
  afterGenerationId: string;
  views: readonly MemoryView[];
  reauthenticated: readonly string[];
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

/** Reauthenticate required views whose declared inputs are untouched. Views that
 * declare no inputs still rebuild when any evidence-plane row changes, because
 * coverage and "no evidence found" selections can widen. Structured reconstruction
 * for touched inputs belongs to a later writer-specific path. */
export function planViewReauthentication(input: {
  before: MemoryCatalog;
  after: MemoryCatalog;
  changedRefs?: ReadonlySet<string>;
}): ViewMigrationPlan {
  check(typeof input.after.generationId === "string" && input.after.generationId.trim() &&
    input.after.generationId !== input.before.generationId, "invalid_catalog");
  check(input.after.parentGenerationId === input.before.generationId, "invalid_catalog");
  const changedRefs = input.changedRefs ?? catalogChangedRefs(input.before, input.after);
  const reauthenticated: string[] = [];
  const views: MemoryView[] = input.before.views.map(view => {
    check(view.generationId === input.before.generationId, "invalid_catalog_views");
    if (view.sourceRefs.length === 0) {
      check(!evidencePlaneChanged(input.before, input.after, changedRefs));
    } else {
      check(!view.sourceRefs.some(ref => changedRefs.has(refKey(ref))));
    }
    reauthenticated.push(view.id);
    return { ...structuredClone(view), generationId: input.after.generationId };
  });
  parseMemoryViews(views, input.after.generationId);
  return Object.freeze({
    beforeGenerationId: input.before.generationId,
    afterGenerationId: input.after.generationId,
    views: Object.freeze(views),
    reauthenticated: Object.freeze(reauthenticated),
  });
}

/** Apply a verified reauthentication plan onto a catalog that already carries the
 * destination generation id. Callers must not invent view rows here. */
export function applyViewMigration(catalog: MemoryCatalog, plan: ViewMigrationPlan): MemoryCatalog {
  check(catalog.generationId === plan.afterGenerationId, "host_context_generation_mismatch");
  check(plan.beforeGenerationId === catalog.parentGenerationId, "host_context_generation_mismatch");
  const next = structuredClone(catalog);
  next.views = structuredClone(plan.views) as MemoryView[];
  parseMemoryViews(next.views, next.generationId);
  return next;
}

/** Recompute the only legal reauthentication for this before/after pair and
 * demand an exact match. Prevents validatePreview callers from smuggling edits. */
export function assertViewReauthentication(
  before: MemoryCatalog,
  after: MemoryCatalog,
  plan: ViewMigrationPlan,
): void {
  check(plan.beforeGenerationId === before.generationId && plan.afterGenerationId === after.generationId,
    "host_context_generation_mismatch");
  const expected = planViewReauthentication({ before, after });
  check(canonicalJson(expected) === canonicalJson(plan), "required_view_migration_mismatch");
  check(canonicalJson(after.views) === canonicalJson(plan.views), "required_view_migration_mismatch");
}
