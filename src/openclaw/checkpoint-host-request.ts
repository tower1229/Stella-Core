import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookReplyDispatchEvent, PluginHookReplyDispatchContext } from "openclaw/plugin-sdk/core";
import { getSessionEntry, patchSessionEntry, loadTranscriptEventsSync, readTranscriptStatsSync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
import { isRecord } from "../shared/type-guards.js";
import { CatalogError } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { parseCheckpointPluginConfig, type CheckpointPluginConfig } from "./checkpoint-plugin-runtime.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "./turn-audience.js";
import { snapshotTurnRequest } from "./turn-request.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
/** A newly created public session may already contain its header and the exact
 * current accepted user input. Those are not prior conversation. Every other
 * record remains unknown history; the Host submission identity is mandatory.
 */
export function assertInitialOwnerTranscript(events: unknown[], request: ReturnType<typeof snapshotTurnRequest>) {
  check(events.length <= 2, "checkpoint_agent_history_owner_unknown");
  let headers = 0, inputs = 0;
  for (const event of events) {
    check(isRecord(event), "checkpoint_agent_history_owner_unknown");
    if (event.type === "session" && event.version === 3 && event.id === request.sessionId) { headers++; continue; }
    const message = event.message;
    check(event.type === "message" && isRecord(message) && message.role === "user" && message.content === request.prompt &&
      message.idempotencyKey === `${request.runId}:user` && isRecord(message.__openclaw) && message.__openclaw.senderIsOwner === true,
      "checkpoint_agent_history_owner_unknown");
    inputs++;
  }
  check(headers <= 1 && inputs <= 1, "checkpoint_agent_history_owner_unknown");
}

/** Trusted public ingress facts only; no model-supplied identity or fabricated session. */
export function captureCheckpointHostRequest(api: OpenClawPluginApi, config: CheckpointPluginConfig,
  event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext, shutdown: AbortSignal) {
  const signal = AbortSignal.any([shutdown, ...ctx.abortSignal ? [ctx.abortSignal] : []]);
  const active = () => signal.throwIfAborted();
  const sessionKey = event.sessionKey ?? event.ctx.SessionKey, timestamp = event.ctx.Timestamp, prompt = event.ctx.Body, runId = event.runId;
  check(sessionKey && runId && (timestamp === undefined || Number.isSafeInteger(timestamp) && Number(timestamp) >= 0) &&
    typeof prompt === "string" && prompt.trim(), "checkpoint_ingress_identity_missing");
  // Core receipt time is distinct from optional Host event time; neither is
  // inferred from model text or presented as the time an underlying fact occurred.
  const capturedAt = new Date().toISOString();
  const env = { OPENCLAW_STATE_DIR: api.runtime.state.resolveStateDir() };
  const facts = () => {
    active();
    check(ctx.dispatchKind === "agent" && event.sendPolicy === "allow" && !event.images?.length && !event.inboundAudio &&
      !event.isTailDispatch && !event.suppressUserDelivery && (!event.ctx.SessionKey || event.ctx.SessionKey === sessionKey) &&
      (!event.ctx.CommandTurn || event.ctx.CommandTurn.kind === "normal"), "checkpoint_ingress_unsupported");
    check(event.runId === runId && (event.sessionKey ?? event.ctx.SessionKey) === sessionKey && event.ctx.Body === prompt && event.ctx.Timestamp === timestamp, "checkpoint_ingress_request_changed");
    const live = api.runtime.config.current() as OpenClawConfig, entry = live.plugins?.entries?.["stella-core"];
    check(entry?.enabled === true && canonicalJson(parseCheckpointPluginConfig(entry.config)) === canonicalJson(config), "checkpoint_ingress_configuration_changed");
    check(entry.hooks?.allowConversationAccess === true && entry.hooks?.allowPromptInjection !== false, "checkpoint_agent_hook_permission_required");
    const sender = resolveCommandAuthorization({ ctx: event.ctx, cfg: live, commandAuthorized: event.ctx.CommandAuthorized });
    check(sender.senderIsOwner && sender.senderId && event.ctx.ChatType === "direct", "private_context_audience_forbidden");
    return { sender, storePath: resolveStorePath(live.session?.store, { agentId: config.agentId, env }) };
  };
  const first = facts(), storePath = first.storePath;
  const entry = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env, readConsistency: "latest", hydrateSkillPromptRefs: false });
  check(entry?.sessionId, "checkpoint_ingress_session_unavailable");
  const request = snapshotTurnRequest({ agentId: config.agentId, sessionId: entry.sessionId, sessionKey, prompt,
    senderId: first.sender.senderId, senderIsOwner: true, chatType: "direct", ...(timestamp === undefined ? {} : { hostMessageTimestamp: Number(timestamp) }) }, runId);
  assertPrivateContextAudience(resolveTurnAudience(request));
  const assertCurrent = async () => {
    assertPrivateContextAudience(resolveTurnAudience(request));
    const next = facts(); check(readPrincipal(next.sender) === principal, "checkpoint_ingress_request_changed");
    check(next.storePath === storePath && next.sender.senderId === request.senderId, "checkpoint_ingress_request_changed");
    const session = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env, readConsistency: "latest", hydrateSkillPromptRefs: false });
    check(session?.sessionId === request.sessionId && session.lifecycleRevision === entry.lifecycleRevision, "checkpoint_ingress_session_changed"); active();
  };
  const namespace = "owner-history/v1", scopeHash = bytesVersion(canonicalJson({ config, storePath, hostStateDirectory: env.OPENCLAW_STATE_DIR }));
  const readPrincipal = (sender: ReturnType<typeof resolveCommandAuthorization>) => canonicalJson({ senderId: sender.senderId, providerId: sender.providerId ?? null,
    surface: event.ctx.Surface ?? null, originatingChannel: event.ctx.OriginatingChannel ?? null, provider: event.ctx.Provider ?? null,
    accountId: "AccountId" in event.ctx ? event.ctx.AccountId ?? null : null });
  const principal = readPrincipal(first.sender);
  const expected = { schemaVersion: "stella.owner-history/v1", scopeHash, sessionId: request.sessionId,
    lifecycleRevision: entry.lifecycleRevision ?? null, principal };
  const sameGeneration = (value: unknown) => value && typeof value === "object" && "sessionId" in value &&
    value.sessionId === expected.sessionId && "lifecycleRevision" in value && value.lifecycleRevision === expected.lifecycleRevision;
  const assertShape = (value: unknown) => {
    check(isRecord(value) && Object.keys(value).sort().join() === "firstRunId,lifecycleRevision,principal,schemaVersion,scopeHash,sessionId" &&
      value.schemaVersion === "stella.owner-history/v1" && [value.scopeHash, value.sessionId, value.principal, value.firstRunId].every(field => typeof field === "string" && field) &&
      (value.lifecycleRevision === null || typeof value.lifecycleRevision === "string" && value.lifecycleRevision), "checkpoint_agent_history_binding_invalid");
  };
  const assertBinding = (value: unknown) => {
    assertShape(value);
    const { firstRunId: _firstRunId, ...binding } = value as Record<string, unknown>;
    check(canonicalJson(binding) === canonicalJson(expected), "checkpoint_agent_history_audience_changed");
    check(typeof _firstRunId === "string" && _firstRunId, "checkpoint_agent_history_owner_unknown");
  };
  const bindConversation = async () => {
    await assertCurrent();
    await patchSessionEntry({ agentId: config.agentId, sessionKey, storePath, env,
      preserveActivity: true, requireWriteSuccess: true, update(current) {
        active(); check(current.sessionId === expected.sessionId && (current.lifecycleRevision ?? null) === expected.lifecycleRevision, "checkpoint_ingress_session_changed");
        const previous = current.pluginExtensions?.["stella-core"]?.[namespace];
        if (previous !== undefined) assertShape(previous);
        if (sameGeneration(previous)) { assertBinding(previous); return null; }
        // Unknown pre-existing conversation is not silently adopted. A normal new
        // empty session is bound once, before the first archive or model request.
        const transcript = { agentId: config.agentId, sessionKey, sessionId: request.sessionId, storePath, env };
        check(readTranscriptStatsSync(transcript).eventCount <= 2, "checkpoint_agent_history_owner_unknown");
        assertInitialOwnerTranscript(loadTranscriptEventsSync(transcript), request);
        return { pluginExtensions: { ...current.pluginExtensions, "stella-core": { ...current.pluginExtensions?.["stella-core"],
          [namespace]: { ...expected, firstRunId: request.runId } } } };
      } });
    await assertCurrent();
    assertBinding(getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env, readConsistency: "latest", hydrateSkillPromptRefs: false })?.pluginExtensions?.["stella-core"]?.[namespace]);
  };
  const assertConversation = async (messages: unknown[]) => {
    await assertCurrent(); check(Array.isArray(messages), "checkpoint_agent_history_invalid");
    const live = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env, readConsistency: "latest", hydrateSkillPromptRefs: false });
    const binding = live?.pluginExtensions?.["stella-core"]?.[namespace]; assertBinding(binding);
    check(!(binding && typeof binding === "object" && "firstRunId" in binding && binding.firstRunId === request.runId) || messages.length === 0,
      "checkpoint_agent_history_owner_unknown");
  };
  return { request, capturedAt, signal, assertCurrent, bindConversation, assertConversation };
}
