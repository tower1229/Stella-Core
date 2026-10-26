import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { CheckpointPluginConfig } from "./checkpoint-plugin-runtime.js";

type Inbound = Parameters<typeof resolveCommandAuthorization>[0]["ctx"];
const PROFILE_PREFIX = "openclaw-profile:";
const DEVICE_PREFIX = "openclaw-device:";
export function deviceRequesterId(id: unknown): string | undefined {
  return typeof id === "string" && id.length === 64 && /^[a-f0-9]{64}$/.test(id) ? DEVICE_PREFIX + id : undefined;
}
export function profileRequesterId(id: unknown): string | undefined {
  return typeof id === "string" && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id)
    ? PROFILE_PREFIX + id : undefined;
}

/** Current Host envelope only. Never derive a person from a client/device label,
 * saved session owner, conversation text, or a configured Telegram alias. The
 * explicit device mode identifies a device holder, never a natural person.
 */
export type CheckpointRequestIdentity = Readonly<{ senderId: string; senderIsOwner: true; providerId?: string;
  kind: "gateway_profile" | "gateway_device" | "transport"; toolSenderId?: string }>;
export function resolveCheckpointRequestIdentity(ctx: Inbound, live: OpenClawConfig, config: Pick<CheckpointPluginConfig, "webchatOwnerProfileId" | "webchatOwnerDeviceId">): CheckpointRequestIdentity {
  if (config.webchatOwnerProfileId !== undefined && config.webchatOwnerDeviceId !== undefined) throw new CatalogError("checkpoint_configuration_invalid");
  const sender = resolveCommandAuthorization({ ctx, cfg: live, commandAuthorized: ctx.CommandAuthorized === true });
  if (!sender.senderIsOwner || ctx.ChatType !== "direct") throw new CatalogError("private_context_audience_forbidden");
  if (config.webchatOwnerDeviceId !== undefined && ctx.Provider === "webchat") {
    // Stock 2026.8.2 copies the current authenticated connection's device id
    // into this public context field. Never accept an id from tool arguments.
    if (ctx.Surface !== "webchat" || sender.senderId || ctx.SessionCreation?.via !== "operator" ||
      ctx.CommandAuthorized !== true || !ctx.GatewayClientScopes?.includes("operator.admin") ||
      ctx.OriginatingChannel && ctx.OriginatingChannel !== "webchat") throw new CatalogError("checkpoint_webchat_device_required");
    if (ctx.SessionCreation.actor !== undefined) throw new CatalogError("checkpoint_webchat_profile_conflict");
    const requesterId = deviceRequesterId(ctx.ApprovalReviewerDeviceId);
    if (!requesterId) throw new CatalogError("checkpoint_webchat_device_required");
    if (ctx.ApprovalReviewerDeviceId !== config.webchatOwnerDeviceId) throw new CatalogError("checkpoint_webchat_device_not_bound");
    return Object.freeze({ senderIsOwner: true, providerId: sender.providerId, senderId: requesterId, kind: "gateway_device" as const });
  }
  if (ctx.Provider === "webchat" && ctx.Surface === "webchat" && !sender.senderId) {
    const actor = ctx.SessionCreation?.actor;
    const profileId = ctx.SessionCreation?.via === "operator" && actor?.type === "human" && actor.source === "profile" ? actor.id : undefined;
    const requesterId = profileRequesterId(profileId);
    if (!requesterId || !ctx.GatewayClientScopes?.includes("operator.admin")) throw new CatalogError("checkpoint_webchat_profile_required");
    if (profileId !== config.webchatOwnerProfileId) throw new CatalogError("checkpoint_webchat_profile_not_bound");
    return Object.freeze({ senderIsOwner: true, providerId: sender.providerId, senderId: requesterId, kind: "gateway_profile" as const, toolSenderId: ctx.SenderId });
  }
  if (!sender.senderId || [PROFILE_PREFIX, DEVICE_PREFIX].some(prefix => sender.senderId!.startsWith(prefix))) throw new CatalogError("private_context_audience_forbidden");
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
    const deviceId = client.connect.device?.id, devicePrincipal = deviceRequesterId(deviceId);
    respond(true, { schemaVersion: "stella.identity/v1", profileStatus: requesterId ? "present" : "missing",
      ...(requesterId ? { profileId, requesterId } : {}), deviceStatus: devicePrincipal ? "present" : "missing",
      ...(devicePrincipal ? { deviceId, deviceRequesterId: devicePrincipal } : {}), clientId: client.connect.client.id,
      sourceAuthorization: "not_checked", conversationAuthorization: "not_checked" });
  }, { scope: "operator.admin", profileAccess: "independent" });
}
