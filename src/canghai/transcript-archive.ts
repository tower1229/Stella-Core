import type { VersionedRef } from "../praxis/episode-v2.js";
import { isRecord } from "../shared/type-guards.js";
import type { CatalogReader } from "./catalog-reader.js";
import { CatalogError } from "./catalog-reader.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "./host-input-archive.js";

export type IngestItemRole = "owner" | "assistant" | "other" | "tool" | "external_author" | "unknown";
export type IngestItemKind = "direct_observation" | "reported" | "inference" | "quotation" | "unknown";

export const HOST_MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool",
  "toolResult",
  "tool_result",
  "bashExecution",
] as const;
export type HostMessageRole = (typeof HOST_MESSAGE_ROLES)[number];

export type IngestAttachment = {
  upstreamId: string;
  mediaType: string;
  fileName?: string | null;
  /** Original bytes for the repository copy. */
  bytes?: Uint8Array | null;
  /** External URL without bytes = non-retryable upstream gap. */
  externalUrl?: string | null;
};

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

export type TranscriptIngestItem = {
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
  envelope?: Record<string, unknown>;
};

const check: (value: unknown, category: string) => asserts value = (value, category) => {
  if (!value) throw new CatalogError(category);
};

function bytesFromPart(part: Record<string, unknown>): Uint8Array | null {
  if (typeof part.data === "string" && part.data) {
    try { return Uint8Array.from(Buffer.from(part.data, "base64")); }
    catch { return null; }
  }
  if (part.bytes instanceof Uint8Array && part.bytes.byteLength > 0) return part.bytes;
  if (Buffer.isBuffer(part.bytes) && part.bytes.byteLength > 0) return Uint8Array.from(part.bytes);
  return null;
}

function mediaTypeFromPart(part: Record<string, unknown>): string {
  if (typeof part.mimeType === "string" && part.mimeType.trim()) return part.mimeType;
  if (typeof part.mediaType === "string" && part.mediaType.trim()) return part.mediaType;
  if (part.type === "image") return "image/png";
  return "application/octet-stream";
}

/** Lift text + inline media from Host content; never silently drop non-text parts. */
export function collectTranscriptContent(
  messageId: string,
  content: TranscriptMessageExport["message"]["content"],
  declared: IngestAttachment[],
): { text: string; attachments: IngestAttachment[] } {
  const attachments = declared.map((item) => ({ ...item }));
  if (typeof content === "string") return { text: content, attachments };
  check(Array.isArray(content) && content.length > 0, "invalid_input");
  const texts: string[] = [];
  content.forEach((part, index) => {
    check(isRecord(part) && typeof part.type === "string", "invalid_input");
    if (part.type === "text") {
      check(typeof part.text === "string", "invalid_input");
      texts.push(part.text);
      return;
    }
    if (part.type === "image" || part.type === "file" || part.type === "input_image" || part.type === "input_file") {
      const upstreamId = `${messageId}#content/${index}`;
      const existing = attachments.find((item) => item.upstreamId === upstreamId);
      const liftedBytes = bytesFromPart(part);
      const mediaType = mediaTypeFromPart(part);
      if (existing) {
        if ((!existing.bytes || existing.bytes.byteLength === 0) && liftedBytes) {
          existing.bytes = liftedBytes;
        }
        if (!existing.mediaType) existing.mediaType = mediaType;
        return;
      }
      attachments.push({
        upstreamId,
        mediaType,
        fileName: typeof part.fileName === "string" ? part.fileName : typeof part.name === "string" ? part.name : null,
        bytes: liftedBytes,
        externalUrl: typeof part.url === "string" ? part.url : null,
      });
      return;
    }
    check(false, "transcript_media_requires_attachment");
  });
  return { text: texts.join("\n"), attachments };
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
}): TranscriptIngestItem[] {
  check(input.hostVersion === "2026.8.2" && input.agentId.trim() && input.sessionId.trim() && input.sessionKey.trim(),
    "invalid_input");
  check(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 32, "invalid_input");
  const seen = new Set<string>();
  const items: TranscriptIngestItem[] = [];
  for (const message of input.messages) {
    check(message.upstreamId.trim() && !seen.has(message.upstreamId), "invalid_input");
    seen.add(message.upstreamId);
    check(typeof message.timestamp === "string" &&
      /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(message.timestamp) &&
      Number.isFinite(Date.parse(message.timestamp)), "invalid_input");
    check(isRecord(message.message) && typeof message.message.role === "string", "invalid_input");
    const mapped = mapTranscriptRole(message.message.role, message.speaker);
    const collected = collectTranscriptContent(
      message.upstreamId,
      message.message.content,
      message.attachments ?? [],
    );
    check(collected.text.trim().length > 0 || collected.attachments.length > 0, "invalid_input");
    for (const attachment of collected.attachments) {
      check(attachment.upstreamId.trim() && attachment.mediaType.trim(), "invalid_input");
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
      text: collected.text || `[attachment:${collected.attachments.map((item) => item.upstreamId).join(",")}]`,
      capturedAt: message.timestamp,
      occurredAt: null,
      authoredAt: null,
      parentUpstreamId: message.parentUpstreamId,
      editedFromUpstreamId: message.editedFromUpstreamId ?? null,
      attachments: collected.attachments,
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
