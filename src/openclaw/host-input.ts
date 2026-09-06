import { loadTranscriptEventsSync } from "openclaw/plugin-sdk/session-store-runtime";
import { canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { CompletionError } from "./completion.js";

type Recorder = { hasPersisted(): boolean; getAdmissionReceipt(): unknown; getPersistedMessage?: () => unknown };
export type HostInputSnapshot = {
  schemaVersion: "stella.host-input-snapshot/v1";
  hostVersion: string; agentId: string; sessionId: string; sessionKey: string;
  entryId: string; logicalTurnId: string; generation: string; rawSeq: number;
  parentId: string | null; text: string; event: Record<string, unknown>;
};

export function captureHostInput(input: {
  hostVersion: string; agentId: string; sessionId: string; sessionKey: string; recorder: Recorder;
}, readEvents: typeof loadTranscriptEventsSync = loadTranscriptEventsSync): HostInputSnapshot {
  const fail = (): never => { throw new CompletionError("host_input_unavailable", "generate"); };
  if (input.hostVersion !== "2026.8.2" || !input.recorder.hasPersisted()) return fail();
  const admission = input.recorder.getAdmissionReceipt();
  if (!isRecord(admission) || admission.role !== "user" || admission.agentId !== input.agentId ||
      admission.sessionId !== input.sessionId || admission.sessionKey !== input.sessionKey ||
      typeof admission.storePath !== "string" || !admission.storePath ||
      typeof admission.entryId !== "string" || !admission.entryId ||
      typeof admission.logicalTurnId !== "string" || !admission.logicalTurnId ||
      typeof admission.generation !== "string" || !admission.generation || !Number.isSafeInteger(admission.rawSeq) || Number(admission.rawSeq) < 1 ||
      !(admission.effectiveParentId === null || typeof admission.effectiveParentId === "string")) return fail();
  const persisted = input.recorder.getPersistedMessage?.();
  if (!isRecord(persisted) || persisted.role !== "user") return fail();
  let events: unknown[];
  try { events = readEvents({ agentId: input.agentId, sessionId: input.sessionId, sessionKey: input.sessionKey, storePath: admission.storePath }); }
  catch { return fail(); }
  const matching = events.filter((event) => isRecord(event) && event.id === admission.entryId);
  if (matching.length !== 1) return fail();
  const event = matching[0];
  if (!isRecord(event) || event.type !== "message" || event.parentId !== admission.effectiveParentId ||
      !isRecord(event.message) || event.message.role !== "user" || canonicalJson(event.message) !== canonicalJson(persisted)) return fail();
  const content = event.message.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && content.every((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")) {
    text = content.map((part) => (part as { text: string }).text).join("\n");
  } else throw new CompletionError("host_input_media_unavailable", "generate");
  if (!text.trim()) return fail();
  return { schemaVersion: "stella.host-input-snapshot/v1", hostVersion: input.hostVersion,
    agentId: input.agentId, sessionId: input.sessionId, sessionKey: input.sessionKey,
    entryId: admission.entryId, logicalTurnId: admission.logicalTurnId, generation: admission.generation,
    rawSeq: Number(admission.rawSeq), parentId: admission.effectiveParentId, text,
    event: JSON.parse(canonicalJson(event)) as Record<string, unknown> };
}
