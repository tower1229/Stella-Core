import { CatalogError, validMemoryRef } from "../canghai/catalog-reader.js";
import { canonicalJson, objectVersion } from "../canghai/content-version.js";
import type { ResponseKind } from "../openclaw/completion.js";
import { isRecord } from "../shared/type-guards.js";
import type { EpisodeEvidenceResolver } from "./episode-evidence.js";
import type { VersionedRef } from "./episode-v2.js";

export const SOURCE_ACCESS_EXCLUSION_CATEGORIES = [
  "permission_denied", "source_topic_unresolved", "source_scenario_forbidden",
  "source_trigger_forbidden", "source_topic_required", "source_quote_forbidden", "source_quote_authorization_required",
] as const;
export type SourceAccessExclusions = Partial<Record<typeof SOURCE_ACCESS_EXCLUSION_CATEGORIES[number], number>>;

export type EvidenceBundle = VersionedRef & {
  schemaVersion: "stella.evidence-bundle/v1";
  requestId: string;
  revision: string;
  generationId: string;
  status: "sufficient" | "material_unknown" | "conflicting";
  claims: Array<{ id: string; statement: string; kind: "fact" | "inference" | "proposal";
    support: VersionedRef[]; counter: VersionedRef[]; unresolved: string[]; scope: string }>;
  searchedCoverageRefs: VersionedRef[];
  readEvidenceRefs: VersionedRef[];
  excludedByAccess?: SourceAccessExclusions;
  unresolvedLeads: Array<{ question: string; material: boolean; reason: string }>;
  stopping: { reason: string; modelRef: string; promptVersion: string };
  suggestedResponseKind: ResponseKind;
};

const key = (ref: VersionedRef) => JSON.stringify([ref.id, ref.version]);
function check(condition: unknown, category: string): asserts condition {
  if (!condition) throw new CatalogError(category);
}
function text(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((name) => Object.hasOwn(value, name));
}
function refs(value: unknown): value is VersionedRef[] {
  return Array.isArray(value) && value.every((ref) => validMemoryRef(ref) && exact(ref, ["id", "version"])) &&
    new Set(value.map(key)).size === value.length;
}

/** Structural validation does not certify the model's claim of evidence sufficiency. */
export function parseEvidenceBundle(value: unknown): EvidenceBundle {
  check(isRecord(value) && exact(value, ["schemaVersion", "id", "version", "requestId", "revision", "generationId", "status",
    "claims", "searchedCoverageRefs", "readEvidenceRefs", "unresolvedLeads", "stopping", "suggestedResponseKind",
    ...(isRecord(value) && Object.hasOwn(value, "excludedByAccess") ? ["excludedByAccess"] : [])]) &&
    value.schemaVersion === "stella.evidence-bundle/v1" && validMemoryRef(value) && text(value.requestId) &&
    typeof value.revision === "string" && /^[a-f0-9]{40}$/.test(value.revision) && text(value.generationId) &&
    ["sufficient", "material_unknown", "conflicting"].includes(String(value.status)) &&
    ["answer", "clarification", "collaboration", "action_advice", "outcome_ack"].includes(String(value.suggestedResponseKind)) &&
    refs(value.searchedCoverageRefs) && refs(value.readEvidenceRefs) && Array.isArray(value.claims) &&
    Array.isArray(value.unresolvedLeads) && isRecord(value.stopping) && exact(value.stopping, ["reason", "modelRef", "promptVersion"]) &&
    Object.values(value.stopping).every(text), "invalid_evidence_bundle");
  if (Object.hasOwn(value, "excludedByAccess")) {
    check(isRecord(value.excludedByAccess) && Object.entries(value.excludedByAccess).every(([category, count]) =>
      SOURCE_ACCESS_EXCLUSION_CATEGORIES.some(allowed => allowed === category) &&
      typeof count === "number" && Number.isSafeInteger(count) && count > 0), "invalid_bundle_access_exclusions");
  }
  const read = new Set(value.readEvidenceRefs.map(key));
  const claimIds = new Set<string>();
  for (const claim of value.claims) {
    check(isRecord(claim) && exact(claim, ["id", "statement", "kind", "support", "counter", "unresolved", "scope"]), "invalid_bundle_claim_shape");
    check(text(claim.id) && !claimIds.has(claim.id), "invalid_bundle_claim_id");
    check(text(claim.statement) && text(claim.scope), "invalid_bundle_claim_text");
    check(["fact", "inference", "proposal"].includes(String(claim.kind)), "invalid_bundle_claim_kind");
    check(refs(claim.support) && refs(claim.counter), "invalid_bundle_claim_references");
    check(Array.isArray(claim.unresolved) && claim.unresolved.every(text), "invalid_bundle_claim_unresolved");
    claimIds.add(claim.id);
    check([...claim.support, ...claim.counter].every((ref) => read.has(key(ref))), "bundle_claim_evidence_not_read");
    check(claim.kind === "proposal" || claim.support.length > 0 || claim.unresolved.length > 0, "unsupported_bundle_claim");
  }
  for (const lead of value.unresolvedLeads) {
    check(isRecord(lead) && exact(lead, ["question", "material", "reason"]) && text(lead.question) &&
      typeof lead.material === "boolean" && text(lead.reason), "invalid_bundle_lead");
  }
  check(value.status !== "sufficient" || !value.unresolvedLeads.some((lead) => lead.material), "bundle_material_unknown_unresolved");
  check(value.status !== "material_unknown" || value.unresolvedLeads.some((lead) => lead.material), "bundle_material_unknown_missing");
  check(objectVersion(value) === value.version, "object_version_mismatch");
  return value as EvidenceBundle;
}

