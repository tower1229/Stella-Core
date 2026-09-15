import { isCronSessionKey, isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
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
export function assertPrivateContextAudience(decision: TurnAudienceDecision): void {
  if (!decision.privateContextAllowed) throw new CatalogError("private_context_audience_forbidden");
}
