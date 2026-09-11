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
import { HOST_REQUEST_ARCHIVE_ADAPTER, type HostRequestSnapshot } from "./host-request-archive.js";
import { afterDurablePersistPublishView } from "./managed-durable-write.js";
import {
  applyMemoryTransaction,
  readRecordedMemoryTransaction,
  MemoryTransactionError,
  type MemoryFileChange,
  type MemoryTransactionPlan,
} from "./memory-transaction.js";
import { parseSourcePolicy } from "./source-policy.js";
import { snapshotTurnRequest } from "../openclaw/turn-request.js";
import type { TranscriptMessageExport } from "./transcript-archive.js";

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

/** Fail-closed: do_not_retain requires explicit Host surface guarantees before any disk write. */
export const DEFAULT_RETENTION_GUARANTEES: HostRetentionGuarantees = {
  transcript: false,
  staging: false,
  backup: false,
};

export type IngestItemRole = "owner" | "assistant" | "other" | "tool" | "external_author" | "unknown";
export type IngestItemKind = "direct_observation" | "reported" | "inference" | "quotation" | "unknown";

export type IngestAttachment = {
  upstreamId: string;
  mediaType: string;
  fileName?: string | null;
  /** Original bytes for the repository copy. Absent bytes with only an external URL are gaps. */
  bytes?: Uint8Array | null;
  externalUrl?: string | null;
};

export type IngestItem = {
  upstreamId: string;
  role: IngestItemRole;
  speakerId: string | null;
  kind: IngestItemKind;
  text: string;
  capturedAt: string;
  occurredAt: string | null;
  authoredAt: string | null;
  parentUpstreamId: string | null;
  editedFromUpstreamId?: string | null;
  attachments?: IngestAttachment[];
  /** Opaque provenance envelope (Host event tree, etc.); never required for explicit records. */
  envelope?: Record<string, unknown>;
};