export type EvidenceBundleBinding = {
  bundleRef: VersionedRef; requestId: string; revision: string; generationId: string;
};

/** Reload persisted originals under the caller's current policy and historical cutoff. */
export async function loadEvidenceBundle(resolver: EpisodeEvidenceResolver, binding: EvidenceBundleBinding) {
  const reader = resolver.reader;
  const bundle = parseEvidenceBundle(await reader.read(binding.bundleRef, "bundles"));
  check(bundle.requestId === binding.requestId && bundle.revision === binding.revision &&
    bundle.generationId === binding.generationId, "bundle_context_mismatch");
  if (bundle.generationId !== reader.catalog.generationId) {
    const originalCatalog = await reader.catalogAtRevision(bundle.revision);
    check(originalCatalog.generationId === bundle.generationId, "bundle_context_mismatch");
    const groups = ["sources", "evidence", "policies", "understandings", "works", "changes", "bundles", "coverage"] as const;
    const historical = new Map(groups.flatMap((group) => originalCatalog[group].map((entry) => [key(entry), { group, entry }] as const)));
    const visited = new Set<string>();
    const verifyHistoricalRef = (ref: VersionedRef): void => {
      if (visited.has(key(ref))) return;
      visited.add(key(ref));
      const original = historical.get(key(ref));
      check(original?.entry.status === "current", "bundle_historical_reference_mismatch");
      const current = reader.entry(ref, original.group);
      check(canonicalJson(original.entry.dependencies) === canonicalJson(current.dependencies) &&
        canonicalJson(original.entry.metadataRef ?? null) === canonicalJson(current.metadataRef ?? null), "bundle_historical_reference_mismatch");
      for (const dependency of [...original.entry.dependencies, ...(original.entry.metadataRef ? [original.entry.metadataRef] : [])]) verifyHistoricalRef(dependency);
    };
    for (const ref of [...bundle.readEvidenceRefs, ...bundle.searchedCoverageRefs]) verifyHistoricalRef(ref);
  }
  const dependencies = new Set(reader.entry(binding.bundleRef, "bundles").dependencies.map(key));
  check([...bundle.readEvidenceRefs, ...bundle.searchedCoverageRefs].every((ref) => dependencies.has(key(ref))), "undeclared_object_dependency");
  const coverage = [];
  for (const ref of bundle.searchedCoverageRefs) {
    const record = await reader.read(ref, "coverage");
    check(record.schemaVersion === "stella.archive-coverage/v1", "invalid_archive_coverage");
    coverage.push(record);
  }
  const originalEvidence = [];
  for (const ref of bundle.readEvidenceRefs) originalEvidence.push(await resolver.readEvidence(ref));
  await reader.assertCurrent();
  return { bundle, coverage, originalEvidence, validatedGenerationId: reader.catalog.generationId };
}
