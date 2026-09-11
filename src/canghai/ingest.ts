import path from "node:path";
import { readFile } from "node:fs/promises";
import type { VersionedRef } from "../praxis/episode-v2.js";
import type { HostInputSnapshot } from "../openclaw/host-input.js";
import { isRecord } from "../shared/type-guards.js";
import {
  CatalogError,
  CatalogReader,
  parseMemoryCatalog,
  type CatalogEntry,
  type CatalogGroup,
  type MemoryCatalog,
} from "./catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import type { CangHaiDurabilityDiagnostics } from "./durability.js";
import { HOST_INPUT_ARCHIVE_ADAPTER, stableId, type ArchiveObject, type HostInputArchive } from "./host-input-archive.js";
import { afterDurablePersistPublishView } from "./managed-durable-write.js";
import {
  applyMemoryTransaction,
  readRecordedMemoryTransaction,
  MemoryTransactionError,
  type MemoryTransactionPlan,
} from "./memory-transaction.js";
import { parseSourcePolicy } from "./source-policy.js";

export const EXPLICIT_RECORD_ADAPTER = "stella-explicit-record/v1";

export type IngestPhase =
  | "received"
  | "staged"
  | "validated"
  | "local_committed"
  | "synchronized"
  | "failed";

export type HostRetentionGuarantees = {
  transcript: boolean;
  staging: boolean;
  backup: boolean;
};

export type IngestItem = {
  upstreamId: string;
  role: "owner" | "assistant" | "other" | "unknown";
  speakerId: string | null;
  kind: "reported" | "unknown";
  text: string;
  capturedAt: string;
  occurredAt: string | null;
  authoredAt: string | null;
  parentUpstreamId: string | null;
  /** Opaque provenance envelope (Host event tree, etc.); never required for explicit records. */
  envelope?: Record<string, unknown>;
};

export type IngestRequest = {
  operationId: string;
  expectedRevision: string;
  adapterId: string;
  collectionId: string;
  cursor: string | null;
  policyRef: VersionedRef;
  items: IngestItem[];
  purpose: { readPurpose: string; derivePurpose: string; deliveryScope: string };
};

export type IngestDurabilityPort = {
  syncCritical(paths: string[], message: string): Promise<unknown>;
  confirmPreviouslyCommitted(path: string): Promise<void>;
  diagnostics(): Promise<CangHaiDurabilityDiagnostics>;
};

export type IngestPorts = {
  reader: CatalogReader;
  durability: IngestDurabilityPort;
  retentionGuarantees: HostRetentionGuarantees;
  objectRoot: string;
  payloadRoot: string;
  onPhase?: (phase: IngestPhase) => void | Promise<void>;
  signal?: AbortSignal;
};

export type IngestResult = {
  operationId: string;
  state: IngestPhase;
  sourceRefs: VersionedRef[];
  coverageRef: VersionedRef | null;
  durability: {
    localRevision: string;
    synchronizedRevision?: string;
    rpoStatus: "current" | "pending" | "breached";
  };
};

export class IngestError extends Error {
  constructor(readonly category: string, options?: ErrorOptions) {
    super(`Memory ingest failed: ${category}`, options);
    this.name = "IngestError";
  }
}

type MemoryOperation = {
  schemaVersion: "stella.memory-operation/v1";
  id: string;
  kind: "ingest";
  inputDigest: string;
  expectedRevision: string;
  expectedGenerationId: string | null;
  targetRefs: VersionedRef[];
  createdAt: string;
  retention: "retain" | "do_not_retain";
  adapterId: string;
  collectionId: string;
  coverageRef: VersionedRef | null;
  sourceRefs: VersionedRef[];
  resultState: "synchronized";
};

const check: (value: unknown, category: string) => asserts value = (value, category) => {
  if (!value) throw new IngestError(category);
};

function validRef(value: unknown): value is VersionedRef {
  return isRecord(value) && typeof value.id === "string" && Boolean(value.id) &&
    typeof value.version === "string" && /^sha256:[a-f0-9]{64}$/.test(value.version);
}