export type IngestCoveragePlan = {
  branchPolicy: "all_retained" | "declared_subset";
  declaredBranches: string[];
  upstreamSnapshot: string;
  fromCursor: string | null;
  toCursor: string | null;
  expectedCount: number | null;
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
  /** When set, one Archive Coverage binds the whole batch (transcript trees). */
  coverage?: IngestCoveragePlan;
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
  evidenceRefs: VersionedRef[];
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
  evidenceRefs: VersionedRef[];
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
  check(Array.isArray(value.evidenceRefs) && value.evidenceRefs.every(validRef), "invalid_record");
  check(value.resultState === "synchronized", "invalid_record");
  check(value.retention === "do_not_retain"
    ? value.sourceRefs.length === 0 && value.evidenceRefs.length === 0 && value.coverageRef === null && value.targetRefs.length === 0
    : value.sourceRefs.length > 0 && value.evidenceRefs.length > 0,
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
    evidenceRefs: value.evidenceRefs.map((ref) => ({ id: ref.id, version: ref.version })),
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
  check(["owner", "assistant", "other", "tool", "external_author", "unknown"].includes(speaker.role), "invalid_input");
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

function textFromTranscriptContent(content: TranscriptMessageExport["message"]["content"]): string {
  if (typeof content === "string") return content;
  check(Array.isArray(content) && content.length > 0, "invalid_input");
  const texts: string[] = [];
  for (const part of content) {
    check(isRecord(part) && typeof part.type === "string", "invalid_input");
    if (part.type === "text") {
      check(typeof part.text === "string", "invalid_input");
      texts.push(part.text);
      continue;
    }
    // Non-text parts must be declared as attachments; never silently drop media from the archive.
    check(false, "transcript_media_requires_attachment");
  }
  return texts.join("\n");
}

function mapTranscriptRole(
  messageRole: string,
  speaker: TranscriptMessageExport["speaker"],
): { role: IngestItemRole; speakerId: string | null; kind: IngestItemKind } {
  if (messageRole === "user") {
    const role = speaker?.role ?? "unknown";
    check(["owner", "other", "unknown", "external_author"].includes(role), "invalid_input");
    check(role !== "owner" || Boolean(speaker?.id), "invalid_input");
    return { role, speakerId: speaker?.id ?? null, kind: "reported" };
  }
  if (messageRole === "assistant") {
    return { role: "assistant", speakerId: speaker?.id ?? null, kind: "inference" };
  }
  if (messageRole === "tool" || messageRole === "toolResult" || messageRole === "tool_result" ||
    messageRole === "bashExecution") {
    return { role: "tool", speakerId: speaker?.id ?? null, kind: "direct_observation" };
  }
  check(false, "unsupported_transcript_role");
  return { role: "unknown", speakerId: null, kind: "unknown" };
}

function detectTranscriptKind(
  message: TranscriptMessageExport,
  mapped: IngestItemKind,
): IngestItemKind {
  if (message.kind) return message.kind;
  const content = message.message.content;
  if (Array.isArray(content) && content.some((part) => isRecord(part) && part.quotation === true)) {
    return "quotation";
  }
  return mapped;
}

/** Host transcript tree → ingest items. Assistant/tool never become owner evidence. */
export function prepareTranscriptItems(input: {
  hostVersion: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  messages: TranscriptMessageExport[];
}): IngestItem[] {
  check(input.hostVersion === "2026.8.2" && input.agentId.trim() && input.sessionId.trim() && input.sessionKey.trim(),
    "invalid_input");
  check(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 32, "invalid_input");
  const seen = new Set<string>();
  const items: IngestItem[] = [];
  for (const message of input.messages) {
    check(message.upstreamId.trim() && !seen.has(message.upstreamId), "invalid_input");
    seen.add(message.upstreamId);
    check(typeof message.timestamp === "string" &&
      /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(message.timestamp) &&
      Number.isFinite(Date.parse(message.timestamp)), "invalid_input");
    check(isRecord(message.message) && typeof message.message.role === "string", "invalid_input");
    const mapped = mapTranscriptRole(message.message.role, message.speaker);
    const text = textFromTranscriptContent(message.message.content);
    const attachments = message.attachments ?? [];
    check(text.trim().length > 0 || attachments.length > 0, "invalid_input");
    for (const attachment of attachments) {
      check(attachment.upstreamId.trim() && attachment.mediaType.trim(), "invalid_input");
      const hasBytes = attachment.bytes != null && attachment.bytes.byteLength > 0;
      check(hasBytes || Boolean(attachment.externalUrl), "invalid_input");
    }
    const event = message.event ?? {
      type: "message",
      id: message.upstreamId,
      parentId: message.parentUpstreamId,
      timestamp: message.timestamp,
      ...(message.appendMode ? { appendMode: message.appendMode } : {}),
      ...(message.editedFromUpstreamId ? { editedFromId: message.editedFromUpstreamId } : {}),
      message: message.message,
    };
    items.push({
      upstreamId: message.upstreamId,
      role: mapped.role,
      speakerId: mapped.speakerId,
      kind: detectTranscriptKind(message, mapped.kind),
      text: text || `[attachment:${attachments.map((item) => item.upstreamId).join(",")}]`,
      capturedAt: message.timestamp,
      occurredAt: null,
      authoredAt: null,
      parentUpstreamId: message.parentUpstreamId,
      editedFromUpstreamId: message.editedFromUpstreamId ?? null,
      attachments,
      envelope: {
        hostVersion: input.hostVersion,
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        ...(message.appendMode ? { appendMode: message.appendMode } : {}),
        ...(message.editedFromUpstreamId ? { editedFromUpstreamId: message.editedFromUpstreamId } : {}),
        event,
      },
    });
  }
  return items;
}

/** Public transcript-tree entry: roles, branches, edits and attachments share unified ingest. */
export async function ingestTranscript(input: {
  operationId: string;
  expectedRevision: string;
  hostVersion: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  messages: TranscriptMessageExport[];
  branchPolicy: "all_retained" | "declared_subset";
  declaredBranches: string[];
  policyRef: VersionedRef;
  purpose: IngestRequest["purpose"];
}, ports: IngestPorts): Promise<IngestResult> {
  const items = prepareTranscriptItems(input);
  const fromCursor = items[0]?.parentUpstreamId ?? null;
  const toCursor = items[items.length - 1]?.upstreamId ?? null;
  return ingest({
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER,
    collectionId: input.sessionId,
    cursor: fromCursor,
    policyRef: input.policyRef,
    items,
    purpose: input.purpose,
    coverage: {
      branchPolicy: input.branchPolicy,
      declaredBranches: input.declaredBranches,
      upstreamSnapshot: bytesVersion(canonicalJson({
        agentId: input.agentId,
        sessionId: input.sessionId,
        upstreamIds: items.map((item) => item.upstreamId),
      })),
      fromCursor,
      toCursor,
      expectedCount: items.length,
    },
  }, ports);
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

/** Host request body → ingest items (transcript not yet reliable). */
export function prepareHostRequestItems(
  snapshot: HostRequestSnapshot,
  ownerId: string,
): IngestItem[] {
  const request = snapshotTurnRequest(snapshot.request, snapshot.request.runId);
  check(snapshot.schemaVersion === "stella.host-request-snapshot/v1", "invalid_input");
  check(canonicalJson(request) === canonicalJson(snapshot.request), "invalid_input");
  check(request.senderIsOwner && request.senderId && request.chatType === "direct" && ownerId.trim(), "invalid_input");
  check(/(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.capturedAt) && Number.isFinite(Date.parse(snapshot.capturedAt)),
    "invalid_input");
  return [{
    upstreamId: request.runId,
    role: "owner",
    speakerId: ownerId,
    kind: "reported",
    text: request.prompt,
    capturedAt: snapshot.capturedAt,
    occurredAt: null,
    authoredAt: null,
    parentUpstreamId: null,
    envelope: {
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      runId: request.runId,
      requestHash: request.requestHash,
      request,
      schemaVersion: snapshot.schemaVersion,
      capturedAt: snapshot.capturedAt,
    },
  }];
}

/** Public Host-request entry into the same ingest state machine. */
export async function ingestHostRequest(input: {
  operationId: string;
  expectedRevision: string;
  snapshot: HostRequestSnapshot;
  ownerId: string;
  policyRef: VersionedRef;
  purpose: IngestRequest["purpose"];
}, ports: IngestPorts): Promise<IngestResult> {
  const items = prepareHostRequestItems(input.snapshot, input.ownerId);
  const request = snapshotTurnRequest(input.snapshot.request, input.snapshot.request.runId);
  return ingest({
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    adapterId: HOST_REQUEST_ARCHIVE_ADAPTER,
    collectionId: request.sessionKey,
    cursor: null,
    policyRef: input.policyRef,
    items,
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
  check(["owner", "assistant", "other", "tool", "external_author", "unknown"].includes(input.role), "invalid_input");
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
    items: request.items.map((item) => ({
      ...item,
      attachments: (item.attachments ?? []).map((attachment) => ({
        upstreamId: attachment.upstreamId,
        mediaType: attachment.mediaType,
        fileName: attachment.fileName ?? null,
        externalUrl: attachment.externalUrl ?? null,
        bytesSha256: attachment.bytes != null && attachment.bytes.byteLength > 0
          ? bytesVersion(Buffer.from(attachment.bytes))
          : null,
      })),
    })),
    purpose: request.purpose,
    coverage: request.coverage ?? null,
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
  payloads: Array<MemoryFileChange & { sha256: string }>;
};

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "application/json") return "json";
  return "bin";
}

function buildArchive(request: IngestRequest, objectRoot: string, payloadRoot: string): BuiltIngestArchive {
  check(request.items.length > 0 && request.items.length <= 32, "invalid_input");
  if (request.coverage) {
    check(request.coverage.branchPolicy === "all_retained" || request.coverage.branchPolicy === "declared_subset",
      "invalid_input");
    check(Array.isArray(request.coverage.declaredBranches), "invalid_input");
    check(request.coverage.branchPolicy !== "declared_subset" || request.coverage.declaredBranches.length > 0,
      "invalid_input");
    check(request.coverage.branchPolicy !== "all_retained" || request.coverage.declaredBranches.length === 0,
      "invalid_input");
  }
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
  const payloads: Array<MemoryFileChange & { sha256: string }> = [];
  const missingItems: Array<{ upstreamId: string; reason: string; retryable: boolean }> = [];
  type PendingItem = {
    item: IngestItem;
    identity: string;
    agentIds: string[];
    evidenceSelector: { kind: "json_pointer"; value: string };
    sourceId: string;
    payloadPath: string;
    payloadHash: string;
    payloadBytes: string;
    presentAttachments: Array<{
      upstreamId: string;
      mediaType: string;
      fileName: string | null;
      sha256: string;
      path: string;
      bytes: number;
    }>;
  };
  const pending: PendingItem[] = [];

  for (const item of request.items) {
    check(item.upstreamId.trim() && item.text.trim(), "invalid_input");
    check(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(item.capturedAt) && Number.isFinite(Date.parse(item.capturedAt)),
      "invalid_input");
    check(["owner", "assistant", "other", "tool", "external_author", "unknown"].includes(item.role), "invalid_input");
    check(["direct_observation", "reported", "inference", "quotation", "unknown"].includes(item.kind), "invalid_input");
    check(item.role !== "owner" || Boolean(item.speakerId), "invalid_input");

    let identity: string;
    let agentIds: string[] = [];
    let evidenceSelector = { kind: "json_pointer" as const, value: "/text" };
    if (request.adapterId === HOST_INPUT_ARCHIVE_ADAPTER) {
      check(isRecord(item.envelope) && typeof item.envelope.agentId === "string" && item.envelope.agentId.trim() &&
        typeof item.envelope.sessionId === "string", "invalid_input");
      identity = canonicalJson([
        HOST_INPUT_ARCHIVE_ADAPTER,
        item.envelope.agentId,
        item.envelope.sessionId,
        item.upstreamId,
      ]);
      agentIds = [item.envelope.agentId];
    } else if (request.adapterId === HOST_REQUEST_ARCHIVE_ADAPTER) {
      check(isRecord(item.envelope) && typeof item.envelope.agentId === "string" && item.envelope.agentId.trim() &&
        typeof item.envelope.sessionKey === "string", "invalid_input");
      identity = canonicalJson([
        HOST_REQUEST_ARCHIVE_ADAPTER,
        item.envelope.agentId,
        item.envelope.sessionKey,
        item.upstreamId,
      ]);
      agentIds = [item.envelope.agentId];
      evidenceSelector = { kind: "json_pointer", value: "/request/prompt" };
    } else {
      identity = canonicalJson([request.adapterId, request.collectionId, item.upstreamId]);
    }
    const sourceId = stableId("source", identity);
    const presentAttachments: PendingItem["presentAttachments"] = [];
    for (const attachment of item.attachments ?? []) {
      check(attachment.upstreamId.trim() && attachment.mediaType.trim(), "invalid_input");
      const raw = attachment.bytes;
      if (raw != null && raw.byteLength > 0) {
        const bytes = Buffer.from(raw);
        const sha256 = bytesVersion(bytes);
        const pathName = `${payloadRoot}/${sourceId}/${sha256.slice(7)}.${extensionForMediaType(attachment.mediaType)}`;
        payloads.push({
          path: pathName,
          before: null,
          after: bytes.toString("base64"),
          encoding: "base64",
          sha256,
        });
        presentAttachments.push({
          upstreamId: attachment.upstreamId,
          mediaType: attachment.mediaType,
          fileName: attachment.fileName ?? null,
          sha256,
          path: pathName,
          bytes: bytes.byteLength,
        });
      } else {
        missingItems.push({
          upstreamId: attachment.upstreamId,
          reason: "attachment_missing",
          retryable: true,
        });
      }
    }

    const payloadBody = item.envelope
      ? (request.adapterId === HOST_REQUEST_ARCHIVE_ADAPTER
        ? {
          schemaVersion: item.envelope.schemaVersion,
          request: item.envelope.request,
          capturedAt: item.envelope.capturedAt,
        }
        : {
          ...item.envelope,
          text: item.text,
          role: item.role,
          speakerId: item.speakerId,
          parentUpstreamId: item.parentUpstreamId,
          editedFromUpstreamId: item.editedFromUpstreamId ?? null,
          attachments: [
            ...presentAttachments.map((attachment) => ({
              upstreamId: attachment.upstreamId,
              mediaType: attachment.mediaType,
              fileName: attachment.fileName,
              sha256: attachment.sha256,
              bytes: attachment.bytes,
            })),
            ...(item.attachments ?? [])
              .filter((attachment) => !(attachment.bytes != null && attachment.bytes.byteLength > 0))
              .map((attachment) => ({
                upstreamId: attachment.upstreamId,
                mediaType: attachment.mediaType,
                fileName: attachment.fileName ?? null,
                sha256: null,
                bytes: null,
                externalUrl: attachment.externalUrl ?? null,
              })),
          ],
        })
      : {
        adapterId: request.adapterId,
        collectionId: request.collectionId,
        upstreamId: item.upstreamId,
        text: item.text,
        role: item.role,
        speakerId: item.speakerId,
        parentUpstreamId: item.parentUpstreamId,
        editedFromUpstreamId: item.editedFromUpstreamId ?? null,
      };
    const payloadBytes = canonicalJson(payloadBody);
    const payloadHash = bytesVersion(payloadBytes);
    const payloadPath = `${payloadRoot}/${sourceId}/${payloadHash.slice(7)}.json`;
    payloads.push({
      path: payloadPath,
      before: null,
      after: payloadBytes,
      sha256: payloadHash,
    });
    pending.push({
      item,
      identity,
      agentIds,
      evidenceSelector,
      sourceId,
      payloadPath,
      payloadHash,
      payloadBytes,
      presentAttachments,
    });
  }

  let batchCoverageRef: VersionedRef | null = null;
  if (request.coverage) {
    const first = request.items[0]!;
    let batchAgentIds: string[] = [];
    if (request.adapterId === HOST_INPUT_ARCHIVE_ADAPTER) {
      check(isRecord(first.envelope) && typeof first.envelope.agentId === "string" && first.envelope.agentId.trim(),
        "invalid_input");
      batchAgentIds = [first.envelope.agentId];
    }
    const complete = missingItems.length === 0 &&
      (request.coverage.expectedCount === null || request.coverage.expectedCount === pending.length);
    batchCoverageRef = add("coverage", {
      schemaVersion: "stella.archive-coverage/v1",
      id: stableId("coverage", canonicalJson([
        request.adapterId,
        request.collectionId,
        request.coverage.upstreamSnapshot,
        request.coverage.fromCursor,
        request.coverage.toCursor,
      ])),
      adapterId: request.adapterId,
      collectionId: request.collectionId,
      scope: {
        agentIds: batchAgentIds,
        roots: [],
        branchPolicy: request.coverage.branchPolicy,
        declaredBranches: request.coverage.declaredBranches,
      },
      upstreamSnapshot: request.coverage.upstreamSnapshot,
      fromCursor: request.coverage.fromCursor,
      toCursor: request.coverage.toCursor,
      expectedCount: request.coverage.expectedCount,
      retainedCount: pending.length,
      excludedByPolicyCount: 0,
      missingItems,
      checkedAt: first.capturedAt,
      completeForDeclaredScope: complete,
    }, []);
  }

  for (const entry of pending) {
    const item = entry.item;
    let coverageRef = batchCoverageRef;
    if (!coverageRef) {
      coverageRef = add("coverage", {
        schemaVersion: "stella.archive-coverage/v1",
        id: stableId("coverage", entry.identity),
        adapterId: request.adapterId,
        collectionId: request.collectionId,
        scope: {
          agentIds: entry.agentIds,
          roots: [],
          branchPolicy: "declared_subset",
          declaredBranches: [item.upstreamId],
        },
        upstreamSnapshot: request.adapterId === HOST_REQUEST_ARCHIVE_ADAPTER && isRecord(item.envelope)
          ? String(item.envelope.requestHash ?? bytesVersion(canonicalJson({ upstreamId: item.upstreamId, text: item.text })))
          : bytesVersion(canonicalJson({ upstreamId: item.upstreamId, text: item.text })),
        fromCursor: request.cursor,
        toCursor: item.upstreamId,
        expectedCount: 1,
        retainedCount: 1,
        excludedByPolicyCount: 0,
        missingItems: [],
        checkedAt: item.capturedAt,
        completeForDeclaredScope: true,
      }, []);
    }

    const sourceRef = add("sources", {
      schemaVersion: "stella.memory-source/v1",
      id: entry.sourceId,
      origin: {
        adapterId: request.adapterId,
        collectionId: request.collectionId,
        upstreamId: item.upstreamId,
      },
      payloads: [
        {
          path: entry.payloadPath,
          mediaType: "application/json",
          bytes: Buffer.byteLength(entry.payloadBytes),
          sha256: entry.payloadHash,
        },
        ...entry.presentAttachments.map((attachment) => ({
          path: attachment.path,
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
          sha256: attachment.sha256,
        })),
      ],
      capturedAt: item.capturedAt,
      policyRef: request.policyRef,
      coverageRef,
    }, [request.policyRef, coverageRef]);
    sourceRefs.push(sourceRef);

    evidenceRefs.push(add("evidence", {
      schemaVersion: "stella.memory-evidence/v1",
      id: stableId("evidence", entry.identity),
      source: sourceRef,
      payloadSha256: entry.payloadHash,
      selector: entry.evidenceSelector,
      speakerId: item.speakerId,
      role: item.role,
      kind: item.kind,
      occurredAt: item.occurredAt,
      authoredAt: item.authoredAt,
      capturedAt: item.capturedAt,
      independentOriginId: entry.sourceId,
      derivedFrom: [],
      policyRef: request.policyRef,
    }, [sourceRef, request.policyRef]));

    for (const attachment of entry.presentAttachments) {
      evidenceRefs.push(add("evidence", {
        schemaVersion: "stella.memory-evidence/v1",
        id: stableId("evidence", `${entry.identity}:attachment:${attachment.upstreamId}`),
        source: sourceRef,
        payloadSha256: attachment.sha256,
        selector: { kind: "payload", value: "all" },
        speakerId: item.speakerId,
        role: item.role,
        kind: item.kind === "quotation" ? "quotation" : "direct_observation",
        occurredAt: item.occurredAt,
        authoredAt: item.authoredAt,
        capturedAt: item.capturedAt,
        independentOriginId: entry.sourceId,
        derivedFrom: [],
        policyRef: request.policyRef,
      }, [sourceRef, request.policyRef]));
    }
  }

  const coverageRef = batchCoverageRef ?? objects.filter((object) => object.group === "coverage").at(-1)?.ref ?? null;
  const jsonPayload = payloads.find((payload) => payload.path.endsWith(".json"));
  check(coverageRef && jsonPayload && sourceRefs.length > 0 && evidenceRefs.length > 0, "invalid_input");
  return {
    sourceRef: sourceRefs[0]!,
    evidenceRefs,
    coverageRef,
    payload: {
      path: jsonPayload!.path,
      bytes: jsonPayload!.after,
      sha256: jsonPayload!.sha256,
    },
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
    evidenceRefs: operation.evidenceRefs,
    coverageRef: operation.coverageRef,
    durability: {
      localRevision: diagnostics.localRevision,
      ...(diagnostics.synchronizedRevision ? { synchronizedRevision: diagnostics.synchronizedRevision } : {}),
      rpoStatus: diagnostics.normalState,
    },
  };
}

function phaseJournalPath(catalogPath: string, operationId: string): string {
  return path.posix.join(path.posix.dirname(catalogPath), "operations", `${operationId}.phase.json`);
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
    const digest = inputDigest(request);
    const opRelative = operationPath(reader.catalogPath, request.operationId);
    const journalRelative = transactionPath(reader.catalogPath, request.operationId);

    // Pending fence or completed journal must resume before any assertCurrent catalog read:
    // a failed critical sync leaves the marker while caller expectedRevision may already have advanced.
    let recorded: MemoryTransactionPlan | undefined;
    try {
      recorded = await readRecordedMemoryTransaction(reader.root, request.operationId, journalRelative);
    } catch (error) {
      const missingJournal = error instanceof Error && "code" in error && error.code === "ENOENT";
      const pendingMissing = error instanceof MemoryTransactionError && error.category === "pending_transaction_not_found";
      if (!missingJournal && !pendingMissing) {
        throw error instanceof IngestError ? error : new IngestError("persistence_failed", { cause: error });
      }
    }
    if (recorded) {
      const operationAfter = recorded.files.find((file) => file.path === opRelative)?.after;
      check(typeof operationAfter === "string", "invalid_record");
      let existing: unknown;
      try { existing = JSON.parse(operationAfter); }
      catch { throw new IngestError("invalid_record"); }
      const operation = parseMemoryOperation(existing);
      check(operation.id === request.operationId && operation.inputDigest === digest, "idempotency_conflict");
      const catalogChange = recorded.files.find((file) => file.path === reader.catalogPath);
      check(catalogChange && typeof catalogChange.before === "string", "invalid_record");
      await emit(ports, "staged", observed);
      await emit(ports, "validated", observed);
      await applyMemoryTransaction(reader.root, recorded, {
        async validate() {
          const current = await CatalogReader.load(reader.root, reader.catalogPath);
          check([bytesVersion(catalogChange.before!), bytesVersion(catalogChange.after)].includes(current.catalogHash),
            "stale_generation");
          const livePolicy = await current.read(request.policyRef, "policies");
          assertRetentionAdmission(livePolicy, ports.retentionGuarantees);
          check(Array.isArray(livePolicy.readPurposes) && livePolicy.readPurposes.includes(request.purpose.readPurpose) &&
            Array.isArray(livePolicy.derivePurposes) && livePolicy.derivePurposes.includes(request.purpose.derivePurpose) &&
            Array.isArray(livePolicy.deliveryScopes) && livePolicy.deliveryScopes.includes(request.purpose.deliveryScope),
          "permission_denied");
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
    }

    // Completed operation without a pending fence: idempotent confirm (also fails closed on corrupt journals).
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

    // Fresh write: catalog has no pending fence, so assertCurrent-backed reads are safe.
    const policy = await reader.read(request.policyRef, "policies");
    const retention = assertRetentionAdmission(policy, ports.retentionGuarantees);
    check(Array.isArray(policy.readPurposes) && policy.readPurposes.includes(request.purpose.readPurpose) &&
      Array.isArray(policy.derivePurposes) && policy.derivePurposes.includes(request.purpose.derivePurpose) &&
      Array.isArray(policy.deliveryScopes) && policy.deliveryScopes.includes(request.purpose.deliveryScope),
    "permission_denied");

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
        ...archive.payloads.map((payload) => ({
          path: payload.path,
          before: null as string | null,
          after: payload.after,
          ...(payload.encoding === "base64" ? { encoding: "base64" as const } : {}),
        })),
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
      evidenceRefs: archive ? archive.evidenceRefs : [],
      resultState: "synchronized",
    };
    // Ensure operation bytes never carry private item text for do_not_retain.
    const operationBytes = canonicalJson(operation);
    check(retention === "retain" || !request.items.some((item) => operationBytes.includes(item.text)),
      "retention_payload_leak");
    const phaseBytes = canonicalJson({
      schemaVersion: "stella.ingest-phase/v1",
      operationId: request.operationId,
      phase: "synchronized",
      retention,
    });

    files.push(
      { path: opRelative, before: null, after: operationBytes },
      { path: phaseJournalPath(reader.catalogPath, request.operationId), before: null, after: phaseBytes },
      { path: reader.catalogPath, before: catalogBytes, after: canonicalJson(after) },
    );

    await emit(ports, "validated", observed);

    const plan: MemoryTransactionPlan = {
      operationId: request.operationId,
      journalPath: journalRelative,
      files,
    };

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
