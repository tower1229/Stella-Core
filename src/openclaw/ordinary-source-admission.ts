import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent } from "openclaw/plugin-sdk/core";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { CatalogError, readRepositoryBytes, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { parseConsciousnessManifest } from "../canghai/manifest.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { createPersonalContextAccess, loadPersonalContextAccess, readPersonalContextAccessBinding } from "../canghai/personal-context-access.js";
import { sourceAccessKey } from "../canghai/source-access.js";
import { sourceSegments, assertEvidenceSegment, segmentLocator } from "../canghai/source-segments.js";
import { assertPersonalSourceMetadata } from "../praxis/personal-views.js";
import { bindProcessingAuthority, assertProcessingStage } from "./processing-authority.js";
import { snapshotTurnRequest } from "./turn-request.js";
import type { createCurrentInputMetadata } from "./current-input-metadata.js";
import { SOURCE_READ_TOOL, type SourceReadAdmission, type SourceReadBinding } from "./ordinary-source-read.js";

export const SOURCE_POLICY_MODEL = "google/gemini-3.8-flash";
export type SourcePolicyCompletion = (input: { prompt: string; maxTokens: number; signal?: AbortSignal }) => Promise<{ text: string }>;
export type GatewayRequestScopeReader = typeof getPluginRuntimeGatewayRequestScope;
type GatewayPrincipal = { id: string; connection: string; assertIdentity(): void };
type Identity = { agentId?: string; sessionKey?: string; sessionId?: string };
type Call = Identity & { runId: string; senderId: string; signal?: AbortSignal; conflict: boolean; release(): void };
type Turn = { sessionKey: string; rawText: string; senderId: string; gateway?: GatewayPrincipal; cutoff: string; conflict: boolean; calls: Set<string>; release(): void };
type ToolEvent = { toolName: string; toolCallId?: string; runId?: string };
type ToolContext = Identity & ToolEvent & { abortSignal?: AbortSignal; requester?: { senderId?: string; senderIsOwner?: boolean } };
const run = promisify(execFile);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new CatalogError(code); }

/** Identity from the genuine public Gateway scope, not client-supplied fields.
 * Only the initial capture uses live transport admission. An admitted run keeps
 * its native/v2 lifetime; a completed RPC is not a newly invented revocation. */
function gatewayPrincipal(read: GatewayRequestScopeReader): GatewayPrincipal | undefined {
  const scope = read(), client = scope?.client, internal = client?.internal;
  check(!internal?.syntheticClient && !internal?.agentToolCaller && !internal?.agentRuntimeIdentity &&
    !internal?.pluginSubagentRequester, "source_gateway_delegated_principal_forbidden");
  // Normal channel/CLI ingress continues to use its Host-supplied sender. A
  // Control UI scope must qualify completely; it cannot fall back to SenderId.
  if (internal?.authenticatedControlUi !== true && !scope?.isWebchatConnect?.(client?.connect)) return;
  const profileId = client?.authenticatedUserProfile?.profileId, connection = client?.connId;
  const live = scope?.hasCurrentClientAuthority;
  check(client && internal?.authenticatedControlUi === true &&
    (text(client.authenticatedUserId) || internal.authenticatedOperator === true) &&
    text(profileId) && text(connection) && typeof live === "function" && live.call(scope) === true &&
    !scope?.signal?.aborted && !client.connectionSignal?.aborted && !client.invalidated,
  "source_gateway_principal_unavailable");
  const assertIdentity = () => {
    const flags = client.internal;
    check(client.connId === connection && client.authenticatedUserProfile?.profileId === profileId &&
      flags?.authenticatedControlUi === true && !flags.syntheticClient && !flags.agentToolCaller &&
      !flags.agentRuntimeIdentity && !flags.pluginSubagentRequester, "source_gateway_principal_changed");
    const current = read()?.client, currentFlags = current?.internal;
    check(current?.connId === connection && current.authenticatedUserProfile?.profileId === profileId &&
      currentFlags?.authenticatedControlUi === true && !currentFlags.syntheticClient && !currentFlags.agentToolCaller &&
      !currentFlags.agentRuntimeIdentity && !currentFlags.pluginSubagentRequester, "source_gateway_scope_mismatch");
  };
  assertIdentity();
  return { id: profileId, connection, assertIdentity };
}
function relativeRef(value: string) {
  const ref = parseCangHaiRef(value);
  check(!ref.fragment && !ref.relativePath.split("/").some(p => p === ".." || p.toLowerCase() === ".git"), "source_processing_reference_invalid");
  return ref.relativePath;
}