function parseMemoryOperation(value: unknown): MemoryOperation {
  check(isRecord(value), "invalid_record");
  check(value.schemaVersion === "stella.memory-operation/v1" && value.kind === "ingest" &&
    typeof value.id === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(value.id), "invalid_record");
  check(typeof value.inputDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.inputDigest), "invalid_record");
  check(typeof value.expectedRevision === "string" && /^[0-9a-f]{40}$/i.test(value.expectedRevision), "invalid_record");
  check(value.expectedGenerationId === null || typeof value.expectedGenerationId === "string" && value.expectedGenerationId,
    "invalid_record");
  check(Array.isArray(value.targetRefs) && value.targetRefs.every(validRef), "invalid_record");
  check(typeof value.createdAt === "string" && value.createdAt, "invalid_record");
  check(value.retention === "retain" || value.retention === "do_not_retain", "invalid_record");
  check(typeof value.adapterId === "string" && value.adapterId && typeof value.collectionId === "string" && value.collectionId,
    "invalid_record");
  check(value.coverageRef === null || validRef(value.coverageRef), "invalid_record");
  check(Array.isArray(value.sourceRefs) && value.sourceRefs.every(validRef), "invalid_record");
  check(value.resultState === "synchronized", "invalid_record");
  check(value.retention === "do_not_retain"
    ? value.sourceRefs.length === 0 && value.coverageRef === null && value.targetRefs.length === 0
    : value.sourceRefs.length > 0,
  "invalid_record");
  return {
    schemaVersion: "stella.memory-operation/v1",
    id: value.id,
    kind: "ingest",
    inputDigest: value.inputDigest,
    expectedRevision: value.expectedRevision,
    expectedGenerationId: value.expectedGenerationId,
    targetRefs: value.targetRefs.map((ref) => ({ id: ref.id, version: ref.version })),
    createdAt: value.createdAt,
    retention: value.retention,
    adapterId: value.adapterId,
    collectionId: value.collectionId,
    coverageRef: value.coverageRef === null ? null : { id: value.coverageRef.id, version: value.coverageRef.version },
    sourceRefs: value.sourceRefs.map((ref) => ({ id: ref.id, version: ref.version })),
    resultState: "synchronized",
  };
}

function relative(value: string): string {
  const result = value.replaceAll("\\", "/");
  check(result && !result.split("/").some((part) =>
    !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":")),
  "unsafe_archive_locator");
  return result;
}

/** Host transcript event → ingest items. Role/source stay on the item; model text cannot enter as owner evidence. */
export function prepareHostMessageItems(
  snapshot: HostInputSnapshot,
  speaker: { id: string | null; role: IngestItem["role"] },
): IngestItem[] {
  check(snapshot.schemaVersion === "stella.host-input-snapshot/v1" && snapshot.hostVersion === "2026.8.2",
    "invalid_input");
  check(snapshot.entryId && snapshot.sessionId && snapshot.text.trim(), "invalid_input");
  check(isRecord(snapshot.event) && snapshot.event.id === snapshot.entryId, "invalid_input");
  check(typeof snapshot.event.timestamp === "string" &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(snapshot.event.timestamp) &&
    Number.isFinite(Date.parse(snapshot.event.timestamp)), "invalid_input");
  check(["owner", "assistant", "other", "unknown"].includes(speaker.role), "invalid_input");
  check(speaker.role !== "owner" || Boolean(speaker.id), "invalid_input");
  const message = isRecord(snapshot.event.message) ? snapshot.event.message : null;
  check(message && message.role === "user", "invalid_input");
  return [{
    upstreamId: snapshot.entryId,
    role: speaker.role,
    speakerId: speaker.id,
    kind: "reported",
    text: snapshot.text,
    capturedAt: snapshot.event.timestamp,
    occurredAt: null,
    authoredAt: null,
    parentUpstreamId: snapshot.parentId,
    envelope: {
      hostVersion: snapshot.hostVersion,
      agentId: snapshot.agentId,
      sessionId: snapshot.sessionId,
      sessionKey: snapshot.sessionKey,
      logicalTurnId: snapshot.logicalTurnId,
      generation: snapshot.generation,
      rawSeq: snapshot.rawSeq,
      event: snapshot.event,
    },
  }];
}

/**
 * Public Host-message entry: bind a captured Host snapshot into the unified ingest contract.
 * Exact Host / real_main wiring still supplies the snapshot and retentionGuarantees.
 */
