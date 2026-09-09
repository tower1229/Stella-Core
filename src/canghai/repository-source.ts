import { CatalogError, readRepositoryBytes, selectTextEvidence, validMemoryRef, type CatalogGroup } from "./catalog-reader.js";
import { sourceSegments } from "./source-segments.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import { stableId, type ArchiveObject } from "./host-input-archive.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

export const REPOSITORY_SOURCE_ADAPTER = "stella-repository-file/v1";

/** Write-free import of an explicitly selected original file. No authorship is inferred. */
export async function prepareRepositorySource(input: {
  root: string; collectionId: string; sourceId: string; relativePath: string;
  expectedSha256: string; capturedAt: string; policyRef: VersionedRef; objectRoot: string;
  reviewedSegments?: Array<{ start: number; end: number; policyRef: VersionedRef }>;
}): Promise<{ sourceRef: VersionedRef; evidenceRefs: VersionedRef[]; objects: ArchiveObject[] }> {
  input = structuredClone(input);
  if (!input.collectionId || !input.sourceId || !validMemoryRef(input.policyRef) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.expectedSha256) || !Number.isFinite(Date.parse(input.capturedAt)) ||
    !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input.capturedAt) ||
    [input.objectRoot, input.relativePath].some((value) => !value || value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":")))) {
    throw new CatalogError("invalid_repository_source_import");
  }
  const bytes = await readRepositoryBytes(input.root, input.relativePath);
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
