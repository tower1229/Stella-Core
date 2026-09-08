import { bytesVersion } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";

/** Created only by the reply-dispatch adapter from Host fields. These facts
 * identify a request; they do not grant source access or model processing. */
export type HostTurnRequest = {
  agentId: string; sessionId: string; sessionKey: string;
  prompt: string; senderId?: string; senderIsOwner: boolean;
  chatType?: "direct" | "group" | "channel";
};
export type BoundTurnRequest = Readonly<HostTurnRequest & { runId: string; requestHash: string }>;

export function snapshotTurnRequest(value: HostTurnRequest, runId: string): BoundTurnRequest {
  if (!isRecord(value) || !runId ||
      ![value.agentId, value.sessionId, value.sessionKey, value.prompt].every(v => typeof v === "string" && v.trim()) ||
      typeof value.senderIsOwner !== "boolean" ||
      (value.senderId !== undefined && (typeof value.senderId !== "string" || !value.senderId.trim())) ||
      (value.chatType !== undefined && !["direct", "group", "channel"].includes(value.chatType))) {
    throw new Error("invalid_host_turn_request");
  }
  return Object.freeze({ agentId: value.agentId, sessionId: value.sessionId, sessionKey: value.sessionKey,
    prompt: value.prompt, senderIsOwner: value.senderIsOwner,
    ...(value.senderId ? { senderId: value.senderId } : {}), ...(value.chatType ? { chatType: value.chatType } : {}),
    runId, requestHash: bytesVersion(value.prompt) });
}