export async function ingestHostMessage(input: {
  operationId: string;
  expectedRevision: string;
  snapshot: HostInputSnapshot;
  speaker: { id: string | null; role: IngestItem["role"] };
  policyRef: VersionedRef;
  purpose: IngestRequest["purpose"];
}, ports: IngestPorts): Promise<IngestResult> {
  return ingest({
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: input.snapshot.sessionId,
    cursor: input.snapshot.parentId,
    policyRef: input.policyRef,
    items: prepareHostMessageItems(input.snapshot, input.speaker),
    purpose: input.purpose,
  }, ports);
}

/**
 * Public explicit-record entry into the same ingest state machine as Host messages.
 */
export async function ingestExplicitRecord(input: {
  operationId: string;
  expectedRevision: string;
  collectionId: string;
  record: {
    upstreamId: string;
    text: string;
    role: IngestItem["role"];
    speakerId: string | null;
    capturedAt: string;
    parentUpstreamId?: string | null;
  };
  policyRef: VersionedRef;
  purpose: IngestRequest["purpose"];
}, ports: IngestPorts): Promise<IngestResult> {
  return ingest({
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    adapterId: EXPLICIT_RECORD_ADAPTER,
    collectionId: input.collectionId,
    cursor: input.record.parentUpstreamId ?? null,
    policyRef: input.policyRef,
    items: prepareExplicitRecordItems(input.record),
    purpose: input.purpose,
  }, ports);
}

/** Explicit skill/manual record → same ingest item shape as Host messages. */
export function prepareExplicitRecordItems(input: {
  upstreamId: string;
  text: string;
  role: IngestItem["role"];
  speakerId: string | null;
  capturedAt: string;
  parentUpstreamId?: string | null;
}): IngestItem[] {
  check(input.upstreamId.trim() && input.text.trim() && input.capturedAt.trim(), "invalid_input");
  check(["owner", "assistant", "other", "unknown"].includes(input.role), "invalid_input");
  check(input.role !== "owner" || Boolean(input.speakerId), "invalid_input");
  check(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input.capturedAt) && Number.isFinite(Date.parse(input.capturedAt)),
    "invalid_input");
  return [{
    upstreamId: input.upstreamId,
    role: input.role,
    speakerId: input.speakerId,
    kind: "reported",
    text: input.text,
    capturedAt: input.capturedAt,
    occurredAt: null,
    authoredAt: null,
    parentUpstreamId: input.parentUpstreamId ?? null,
  }];
}

/**
 * do_not_retain may be promised only when Host already guarantees non-retention on
 * transcript, staging and backup. Never write first and claim compliance later.
 */
export function assertRetentionAdmission(
  policyValue: unknown,
  guarantees: HostRetentionGuarantees,
): "retain" | "do_not_retain" {
  const policy = parseSourcePolicy(policyValue);
  if (policy.retention !== "do_not_retain") return "retain";
  check(guarantees.transcript && guarantees.staging && guarantees.backup, "retention_guarantee_unavailable");
  return "do_not_retain";
}

function inputDigest(request: IngestRequest): string {
  return bytesVersion(canonicalJson({
    adapterId: request.adapterId,
    collectionId: request.collectionId,
    cursor: request.cursor,
    policyRef: request.policyRef,
    items: request.items,
    purpose: request.purpose,
  }));
}

function operationPath(catalogPath: string, operationId: string): string {
  return path.posix.join(path.posix.dirname(catalogPath), "operations", `${operationId}.json`);
}

function transactionPath(catalogPath: string, operationId: string): string {
  return path.posix.join(path.posix.dirname(catalogPath), "operations", `${operationId}.transaction.json`);
}

