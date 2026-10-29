import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds, resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { CatalogError } from "../canghai/catalog-reader.js";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../canghai/personal-context-access.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { readCheckpointCommittedDocument } from "../canghai/checkpoint-committed-document.js";
import type { SourceAccessProvider } from "../canghai/source-access.js";
import type { PolicyPurpose } from "../canghai/source-policy.js";
import type { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import { assertPersonalSourceMetadata, preparePersonalViews } from "../praxis/personal-views.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { bindProcessingAuthority, resolveDeploymentDigest } from "./processing-authority.js";
import type { BoundTurnRequest } from "./turn-request.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
type Input = {
  api: OpenClawPluginApi; agentId: string; root: string; bindingPath?: string;
  request: BoundTurnRequest; purpose: PolicyPurpose; signal: AbortSignal;
  assertCurrent: () => Promise<void>;
};

/** One pinned public Host model adapter shared by policy and personal-view selection. */
export async function createCheckpointProcessingContext(input: Input) {
  if (!input.bindingPath) return undefined;
  const model = () => {
    const cfg = structuredClone(input.api.runtime.config.current()) as OpenClawConfig;
    const entry = cfg.agents?.entries?.[input.agentId];
    for (const value of [cfg.agents?.defaults?.model, entry?.model]) {
      check(typeof value !== "object" || value === null || !value.fallbacks?.length, "checkpoint_source_fallback_forbidden");
    }
    const selected = resolveDefaultModelForAgent({ cfg, agentId: input.agentId });
    const agents = listAgentIds(cfg), systemAgent = cfg.agents?.defaults?.systemAgent?.agentId;
    return { ref: `${selected.provider}/${selected.model}`,
      implicitAgent: agents.length === 1 && agents[0] === input.agentId && (!systemAgent || systemAgent === input.agentId) };
  };
  const selected = model(), modelRef = selected.ref, processing = await loadPersonalContextAccess(input.root, input.bindingPath);
  check(canonicalJson(processing.config.purpose) === canonicalJson(input.purpose), "personal_context_purpose_mismatch");
  const current = async () => {
    input.signal.throwIfAborted(); await input.assertCurrent(); input.signal.throwIfAborted();
    check(canonicalJson(model()) === canonicalJson(selected), "personal_context_model_changed");
  };
  await current();
  return { modelRef, processing, current,
    async complete(purpose: "stella-source-access" | "stella-personal-views" | "stella-correction", { prompt, maxTokens }: { prompt: string; maxTokens: number }) {
      await current();
      // A sole matching owner needs no target/model override. An ambiguous
      // fleet still follows the Host's existing explicit-agent policy.
      const result = await input.api.runtime.llm.complete({ ...selected.implicitAgent ? {} : { agentId: input.agentId },
        purpose, reasoning: "low", maxTokens, signal: input.signal, messages: [{ role: "user", content: prompt }] });
      await current();
      check(result.agentId === input.agentId && `${result.provider}/${result.model}` === modelRef &&
        result.execution.mode === "direct-provider", "personal_context_model_mismatch");
      return { text: result.text, provider: result.provider, model: result.model };
    },
  };
}

/** Adapt an admitted owner request to existing source-specific policy judgment.
 * Metadata processing permission does not authorize original source bytes. */
export async function createCheckpointSourceAccess(input: Input): Promise<SourceAccessProvider | undefined> {
  const context = await createCheckpointProcessingContext(input);
  if (!context) return undefined;
  return createPersonalContextAccess({ request: input.request, modelRef: context.modelRef, binding: context.processing,
    assertRequestCurrent: context.current, reuseWithinRequest: true, signal: input.signal,
    complete: args => context.complete("stella-source-access", args) });
}

type ViewInput = Input & { resolver: EpisodeEvidenceResolver; recoveryRevision: string };

/** Bind both narrow view projections to the same genuine request and source rules. */
async function checkpointViewContext(input: ViewInput, catalogMismatch: string) {
  const context = await createCheckpointProcessingContext(input);
  check(context, "personal_view_processing_grant_required");
  check(context.processing.config.viewProcessingModelRefs?.includes(context.modelRef), "personal_view_processing_grant_mismatch");
  check(typeof input.api.source === "string" && input.api.source.trim(), "plugin_source_binding_required");
  const reader = input.resolver.reader;
  check(reader.root === input.root, "recovery_read_binding_mismatch");
  const committed = await readCheckpointCommittedDocument(input.root, input.recoveryRevision, reader.catalogPath);
  check(bytesVersion(committed) === reader.catalogHash, catalogMismatch);
  await reader.assertCurrent();
  const authority = bindProcessingAuthority({ request: input.request, ownerId: context.processing.config.ownerId,
    modelRef: context.modelRef, purpose: input.purpose, generationId: reader.catalog.generationId,
    // This digest names the logical deployment scope, not authenticated code.
    deployment: resolveDeploymentDigest({ agentId: input.agentId, recoveryRevision: input.recoveryRevision, pluginSource: input.api.source }) });
  check(authority.privateContextAllowed && authority.audience === "owner_direct", "private_context_audience_forbidden");
  return { reader, context, authority };
}

/** Request-bound metadata processing only; exact Evidence owns payload access. */
export async function prepareCheckpointSourceMetadata(input: ViewInput) {
  const { reader, context, authority } = await checkpointViewContext(input, "correction_readback_catalog_mismatch");
  const current = async () => { await context.current(); await context.processing.assertCurrent(); await reader.assertCurrent(); await context.current(); };
  return { async assertSource(sourceRef: VersionedRef) {
    await current();
    await assertPersonalSourceMetadata({ reader, sourceRef, ownerId: context.processing.config.ownerId, processingAuthority: authority,
      read: async ref => { await current(); const value = await reader.read(ref); await current(); return value; } });
    await current();
  } };
}

async function prepareCheckpointViews(input: ViewInput, catalogMismatch: string) {
  const { reader, context, authority } = await checkpointViewContext(input, catalogMismatch);
  const prepared = await preparePersonalViews({ resolver: input.resolver, requestId: input.request.runId,
    question: input.request.prompt, ownerId: context.processing.config.ownerId, modelRef: context.modelRef,
    audience: "owner_direct", processingAuthority: authority, processingGrant: context.processing,
    assertProcessingCurrent: context.current, selection: "model",
    complete: args => context.complete("stella-personal-views", args) });
  await prepared.assertCurrent(); await context.current();
  return { reader, prepared };
}

/** Lazy read-only work projection. No caller-supplied question, identity, or selection. */
export async function prepareCheckpointWork(input: ViewInput) {
  const { reader, prepared } = await prepareCheckpointViews(input, "work_checkpoint_catalog_mismatch");
  // Candidate.originals and context contain other data; never return them from
  // this narrow tool. The renderer has authorized each selected work dependency.
  const selected = prepared.view.memory.filter(item => item.group === "works");
  const usageConstraints = selected.flatMap(item => {
    const policies = [...new Map(item.originals.flatMap(original => original.usageConstraints ?? [])
      .map(policy => [canonicalJson(policy), structuredClone(policy)])).values()];
    return policies.length ? [{ work: { ...item.ref }, policies }] : [];
  });
  return { generation: reader.catalog.generationId,
    works: selected.map(item => ({ ref: { ...item.ref }, record: structuredClone(item.record) })),
    exclusions: { ...prepared.view.exclusions }, ...(usageConstraints.length ? { usageConstraints } : {}) };
}


/** Preserve the renderer's USER/MEMORY distinction, including provisional scope.
 * Derived statements remain interpretations, never new evidence or tool authority. */
export async function prepareCheckpointUnderstanding(input: ViewInput) {
  const { reader, prepared } = await prepareCheckpointViews(input, "understanding_checkpoint_catalog_mismatch");
  const selected = (["user", "memory"] as const).flatMap(view =>
    prepared.view[view].filter(item => item.group === "understandings").map(item => ({ view, item })));
  const usageConstraints = selected.flatMap(({ view, item }) => {
    const policies = [...new Map(item.originals.flatMap(original => original.usageConstraints ?? [])
      .map(policy => [canonicalJson(policy), structuredClone(policy)])).values()];
    return policies.length ? [{ understanding: { ...item.ref }, view, policies }] : [];
  });
  return { generation: reader.catalog.generationId,
    understandings: selected.map(({ view, item }) => ({ view, ref: { ...item.ref }, record: structuredClone(item.record) })),
    exclusions: { ...prepared.view.exclusions }, ...(usageConstraints.length ? { usageConstraints } : {}) };
}
