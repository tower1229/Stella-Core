import { CatalogError, readRepositoryBytes, selectTextEvidence, validMemoryRef, type CatalogGroup } from "./catalog-reader.js";
import { sourceSegments } from "./source-segments.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import { stableId, type ArchiveObject } from "./host-input-archive.js";
import type { VersionedRef } from "./ref.js";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "./native-memory-origin.js";
import { isRecord } from "../shared/type-guards.js";

export const REPOSITORY_SOURCE_ADAPTER = "stella-repository-file/v1";

/** Write-free import of an explicitly selected original file. No authorship is inferred. */
export async function prepareRepositorySource(input: {
  root: string; collectionId: string; sourceId: string; relativePath: string;
  expectedSha256: string; capturedAt: string; policyRef: VersionedRef; objectRoot: string;
  reviewedSegments?: Array<{ start: number; end: number; policyRef: VersionedRef }>;
  nativeMemory?: NativeMemoryOrigin;
}): Promise<{ sourceRef: VersionedRef; evidenceRefs: VersionedRef[]; objects: ArchiveObject[] }> {
  input = structuredClone(input);
  if (!input.collectionId || !input.sourceId || !validMemoryRef(input.policyRef) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.expectedSha256) || !Number.isFinite(Date.parse(input.capturedAt)) ||
    !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input.capturedAt) ||
    [input.objectRoot, input.relativePath].some((value) => !value || value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":")))) {
    throw new CatalogError("invalid_repository_source_import");
  }
  let bytes: Buffer;
  try { bytes = await readRepositoryBytes(input.root, input.relativePath); }
  catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("repository_source_unavailable");
  }
  if (bytesVersion(bytes) !== input.expectedSha256) throw new CatalogError("repository_source_changed");
  // Binary attachments need their own media adapter; never decode them lossily as evidence.
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CatalogError("repository_source_media_adapter_required"); }
  const objects: ArchiveObject[] = [];
  const add = (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[]): VersionedRef => {
    const ref = { id: String(object.id), version: objectVersion(object) };
    const versioned = { ...object, version: ref.version };
    const serialized = canonicalJson(versioned);
    objects.push({ group, ref, object: versioned, bytes: serialized, entry: { ...ref, status: "current", dependencies,
      locator: { path: `${input.objectRoot}/${encodeURIComponent(ref.id)}/${ref.version.slice(7)}.json`, sha256: bytesVersion(serialized) } } });
    return ref;
  };
  const identity = canonicalJson([REPOSITORY_SOURCE_ADAPTER, input.collectionId, input.sourceId]);
  const coverageRef = add("coverage", { schemaVersion: "stella.archive-coverage/v1", id: stableId("coverage", identity),
    adapterId: REPOSITORY_SOURCE_ADAPTER, collectionId: input.collectionId,
    scope: { agentIds: [], roots: [input.relativePath], branchPolicy: "declared_subset", declaredBranches: [input.sourceId] },
    upstreamSnapshot: input.expectedSha256, fromCursor: null, toCursor: input.expectedSha256,
    expectedCount: 1, retainedCount: 1, excludedByPolicyCount: 0, missingItems: [],
    checkedAt: input.capturedAt, completeForDeclaredScope: true }, []);
  const sourceObject = { schemaVersion: input.reviewedSegments ? "stella.memory-source/v2" : "stella.memory-source/v1", id: stableId("source", identity),
    origin: { adapterId: REPOSITORY_SOURCE_ADAPTER, collectionId: input.collectionId, upstreamId: input.sourceId },
    payloads: [{ path: input.relativePath, mediaType: "text/plain", bytes: bytes.length, sha256: input.expectedSha256 }],
    capturedAt: input.capturedAt, policyRef: input.policyRef, coverageRef,
    ...(input.nativeMemory !== undefined ? { nativeMemory: parseNativeMemoryOrigin(input.nativeMemory) } : {}),
    ...(input.reviewedSegments ? { accessSegments: input.reviewedSegments.map(segment => ({ ...structuredClone(segment), payloadSha256: input.expectedSha256 })) } : {}) };
  const segments = sourceSegments(sourceObject);
  // Validate every boundary, including a segment that a later request will deny.
  for (const segment of segments) selectTextEvidence(bytes, { kind: "utf8_bytes", value: `${segment.start}:${segment.end}` });
  const dependencies = [input.policyRef, coverageRef, ...segments.map(segment => segment.policyRef)];
  const sourceRef = add("sources", sourceObject, [...new Map(dependencies.map(ref => [canonicalJson(ref), ref])).values()]);
  const slices = input.reviewedSegments ? segments : text.trim() ? [{ start: 0, end: bytes.length, policyRef: input.policyRef }] : [];
  const evidenceRefs = slices.map(segment => add("evidence", {
    schemaVersion: "stella.memory-evidence/v1", id: stableId("evidence", `${identity}:${input.reviewedSegments ? `segment:${segment.start}:${segment.end}` : "unclassified-payload"}`), source: sourceRef,
    payloadSha256: input.expectedSha256, selector: { kind: "utf8_bytes", value: `${segment.start}:${segment.end}` }, speakerId: null,
    role: "unknown", kind: "unknown", occurredAt: null, authoredAt: null, capturedAt: input.capturedAt,
    independentOriginId: sourceRef.id, derivedFrom: [], policyRef: segment.policyRef,
  }, [sourceRef, segment.policyRef]));
  // The original bytes stay in place; a later writer must revalidate this digest before committing.
  return { sourceRef, evidenceRefs, objects };
}

