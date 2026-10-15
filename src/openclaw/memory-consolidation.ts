import path from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CatalogError, CatalogReader, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { loadConsciousness, type LoadedConsciousness } from "../canghai/manifest.js";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../canghai/personal-context-access.js";
import { readRecordedMemoryTransaction, MemoryTransactionError } from "../canghai/memory-transaction.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "../canghai/host-input-archive.js";
import { HOST_REQUEST_ARCHIVE_ADAPTER } from "../canghai/host-request-archive.js";
import { learningOperationKey, prepareCorrection, recoverCorrection } from "../learning/correction.js";
import { loadOutcomeRecoveryBinding } from "../praxis/outcome-recovery-binding.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import { bindProcessingAuthority, resolveDeploymentDigest } from "./processing-authority.js";
import { snapshotTurnRequest } from "./turn-request.js";
import { withCompletionResourceReservation } from "./completion.js";
import { hostContextExecutionHash } from "./host-memory-inventory.js";
import { HOST_MEMORY_PROVIDER, readHostModelOutput, withHostModelConsumption } from "./host-memory-provider.js";
import { assertMemoryConsolidation, withMemoryConsolidation } from "./memory-consolidation-scope.js";
import { isRecord } from "../shared/type-guards.js";
import type { StellaDataMode } from "../praxis/episode-store.js";

type Config = { canghaiRoot: string; manifestPath: string; recoveryRevision: string; agentId: string; dataMode?: StellaDataMode };
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
export function parseMemoryConsolidation(value: unknown) {
  check(isRecord(value) && Object.keys(value).sort().join() === "evidenceRefs,operationId,request" &&
    typeof value.operationId === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(value.operationId) &&
    typeof value.request === "string" && value.request.trim() && value.request.length <= 8000 &&
    Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0 && value.evidenceRefs.length <= 64 &&
    value.evidenceRefs.every(ref => validMemoryRef(ref) && Object.keys(ref).length === 2) &&
    new Set(value.evidenceRefs.map(ref => canonicalJson(ref))).size === value.evidenceRefs.length,
  "invalid_memory_consolidation_request");
  return { operationId: value.operationId, request: value.request,
    evidenceRefs: value.evidenceRefs.map(ref => ({ id: ref.id, version: ref.version })) };
}

/** Explicit local maintenance. No scheduler, private Host database or native
 * Dreaming artifact is used. The ordinary learning transaction owns publication. */
