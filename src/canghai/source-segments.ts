import { CatalogError, validMemoryRef } from "./catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

export type SourceSegment = { payloadSha256: string; start: number; end: number; policyRef: VersionedRef };
function check(value: unknown, category = "invalid_source_segments"): asserts value {
  if (!value) throw new CatalogError(category);
}

/** Segmentation is supplied by a semantic review. This validates coverage and
 * exact policy bindings; it never classifies private text or chooses a boundary. */
export function sourceSegments(source: Record<string, unknown>): SourceSegment[] {
  if (source.schemaVersion === "stella.memory-source/v1") {
    check(source.accessSegments === undefined, "source_segmentation_migration_required");
    return [];
  }
  check(source.schemaVersion === "stella.memory-source/v2" && Array.isArray(source.payloads) && source.payloads.length > 0 &&
    Array.isArray(source.accessSegments) && source.accessSegments.length > 0 && source.accessSegments.length <= 512);
  const segments: SourceSegment[] = [];
  const sizes = new Map<string, number>();
  for (const payload of source.payloads) {
    check(isRecord(payload) && typeof payload.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(payload.sha256) &&
      !sizes.has(payload.sha256) && Number.isSafeInteger(payload.bytes) && Number(payload.bytes) > 0 &&
      typeof payload.mediaType === "string" && (payload.mediaType.startsWith("text/") || payload.mediaType === "application/json"));
    sizes.set(payload.sha256, Number(payload.bytes));
  }
  const cursors = new Map<string, number>();
  for (const value of source.accessSegments) {
    check(isRecord(value) && Object.keys(value).sort().join() === "end,payloadSha256,policyRef,start" &&
      typeof value.payloadSha256 === "string" && sizes.has(value.payloadSha256) &&
      Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && Number(value.start) < Number(value.end) &&
      Number(value.end) <= sizes.get(value.payloadSha256)! && Number(value.start) === (cursors.get(value.payloadSha256) ?? 0) &&
      validMemoryRef(value.policyRef) && Object.keys(value.policyRef).sort().join() === "id,version");
    cursors.set(value.payloadSha256, Number(value.end));
    segments.push(structuredClone(value) as SourceSegment);
  }
  check([...sizes].every(([sha, size]) => cursors.get(sha) === size), "source_segment_coverage_incomplete");
  return segments;
}

export function assertEvidenceSegment(segments: SourceSegment[], evidence: Record<string, unknown>): void {
  if (!segments.length) return;
  check(isRecord(evidence.selector) && Object.keys(evidence.selector).sort().join() === "kind,value" &&
    evidence.selector.kind === "utf8_bytes" && typeof evidence.selector.value === "string" &&
    /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(evidence.selector.value), "evidence_segment_required");
  const [start, end] = evidence.selector.value.split(":").map(Number);
  check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start! < end! && validMemoryRef(evidence.policyRef), "evidence_segment_required");
  const policyRef = evidence.policyRef;
  check(segments.some(segment => segment.payloadSha256 === evidence.payloadSha256 && start! >= segment.start && end! <= segment.end &&
    segment.policyRef.id === policyRef.id && segment.policyRef.version === policyRef.version), "evidence_segment_policy_mismatch");
}
