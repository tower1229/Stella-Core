import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { parse as parseYaml } from "yaml";
import { CatalogError, CatalogReader, readRepositoryBytes, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { loadConsciousness } from "../canghai/manifest.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { parseNativeMemoryOrigin } from "../canghai/native-memory-origin.js";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../canghai/personal-context-access.js";
import { loadPraxisRuntimeBinding } from "../praxis/runtime-binding.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import type { CapabilityHostBinding } from "../acceptance/capability-receipt.js";
import { isRecord } from "../shared/type-guards.js";
import { withCompletionResourceReservation } from "./completion.js";
import { createFragmentReadTool, readFragmentToolResult } from "./fragment-read-tool.js";
import { createNativeMemoryReader } from "./native-memory-reader.js";
import { createNativeQueryEmbedding } from "./native-query-embedding.js";
import { bindProcessingAuthority, assertProcessingStage } from "./processing-authority.js";
import { snapshotTurnRequest } from "./turn-request.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "./turn-audience.js";
import { HOST_MEMORY_PROVIDER, readHostModelOutput, withHostModelConsumption, type HostModelOutputReceipt } from "./host-memory-provider.js";
import { assertHostMemoryVerification, hostMemoryVerification, withHostMemoryVerification } from "./host-memory-verification.js";
import { hostMemoryConfigurationHash } from "./host-memory-inventory.js";
import type { StellaDataMode } from "../praxis/episode-store.js";

export const HOST_MEMORY_ACCEPTANCE_CASES = "host-memory-access:explicit-operator-grant,source-verdict-output,native-fragment,memory-core,session-memory,wiki-claim-cache,vector-cache-binding,query-processing-consumption,guarded-direct-consumption:v4";
type Config = { canghaiRoot: string; manifestPath: string; recoveryRevision: string; agentId: string; dataMode?: StellaDataMode };
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

export function parseHostMemoryAcceptance(value: unknown) {
  check(isRecord(value) && Object.keys(value).sort().join() === (value.queryEmbedding === undefined ? "evidenceRef,request,schemaVersion" : "evidenceRef,queryEmbedding,request,schemaVersion") &&
    (value.queryEmbedding === undefined || value.queryEmbedding === true) &&
    value.schemaVersion === "stella.host-memory-acceptance/v1" && validMemoryRef(value.evidenceRef) &&
    typeof value.request === "string" && value.request.trim() && value.request.length <= 8000, "invalid_host_memory_acceptance");
  return { evidenceRef: { ...value.evidenceRef }, request: value.request, ...(value.queryEmbedding === true ? { queryEmbedding: true } : {}) };
}

/** A single explicitly configured verification target, never a retrieval ranking
 * algorithm or ordinary full_memory admission. No business writes or delivery. */
export function createHostMemoryAcceptance(api: OpenClawPluginApi, config: Config) {
  const load = async () => {
    const live = structuredClone(api.runtime.config.current()) as OpenClawConfig;
    const plugin = live.plugins?.entries?.["stella-core"];
    check(plugin?.enabled && plugin.config?.canghaiRoot === config.canghaiRoot && plugin.config.agentId === config.agentId &&
      typeof plugin.config.recoveryRevision === "string", "host_memory_acceptance_configuration_changed");
    check(live.plugins?.entries?.["memory-core"]?.config?.dreaming &&
      isRecord(live.plugins.entries["memory-core"].config!.dreaming) &&
      live.plugins.entries["memory-core"].config!.dreaming.enabled === false, "dreaming_disabled_required");
    const loaded = await loadConsciousness(config.canghaiRoot, config.manifestPath, {
      recoveryRevision: plugin.config.recoveryRevision, coreVersion: "3.0.0-alpha.0", openclawVersion: api.runtime.version, dataMode: config.dataMode,
    });
    const document = loaded.bootstrapDocuments.find(item => item.field === "identity.runtimeProfileRef");
    check(document, "runtime_profile_required");
    const profile = parseRuntimeProfile(parseYaml(document.content));
    check(profile.contract_profile === "full_memory", "full_memory_profile_required");
    const capability = profile.capabilities.find(item => item.id === "memory_access");
    check(capability?.required && capability.adapter_id === "stella.memory-access" && capability.adapter_version === "1",
      "host_memory_acceptance_capability_required");
    const ref = parseCangHaiRef(capability.config_ref);
    check(!ref.fragment, "invalid_host_memory_acceptance");
    const bytes = await readRepositoryBytes(config.canghaiRoot, ref.relativePath);
    check(bytes.length <= 256_000, "host_memory_acceptance_budget_exhausted");
    const specification = parseHostMemoryAcceptance(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const binding = await loadPraxisRuntimeBinding(loaded);
    check(binding.personalContextAccessPath, "operator_memory_acceptance_grant_required");
    const processing = await loadPersonalContextAccess(config.canghaiRoot, binding.personalContextAccessPath);
    const reader = await CatalogReader.load(config.canghaiRoot, binding.catalogPath);
    const evidence = await reader.read(specification.evidenceRef, "evidence");
    check(validMemoryRef(evidence.source), "invalid_evidence");
    const source = await reader.read(evidence.source, "sources");
    const origin = parseNativeMemoryOrigin(source.nativeMemory);
    check(origin.agentId === config.agentId && origin.hostVersion === api.runtime.version,
      "host_memory_acceptance_origin_unsupported");
    check(origin.provider !== "memory-wiki" || origin.claimId !== undefined, "host_memory_acceptance_claim_required");
    const selected = resolveDefaultModelForAgent({ cfg: live, agentId: config.agentId });
    const modelRef = `${selected.provider}/${selected.model}`;
    check(selected.provider === HOST_MEMORY_PROVIDER, "host_memory_guarded_provider_required");
    const routes = [live.agents?.defaults?.model, live.agents?.entries?.[config.agentId]?.model,
      live.agents?.list?.find(agent => agent.id === config.agentId)?.model];
    check(!routes.some(route => route && typeof route !== "string" && route.fallbacks?.length), "personal_view_fallback_route_forbidden");
    return { binding, processing, reader, specification, origin, modelRef, revision: plugin.config.recoveryRevision,
      configurationHash: hostMemoryConfigurationHash(live) };
  };
  const captureDependencies = async () => {
    const state = await load();
    await state.reader.assertCurrent(); await state.processing.assertCurrent();
    // Capture authority metadata only. Native payload/index bytes must wait for
    // source_access_context. This receipt never authorizes a future native read;
    // each read still validates the actual live index and native body.
    return bytesVersion(canonicalJson({ generation: state.reader.catalog, origin: state.origin, configurationHash: state.configurationHash }));
  };
  return { captureDependencies, async verify(input: {
    host: CapabilityHostBinding; clientId: string; signal?: AbortSignal; assertRunCurrent(): Promise<void>;
  }): Promise<{ outcome: "passed"; executionDigest: string }> {
    check(input.host.purpose.kind === "adapter_verification" && input.host.purpose.capabilityId === "memory_access", "capability_purpose_mismatch");
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
    signal.throwIfAborted();
    const state = await load();
    check(state.processing.config.operatorMemoryAcceptance === true && state.processing.config.requesterIds.includes(input.clientId) &&
      state.processing.config.modelRefs.includes(state.modelRef) && state.processing.config.viewProcessingModelRefs?.includes(state.modelRef),
    "operator_memory_acceptance_grant_required");
    const request = snapshotTurnRequest({ agentId: config.agentId, sessionId: randomUUID(), sessionKey: `agent:${config.agentId}:main`,
      prompt: state.specification.request, senderId: input.clientId, senderIsOwner: true, chatType: "direct" }, input.host.runId);
    assertPrivateContextAudience(resolveTurnAudience(request));
    const before = await captureDependencies();
    const assertAuthorityCurrent = async () => {
      signal.throwIfAborted(); await input.assertRunCurrent();
      await state.processing.assertCurrent(); await state.reader.assertCurrent();
      check(await captureDependencies() === before, "host_memory_acceptance_dependencies_changed");
      signal.throwIfAborted();
    };
    let assertNativeCurrent: (() => Promise<void>) | undefined;
    const assertCurrent = async () => {
      await assertAuthorityCurrent();
      await assertNativeCurrent?.();
      await assertAuthorityCurrent();
    };
    const root = await realpath(config.canghaiRoot);
    const resourceScope = process.platform === "win32" ? root.toLowerCase() : root;
    return withCompletionResourceReservation(resourceScope, () => withHostMemoryVerification({ request, signal, assertCurrent }, async () => {
      const complete = async (purpose: string, prompt: string, observeOutput?: (receipt: HostModelOutputReceipt) => Promise<void>) => {
        const params = { agentId: config.agentId, model: state.modelRef, purpose, maxTokens: 8192, signal,
          messages: [{ role: "user" as const, content: prompt }] };
        let consumed = false;
        let outputText: string | undefined;
        let observationFailure: unknown;
        const result = await withHostModelConsumption({ request, modelRef: state.modelRef, params,
          assertCurrent: () => assertHostMemoryVerification(request), async observeOutput(receipt) {
            try {
              const observed = readHostModelOutput(receipt);
              check(observed.request === request && observed.modelRef === state.modelRef && observed.message.stopReason === "stop" &&
                observed.message.content.some(part => part.type === "text" && part.text.trim()) && observed.input.systemPrompt === "" &&
                observed.input.tools.length === 0 && observed.input.messages.length === 1 && observed.input.messages[0]?.role === "user" &&
                observed.input.messages[0].content === prompt, "host_memory_acceptance_model_consumption_unbound");
              await observeOutput?.(receipt);
              // Pinned Host direct-completion text codec. A wrapper's altered
              // return value cannot become the structured semantic verdict.
              outputText = observed.message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
              consumed = true;
            } catch (error) { observationFailure = error; throw error; }
          } }, () => api.runtime.llm.complete(params));
        await assertHostMemoryVerification(request);
        if (observationFailure) throw observationFailure;
        check(consumed, "host_memory_acceptance_model_receipt_required");
        check(result.text === outputText, "host_memory_acceptance_model_output_changed");
        check(`${result.provider}/${result.model}` === state.modelRef, "personal_context_model_mismatch");
        return result;
      };
      const authority = bindProcessingAuthority({ request, ownerId: state.processing.config.ownerId, purpose: state.binding.purpose,
        modelRef: state.modelRef, deployment: bytesVersion(canonicalJson({ source: api.source, revision: state.revision })),
        generationId: state.reader.catalog.generationId });
      const sourceAccess = createPersonalContextAccess({ request, modelRef: state.modelRef, binding: state.processing,
        processingAuthority: authority, signal, assertRequestCurrent() {
          check(hostVerificationActive(), "host_memory_verification_not_admitted");
          check(hostMemoryConfigurationHash(api.runtime.config.current()) === state.configurationHash, "host_memory_acceptance_configuration_changed");
        }, complete: ({ prompt }) => complete("stella-source-access", prompt) });
      function hostVerificationActive() { return hostMemoryVerification(request)?.request === request; }
      const resolver = new EpisodeEvidenceResolver(state.reader, { ...state.binding.purpose, sourceAccess,
        evidenceCutoff: new Date().toISOString(), trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
      () => { throw new CatalogError("host_memory_acceptance_source_expansion_forbidden"); });
      const original = await resolver.readEvidence(state.specification.evidenceRef);
      let nativeDigest: string | undefined;
      const queryEmbedding = state.specification.queryEmbedding ? createNativeQueryEmbedding({ request, authority,
        processingGrant: state.processing, currentConfig: () => structuredClone(api.runtime.config.current()) as OpenClawConfig, assertCurrent: assertAuthorityCurrent, signal }) : undefined;
      const readVerifiedNative = createNativeMemoryReader(api, config.agentId, request.sessionKey, observation => {
        check(canonicalJson(observation.origin) === canonicalJson(state.origin), "host_memory_acceptance_origin_changed");
        check(nativeDigest === undefined || nativeDigest === observation.digest, "host_memory_acceptance_native_changed");
        nativeDigest = observation.digest;
        // Arm this before returning the first native read. Post-tool source
        // judgments are model calls too and cannot precede native revalidation.
        assertNativeCurrent ??= async () => {
          check(await readVerifiedNative(state.origin, original, assertAuthorityCurrent) === original.text, "native_memory_payload_changed");
        };
      }, queryEmbedding);
      const readNative = async (...args: Parameters<typeof readVerifiedNative>) => {
        await args[2]();
        // Source semantics are checked before and after the native operation.
        // Its inner awaits recheck the exact source/configuration authority,
        // without issuing another model call before native bytes are verified.
        const text = await readVerifiedNative(args[0], args[1], assertAuthorityCurrent);
        await args[2]();
        return text;
      };
      let toolDigest: string | undefined;
      const tool = createFragmentReadTool({ resolver, originals: [original], descriptors: state.processing.config.descriptors,
        processingAuthority: authority, assertCurrent, readNative,
        async observeResult(receipt) {
          const observed = readFragmentToolResult(receipt);
          check(observed.tool === tool && canonicalJson(observed.authority) === canonicalJson(authority) &&
            canonicalJson(observed.output.details) === canonicalJson({ original }), "host_memory_acceptance_fragment_unbound");
          toolDigest = bytesVersion(canonicalJson({ call: observed.toolCallId, arguments: observed.arguments, output: observed.output }));
        } });
      await tool.execute(`memory_acceptance_${request.runId}`, { action: "read", handle: "F1" }, signal);
      check(toolDigest && nativeDigest, "host_memory_acceptance_fragment_required");
      const evidence = await state.reader.read(original.ref, "evidence");
      check(validMemoryRef(evidence.policyRef), "invalid_evidence");
      assertProcessingStage(authority, await state.reader.read(evidence.policyRef, "policies"), "derive");
      const prompt = canonicalJson({ request: request.prompt, original });
      let modelDigest: string | undefined;
      await complete("stella-memory-access-verification", prompt, async receipt => {
        const observed = readHostModelOutput(receipt);
        check(observed.request === request && observed.modelRef === state.modelRef && observed.message.stopReason === "stop" &&
          observed.message.content.some(part => part.type === "text" && part.text.trim()) &&
          observed.input.systemPrompt === "" && observed.input.tools.length === 0 && observed.input.messages.length === 1 &&
          observed.input.messages[0]?.role === "user" && observed.input.messages[0].content === prompt,
        "host_memory_acceptance_model_consumption_unbound");
        modelDigest = bytesVersion(canonicalJson({ input: observed.input, output: observed.message }));
      });
      check(modelDigest, "host_memory_acceptance_model_receipt_required");
      return { outcome: "passed", executionDigest: bytesVersion(canonicalJson({ scope: "native_fragment_guarded_direct", host: input.host,
        generation: state.reader.catalog.generationId, nativeDigest, toolDigest, modelDigest, dependencies: before })) };
    }));
  } };
}