/** Load only the selected profile's existing grant. No bootstrap, grant creation
 * or adoption of the current checkout as a newly authorized revision. */
async function processingBinding(binding: SourceReadBinding, guard: () => void) {
  guard(); check(await realpath(binding.root) === binding.root, "source_root_not_canonical"); guard();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = async (args: string[], binary = false) => {
    guard(); const result = await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", binding.root, ...args],
      { env, encoding: binary ? "buffer" : "utf8", maxBuffer: 2 * 1024 * 1024 }); guard(); return result.stdout;
  };
  const selected = async () => {
    check(String(await git(["rev-parse", "HEAD"])).trim() === binding.revision, "source_revision_mismatch");
    check(String(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) === "", "source_repository_dirty");
  };
  await selected();
  const document = async (path: string) => {
    guard(); const bytes = await readRepositoryBytes(binding.root, path); guard();
    check(bytes.length <= 256_000, "source_processing_document_capacity");
    check(bytesVersion(await git(["cat-file", "blob", `${binding.revision}:${path}`], true) as Buffer) === bytesVersion(bytes), "source_git_blob_mismatch");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const manifest = parseConsciousnessManifest(await document(binding.manifestPath));
  const profilePath = relativeRef(manifest.identity.runtimeProfileRef);
  check(manifest.runtimeState.runtimeProfileRef === undefined || relativeRef(manifest.runtimeState.runtimeProfileRef) === profilePath, "source_profile_reference_conflict");
  const profile = parseRuntimeProfile(parseYaml(await document(profilePath)));
  check(profile.agent_id === "main" && profile.memory, "source_profile_binding_mismatch");
  const capabilities = profile.capabilities.filter(c => c.id === "source_access_context" && c.adapter_id === "stella.personal-context-access");
  check(capabilities.length === 1, "source_processing_binding_unavailable");
  const path = relativeRef(capabilities[0]!.config_ref), grantText = await document(path);
  const loaded = await loadPersonalContextAccess(binding.root, path); guard();
  const receipt = await readPersonalContextAccessBinding(loaded); guard();
  check(receipt.sha256 === bytesVersion(grantText), "personal_context_access_changed");
  const config = loaded.config;
  check(config.requesterIds.length === 1 && config.modelRefs.includes(SOURCE_POLICY_MODEL) &&
    canonicalJson(config.purpose) === canonicalJson({ readPurpose: "personal_context", derivePurpose: "personal_understanding", deliveryScope: "owner-direct" }), "source_processing_scope_mismatch");
  await selected();
  return { loaded, catalogPath: relativeRef(profile.memory.catalog_ref) };
}

/** Ordinary public callbacks -> existing source processing checks. This stores
 * bounded current-turn references only; it neither issues identities nor grants. */
