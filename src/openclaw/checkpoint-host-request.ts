import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookReplyDispatchEvent, PluginHookReplyDispatchContext } from "openclaw/plugin-sdk/core";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
import { CatalogError } from "../canghai/catalog-reader.js";
import { canonicalJson } from "../canghai/content-version.js";
import { parseCheckpointPluginConfig, type CheckpointPluginConfig } from "./checkpoint-plugin-runtime.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "./turn-audience.js";
import { snapshotTurnRequest } from "./turn-request.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
/** Trusted public ingress facts only; no model-supplied identity or fabricated session. */
export function captureCheckpointHostRequest(api: OpenClawPluginApi, config: CheckpointPluginConfig,
  event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext, shutdown: AbortSignal) {
  const signal = AbortSignal.any([shutdown, ...ctx.abortSignal ? [ctx.abortSignal] : []]);
  const active = () => signal.throwIfAborted();
  const sessionKey = event.sessionKey ?? event.ctx.SessionKey, timestamp = event.ctx.Timestamp, prompt = event.ctx.Body, runId = event.runId;
  check(sessionKey && runId && Number.isSafeInteger(timestamp) && Number(timestamp) >= 0 && typeof prompt === "string" && prompt.trim(), "checkpoint_ingress_identity_missing");
  const capturedAt = new Date(Number(timestamp)).toISOString();
  const env = { OPENCLAW_STATE_DIR: api.runtime.state.resolveStateDir() };
  const facts = () => {
    active();
    check(ctx.dispatchKind === "agent" && event.sendPolicy === "allow" && !event.images?.length && !event.inboundAudio &&
      !event.isTailDispatch && !event.suppressUserDelivery && (!event.ctx.SessionKey || event.ctx.SessionKey === sessionKey) &&
      (!event.ctx.CommandTurn || event.ctx.CommandTurn.kind === "normal"), "checkpoint_ingress_unsupported");
    check(event.runId === runId && (event.sessionKey ?? event.ctx.SessionKey) === sessionKey && event.ctx.Body === prompt && event.ctx.Timestamp === timestamp, "checkpoint_ingress_request_changed");
    const live = api.runtime.config.current() as OpenClawConfig, entry = live.plugins?.entries?.["stella-core"];
    check(entry?.enabled === true && canonicalJson(parseCheckpointPluginConfig(entry.config)) === canonicalJson(config), "checkpoint_ingress_configuration_changed");
    const sender = resolveCommandAuthorization({ ctx: event.ctx, cfg: live, commandAuthorized: event.ctx.CommandAuthorized });
    check(sender.senderIsOwner && sender.senderId && event.ctx.ChatType === "direct", "private_context_audience_forbidden");
    return { sender, storePath: resolveStorePath(live.session?.store, { agentId: config.agentId, env }) };
  };
  const first = facts(), storePath = first.storePath;
  const entry = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env, readConsistency: "latest", hydrateSkillPromptRefs: false });
  check(entry?.sessionId, "checkpoint_ingress_session_unavailable");
  const request = snapshotTurnRequest({ agentId: config.agentId, sessionId: entry.sessionId, sessionKey, prompt,
    senderId: first.sender.senderId, senderIsOwner: true, chatType: "direct", hostMessageTimestamp: Number(timestamp) }, runId);
  assertPrivateContextAudience(resolveTurnAudience(request));
  const assertCurrent = async () => {
    assertPrivateContextAudience(resolveTurnAudience(request));
    const next = facts(); check(next.storePath === storePath && next.sender.senderId === request.senderId, "checkpoint_ingress_request_changed");
    const session = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env, readConsistency: "latest", hydrateSkillPromptRefs: false });
    check(session?.sessionId === request.sessionId, "checkpoint_ingress_session_changed"); active();
  };
  return { request, capturedAt, signal, assertCurrent };
}
