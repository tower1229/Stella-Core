import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CatalogError, type CatalogReader } from "./catalog-reader.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { parseArchiveManifest } from "./archive-integrity.js";
import { checkpointPath, loadCheckpoint, resumeIngestCursor } from "./ingest-progress.js";
import { isLiveMemoryMutationDirt, withMemoryMutationLock } from "./memory-transaction.js";
import { isRecord } from "../shared/type-guards.js";
import type { IngestPorts } from "./ingest.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

const run = promisify(execFile);

const check: (value: unknown, category: string) => asserts value = (value, category) => {
  if (!value) throw new CatalogError(category);
};
export type ArchiveCleanupRequest = {
  operationId: string;
  adapterId: string;
  collectionId: string;
  upstreamSnapshot: string;
  eventIds: string[];
  coverageRef: VersionedRef;
  archiveRevision: string;
};
/** Host must compare the snapshot, release only these IDs, and deduplicate operationId. */
export type ArchiveCleanupPort = {
  releaseArchived(request: ArchiveCleanupRequest): Promise<{ state: "released"; operationId: string; upstreamSnapshot: string; eventIds: string[] }>;
};

/** Re-read every original through the ordinary repository reader, also usable on an isolated clone. */
export async function verifyArchiveCoverage(reader: CatalogReader, coverageRef: VersionedRef): Promise<{ eventIds: string[] }> {
  const coverage = await reader.read(coverageRef, "coverage");
  const manifest = parseArchiveManifest(coverage.manifest);
  check(coverage.completeForDeclaredScope === true && Array.isArray(coverage.missingItems) && coverage.missingItems.length === 0 &&
    coverage.expectedCount === manifest.items.length && coverage.retainedCount === manifest.items.length &&
    coverage.excludedByPolicyCount === 0, "archive_incomplete");
  const sources = reader.catalog.sources.filter(entry => entry.status === "current" && entry.dependencies.some(ref =>
    ref.id === coverageRef.id && ref.version === coverageRef.version));
  check(sources.length === manifest.items.length, "archive_manifest_mismatch");
  const seen = new Set<string>();
  for (const ref of sources) {
    const source = await reader.read(ref, "sources");
    check(isRecord(source.origin) && source.origin.adapterId === coverage.adapterId &&
      source.origin.collectionId === coverage.collectionId && typeof source.origin.upstreamId === "string", "archive_manifest_mismatch");
    const upstreamId = source.origin.upstreamId;
    const expected = manifest.items.find(item => item.upstreamId === upstreamId);
    check(expected && !seen.has(expected.upstreamId), "archive_manifest_mismatch");
    seen.add(expected.upstreamId);
    check(isRecord(source.policyRef) && typeof source.policyRef.id === "string" && typeof source.policyRef.version === "string",
      "invalid_source");
    const policy = await reader.read({ id: source.policyRef.id, version: source.policyRef.version }, "policies");
    check(policy.retention === "retain", "archive_retention_changed");
    check(Array.isArray(source.payloads) && source.payloads.length > 0, "invalid_source");
    const payloads = new Map<string, Buffer>();
    for (const payload of source.payloads) {
      check(isRecord(payload) && typeof payload.sha256 === "string", "invalid_source");
      payloads.set(payload.sha256, (await reader.readPayload(ref, payload.sha256)).bytes);
    }
    const first = source.payloads[0];
    check(isRecord(first) && typeof first.sha256 === "string" && first.mediaType === "application/json", "invalid_source");
    const body: unknown = JSON.parse(payloads.get(first.sha256)!.toString("utf8"));
    check(isRecord(body), "invalid_source");
    const text = typeof body.text === "string" ? body.text : isRecord(body.request) ? body.request.prompt : null;
    check(typeof text === "string" && expected.textSha256 !== null && bytesVersion(text) === expected.textSha256,
      "archive_manifest_mismatch");
    const attachments = body.attachments ?? [];
    check(Array.isArray(attachments) && attachments.length === expected.attachments.length, "archive_manifest_mismatch");
    for (const declaration of expected.attachments) {
      const attachment = attachments.find(value => isRecord(value) && value.upstreamId === declaration.upstreamId);
      check(isRecord(attachment) && typeof attachment.sha256 === "string" && payloads.has(attachment.sha256) &&
        (declaration.sha256 === null || declaration.sha256 === attachment.sha256), "archive_manifest_mismatch");
    }
  }
  await reader.assertCurrent();
  return { eventIds: manifest.items.map(item => item.upstreamId) };
}

/** Fail closed without a Host cleanup adapter; no global cleanup acknowledgement or implicit activation. */
export async function coordinateArchiveCleanup(input: {
  resumeKey: string; expectedCursor: string; upstreamSnapshot: string;
}, ports: IngestPorts & { cleanup?: ArchiveCleanupPort }): Promise<ArchiveCleanupRequest> {
  check(ports.cleanup, "host_cleanup_coordination_unavailable");
  return withMemoryMutationLock(ports.reader.root, async () => {
    check(!ports.signal?.aborted, "archive_cleanup_cancelled");
    const progress = await resumeIngestCursor(input.resumeKey, ports);
    check(progress.state === "synchronized", "archive_sync_pending");
    const stored = await loadCheckpoint(ports, input.resumeKey);
    check(stored && stored.value.cursor === input.expectedCursor && stored.value.upstreamSnapshot === input.upstreamSnapshot,
      "archive_cleanup_stale");
    const coverage = await ports.reader.read(stored.value.coverageRef, "coverage");
    check(coverage.adapterId === stored.value.adapterId && coverage.collectionId === stored.value.collectionId &&
      coverage.upstreamSnapshot === stored.value.upstreamSnapshot && coverage.toCursor === stored.value.cursor &&
      coverage.fromCursor === stored.value.fromCursor, "archive_cleanup_stale");
    const { eventIds } = await verifyArchiveCoverage(ports.reader, stored.value.coverageRef);
    await ports.durability.confirmPreviouslyCommitted(checkpointPath(ports.reader.catalogPath, input.resumeKey));
    const diagnostics = await ports.durability.diagnostics();
    check(diagnostics.criticalSynchronized && diagnostics.localRevision === diagnostics.synchronizedRevision, "archive_sync_pending");
    await ports.reader.assertCurrent();
    const { stdout: status } = await run("git", ["-C", ports.reader.root, "status", "--porcelain", "--untracked-files=all"]);
    check(status.trim() === "" || isLiveMemoryMutationDirt(status.trim()), "archive_not_committed");
    const { stdout: revision } = await run("git", ["-C", ports.reader.root, "rev-parse", "HEAD"]);
    check(revision.trim() === diagnostics.synchronizedRevision, "archive_sync_pending");
    check(!ports.signal?.aborted, "archive_cleanup_cancelled");
    const request: ArchiveCleanupRequest = { operationId: stored.value.operationId,
      adapterId: stored.value.adapterId, collectionId: stored.value.collectionId,
      upstreamSnapshot: stored.value.upstreamSnapshot, eventIds, coverageRef: stored.value.coverageRef,
      archiveRevision: diagnostics.localRevision };
    let receipt: Awaited<ReturnType<ArchiveCleanupPort["releaseArchived"]>>;
    try { receipt = await ports.cleanup!.releaseArchived(structuredClone(request)); }
    catch { throw new CatalogError("host_cleanup_result_unknown"); }
    check(receipt?.state === "released" && receipt.operationId === request.operationId &&
      receipt.upstreamSnapshot === request.upstreamSnapshot && canonicalJson(receipt.eventIds) === canonicalJson(eventIds),
    "host_cleanup_receipt_invalid");
    return request;
  });
}