export function createOrdinarySourceAdmission(input: {
  agentId: string; metadata: ReturnType<typeof createCurrentInputMetadata>; complete: SourcePolicyCompletion;
  getGatewayRequestScope?: GatewayRequestScopeReader;
}) {
  const turns = new Map<string, Turn>(), calls = new Map<string, Call>();
  const discardCall = (id: string) => { const call = calls.get(id); if (call) { calls.delete(id); call.release(); } };
  const discardTurn = (id: string, turn: Turn) => {
    if (turns.get(id) !== turn) return;
    turns.delete(id); turn.release();
    for (const [callId, call] of calls) if (call.runId === id) discardCall(callId);
  };
  return {
    observeDispatch(event: PluginHookReplyDispatchEvent, context: PluginHookReplyDispatchContext) {
      const ctx = event.ctx, runId = event.runId, sessionKey = event.sessionKey;
      const rawText = ctx.rawText, transportSender = ctx.SenderId, signal = context.abortSignal;
      let gateway: GatewayPrincipal | undefined;
      try { gateway = gatewayPrincipal(input.getGatewayRequestScope ?? getPluginRuntimeGatewayRequestScope); }
      catch { const previous = turns.get(runId ?? ""); if (previous) previous.conflict = true; return; }
      const senderId = gateway?.id ?? transportSender;
      if (input.agentId !== "main" || context.dispatchKind !== "agent" || ctx.AgentId !== input.agentId ||
          !text(runId) || !text(sessionKey) || ctx.SessionKey !== sessionKey || !text(senderId) ||
          (gateway && transportSender !== undefined && transportSender !== gateway.id) ||
          typeof rawText !== "string" || !rawText.trim() || rawText.length > 16_000 || ctx.ChatType !== "direct" || ctx.InternalTurnSource !== undefined || !signal || signal.aborted) return;
      const previous = turns.get(runId);
      if (previous) {
        if (previous.sessionKey !== sessionKey || previous.rawText !== rawText || previous.senderId !== senderId ||
            previous.gateway?.connection !== gateway?.connection) previous.conflict = true;
        return;
      }
      if (turns.size >= 32) return;
      const discard = () => discardTurn(runId, turn);
      const turn: Turn = { sessionKey, rawText, senderId, gateway, cutoff: new Date().toISOString(), conflict: false, calls: new Set(),
        release: () => signal.removeEventListener("abort", discard) };
      turns.set(runId, turn); signal.addEventListener("abort", discard, { once: true });
    },
    observeTool(event: ToolEvent, context: ToolContext) {
      if (event.toolName !== SOURCE_READ_TOOL || context.toolName !== SOURCE_READ_TOOL) return;
      const callId = context.toolCallId, runId = context.runId, requester = context.requester;
      if (!text(callId) || event.toolCallId !== callId || !text(runId) || event.runId !== runId ||
          context.agentId !== input.agentId || !text(context.sessionKey) || !text(context.sessionId)) return "source_request_admission_unavailable";
      const previous = calls.get(callId), turn = turns.get(runId);
      if (previous) { previous.conflict = true; return "source_call_ambiguous"; }
      if (!turn || turn.conflict || turn.sessionKey !== context.sessionKey || turn.calls.has(callId)) return "source_request_binding_mismatch";
      if (turn.gateway) {
        try { turn.gateway.assertIdentity(); } catch { turn.conflict = true; return "source_gateway_principal_changed"; }
        if (requester && (requester.senderIsOwner !== true || requester.senderId !== undefined && requester.senderId !== turn.senderId)) return "source_requester_or_audience_forbidden";
      } else if (requester?.senderIsOwner !== true || requester.senderId !== turn.senderId) return "source_request_admission_unavailable";
      if (context.abortSignal?.aborted || calls.size >= 128 || turn.calls.size >= 128) return "source_call_unavailable";
      const signal = context.abortSignal;
      const discard = () => discardCall(callId);
      calls.set(callId, { agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId, runId,
        senderId: turn.senderId, signal, conflict: false, release: () => signal?.removeEventListener("abort", discard) });
      signal?.addEventListener("abort", discard, { once: true });
    },
    end(event: { runId?: string }, context: Identity & { runId?: string }) {
      if (!text(event.runId) || event.runId !== context.runId || context.agentId !== input.agentId) return;
      const turn = turns.get(event.runId);
      if (!turn || turn.sessionKey !== context.sessionKey) return;
      discardTurn(event.runId, turn);
    },
    forFactory(context: OpenClawPluginToolContext<2>) {
      const identity = { agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId };
      const senderId = context.requesterSenderId, owner = context.senderIsOwner, audience = context.memoryAudience;
      const audienceSnapshot = audience ? structuredClone(audience) : undefined, modelRef = context.activeModel?.modelRef;
      const originalGuard = context.assertInvocationCurrent.bind(context);
      const audienceGuard = context.assertMemoryAudienceCurrent?.bind(context);
      return async (binding: SourceReadBinding, callId: string, signal?: AbortSignal): Promise<SourceReadAdmission> => {
        const call = calls.get(callId); discardCall(callId);
        check(call && !call.conflict && !call.signal?.aborted, "source_request_admission_unavailable");
        const turn = turns.get(call.runId);
        check(turn && !turn.conflict && !turn.calls.has(callId), "source_request_binding_mismatch");
        turn.calls.add(callId);
        const guard = () => {
          originalGuard(); audienceGuard?.(); signal?.throwIfAborted(); call.signal?.throwIfAborted();
          check(turns.get(call.runId) === turn && !turn.conflict && context.agentId === identity.agentId &&
            context.sessionKey === identity.sessionKey && context.sessionId === identity.sessionId &&
            call.agentId === identity.agentId && call.sessionKey === identity.sessionKey && call.sessionId === identity.sessionId,
          "source_request_binding_mismatch");
          try { turn.gateway?.assertIdentity(); }
          catch (error) { turn.conflict = true; throw error; }
          const senderMatches = turn.gateway ? senderId === undefined || senderId === turn.senderId : text(senderId) && senderId === turn.senderId;
          check(input.agentId === "main" && owner === true && context.senderIsOwner === owner && senderMatches &&
            context.requesterSenderId === senderId && call.senderId === turn.senderId &&
            audienceSnapshot?.kind === "owner-private" && audienceSnapshot.agentId === input.agentId &&
            canonicalJson(context.memoryAudience) === canonicalJson(audienceSnapshot), "source_requester_or_audience_forbidden");
          check(modelRef === SOURCE_POLICY_MODEL && context.activeModel?.modelRef === modelRef, "personal_context_model_forbidden");
          const native = input.metadata.inspect(call.runId, identity);
          check(native.status === "observed", "source_native_admission_unavailable");
        };
        guard();
        const processing = await processingBinding(binding, guard); guard();
        const config = processing.loaded.config;
        check(config.requesterIds[0] === turn.senderId, "personal_context_requester_forbidden");
        const request = snapshotTurnRequest({ agentId: identity.agentId!, sessionId: identity.sessionId!, sessionKey: identity.sessionKey!,
          prompt: turn.rawText, senderId: turn.senderId, senderIsOwner: true, chatType: "direct" }, call.runId);
        const authority = bindProcessingAuthority({ request, ownerId: config.ownerId, modelRef: SOURCE_POLICY_MODEL,
          purpose: config.purpose, deployment: bytesVersion(canonicalJson(binding)), generationId: binding.revision });
        const sourceAccess = createPersonalContextAccess({ request, modelRef: SOURCE_POLICY_MODEL, binding: processing.loaded,
          assertRequestCurrent: guard, reuseWithinRequest: true, signal, processingAuthority: authority,
          complete: async params => { guard(); const value = await input.complete(params); guard(); return value; } });
        const descriptors = new Set(config.descriptors.map(sourceAccessKey));
        return { assertCurrent: guard,
          purpose: { ...config.purpose, evidenceCutoff: turn.cutoff, trustedAdapters: { user_report: [], tool_observation: [], system_event: [] }, sourceAccess },
          async assertMetadata(reader, ref) {
            guard(); await processing.loaded.assertCurrent(); guard();
            check(reader.root === binding.root && reader.catalogPath === processing.catalogPath, "source_processing_catalog_mismatch");
            const evidence = await reader.read(ref, "evidence"); guard();
            check(validMemoryRef(evidence.source) && validMemoryRef(evidence.policyRef), "invalid_evidence");
            const source = await reader.read(evidence.source, "sources"); guard();
            check(validMemoryRef(source.policyRef), "invalid_source");
            const segment = assertEvidenceSegment(sourceSegments(source), evidence);
            const policies = [evidence.policyRef, source.policyRef];
            if (!policies.every(policyRef => descriptors.has(sourceAccessKey({ sourceRef: evidence.source as typeof ref, policyRef,
              ...(segment ? { segment: segmentLocator(segment) } : {}) })))) return false;
            await assertPersonalSourceMetadata({ reader, sourceRef: evidence.source, ownerId: config.ownerId, processingAuthority: authority });
            const leafPolicy = await reader.read(evidence.policyRef, "policies"); guard();
            check(leafPolicy.ownerId === config.ownerId, "personal_context_owner_mismatch");
            assertProcessingStage(authority, leafPolicy, "derive");
            guard();
          } };
      };
    },
  };
}
