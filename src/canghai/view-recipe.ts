import path from "node:path";
import { CatalogError, validMemoryRef } from "./catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import { isRecord } from "../shared/type-guards.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

export type MemoryView = {
  id: string; generationId: string; recipeRef: VersionedRef; required: boolean; sourceRefs: VersionedRef[];
};
export type ViewRecipe = {
  schemaVersion: "stella.view-recipe/v1"; id: string; version: string;
  adapterId: string; adapterVersion: string; hostTarget: string;
  inputRefs: VersionedRef[]; parameters: Record<string, unknown>;
  modelRef?: string; promptVersion?: string;
};
function check(value: unknown, category = "invalid_view_recipe"): asserts value {
  if (!value) throw new CatalogError(category);
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
function refs(value: unknown): asserts value is VersionedRef[] {
  check(Array.isArray(value) && value.length <= 4096 && value.every(ref => validMemoryRef(ref) && Object.keys(ref).sort().join() === "id,version"));
  check(new Set(value.map(ref => canonicalJson(ref))).size === value.length);
}
function refSet(value: readonly VersionedRef[]): string {
  return canonicalJson(value.map(ref => canonicalJson(ref)).sort());
}
export function parseMemoryViews(value: unknown, generationId: string): MemoryView[] {
  check(Array.isArray(value) && value.length <= 4096, "invalid_catalog_views");
  const ids = new Set<string>();
  for (const view of value) {
    check(isRecord(view) && Object.keys(view).sort().join() === "generationId,id,recipeRef,required,sourceRefs" &&
      text(view.id) && !ids.has(view.id) && view.generationId === generationId && validMemoryRef(view.recipeRef) &&
      Object.keys(view.recipeRef).sort().join() === "id,version" && typeof view.required === "boolean", "invalid_catalog_views");
    refs(view.sourceRefs);
    ids.add(view.id);
  }
  return structuredClone(value) as MemoryView[];
}

/** Version-addressed recipe files live beside the catalog. IDs never become
 * path segments; hashing them also bounds filesystem component lengths. */
export function viewRecipePath(catalogPath: string, ref: VersionedRef): string {
  check(catalogPath && !catalogPath.includes("\\") && catalogPath.split("/").every(part =>
    part && ![".", "..", ".git"].includes(part.toLowerCase()) && !part.includes(":")), "unsafe_locator");
  check(validMemoryRef(ref));
  return path.posix.join(path.posix.dirname(catalogPath), "view-recipes", bytesVersion(ref.id).slice(7), `${ref.version.slice(7)}.json`);
}

/** Generic recipe structure and exact input identity, not adapter readiness.
 * Each installed adapter must additionally validate its own parameters. */
export function parseViewRecipe(value: unknown, view: MemoryView): ViewRecipe {
  check(isRecord(value) && value.schemaVersion === "stella.view-recipe/v1" &&
    value.id === view.recipeRef.id && value.version === view.recipeRef.version &&
    text(value.adapterId) && text(value.adapterVersion) && text(value.hostTarget) && isRecord(value.parameters));
  const usesModel = value.modelRef !== undefined || value.promptVersion !== undefined;
  check(Object.keys(value).sort().join() === (usesModel
    ? "adapterId,adapterVersion,hostTarget,id,inputRefs,modelRef,parameters,promptVersion,schemaVersion,version"
    : "adapterId,adapterVersion,hostTarget,id,inputRefs,parameters,schemaVersion,version"));
  check(!usesModel || text(value.modelRef) && text(value.promptVersion));
  refs(value.inputRefs);
  check(refSet(value.inputRefs) === refSet(view.sourceRefs), "view_recipe_inputs_mismatch");
  check(objectVersion(value) === view.recipeRef.version, "view_recipe_version_mismatch");
  return structuredClone(value) as ViewRecipe;
}

/** Profile-required view ids must already be declared required in the catalog with a readable recipe. */
export async function assertRequiredMemoryViews(
  reader: { catalog: { views: MemoryView[] }; readViewRecipe(viewId: string): Promise<ViewRecipe>; assertCurrent(): Promise<void> },
  requiredViews: readonly string[],
): Promise<void> {
  for (const id of requiredViews) {
    check(typeof id === "string" && id.trim(), "required_view_unavailable");
    const view = reader.catalog.views.find(entry => entry.id === id);
    check(view?.required === true, "required_view_unavailable");
    await reader.readViewRecipe(id);
  }
  await reader.assertCurrent();
}

/** First required host-history view registered for Stella main. */
export const MAIN_REQUIRED_HISTORY_VIEW_ID = "session-current-view";
