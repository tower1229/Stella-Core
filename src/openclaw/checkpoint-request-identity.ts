import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { CheckpointPluginConfig } from "./checkpoint-plugin-runtime.js";

type Inbound = Parameters<typeof resolveCommandAuthorization>[0]["ctx"];
const PROFILE_PREFIX = "openclaw-profile:";
export function profileRequesterId(id: unknown): string | undefined {
  return typeof id === "string" && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id)
    ? PROFILE_PREFIX + id : undefined;
}

/** Current Host envelope only. Never derive a person from a client/device label,
 * saved session owner, conversation text, or a configured Telegram alias.
 */
export type CheckpointRequestIdentity = Readonly<{ senderId: string; senderIsOwner: true; providerId?: string;
  kind: "gateway_profile" | "transport"; toolSenderId?: string }>;
export function resolveCheckpointRequestIdentity(ctx: Inbound, live: OpenClawConfig, config: Pick<CheckpointPluginConfig, "webchatOwnerProfileId">): CheckpointRequestIdentity {
  const sender = resolveCommandAuthorization({ ctx, cfg: live, commandAuthorized: ctx.CommandAuthorized === true });
  if (!sender.senderIsOwner || ctx.ChatType !== "direct") throw new CatalogError("private_context_audience_forbidden");
  if (ctx.Provider === "webchat" && ctx.Surface === "webchat" && !sender.senderId) {
    const actor = ctx.SessionCreation?.actor;
    const profileId = ctx.SessionCreation?.via === "operator" && actor?.type === "human" && actor.source === "profile" ? actor.id : undefined;
    const requesterId = profileRequesterId(profileId);
    if (!requesterId || !ctx.GatewayClientScopes?.includes("operator.admin")) throw new CatalogError("checkpoint_webchat_profile_required");
    if (profileId !== config.webchatOwnerProfileId) throw new CatalogError("checkpoint_webchat_profile_not_bound");
    return Object.freeze({ senderIsOwner: true, providerId: sender.providerId, senderId: requesterId, kind: "gateway_profile" as const, toolSenderId: ctx.SenderId });
  }
  if (!sender.senderId || sender.senderId.startsWith(PROFILE_PREFIX)) throw new CatalogError("private_context_audience_forbidden");
  return Object.freeze({ senderIsOwner: true, providerId: sender.providerId, senderId: sender.senderId, kind: "transport" as const, toolSenderId: sender.senderId });
}

/** Existing operator scope; no Agent, source, transcript, config or LLM access.
 * The caller's current profile is diagnostic metadata, never a source grant.
 */
export function registerCheckpointIdentityDiagnostic(api: OpenClawPluginApi) {
  api.registerGatewayMethod("stella.identity", ({ params, client, respond }) => {
    if (Object.keys(params).length) { respond(false, undefined, { code: "INVALID_REQUEST", message: "stella.identity accepts no parameters" }); return; }
    if (!client || client.connect.role !== "operator" || !client.connect.scopes?.includes("operator.admin")) {
      respond(false, undefined, { code: "UNAVAILABLE", message: "checkpoint_identity_operator_required" }); return;
    }
    const profileId = client.authenticatedUserProfile?.profileId, requesterId = profileRequesterId(profileId);
    if (!requesterId) { respond(false, undefined, { code: "UNAVAILABLE", message: "checkpoint_webchat_profile_required" }); return; }
    respond(true, { schemaVersion: "stella.identity/v1", profileId, requesterId, clientId: client.connect.client.id,
      sourceAuthorization: "not_checked", conversationAuthorization: "not_checked" });
  }, { scope: "operator.admin", profileAccess: "required" });
}
