import { parse as parseYaml } from "yaml";
import type { SourceAccessProvider } from "../canghai/source-access.js";
import { CatalogError, CatalogReader, readRepositoryBytes, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion } from "../canghai/content-version.js";
import type { LoadedConsciousness } from "../canghai/manifest.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { parseRuntimeProfile, RuntimeProfileError } from "../canghai/runtime-profile.js";
import { loadRuntimeProfileResources } from "../canghai/runtime-profile-resources.js";
import { HOST_INPUT_ARCHIVE_ADAPTER, prepareHostInputArchive } from "../canghai/host-input-archive.js";
import { persistHostInputArchive } from "../canghai/archive-writer.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import type { HostInputSnapshot } from "../openclaw/host-input.js";
import { isRecord } from "../shared/type-guards.js";
import { EpisodeEvidenceResolver } from "./episode-evidence.js";
import { EpisodeRepository, type EpisodeRepositoryPorts, type EpisodeSnapshot } from "./episode-repository.js";
import { PraxisRuntimeMemory } from "./runtime-memory.js";
import { EpisodeV2Error, type EpisodeV2, type VersionedRef } from "./episode-v2.js";

export type PraxisRuntimeBinding = {
  profileAuthorityPaths: string[];
  configPath: string;
  catalogPath: string;
  archive: { policyRef: VersionedRef; objectRoot: string; payloadRoot: string };
  purpose: { readPurpose: string; derivePurpose: string; deliveryScope: string };
  referenceBindings: Array<{ routingRef: string; sourceRef: VersionedRef }>;
};
function requireValue(value: unknown): asserts value {
  if (!value) throw new EpisodeV2Error("runtime_binding_migration_required");
}
function relativeRef(value: unknown): string {
  requireValue(typeof value === "string");
  const parsed = parseCangHaiRef(value);
  requireValue(!parsed.fragment && !parsed.relativePath.split("/").some((part) => part.toLowerCase() === ".git"));
  return parsed.relativePath;
}

export async function loadPraxisRuntimeBinding(loaded: LoadedConsciousness): Promise<PraxisRuntimeBinding> {
  try {
    const profileDocument = loaded.bootstrapDocuments.find((document) => document.field === "identity.runtimeProfileRef");
    requireValue(profileDocument);
    const profile = parseRuntimeProfile(parseYaml(profileDocument.content));
    requireValue(profile.contract_profile === "alpha_praxis" && profile.memory);
    const resources = await loadRuntimeProfileResources(loaded.canghaiRoot, profile);
    const catalogPath = relativeRef(profile.memory.catalog_ref);
    const capabilities = profile.capabilities.filter((value) => isRecord(value) && value.id === "transcript_archive");
    const capability = capabilities[0];
    requireValue(capabilities.length === 1 && isRecord(capability) && capability.adapter_id === HOST_INPUT_ARCHIVE_ADAPTER && capability.adapter_version === "1");
    const configPath = relativeRef(capability.config_ref);
    const bytes = await readRepositoryBytes(loaded.canghaiRoot, configPath);
    requireValue(bytes.length <= 256_000);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    requireValue(isRecord(value) && value.schemaVersion === "stella.alpha-praxis-binding/v2" && isRecord(value.archive) &&
      validMemoryRef(value.archive.policyRef) && typeof value.archive.objectRoot === "string" && value.archive.objectRoot &&
      typeof value.archive.payloadRoot === "string" && value.archive.payloadRoot && isRecord(value.purpose) &&
      typeof value.purpose.readPurpose === "string" && value.purpose.readPurpose &&
      typeof value.purpose.derivePurpose === "string" && value.purpose.derivePurpose &&
      typeof value.purpose.deliveryScope === "string" && value.purpose.deliveryScope &&
      Array.isArray(value.referenceBindings));
    const referenceBindings: PraxisRuntimeBinding["referenceBindings"] = [];
    for (const binding of value.referenceBindings) {
      requireValue(isRecord(binding) && typeof binding.routingRef === "string" && validMemoryRef(binding.sourceRef));
      relativeRef(binding.routingRef);
      requireValue(!referenceBindings.some((other) => other.routingRef === binding.routingRef));
      referenceBindings.push({ routingRef: binding.routingRef, sourceRef: { id: binding.sourceRef.id, version: binding.sourceRef.version } });
    }
    return { profileAuthorityPaths: resources.authorityPaths, configPath, catalogPath, archive: { policyRef: value.archive.policyRef, objectRoot: value.archive.objectRoot, payloadRoot: value.archive.payloadRoot },
      purpose: value.purpose as PraxisRuntimeBinding["purpose"], referenceBindings };
  } catch (error) {
    if (error instanceof EpisodeV2Error) throw error;
    if (error instanceof RuntimeProfileError) throw new EpisodeV2Error(error.category);
    throw new EpisodeV2Error("runtime_binding_migration_required");
  }
}