type RepositorySourceInput = Parameters<typeof prepareRepositorySource>[0];
export type MigratedRepositorySourceInput = Omit<RepositorySourceInput, "relativePath" | "expectedSha256" | "nativeMemory" | "reviewedSegments"> & {
  /** An inactive MIG02 document receipt, not its aggregate manifest/mapping. */
  receipt: unknown;
  /** Original producer baseline, distinct from the later runtime export commit. */
  sourceRevision: string;
  /** Explicit selected retained original; never select normalized prose by filename. */
  originalPath: string;
  reviewedSegments: NonNullable<RepositorySourceInput["reviewedSegments"]>;
};

/** Prepare objects only: no writes, commits, grant issuance or activation. The
 * producer owns the fixed input snapshot and later verifies/writes these objects;
 * ordinary-source-read independently pins the final committed runtime export.
 * Existing source_id is a record identifier, not proof of author identity. */
export async function prepareMigratedRepositorySource(input: MigratedRepositorySourceInput) {
  input = structuredClone(input);
  const receipt = input.receipt;
  const check: (ok: unknown, code: string) => asserts ok = (ok, code) => {
    if (!ok) throw new CatalogError(code);
  };
  check(isRecord(receipt) && receipt.schemaVersion === "canghai.evidence-migration-receipt/v1" &&
    receipt.disposition === "document_package_candidate" &&
    Array.isArray(receipt.reasons) && receipt.reasons.length === 0 &&
    receipt.sourceMetadataNotInferred === true && receipt.modelReadPermissionGranted === false &&
    receipt.activeCatalogChanged === false && receipt.semanticallyAdmitted === false,
  "migration_document_receipt_required");
  check(typeof input.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(input.sourceRevision) &&
    receipt.sourceRevision === input.sourceRevision, "migration_source_revision_mismatch");
  check(receipt.requiresSourceVersionReview === undefined || receipt.requiresSourceVersionReview === false,
    "migration_source_version_review_required");
  check(isRecord(receipt.identity) && receipt.identity.kind === "existing_source_id" &&
    typeof input.sourceId === "string" && input.sourceId.length > 0 &&
    receipt.identity.value === input.sourceId && receipt.requiresIdentityReview === false,
  "migration_stable_identity_required");
  check(Array.isArray(receipt.targetFiles) && receipt.targetFiles.every(p => typeof p === "string") &&
    new Set(receipt.targetFiles).size === receipt.targetFiles.length &&
    receipt.targetFiles.includes(input.originalPath), "migration_original_not_declared");
  check(typeof receipt.originSha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.originSha256) &&
    typeof receipt.normalizedSha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.normalizedSha256) &&
    typeof receipt.originBlob === "string" && /^[a-f0-9]{40}$/.test(receipt.originBlob) &&
    ["100644", "100755"].includes(String(receipt.originMode)) &&
    Number.isSafeInteger(receipt.originBytes) && Number(receipt.originBytes) > 0 &&
    Number(receipt.originBytes) <= 16 * 1024 * 1024, "migration_original_metadata_invalid");
  check(Array.isArray(input.reviewedSegments) && input.reviewedSegments.length > 0,
    "migration_reviewed_segments_required");
  const prepared = await prepareRepositorySource({ root: input.root, collectionId: input.collectionId,
    sourceId: input.sourceId, relativePath: input.originalPath, expectedSha256: `sha256:${receipt.originSha256}`,
    capturedAt: input.capturedAt, policyRef: input.policyRef, objectRoot: input.objectRoot,
    reviewedSegments: input.reviewedSegments });
  const source = prepared.objects.find(item => item.group === "sources")!.object;
  const payloads = source.payloads as Array<{ bytes: number }>;
  check(payloads[0]!.bytes === receipt.originBytes, "migration_original_size_mismatch");
  return { ...prepared, migration: { sourceRevision: input.sourceRevision, originBlob: receipt.originBlob,
    originalSha256: `sha256:${receipt.originSha256}`, originalBytes: receipt.originBytes,
    normalizationChangedBytes: receipt.originSha256 !== receipt.normalizedSha256,
    payloadRepresentation: "retained_original" as const, runtimeActivated: false as const,
    processingPermissionGranted: false as const } };
}
