import type { VersionedRef } from "../praxis/episode-v2.js";
import { isRecord } from "../shared/type-guards.js";
import type { CatalogReader } from "./catalog-reader.js";
import { CatalogError } from "./catalog-reader.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "./host-input-archive.js";
import type { IngestAttachment, IngestItemKind, IngestItemRole } from "./ingest.js";

export type TranscriptMessageExport = {
  upstreamId: string;
  parentUpstreamId: string | null;
  editedFromUpstreamId?: string | null;
  timestamp: string;
  appendMode?: "side";
  message: {
    role: string;
    content: string | Array<Record<string, unknown>>;
  };
  event?: Record<string, unknown>;
  speaker?: { id: string | null; role: IngestItemRole };
  kind?: IngestItemKind;
  attachments?: IngestAttachment[];
};

export type RebuiltConversationMessage = {
  upstreamId: string;
  parentUpstreamId: string | null;
  editedFromUpstreamId: string | null;
  role: string;
  kind: string;
  text: string | null;
  attachmentRefs: Array<{
    upstreamId: string;
    sha256: string | null;
    mediaType: string | null;
    present: boolean;
  }>;
};

export type RebuiltConversation = {
  messages: RebuiltConversationMessage[];
  missingAttachments: Array<{ upstreamId: string; reason: string; retryable: boolean }>;
  completeForDeclaredScope: boolean;
};

/** Rebuild a test dialogue from archived sources bound to one transcript coverage. */
export async function rebuildConversationFromArchive(input: {
  reader: CatalogReader;
  coverageRef: VersionedRef;
}): Promise<RebuiltConversation> {
  const coverage = await input.reader.read(input.coverageRef, "coverage");
  if (!isRecord(coverage) || coverage.schemaVersion !== "stella.archive-coverage/v1") {
    throw new CatalogError("invalid_archive_coverage");
  }
  const missingAttachments = Array.isArray(coverage.missingItems)
    ? coverage.missingItems.filter((item): item is { upstreamId: string; reason: string; retryable: boolean } =>
      isRecord(item) && typeof item.upstreamId === "string" && typeof item.reason === "string" &&
      typeof item.retryable === "boolean")
    : [];
  const sources = input.reader.catalog.sources.filter((entry) =>
    entry.status === "current" &&
    entry.dependencies.some((dependency) =>
      dependency.id === input.coverageRef.id && dependency.version === input.coverageRef.version));
  const messages: Array<RebuiltConversationMessage & { capturedAt: string }> = [];
  for (const entry of sources) {
    const source = await input.reader.read({ id: entry.id, version: entry.version }, "sources");
    if (!isRecord(source) || !isRecord(source.origin) || source.origin.adapterId !== HOST_INPUT_ARCHIVE_ADAPTER) {
      continue;
    }
    const evidenceEntries = input.reader.catalog.evidence.filter((evidence) =>
      evidence.status === "current" &&
      evidence.dependencies.some((dependency) => dependency.id === entry.id && dependency.version === entry.version));
    const evidenceObjects = await Promise.all(evidenceEntries.map((evidence) =>
      input.reader.read({ id: evidence.id, version: evidence.version }, "evidence")));
    const textEvidence = evidenceObjects.find((evidence) =>
      isRecord(evidence) && isRecord(evidence.selector) && evidence.selector.kind === "json_pointer");
    if (!isRecord(textEvidence) || typeof textEvidence.role !== "string" || typeof textEvidence.kind !== "string") {
      throw new CatalogError("transcript_evidence_missing");
    }
    const role = textEvidence.role;
    const kind = textEvidence.kind;
    let text: string | null = null;
    let parentUpstreamId: string | null = null;
    let editedFromUpstreamId: string | null = null;
    const attachmentRefs: RebuiltConversationMessage["attachmentRefs"] = [];
    const declaredMissing = new Set<string>();
    if (Array.isArray(source.payloads)) {
      for (const payload of source.payloads) {
        if (!isRecord(payload) || typeof payload.sha256 !== "string") continue;
        if (payload.mediaType === "application/json") {
          const loaded = await input.reader.readPayload({ id: entry.id, version: entry.version }, payload.sha256);
          const body = JSON.parse(loaded.bytes.toString("utf8")) as unknown;
          if (isRecord(body)) {
            if (typeof body.text === "string") text = body.text;
            if (body.parentUpstreamId === null || typeof body.parentUpstreamId === "string") {
              parentUpstreamId = body.parentUpstreamId as string | null;
            }
            if (body.editedFromUpstreamId === null || typeof body.editedFromUpstreamId === "string") {
              editedFromUpstreamId = body.editedFromUpstreamId as string | null;
            }
            if (Array.isArray(body.attachments)) {
              for (const attachment of body.attachments) {
                if (!isRecord(attachment) || typeof attachment.upstreamId !== "string") continue;
                const presentPayload = source.payloads.find((candidate) =>
                  isRecord(candidate) && candidate.sha256 === attachment.sha256);
                const present = Boolean(presentPayload);
                if (!present) declaredMissing.add(attachment.upstreamId);
                attachmentRefs.push({
                  upstreamId: attachment.upstreamId,
                  sha256: typeof attachment.sha256 === "string" ? attachment.sha256 : null,
                  mediaType: typeof attachment.mediaType === "string" ? attachment.mediaType : null,
                  present,
                });
              }
            }
          }
        }
      }
    }
    for (const missing of missingAttachments) {
      if (missing.reason !== "attachment_missing" || !declaredMissing.has(missing.upstreamId)) continue;
      if (!attachmentRefs.some((ref) => ref.upstreamId === missing.upstreamId)) {
        attachmentRefs.push({
          upstreamId: missing.upstreamId,
          sha256: null,
          mediaType: null,
          present: false,
        });
      }
    }
    messages.push({
      upstreamId: String(source.origin.upstreamId),
      parentUpstreamId,
      editedFromUpstreamId,
      role,
      kind,
      text,
      attachmentRefs,
      capturedAt: typeof source.capturedAt === "string" ? source.capturedAt : "",
    });
  }
  messages.sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt) || left.upstreamId.localeCompare(right.upstreamId));
  return {
    messages: messages.map(({ capturedAt: _capturedAt, ...message }) => message),
    missingAttachments: missingAttachments.filter((item) => item.reason === "attachment_missing"),
    completeForDeclaredScope: coverage.completeForDeclaredScope === true,
  };
}