export function registerMemoryConsolidation(api: OpenClawPluginApi, config: Config, ports: {
  resolveModelRef(): string; durability(loaded: LoadedConsciousness): GitCangHaiDurability;
}) {
  api.registerGatewayMethod("stella.consolidateMemory", async ({ params, client, respond, signal }) => {
    try {
      check(client?.connect.role === "operator" && client.connect.scopes?.includes("operator.admin") &&
        client.internal?.isLocalClient === true && api.runtime.config.current().gateway?.mode !== "remote", "memory_consolidation_admin_required");
      check(config.dataMode === "managed_durable_write", "critical_durability_required");
      const input = parseMemoryConsolidation(params);
      const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
      const root = await realpath(config.canghaiRoot);
      const result = await withCompletionResourceReservation(process.platform === "win32" ? root.toLowerCase() : root, async () => {
        abort.throwIfAborted();
        // Authority files must be pinned even when recovering partially written
        // business files. The exact recorded transaction is checked below.
        const recovery = await loadOutcomeRecoveryBinding(root, config.manifestPath, config.recoveryRevision);
        const { binding } = recovery;
        const operationId = learningOperationKey(input.operationId, "consolidation");
        let recorded = false;
        try {
          await readRecordedMemoryTransaction(root, operationId,
            path.posix.join(path.posix.dirname(binding.catalogPath), "operations", `${operationId}.transaction.json`));
          recorded = true;
        } catch (error) {
          if (!(error instanceof MemoryTransactionError && error.category === "pending_transaction_not_found") &&
            !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const loaded = recorded ? recovery.loaded : await loadConsciousness(root, config.manifestPath, {
          recoveryRevision: config.recoveryRevision, coreVersion: "3.0.0-alpha.0", openclawVersion: api.runtime.version, dataMode: config.dataMode,
        });
        check(binding.personalContextAccessPath, "operator_memory_consolidation_grant_required");
        const processing = await loadPersonalContextAccess(root, binding.personalContextAccessPath);
        const modelRef = ports.resolveModelRef();
        check(processing.config.operatorMemoryConsolidation === true && processing.config.requesterIds.includes(client.connect.client.id) &&
          processing.config.viewProcessingModelRefs?.includes(modelRef) && modelRef.split("/")[0] === HOST_MEMORY_PROVIDER,
        "operator_memory_consolidation_grant_required");
        const execution = hostContextExecutionHash(api.runtime.config.current(), config);
        const assertAuthority = async () => {
          abort.throwIfAborted(); await processing.assertCurrent(); await recovery.assertCurrent();
          check(ports.resolveModelRef() === modelRef && hostContextExecutionHash(api.runtime.config.current(), config) === execution,
            "memory_consolidation_configuration_changed");
          const live = api.runtime.config.current();
          const dreaming = live.plugins?.entries?.["memory-core"]?.config?.dreaming;
          check(isRecord(dreaming) && dreaming.enabled === false && live.plugins?.entries?.dreaming?.enabled !== true,
            "dreaming_disabled_required");
          abort.throwIfAborted();
        };
        await assertAuthority();
        const reader = await CatalogReader.load(root, binding.catalogPath);
        const request = snapshotTurnRequest({ agentId: config.agentId, sessionId: `consolidation:${input.operationId}`,
          sessionKey: `agent:${config.agentId}:consolidation`, prompt: input.request, senderId: client.connect.client.id,
          senderIsOwner: true, chatType: "direct" }, `consolidation_${randomUUID()}`);
        const authority = bindProcessingAuthority({ request, ownerId: processing.config.ownerId, purpose: binding.purpose, modelRef,
          deployment: resolveDeploymentDigest({ agentId: config.agentId, recoveryRevision: config.recoveryRevision, pluginSource: api.source }),
          generationId: reader.catalog.generationId });
        return withMemoryConsolidation({ request, signal: abort }, async () => {
          const assertCurrent = async () => { assertMemoryConsolidation(request); await assertAuthority(); assertMemoryConsolidation(request); };
          const complete = async ({ prompt, maxTokens, assertInputsCurrent }: {
            prompt: string; maxTokens: number; assertInputsCurrent?: () => Promise<void>;
          }) => {
            await assertCurrent();
            const params = { agentId: config.agentId, model: modelRef, purpose: "stella-memory-consolidation", temperature: 0,
              maxTokens, signal: abort, messages: [{ role: "user" as const, content: prompt }] };
            let observedText: string | undefined;
            const output = await withHostModelConsumption({ request, modelRef, params,
              assertCurrent: async () => { await assertCurrent(); await assertInputsCurrent?.(); await assertCurrent(); },
              async observeOutput(receipt) {
                const observed = readHostModelOutput(receipt);
                check(observed.request === request && observed.modelRef === modelRef && observed.message.stopReason === "stop" &&
                  observed.input.systemPrompt === "" && observed.input.tools.length === 0 && observed.input.messages.length === 1 &&
                  observed.input.messages[0]?.role === "user" && observed.input.messages[0].content === prompt,
                "memory_consolidation_model_consumption_unbound");
                observedText = observed.message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
                check(observedText.trim(), "memory_consolidation_empty_model_output");
              } }, () => api.runtime.llm.complete(params));
            await assertCurrent();
            check(observedText !== undefined && output.text === observedText && `${output.provider}/${output.model}` === modelRef,
              "memory_consolidation_model_receipt_required");
            return output;
          };
          let publishing = false;
          const sourceAccess = createPersonalContextAccess({ request, modelRef, binding: processing, processingAuthority: authority,
            signal: abort, assertRequestCurrent: () => assertMemoryConsolidation(request),
            isPersistenceRevalidation: () => publishing && !recorded, complete });
          const purpose = { ...binding.purpose, sourceAccess, evidenceCutoff: new Date().toISOString(),
            trustedAdapters: { user_report: [HOST_INPUT_ARCHIVE_ADAPTER, HOST_REQUEST_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] } };
          const common = { mode: "consolidation" as const, processingGrant: processing, ownerId: processing.config.ownerId, modelRef,
            processingAuthority: authority, assertProcessingCurrent: assertCurrent };
          const durability = ports.durability(loaded);
          if (recorded) return recoverCorrection({ ...common, root, operationId, catalogPath: binding.catalogPath,
            objectRoot: binding.archive.objectRoot, purpose, durability, signal: abort,
            requestBinding: { requestHash: bytesVersion(input.request), evidenceRefs: input.evidenceRefs } });
          const prepared = await prepareCorrection({ ...common, ...input, resolver: new EpisodeEvidenceResolver(reader, purpose,
            async () => { throw new CatalogError("memory_consolidation_source_expansion_forbidden"); }),
            objectRoot: binding.archive.objectRoot, recordedAt: new Date().toISOString(), complete });
          publishing = true;
          return { ...await prepared.persist(durability, abort), disposition: prepared.disposition, clarification: prepared.clarification };
        });
      });
      respond(true, result);
    } catch (error) {
      const category = error instanceof Error && "category" in error && typeof error.category === "string" ? error.category
        : error instanceof Error && error.name === "AbortError" ? "memory_consolidation_cancelled" : "memory_consolidation_failed";
      api.logger.error(`Stella memory consolidation: ${category}`);
      respond(false, undefined, { code: "UNAVAILABLE", message: `Stella memory consolidation failed: ${category}` });
    }
  }, { scope: "operator.admin", profileAccess: "required" });
}
