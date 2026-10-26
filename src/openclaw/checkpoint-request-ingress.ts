import type { PluginHookReplyDispatchEvent, PluginHookReplyDispatchContext } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCheckpointRequestIdentity } from "./checkpoint-request-identity.js";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { archiveCorrectionInput } from "../learning/host-correction.js";
import { CatalogError, CatalogReader, parseMemoryCatalog, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "../canghai/host-input-archive.js";
import { HOST_REQUEST_ARCHIVE_ADAPTER } from "../canghai/host-request-archive.js";
import { loadPraxisRuntimeBinding, type PraxisRuntimeBinding } from "../praxis/runtime-binding.js";
import { snapshotTurnRequest } from "./turn-request.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "./turn-audience.js";
import { parseCheckpointPluginConfig, type createCheckpointPluginRuntime, type CheckpointPluginConfig } from "./checkpoint-plugin-runtime.js";
import { readRecordedMemoryTransaction } from "../canghai/memory-transaction.js";
import type { MemoryTransactionPlan } from "../canghai/memory-transaction-plan.js";
import { isRecord } from "../shared/type-guards.js";
import { readCheckpointCommittedDocument } from "../canghai/checkpoint-committed-document.js";
import { parseConsciousnessManifest } from "../canghai/manifest.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { parseSourcePolicy } from "../canghai/source-policy.js";
import { parse as parseYaml } from "yaml";
import type { RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import { replyCheckpointFailure } from "./checkpoint-failure-reply.js";

import type { VersionedRef } from "../praxis/episode-v2.js";

export type CheckpointRequestArchiveReceipt = Readonly<{ recovery: RecoveryReadBinding; evidenceRefs: VersionedRef[]; sourceRefs: VersionedRef[];
  capturedAt: string; requestHash: string; runId: string }>;

type Runtime = Awaited<ReturnType<typeof createCheckpointPluginRuntime>>;
type Frame = { runtime: Runtime; recovery: RecoveryReadBinding; reader: Pick<CatalogReader, "root" | "catalogPath" | "catalogHash">; binding: Pick<PraxisRuntimeBinding, "archive" | "purpose" | "catalogPath">; ownerId: string; capturedAt: string };
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Recover configuration and original expectation from this one recorded business operation.
 * Actual working bytes, parent Git commit and CAS are still authenticated by the common writer.
 * The new scope contributes its resolver/lifetime only, never its observed revision/token.
 */
async function recordedFrame(runtime: Runtime, config: CheckpointPluginConfig, plan: MemoryTransactionPlan, request: ReturnType<typeof snapshotTurnRequest>): Promise<Frame> {
  // Recover the original receive clock, not an authority, from the recorded request.
  // The common archive writer still reconstructs and authenticates the entire plan.
  const originals = plan.files.flatMap(file => {
    try { const value: unknown = JSON.parse(file.after ?? "null");
      return isRecord(value) && value.schemaVersion === "stella.host-request-snapshot/v1" &&
        canonicalJson(value.request) === canonicalJson(request) ? [value] : [];
    } catch { return []; }
  });
  check(originals.length === 1 && typeof originals[0]!.capturedAt === "string" && Number.isFinite(Date.parse(originals[0]!.capturedAt)), "checkpoint_ingress_replay_conflict");
  const capturedAt = originals[0]!.capturedAt as string;
  if (request.hostMessageTimestamp !== undefined) check(capturedAt === new Date(request.hostMessageTimestamp).toISOString(), "checkpoint_ingress_replay_conflict");
  const recovery = plan.recoveryCheckpoint;
  check(recovery && recovery.binding.repositoryRoot === config.canghaiRoot && recovery.binding.agentId === config.agentId &&
    recovery.binding.manifestPath === config.manifestPath, "checkpoint_ingress_replay_conflict");
  const committed = (file: string) => readCheckpointCommittedDocument(config.canghaiRoot, recovery.expected.revision, file);
  const relative = (ref: string) => { const value = parseCangHaiRef(ref); check(!value.fragment, "checkpoint_ingress_replay_conflict"); return value.relativePath; };
  const manifest = parseConsciousnessManifest(await committed(config.manifestPath));
  const profile = parseRuntimeProfile(parseYaml(await committed(relative(manifest.identity.runtimeProfileRef))));
  check(profile.memory, "checkpoint_ingress_replay_conflict");
  const capabilities = profile.capabilities.filter(value => value.id === (profile.contract_profile === "full_memory" ? "memory_lifecycle" : "transcript_archive"));
  check(capabilities.length === 1 && capabilities[0]!.required && capabilities[0]!.adapter_version === "1" &&
    capabilities[0]!.adapter_id === (profile.contract_profile === "full_memory" ? "stella.memory-lifecycle" : HOST_INPUT_ARCHIVE_ADAPTER), "checkpoint_ingress_replay_conflict");
  const value: unknown = JSON.parse(await committed(relative(capabilities[0]!.config_ref)));
  check(isRecord(value) && value.schemaVersion === (profile.contract_profile === "full_memory" ? "stella.memory-runtime-binding/v1" : "stella.alpha-praxis-binding/v2") &&
    isRecord(value.archive) && validMemoryRef(value.archive.policyRef) && typeof value.archive.objectRoot === "string" && typeof value.archive.payloadRoot === "string" &&
    isRecord(value.purpose), "checkpoint_ingress_replay_conflict");
  const archive = value.archive, purpose = value.purpose, policyRef = value.archive.policyRef;
  check(["readPurpose", "derivePurpose", "deliveryScope"].every(key => typeof purpose[key] === "string" && purpose[key]), "checkpoint_ingress_replay_conflict");
  const catalogPath = relative(profile.memory.catalog_ref), catalogBytes = await committed(catalogPath), catalog = parseMemoryCatalog(JSON.parse(catalogBytes));
  const entry = catalog.policies.find(entry => entry.id === policyRef.id && entry.version === policyRef.version && entry.status === "current");
  check(entry, "checkpoint_ingress_replay_conflict");
  const policyBytes = await committed(entry.locator.path), policy: unknown = JSON.parse(policyBytes);
  check(bytesVersion(policyBytes) === entry.locator.sha256 && isRecord(policy) && objectVersion(policy) === entry.version &&
    policy.id === entry.id && typeof policy.ownerId === "string" && policy.ownerId, "checkpoint_ingress_replay_conflict");
  parseSourcePolicy(policy);
  const fresh = await runtime.capture();
  return { runtime, recovery: Object.freeze({ resolver: fresh.resolver, expected: Object.freeze({ mode: "core_checkpoint", binding: Object.freeze({ ...recovery.binding }),
    revision: recovery.expected.revision, token: recovery.expected.token }) }),
    reader: { root: config.canghaiRoot, catalogPath, catalogHash: bytesVersion(catalogBytes) }, ownerId: policy.ownerId, capturedAt,
    binding: { catalogPath, archive: { policyRef: value.archive.policyRef, objectRoot: value.archive.objectRoot, payloadRoot: value.archive.payloadRoot },
      purpose: { readPurpose: String(purpose.readPurpose), derivePurpose: String(purpose.derivePurpose), deliveryScope: String(purpose.deliveryScope) } } };
}

/** Public Host ingress → existing business archive writer. Standalone retention or
 * a phase before stock Agent supply; no transcript, delivery or full_memory claim.
 */
export function registerCheckpointRequestIngress(api: OpenClawPluginApi, config: CheckpointPluginConfig, current: () => Promise<Runtime>) {
  const shutdown = new AbortController(), frames = new Map<string, { identity: string; prepared: Promise<Frame>; users: number }>();
  let last: { state: "local_committed" | "blocked"; revision?: string; category?: string; runId?: string; operationId?: string; capturedAtSource?: "host_timestamp" | "core_receive_clock" } | null = null;
  if (config.requestArchive !== "local") return { close() { shutdown.abort(); }, status: () => last, dispatch: async (_event: PluginHookReplyDispatchEvent, _ctx: PluginHookReplyDispatchContext) => undefined };
  const continueAgent = config.agentMemory === "fresh_tools";
  const hostEnvironment = { OPENCLAW_STATE_DIR: api.runtime.state.resolveStateDir() };
  const dispatch = async (event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext) => {
    const sessionKey = event.sessionKey ?? event.ctx.SessionKey;
    if (!sessionKey || parseAgentSessionKey(sessionKey)?.agentId !== config.agentId) return;
    // Host reset and other commands retain their own parser/lifecycle; they are not owner input archives.
    if (event.ctx.CommandTurn && event.ctx.CommandTurn.kind !== "normal") return;
    const cancellation = AbortSignal.any([shutdown.signal, ...ctx.abortSignal ? [ctx.abortSignal] : []]);
    const active = () => { cancellation.throwIfAborted(); };
    let releaseFrame: (() => void) | undefined, failed = false;
    try {
      active();
      check(ctx.dispatchKind === "agent" && event.sendPolicy === "allow" && !event.images?.length && !event.inboundAudio &&
        !event.isTailDispatch && !event.suppressUserDelivery && event.runId &&
        (!event.ctx.SessionKey || event.ctx.SessionKey === sessionKey), "checkpoint_ingress_unsupported");
      const timestamp = event.ctx.Timestamp;
      check((timestamp === undefined || Number.isSafeInteger(timestamp) && Number(timestamp) >= 0) && typeof event.ctx.Body === "string" && event.ctx.Body.trim(), "checkpoint_ingress_identity_missing");
      const runId = event.runId!, prompt = event.ctx.Body!;
      // This is Core receipt time when the public envelope omits Host event time.
      const capturedAt = new Date(timestamp === undefined ? Date.now() : Number(timestamp)).toISOString();
      const readFacts = () => {
        active();
        check(ctx.dispatchKind === "agent" && event.sendPolicy === "allow" && !event.images?.length && !event.inboundAudio &&
          !event.isTailDispatch && !event.suppressUserDelivery && (!event.ctx.SessionKey || event.ctx.SessionKey === sessionKey) &&
          (!event.ctx.CommandTurn || event.ctx.CommandTurn.kind === "normal"), "checkpoint_ingress_request_changed");
        check(event.runId === runId && (event.sessionKey ?? event.ctx.SessionKey) === sessionKey && event.ctx.Body === prompt && event.ctx.Timestamp === timestamp,
          "checkpoint_ingress_request_changed");
        const live = api.runtime.config.current() as OpenClawConfig;
        const entry = live.plugins?.entries?.["stella-core"];
        check(entry?.enabled === true && canonicalJson(parseCheckpointPluginConfig(entry.config)) === canonicalJson(config), "checkpoint_ingress_configuration_changed");
        const sender = resolveCheckpointRequestIdentity(event.ctx, live, config);
        check(sender.senderIsOwner && sender.senderId && event.ctx.ChatType === "direct", "private_context_audience_forbidden");
        return { live, sender, storePath: resolveStorePath(live.session?.store, { agentId: config.agentId, env: hostEnvironment }) };
      };
      const first = readFacts(), storePath = first.storePath;
      const entry = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env: hostEnvironment, readConsistency: "latest", hydrateSkillPromptRefs: false });
      check(entry?.sessionId, "checkpoint_ingress_session_unavailable");
      const request = snapshotTurnRequest({ agentId: config.agentId, sessionId: entry!.sessionId, sessionKey,
        prompt, senderId: first.sender.senderId, senderIsOwner: true, chatType: "direct", ...(timestamp === undefined ? {} : { hostMessageTimestamp: Number(timestamp) }) }, runId);
      assertPrivateContextAudience(resolveTurnAudience(request));
      const assertScope = async () => {
        const facts = readFacts();
        check(facts.storePath === storePath && facts.sender.senderId === request.senderId, "checkpoint_ingress_request_changed");
        const session = getSessionEntry({ agentId: config.agentId, sessionKey, storePath, env: hostEnvironment, readConsistency: "latest", hydrateSkillPromptRefs: false });
        check(session?.sessionId === request.sessionId, "checkpoint_ingress_session_changed"); active();
      };
      const key = canonicalJson([config.agentId, sessionKey, runId]), identity = bytesVersion(canonicalJson(request));
      let frame = frames.get(key);
      if (frame) check(frame.identity === identity, "checkpoint_ingress_replay_conflict");
      else {
        // Bound concurrent distinct requests. Completed originals, receive clocks
        // and expected tuples are recovered from the existing Git/journal path.
        check(frames.size < 256, "checkpoint_ingress_capacity");
        const prepared = (async (): Promise<Frame> => {
          const runtime = await current(); await assertScope();
          const operationId = `correction_archive_${bytesVersion(canonicalJson([request.agentId, request.sessionKey, request.runId])).slice(7)}`;
          let pending: MemoryTransactionPlan | undefined;
          try { pending = await readRecordedMemoryTransaction(config.canghaiRoot, operationId); }
          catch (error) { if (!(error && typeof error === "object" && "category" in error && error.category === "pending_transaction_not_found")) throw error; }
          if (pending) return recordedFrame(runtime, config, pending, request);
          const loaded = await runtime.load();
          const binding = await loadPraxisRuntimeBinding(loaded.loaded, { sourceSupplyOnly: true }); await runtime.assert(loaded.recovery); await assertScope();
          const journalPath = `${binding.catalogPath.includes("/") ? binding.catalogPath.slice(0, binding.catalogPath.lastIndexOf("/")) + "/" : ""}operations/${operationId}.checkpoint.json`;
          let completed: MemoryTransactionPlan | undefined;
          try { completed = await readRecordedMemoryTransaction(config.canghaiRoot, operationId, journalPath); }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT") &&
                !(error && typeof error === "object" && "category" in error && error.category === "pending_transaction_not_found")) throw error;
          }
          if (completed) return recordedFrame(runtime, config, completed, request);
          const reader = await CatalogReader.load(config.canghaiRoot, binding.catalogPath), policy = await reader.read(binding.archive.policyRef, "policies");
          check(typeof policy.ownerId === "string" && policy.ownerId, "archive_permission_denied");
          await reader.assertCurrent(); await runtime.assert(loaded.recovery);
          return { runtime, recovery: loaded.recovery, reader, binding, ownerId: String(policy.ownerId), capturedAt };
        })();
        frame = { identity, prepared, users: 0 }; frames.set(key, frame);
      }
      const held = frame; held.users++;
      releaseFrame = () => {
        held.users--;
        if (held.users === 0 && frames.get(key) === held) frames.delete(key);
      };
      const prepared = await held.prepared; await assertScope();
      const result = await archiveCorrectionInput({ request, original: { schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: prepared.capturedAt },
        ownerId: prepared.ownerId, reader: prepared.reader, archive: prepared.binding.archive,
        purpose: { ...prepared.binding.purpose, evidenceCutoff: prepared.capturedAt,
          trustedAdapters: { user_report: [HOST_REQUEST_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] } },
        signal: cancellation, assertCurrent: assertScope,
        checkpoint: { runtime: prepared.runtime, recovery: prepared.recovery, async assertPublication(accepted) {
          await assertScope(); await prepared.runtime.assert({ resolver: prepared.recovery.resolver, expected: accepted });
        } },
      });
      active(); last = { state: "local_committed", revision: result.revision, runId, operationId: result.operationId,
        capturedAtSource: timestamp === undefined ? "core_receive_clock" : "host_timestamp" };
      if (continueAgent) {
        check(result.recovery, "checkpoint_agent_archive_receipt_missing");
        const archive: CheckpointRequestArchiveReceipt = Object.freeze({ recovery: result.recovery,
          evidenceRefs: structuredClone(result.evidenceRefs), sourceRefs: structuredClone(result.sourceRefs),
          capturedAt: prepared.capturedAt, requestHash: request.requestHash, runId: request.runId });
        return { recovery: result.recovery, archive };
      }
      try { ctx.recordProcessed("skipped", { reason: "stella_owner_ingress_archived_no_agent" }); } catch { /* Diagnostics never release the default model path. */ }
    } catch (error) {
      failed = true;
      const category = error && typeof error === "object" && "category" in error && typeof error.category === "string" ? error.category :
        cancellation.aborted ? "operation_cancelled" : "checkpoint_ingress_failed";
      last = { state: "blocked", category };
      try { ctx.recordProcessed("error", { reason: category }); } catch { /* Keep the explicit handled result. */ }
      return await replyCheckpointFailure(event, ctx, cancellation);
    } finally {
      releaseFrame?.();
      if (!continueAgent && !failed) try { ctx.markIdle("Stella archive-only ingress settled"); } catch { /* Hook exceptions must not create fail-open dispatch. */ }
    }
    // The stock hook runner can fail open on a thrown error; return ownership explicitly.
    // The general before_agent_run blocker remains in place for other paths/timeouts.
    return { handled: true as const, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  };
  if (!continueAgent) api.on("reply_dispatch", async (event, ctx) => {
    const result = await dispatch(event, ctx); return result && "recovery" in result ? undefined : result;
  }, { priority: 2_000, eligibleDispatchKinds: ["agent"] });
  return { close() { shutdown.abort(); frames.clear(); }, status: () => last, dispatch };
}
