import { loadTranscriptEventsSync } from "openclaw/plugin-sdk/session-store-runtime";
import { canonicalJson } from "../canghai/content-version.js";
import type { TranscriptMessageExport } from "../canghai/transcript-archive.js";
import { isRecord } from "../shared/type-guards.js";
import { CompletionError } from "./completion.js";

export type CaptureHostTranscriptInput = {
  hostVersion: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  /** Optional: map Host user messages to owner/other speaker. */
  ownerSpeaker?: { id: string; role: "owner" };
};

/**
 * Export retained Host transcript message events as archive-ready message exports.
 * Does not treat the SQLite store itself as personal archive material.
 */
export function captureHostTranscript(
  input: CaptureHostTranscriptInput,
  readEvents: typeof loadTranscriptEventsSync = loadTranscriptEventsSync,
): TranscriptMessageExport[] {
  if (input.hostVersion !== "2026.8.2" || !input.agentId || !input.sessionId || !input.sessionKey || !input.storePath) {
    throw new CompletionError("host_transcript_unavailable", "generate");
  }
  let events: unknown[];
  try {
    events = readEvents({
      agentId: input.agentId,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      storePath: input.storePath,
    });
  } catch {
    throw new CompletionError("host_transcript_unavailable", "generate");
  }
  const messages: TranscriptMessageExport[] = [];
  for (const event of events) {
    if (!isRecord(event) || event.type !== "message" || typeof event.id !== "string" || !event.id) continue;
    if (!(event.parentId === null || typeof event.parentId === "string")) continue;
    if (typeof event.timestamp !== "string" || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(event.timestamp)) continue;
    if (!isRecord(event.message) || typeof event.message.role !== "string") continue;
    const content = event.message.content;
    if (!(typeof content === "string" || Array.isArray(content))) continue;
    const role = event.message.role;
    const exportMessage: TranscriptMessageExport = {
      upstreamId: event.id,
      parentUpstreamId: event.parentId,
      timestamp: event.timestamp,
      ...(event.appendMode === "side" ? { appendMode: "side" as const } : {}),
      ...(typeof event.editedFromId === "string" ? { editedFromUpstreamId: event.editedFromId } : {}),
      message: {
        role,
        content: JSON.parse(canonicalJson(content)) as TranscriptMessageExport["message"]["content"],
      },
      event: JSON.parse(canonicalJson(event)) as Record<string, unknown>,
    };
    if (role === "user" && input.ownerSpeaker) {
      exportMessage.speaker = { id: input.ownerSpeaker.id, role: "owner" };
    }
    messages.push(exportMessage);
  }
  if (!messages.length) throw new CompletionError("host_transcript_unavailable", "generate");
  return messages;
}
