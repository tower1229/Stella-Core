import path from "node:path";
import { CatalogError, readRepositoryBytes } from "./catalog-reader.js";
import { canonicalJson } from "./content-version.js";
import { isRecord } from "../shared/type-guards.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import type { IngestPorts, IngestRequest, IngestResult } from "./ingest.js";
import { MemoryTransactionError, readRecordedMemoryTransaction } from "./memory-transaction.js";

export type IngestCheckpoint = {
  schemaVersion: "stella.ingest-checkpoint/v1";
  resumeKey: string;
  adapterId: string;
  collectionId: string;
  upstreamSnapshot: string;
  operationId: string;
  fromCursor: string | null;
  cursor: string;
  coverageRef: VersionedRef;
};
const check: (value: unknown) => asserts value = (value) => {
  if (!value) throw new CatalogError("invalid_ingest_checkpoint");
};
export function checkpointPath(catalogPath: string, resumeKey: string): string {
  check(typeof resumeKey === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(resumeKey));
  return path.posix.join(path.posix.dirname(catalogPath), "operations", `${resumeKey}.ingest-checkpoint.json`);
}
export function parseIngestCheckpoint(value: unknown): IngestCheckpoint {
  check(isRecord(value) && value.schemaVersion === "stella.ingest-checkpoint/v1");
  for (const key of ["resumeKey", "adapterId", "collectionId", "upstreamSnapshot", "operationId", "cursor"]) {
    check(typeof value[key] === "string" && value[key].trim());
  }
  checkpointPath("catalog.json", String(value.resumeKey));
  check(/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(String(value.operationId)));
  check(value.fromCursor === null || typeof value.fromCursor === "string" && value.fromCursor.trim());
  check(value.fromCursor !== value.cursor && isRecord(value.coverageRef) &&
    typeof value.coverageRef.id === "string" && value.coverageRef.id.trim() &&
    typeof value.coverageRef.version === "string" && /^sha256:[a-f0-9]{64}$/.test(value.coverageRef.version));
  check(Object.keys(value).sort().join(",") ===
    "adapterId,collectionId,coverageRef,cursor,fromCursor,operationId,resumeKey,schemaVersion,upstreamSnapshot");
  check(Object.keys(value.coverageRef).sort().join(",") === "id,version");
  return value as IngestCheckpoint;
}

export async function loadCheckpoint(ports: IngestPorts, resumeKey: string): Promise<{ bytes: string; value: IngestCheckpoint } | null> {
  try {
    const bytes = (await readRepositoryBytes(ports.reader.root, checkpointPath(ports.reader.catalogPath, resumeKey))).toString("utf8");
    const value = parseIngestCheckpoint(JSON.parse(bytes));
    check(value.resumeKey === resumeKey);
    return { bytes, value };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Same memory transaction publishes archive and checkpoint; no cursor-only commit. */
export async function prepareCheckpoint(request: IngestRequest, result: Pick<IngestResult, "coverageRef">, ports: IngestPorts) {
  if (!request.resumeKey) return null;
  const coverage = request.coverage;
  check(coverage?.manifest && coverage.toCursor && coverage.fromCursor === request.cursor && result.coverageRef);
  const previous = await loadCheckpoint(ports, request.resumeKey);
  if (previous) {
    check(previous.value.adapterId === request.adapterId && previous.value.collectionId === request.collectionId &&
      previous.value.upstreamSnapshot === coverage.upstreamSnapshot && previous.value.cursor === request.cursor);
  } else check(request.cursor === null);
  const value: IngestCheckpoint = { schemaVersion: "stella.ingest-checkpoint/v1", resumeKey: request.resumeKey,
    adapterId: request.adapterId, collectionId: request.collectionId, upstreamSnapshot: coverage.upstreamSnapshot,
    operationId: request.operationId, fromCursor: request.cursor, cursor: coverage.toCursor, coverageRef: result.coverageRef };
  parseIngestCheckpoint(value);
  return { path: checkpointPath(ports.reader.catalogPath, request.resumeKey), before: previous?.bytes ?? null, after: canonicalJson(value) };
}

/** Reopens durable progress. A pending page always returns its input cursor and operation ID for replay. */
export async function resumeIngestCursor(resumeKey: string, ports: IngestPorts): Promise<{
  state: "new" | "pending" | "synchronized";
  cursor: string | null;
  operationId: string | null;
}> {
  const location = checkpointPath(ports.reader.catalogPath, resumeKey);
  try { await ports.reader.assertCurrent(); }
  catch (error) {
    if (!(error instanceof MemoryTransactionError) || error.category !== "memory_transaction_pending") throw error;
    const plan = await readRecordedMemoryTransaction(ports.reader.root);
    const change = plan.files.find(file => file.path === location);
    check(change);
    const checkpoint = parseIngestCheckpoint(JSON.parse(change.after));
    check(checkpoint.resumeKey === resumeKey && checkpoint.operationId === plan.operationId);
    return { state: "pending", cursor: checkpoint.fromCursor, operationId: checkpoint.operationId };
  }
  const stored = await loadCheckpoint(ports, resumeKey);
  if (!stored) return { state: "new", cursor: null, operationId: null };
  await ports.durability.confirmPreviouslyCommitted(checkpointPath(ports.reader.catalogPath, resumeKey));
  const diagnostics = await ports.durability.diagnostics();
  check(diagnostics.criticalSynchronized && diagnostics.localRevision === diagnostics.synchronizedRevision);
  await ports.reader.assertCurrent();
  return { state: "synchronized", cursor: stored.value.cursor, operationId: stored.value.operationId };
}