async function readOptional(root: string, relative: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

type BuiltIngestArchive = HostInputArchive & {
  payloads: Array<{ path: string; bytes: string; sha256: string }>;
};

function buildArchive(request: IngestRequest, objectRoot: string, payloadRoot: string): BuiltIngestArchive {
  check(request.items.length > 0 && request.items.length <= 32, "invalid_input");
  const objects: ArchiveObject[] = [];
  const add = (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[]): VersionedRef => {
    const version = objectVersion(object);
    const ref = { id: String(object.id), version };
    const versioned = { ...object, version };
    const bytes = canonicalJson(versioned);
    const entry: CatalogEntry = {
      ...ref,
      locator: { path: `${objectRoot}/${ref.id}/${version.slice(7)}.json`, sha256: bytesVersion(bytes) },
      status: "current",
      dependencies,
    };
    objects.push({ group, ref, object: versioned, entry, bytes });
    return ref;
  };

  const sourceRefs: VersionedRef[] = [];
  const evidenceRefs: VersionedRef[] = [];
  const payloads: HostInputArchive["payload"][] = [];
  let coverageRef: VersionedRef | null = null;

  for (const item of request.items) {
    check(item.upstreamId.trim() && item.text.trim(), "invalid_input");
    check(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(item.capturedAt) && Number.isFinite(Date.parse(item.capturedAt)),
      "invalid_input");
    check(["owner", "assistant", "other", "unknown"].includes(item.role), "invalid_input");
    check(item.role !== "owner" || Boolean(item.speakerId), "invalid_input");

    const identity = canonicalJson([request.adapterId, request.collectionId, item.upstreamId]);
    const sourceId = stableId("source", identity);
    const coverageId = stableId("coverage", identity);
    const payloadBody = item.envelope
      ? { ...item.envelope, text: item.text, role: item.role, speakerId: item.speakerId }
      : {
        adapterId: request.adapterId,
        collectionId: request.collectionId,
        upstreamId: item.upstreamId,
        text: item.text,
        role: item.role,
        speakerId: item.speakerId,
        parentUpstreamId: item.parentUpstreamId,
      };
    const payloadBytes = canonicalJson(payloadBody);
    const payloadHash = bytesVersion(payloadBytes);
    const payload = {
      path: `${payloadRoot}/${sourceId}/${payloadHash.slice(7)}.json`,
      bytes: payloadBytes,
      sha256: payloadHash,
    };
    payloads.push(payload);

    const agentId = request.adapterId === HOST_INPUT_ARCHIVE_ADAPTER && isRecord(item.envelope)
      ? item.envelope.agentId
      : null;
    check(request.adapterId !== HOST_INPUT_ARCHIVE_ADAPTER || typeof agentId === "string" && agentId.trim(),
      "invalid_input");

    coverageRef = add("coverage", {
      schemaVersion: "stella.archive-coverage/v1",
      id: coverageId,
      adapterId: request.adapterId,
      collectionId: request.collectionId,
      scope: {
        agentIds: typeof agentId === "string" ? [agentId] : [],
        roots: [],
        branchPolicy: "declared_subset",
        declaredBranches: [item.upstreamId],
      },
      upstreamSnapshot: bytesVersion(canonicalJson({ upstreamId: item.upstreamId, text: item.text })),
      fromCursor: request.cursor,
      toCursor: item.upstreamId,
      expectedCount: 1,
      retainedCount: 1,
      excludedByPolicyCount: 0,
      missingItems: [],
      checkedAt: item.capturedAt,
      completeForDeclaredScope: true,
    }, []);

    const sourceRef = add("sources", {
      schemaVersion: "stella.memory-source/v1",
      id: sourceId,
      origin: {
        adapterId: request.adapterId,
        collectionId: request.collectionId,
        upstreamId: item.upstreamId,
      },
      payloads: [{
        path: payload.path,
        mediaType: "application/json",
        bytes: Buffer.byteLength(payloadBytes),
        sha256: payloadHash,
      }],
      capturedAt: item.capturedAt,
      policyRef: request.policyRef,
      coverageRef,
    }, [request.policyRef, coverageRef]);
    sourceRefs.push(sourceRef);

    evidenceRefs.push(add("evidence", {
      schemaVersion: "stella.memory-evidence/v1",
      id: stableId("evidence", identity),
      source: sourceRef,
      payloadSha256: payloadHash,
      selector: { kind: "json_pointer", value: "/text" },
      speakerId: item.speakerId,
      role: item.role,
      kind: item.kind,
      occurredAt: item.occurredAt,
      authoredAt: item.authoredAt,
      capturedAt: item.capturedAt,
      independentOriginId: sourceId,
      derivedFrom: [],
      policyRef: request.policyRef,
    }, [sourceRef, request.policyRef]));
  }

  check(coverageRef && payloads.length > 0 && sourceRefs.length > 0 && evidenceRefs.length > 0, "invalid_input");
  return {
    sourceRef: sourceRefs[0]!,
    evidenceRefs,
    coverageRef: coverageRef!,
    payload: payloads[0]!,
    objects,
    payloads,
  };
}

function applyArchiveToCatalog(
  before: MemoryCatalog,
  archive: HostInputArchive,
  operationId: string,
  inputHash: string,
): MemoryCatalog {
  const after: MemoryCatalog = JSON.parse(canonicalJson(before));
  for (const object of archive.objects) {
    const entries = after[object.group];
    const existingExact = entries.find((entry) => entry.id === object.ref.id && entry.version === object.ref.version);
    if (existingExact) {
      check(canonicalJson(existingExact) === canonicalJson(object.entry), "archive_catalog_conflict");
      continue;
    }
    const current = entries.find((entry) => entry.id === object.ref.id && entry.status === "current");
    if (current) current.status = "superseded";
    else check(!entries.some((entry) => entry.id === object.ref.id), "archive_catalog_conflict");
    entries.push(object.entry);
  }
  after.parentGenerationId = before.generationId;
  after.generationId = `generation_${bytesVersion(`${bytesVersion(canonicalJson(before))}:${inputHash}:${operationId}`).slice(7)}`;
  return parseMemoryCatalog(after);
}

async function emit(ports: IngestPorts, phase: IngestPhase, observed: IngestPhase[]): Promise<void> {
  observed.push(phase);
  await ports.onPhase?.(phase);
}

function resultFromOperation(
  operation: MemoryOperation,
  diagnostics: CangHaiDurabilityDiagnostics,
): IngestResult {
  return {
    operationId: operation.id,
    state: operation.resultState,
    sourceRefs: operation.sourceRefs,
    coverageRef: operation.coverageRef,
    durability: {
      localRevision: diagnostics.localRevision,
      ...(diagnostics.synchronizedRevision ? { synchronizedRevision: diagnostics.synchronizedRevision } : {}),
      rpoStatus: diagnostics.normalState,
    },
  };
}

/**
 * Unified Memory Lifecycle ingest: Host messages and explicit records share one state machine.
 * Retries with the same operationId and input digest do not create independent evidence.
 */
export async function ingest(request: IngestRequest, ports: IngestPorts): Promise<IngestResult> {
  const observed: IngestPhase[] = [];
  try {
    check(/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(request.operationId), "invalid_input");
    check(request.adapterId.trim() && request.collectionId.trim(), "invalid_input");
    check(/^[0-9a-f]{40}$/i.test(request.expectedRevision), "invalid_input");
    check(Array.isArray(request.items) && request.items.length > 0, "invalid_input");
    relative(ports.objectRoot);
    relative(ports.payloadRoot);
    await emit(ports, "received", observed);

    const reader = ports.reader;
    const policy = await reader.read(request.policyRef, "policies");
    const retention = assertRetentionAdmission(policy, ports.retentionGuarantees);
    check(Array.isArray(policy.readPurposes) && policy.readPurposes.includes(request.purpose.readPurpose) &&
      Array.isArray(policy.derivePurposes) && policy.derivePurposes.includes(request.purpose.derivePurpose) &&
      Array.isArray(policy.deliveryScopes) && policy.deliveryScopes.includes(request.purpose.deliveryScope),
    "permission_denied");

    const digest = inputDigest(request);
    const opRelative = operationPath(reader.catalogPath, request.operationId);
    const existingBytes = await readOptional(reader.root, opRelative);
    if (existingBytes !== null) {
      let existing: unknown;
      try { existing = JSON.parse(existingBytes); }
      catch { throw new IngestError("invalid_record"); }
      const operation = parseMemoryOperation(existing);
      check(operation.id === request.operationId, "invalid_record");
      check(operation.inputDigest === digest, "idempotency_conflict");
      await ports.durability.confirmPreviouslyCommitted(opRelative);
      await emit(ports, "staged", observed);
      await emit(ports, "validated", observed);
      await emit(ports, "local_committed", observed);
      await emit(ports, "synchronized", observed);
      return resultFromOperation(operation, await ports.durability.diagnostics());
    }

    const head = await ports.durability.diagnostics();
    check(head.localRevision.toLowerCase() === request.expectedRevision.toLowerCase(), "write_conflict");

    await emit(ports, "staged", observed);

    const catalogBytes = await readFile(path.join(reader.root, reader.catalogPath), "utf8");
    const before = parseMemoryCatalog(JSON.parse(catalogBytes));
    check(bytesVersion(catalogBytes) === reader.catalogHash ||
      bytesVersion(canonicalJson(before)) === reader.catalogHash, "stale_generation");

    let archive: BuiltIngestArchive | null = null;
    let after = before;
    const files: MemoryTransactionPlan["files"] = [];

    if (retention === "retain") {
      archive = buildArchive(request, relative(ports.objectRoot), relative(ports.payloadRoot));
      after = applyArchiveToCatalog(before, archive, request.operationId, digest);
      files.push(
        ...archive.payloads.map((payload) => ({ path: payload.path, before: null as string | null, after: payload.bytes })),
        ...archive.objects.map((object) => ({ path: object.entry.locator.path, before: null as string | null, after: object.bytes })),
      );
    } else {
      // Admitted do_not_retain: only content-free operation status may land on disk.
      after = parseMemoryCatalog({
        ...JSON.parse(canonicalJson(before)),
        parentGenerationId: before.generationId,
        generationId: `generation_${bytesVersion(`${reader.catalogHash}:${digest}:${request.operationId}`).slice(7)}`,
      });
    }

    const operation: MemoryOperation = {
      schemaVersion: "stella.memory-operation/v1",
      id: request.operationId,
      kind: "ingest",
      inputDigest: digest,
      expectedRevision: request.expectedRevision,
      expectedGenerationId: before.generationId,
      targetRefs: archive ? [archive.sourceRef, ...archive.evidenceRefs, archive.coverageRef] : [],
      createdAt: request.items[0]!.capturedAt,
      retention,
      adapterId: request.adapterId,
      collectionId: request.collectionId,
      coverageRef: archive?.coverageRef ?? null,
      sourceRefs: archive ? [...new Map(archive.objects.filter((o) => o.group === "sources").map((o) => [o.ref.id, o.ref])).values()] : [],
      resultState: "synchronized",
    };
    // Ensure operation bytes never carry private item text for do_not_retain.
    const operationBytes = canonicalJson(operation);
    check(retention === "retain" || !request.items.some((item) => operationBytes.includes(item.text)),
      "retention_payload_leak");

    files.push(
      { path: opRelative, before: null, after: operationBytes },
      { path: reader.catalogPath, before: catalogBytes, after: canonicalJson(after) },
    );

    await emit(ports, "validated", observed);

    const plan: MemoryTransactionPlan = {
      operationId: request.operationId,
      journalPath: transactionPath(reader.catalogPath, request.operationId),
      files,
    };

    let recorded;
    try {
      recorded = await readRecordedMemoryTransaction(reader.root, request.operationId, plan.journalPath);
    } catch (error) {
      const missingJournal = error instanceof Error && "code" in error && error.code === "ENOENT";
      const pendingMissing = error instanceof MemoryTransactionError && error.category === "pending_transaction_not_found";
      if (!missingJournal && !pendingMissing) {
        throw error instanceof IngestError ? error : new IngestError("persistence_failed", { cause: error });
      }
    }
    if (recorded) check(canonicalJson(recorded) === canonicalJson(plan), "idempotency_conflict");

    await applyMemoryTransaction(reader.root, plan, {
      async validate() {
        const current = await CatalogReader.load(reader.root, reader.catalogPath);
        check([bytesVersion(catalogBytes), bytesVersion(canonicalJson(after))].includes(current.catalogHash),
          "stale_generation");
        const livePolicy = await current.read(request.policyRef, "policies");
        assertRetentionAdmission(livePolicy, ports.retentionGuarantees);
        await current.assertCurrent();
      },
      persist: async (paths) => {
        await ports.durability.syncCritical(paths, `stella ingest ${request.operationId}`);
      },
      confirmPreviouslyCommitted: (file) => ports.durability.confirmPreviouslyCommitted(file),
      publishView: () => afterDurablePersistPublishView(reader.root),
    }, ports.signal);

    await emit(ports, "local_committed", observed);
    const diagnostics = await ports.durability.diagnostics();
    check(diagnostics.criticalSynchronized && diagnostics.localRevision === diagnostics.synchronizedRevision,
      "sync_failed");
    await emit(ports, "synchronized", observed);
    return resultFromOperation(operation, diagnostics);
  } catch (error) {
    if (observed[observed.length - 1] !== "failed") {
      try { await ports.onPhase?.("failed"); } catch { /* phase observers must not mask the root failure */ }
    }
    if (error instanceof IngestError) throw error;
    if (error instanceof CatalogError) throw new IngestError(error.category, { cause: error });
    if (error instanceof MemoryTransactionError) throw new IngestError(error.category, { cause: error });
    throw new IngestError("persistence_failed", { cause: error });
  }
}