export async function createBoundPraxisRuntime(loaded: LoadedConsciousness, binding: PraxisRuntimeBinding,
  complete: ConstructorParameters<typeof EpisodeEvidenceResolver>[2], persist: EpisodeRepositoryPorts["persist"],
  sourceAccess?: SourceAccessProvider): Promise<PraxisRuntimeMemory> {
  const reader = await CatalogReader.load(loaded.canghaiRoot, binding.catalogPath);
  const resolver = new EpisodeEvidenceResolver(reader, { ...binding.purpose, evidenceCutoff: new Date().toISOString(),
    ...(sourceAccess ? { sourceAccess } : {}),
    trustedAdapters: { user_report: [HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] } }, complete);
  return new PraxisRuntimeMemory(new EpisodeRepository(loaded.canghaiRoot, relativeRef(loaded.manifest.praxis.episodeRootRef), {
    resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
    resolveLearning: (ref) => resolver.resolveLearning(ref), verifyActionEvidence: (actual) => resolver.verifyActionEvidence(actual),
    verifyOutcomeEvidence: (actual, outcome) => resolver.verifyOutcomeEvidence(actual, outcome),
    isCurrentlyEligible: (episode) => resolver.isCurrentlyEligible(episode), persist,
  }), resolver);
}

export async function resolveBoundInputRefs(runtime: PraxisRuntimeMemory, binding: PraxisRuntimeBinding, refs: string[]): Promise<VersionedRef[]> {
  const reader = runtime.evidence.reader;
  const result: VersionedRef[] = [];
  for (const ref of [...new Set(refs)]) {
    const target = binding.referenceBindings.find((value) => value.routingRef === ref);
    if (!target) throw new EpisodeV2Error("cognitive_source_binding_required");
    const source = await reader.read(target.sourceRef, "sources");
    if (!validMemoryRef(source.policyRef)) throw new EpisodeV2Error("cognitive_source_policy_required");
    await runtime.evidence.assertSourceAccess(target.sourceRef, source.policyRef);
    const bytes = await readRepositoryBytes(reader.root, relativeRef(ref));
    await reader.readPayload(target.sourceRef, bytesVersion(bytes));
    if (!result.some((value) => value.id === target.sourceRef.id && value.version === target.sourceRef.version)) result.push({ ...target.sourceRef });
  }
  return result;
}

export async function persistBoundAdvice(input: {
  loaded: LoadedConsciousness; binding: PraxisRuntimeBinding; runtime: PraxisRuntimeMemory; durability: GitCangHaiDurability;
  operationId: string; original: HostInputSnapshot;
  target: { kind: "new"; episode: Omit<EpisodeV2, "historicalInputRefs"> } | { kind: "revision"; selected: EpisodeSnapshot };
  inputRefs: VersionedRef[]; decision: NonNullable<EpisodeV2["decision"]>; abortSignal: AbortSignal;
  complete: ConstructorParameters<typeof EpisodeEvidenceResolver>[2];
}): Promise<{ revision: string; generationId: string; catalogHash: string; episodeRef: VersionedRef; writeOperationIds: string[] }> {
  const checkActive = () => { if (input.abortSignal.aborted) throw new EpisodeV2Error("operation_cancelled"); };
  checkActive();
  const operationId = `op_${bytesVersion(input.operationId).slice(7)}`;
  // A Host user-role message alone does not identify the owner.
  const archive = prepareHostInputArchive(input.original, { ...input.binding.archive, speaker: { id: null, role: "unknown" } });
  const archived = await persistHostInputArchive({ reader: input.runtime.evidence.reader, archive, operationId: `${operationId}-archive`, purpose: input.binding.purpose }, {
    persist: async (paths, id) => { checkActive(); await input.durability.syncCritical(paths, `stella: archive ${id}`); },
    confirmPreviouslyCommitted: (file) => input.durability.confirmPreviouslyCommitted(file),
  });
  checkActive();
  const runtime = await createBoundPraxisRuntime(input.loaded, input.binding, input.complete,
    async ({ paths, operationId: id }) => { checkActive(); await input.durability.syncCritical(paths, `stella: preserve ${id}`); },
    input.runtime.evidence.purpose.sourceAccess);
  const inputRefs = [...new Map([...input.inputRefs, archived.sourceRef].map((ref) => [`${ref.id}@${ref.version}`, ref])).values()];
  const recordedAt = String(input.original.event.timestamp);
  const decision = { ...input.decision, inputRefs };
  const recommended = input.target.kind === "new"
    ? await runtime.recommend({ operationId, episode: { ...input.target.episode, historicalInputRefs: inputRefs },
      decision, recordedAt, abortSignal: input.abortSignal })
    : await runtime.reviseRecommendation({ operationId, selected: input.target.selected, decision, recordedAt,
      provenance: { agentId: input.original.agentId, sessionId: input.original.sessionId, runId: input.operationId, messageRefs: [input.original.entryId] },
      abortSignal: input.abortSignal });
  checkActive();
  const diagnostics = await input.durability.diagnostics();
  if (!diagnostics.criticalSynchronized || diagnostics.localRevision !== diagnostics.synchronizedRevision) throw new EpisodeV2Error("critical_sync_failed");
  return { revision: diagnostics.localRevision, generationId: archived.generationId,
    catalogHash: runtime.evidence.reader.catalogHash, episodeRef: { id: recommended.episode.id, version: recommended.version },
    writeOperationIds: [`${operationId}-archive`, ...(input.target.kind === "new"
      ? [`${operationId}-open`, `${operationId}-recommend`] : [`${operationId}-revise`])] };
}
