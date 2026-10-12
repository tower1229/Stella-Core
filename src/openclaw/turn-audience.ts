import { isCronSessionKey, isSubagentSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { BoundTurnRequest } from "./turn-request.js";

export const TURN_AUDIENCES = [
  "owner_direct",
  "non_owner_direct",
  "group",
  "channel",
  "subagent",
  "cron",
  "unknown",
] as const;
export type TurnAudience = (typeof TURN_AUDIENCES)[number];

export type TurnAudienceDecision = {
  audience: TurnAudience;
  /** Private catalog / PCA / personal views may load only when true. */
  privateContextAllowed: boolean;
};

/** Structural addresses from the pinned Host's canonical/legacy session-key
 * formats. Its public routing API exposes agent parsing but not chat-type
 * extraction. Never infer audience from prompt text or arbitrary substrings.
 * Ambiguous addresses cannot acquire private rights through Gateway's direct
 * chat envelope. Opaque main keys continue to use authenticated Host metadata.
 */
function sharedSessionAudience(sessionKey: string): "group" | "channel" | "unknown" | undefined {
  const key = sessionKey.trim().toLowerCase();
  const parts = (parseAgentSessionKey(key)?.rest ?? key).split(":");
  const peerKinds = ["direct", "dm", "group", "channel"];
  const candidates: string[] = [];
  if (["direct", "dm"].includes(parts[0]!) && parts[1]) candidates.push("direct");
  if (parts[0] && peerKinds.includes(parts[1]!) && parts[2]) candidates.push(parts[1]!);
  if (parts[0] && parts[1] && peerKinds.includes(parts[2]!) && parts[3]) candidates.push(parts[2]!);
  if (["group", "channel"].includes(parts[0]!) && parts[1]) candidates.push(parts[0]!);
  if ((parts.length === 1 || parts.length === 2 && parts[0] === "whatsapp") && parts.at(-1)!.endsWith("@g.us")) {
    candidates.push("group");
  }
  if (parts[0] === "discord" && [3, 4].includes(parts.length) &&
      parts.at(-2)!.startsWith("guild-") && parts.at(-2)!.length > 6 &&
      parts.at(-1)!.startsWith("channel-") && parts.at(-1)!.length > 8) candidates.push("channel");
  if (candidates.length > 1) return "unknown";
  const audience = candidates[0];
  return audience === "group" || audience === "channel" ? audience : undefined;
}

/**
 * Host-trusted audience classification. Session-key cron/subagent markers win
 * over chatType. This never grants source access — it only decides whether
 * private context may be loaded at all.
 */
export function resolveTurnAudience(request: BoundTurnRequest): TurnAudienceDecision {
  const sessionKey = request.sessionKey;
  if (isSubagentSessionKey(sessionKey)) {
    return { audience: "subagent", privateContextAllowed: false };
  }
  if (isCronSessionKey(sessionKey)) {
    return { audience: "cron", privateContextAllowed: false };
  }
  const shared = sharedSessionAudience(sessionKey);
  if (shared) return { audience: shared, privateContextAllowed: false };
  const chatType = request.chatType;
  if (chatType === "group") return { audience: "group", privateContextAllowed: false };
  if (chatType === "channel") return { audience: "channel", privateContextAllowed: false };
  if (chatType === "direct") {
    if (request.senderIsOwner === true && typeof request.senderId === "string" && request.senderId.trim()) {
      return { audience: "owner_direct", privateContextAllowed: true };
    }
    return { audience: "non_owner_direct", privateContextAllowed: false };
  }
  return { audience: "unknown", privateContextAllowed: false };
}

/** Parent-task summary text cannot expand a denied audience into private access. */
export function assertPrivateContextAudience(
  decision: TurnAudienceDecision,
): asserts decision is TurnAudienceDecision & { audience: "owner_direct"; privateContextAllowed: true } {
  if (decision.audience !== "owner_direct" || !decision.privateContextAllowed) {
    throw new CatalogError("private_context_audience_forbidden");
  }
}
