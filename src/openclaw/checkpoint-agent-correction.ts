import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CatalogError, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { readCheckpointCommittedDocument } from "../canghai/checkpoint-committed-document.js";
import { createPersonalContextAccess } from "../canghai/personal-context-access.js";
import type { RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import { bindProcessingAuthority, resolveDeploymentDigest } from "./processing-authority.js";
import { createCheckpointProcessingContext } from "./checkpoint-source-access.js";
import type { createCheckpointPluginRuntime } from "./checkpoint-plugin-runtime.js";
import type { CheckpointRequestArchiveReceipt } from "./checkpoint-request-ingress.js";
import { snapshotTurnRequest, type BoundTurnRequest } from "./turn-request.js";

type Runtime = Awaited<ReturnType<typeof createCheckpointPluginRuntime>>;
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Core-only request custody. The model selects this action, never its request,
 * Evidence, owner, version, operation identity or persistence parameters. */
export async function correctCheckpointRequest(input: {
  api: OpenClawPluginApi; runtime: Runtime; recovery: RecoveryReadBinding; resolver: EpisodeEvidenceResolver;
  bindingPath?: string; objectRoot: string; request: BoundTurnRequest; archive: CheckpointRequestArchiveReceipt;
  signal: AbortSignal; assertCurrent: () => Promise<void>;
}) {
  input.signal.throwIfAborted();
  const { runtime, recovery, archive } = input, config = runtime.config;
  check(config.agentCorrection === "tool" && config.dataMode === "local_write" && config.requestArchive === "local" &&
    config.agentMemory === "fresh_tools", "checkpoint_agent_correction_disabled");
  const request = snapshotTurnRequest(input.request, input.request.runId), reader = input.resolver.reader;
  check(canonicalJson(request) === canonicalJson(input.request) && request.agentId === config.agentId && reader.root === config.canghaiRoot,
    "checkpoint_correction_request_mismatch");
  check(archive && archive.runId === request.runId && archive.requestHash === request.requestHash &&
    request.requestHash === bytesVersion(request.prompt) && archive.recovery?.resolver === recovery.resolver &&
    canonicalJson(archive.recovery.expected) === canonicalJson(recovery.expected) &&
    typeof archive.capturedAt === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(archive.capturedAt) && Number.isFinite(Date.parse(archive.capturedAt)) &&
    Array.isArray(archive.evidenceRefs) && archive.evidenceRefs.length > 0 && archive.evidenceRefs.every(validMemoryRef) &&
    Array.isArray(archive.sourceRefs) && archive.sourceRefs.length > 0 && archive.sourceRefs.every(validMemoryRef), "checkpoint_correction_archive_receipt_required");
  await runtime.assert(recovery);
  const committed = await readCheckpointCommittedDocument(reader.root, recovery.expected.revision, reader.catalogPath);
  check(bytesVersion(committed) === reader.catalogHash, "correction_checkpoint_catalog_mismatch");
  await reader.assertCurrent();
  const purpose = { readPurpose: input.resolver.purpose.readPurpose, derivePurpose: input.resolver.purpose.derivePurpose, deliveryScope: input.resolver.purpose.deliveryScope };
  const context = await createCheckpointProcessingContext({ api: input.api, agentId: config.agentId, root: reader.root,
    bindingPath: input.bindingPath, request, purpose, signal: input.signal, assertCurrent: input.assertCurrent });
  check(context, "personal_view_processing_grant_required");
  check(context.processing.config.viewProcessingModelRefs?.includes(context.modelRef), "personal_view_processing_grant_mismatch");
  check(typeof input.api.source === "string" && input.api.source.trim(), "plugin_source_binding_required");
  const authority = bindProcessingAuthority({ request, ownerId: context.processing.config.ownerId, modelRef: context.modelRef, purpose,
    generationId: reader.catalog.generationId, deployment: resolveDeploymentDigest({ agentId: config.agentId,
      recoveryRevision: recovery.expected.revision, pluginSource: input.api.source }) });
  check(authority.privateContextAllowed && authority.audience === "owner_direct", "private_context_audience_forbidden");
  // Identity, activity, model and the genuine processing grant survive publication.
  // Do not close over B-bound authority or reader assertions: the writer validates
  // B during preparation and authenticates its accepted C during publication.
  const assertProcessingCurrent = async () => {
    input.signal.throwIfAborted(); await context.current(); await context.processing.assertCurrent(); input.signal.throwIfAborted();
  };
  await assertProcessingCurrent();
  const sources = new Set(archive.sourceRefs.map(value => canonicalJson(value))), seen = new Set<string>();
  for (const evidenceRef of archive.evidenceRefs) {
    const evidence = await reader.read(evidenceRef, "evidence");
    check(validMemoryRef(evidence.source) && sources.has(canonicalJson(evidence.source)) && evidence.capturedAt === archive.capturedAt,
      "checkpoint_correction_archive_receipt_required");
    const source = await reader.read(evidence.source, "sources");
    check(source.capturedAt === archive.capturedAt && source.origin && typeof source.origin === "object" &&
      "upstreamId" in source.origin && source.origin.upstreamId === request.runId, "checkpoint_correction_archive_receipt_required");
    seen.add(canonicalJson(evidence.source));
  }
  check(seen.size === sources.size, "checkpoint_correction_archive_receipt_required");
  const sourceAccess = createPersonalContextAccess({ request, modelRef: context.modelRef, binding: context.processing,
    assertRequestCurrent: assertProcessingCurrent, reuseWithinRequest: true, processingAuthority: authority, signal: input.signal,
    complete: args => context.complete("stella-source-access", args) });
  const resolver = new EpisodeEvidenceResolver(reader, { ...input.resolver.purpose, evidenceCutoff: archive.capturedAt,
    signal: input.signal, sourceAccess }, args => context.complete("stella-correction", args));
  const operationId = `correction_${bytesVersion(canonicalJson([request.runId, request.requestHash])).slice(7)}`;
  return runtime.correctLocal({ recovery, operationId, request: request.prompt, ownerId: context.processing.config.ownerId,
    modelRef: context.modelRef, recordedAt: archive.capturedAt, evidenceRefs: structuredClone(archive.evidenceRefs), resolver,
    objectRoot: input.objectRoot, processingAuthority: authority, processingGrant: context.processing,
    assertProcessingCurrent, complete: args => context.complete("stella-correction", args), signal: input.signal });
}
