import { prepareHostRequestArchive } from "../canghai/host-request-archive.js";
import { prepareHostInputArchive } from "../canghai/host-input-archive.js";
import type { createCheckpointPluginRuntime } from "../openclaw/checkpoint-plugin-runtime.js";
import type { RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import type { RecoveryAuthoritySnapshot } from "../canghai/recovery-authority-contract.js";
import path from "node:path";
import { collectContextSources, type ContextSources } from "../praxis/context-sources.js";
import { readPersonalContextAccessBinding } from "../canghai/personal-context-access.js";
import { isRecord } from "../shared/type-guards.js";
import { CatalogError, CatalogReader, type MemoryCatalog } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import {
  DEFAULT_RETENTION_GUARANTEES,
  ingestHostMessage,
  ingestHostRequest,
  IngestError,
  type HostRetentionGuarantees,
} from "../canghai/ingest.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import type { HostInputSnapshot } from "../openclaw/host-input.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "../openclaw/turn-audience.js";
import type { BoundTurnRequest } from "../openclaw/turn-request.js";
import type { ProcessingAuthority } from "../openclaw/processing-authority.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import type { ViewRebuildAdmission } from "../canghai/view-migration.js";
import { learn, prepareCorrection } from "./correction.js";
import type { HostRequestSnapshot } from "../canghai/host-request-archive.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

type AppliedCorrectionContext = ContextSources & {
  root: string; catalogPath: string; generationId: string; ownerId: string; modelRef: string;
  request: BoundTurnRequest; purpose: ProcessingAuthority["purpose"]; context: string;
  ingressRefs: VersionedRef[]; assertCurrent(): Promise<void>;
};
const appliedContexts = new WeakMap<object, { result: string; binding: AppliedCorrectionContext }>();

/** A completed learning transaction, not a caller-authored receipt, produces
 * this context. Its dependencies are the newly published records and originals. */
export async function readAppliedCorrectionContext(receipt: object): Promise<AppliedCorrectionContext> {
  const stored = appliedContexts.get(receipt);
  check(stored, "correction_context_unbound");
  const assertResult = () => check(canonicalJson(receipt) === stored.result, "correction_context_changed");
  assertResult();
  await stored.binding.assertCurrent();
  assertResult();
  const { assertCurrent, ...snapshot } = stored.binding;
  return { ...structuredClone(snapshot), assertCurrent };
}

/** Canonical Host input custody, before any semantic correction or answer generation. */
type ArchiveCorrectionInput = {
  request: BoundTurnRequest; original: HostInputSnapshot | HostRequestSnapshot; ownerId: string;
  archive: { policyRef: VersionedRef; objectRoot: string; payloadRoot: string };
  purpose: EpisodeEvidenceResolver["purpose"]; signal: AbortSignal;
  assertCurrent: () => Promise<void>;
  /** Fail-closed defaults: do_not_retain requires explicit Host guarantees before any disk write. */
  retentionGuarantees?: HostRetentionGuarantees;
} & ({ reader: CatalogReader; durability: GitCangHaiDurability; checkpoint?: never } | { reader: Pick<CatalogReader, "root" | "catalogPath" | "catalogHash">; durability?: never; checkpoint: {
  runtime: Awaited<ReturnType<typeof createCheckpointPluginRuntime>>; recovery: RecoveryReadBinding;
  /** Host scope/access only; distinct from the old A-bound processing closure. */
  assertPublication(accepted: RecoveryAuthoritySnapshot): Promise<void>;
} });
export async function archiveCorrectionInput(input: ArchiveCorrectionInput) {
  const request = structuredClone(input.request), original = structuredClone(input.original);
  const guarantees = input.retentionGuarantees ?? DEFAULT_RETENTION_GUARANTEES;
  if (input.checkpoint) {
    input.signal.throwIfAborted();
    await input.assertCurrent();
    check(request.senderIsOwner && request.senderId && request.chatType === "direct", "correction_host_request_mismatch");
    const operationId = `correction_archive_${bytesVersion(canonicalJson([request.agentId, request.sessionKey, request.runId])).slice(7)}`;
    let archive;
    if (original.schemaVersion === "stella.host-request-snapshot/v1") {
      check(canonicalJson(request) === canonicalJson(original.request), "correction_host_request_mismatch");
      archive = prepareHostRequestArchive(original, { ...input.archive, ownerId: input.ownerId });
    } else {
      check(request.agentId === original.agentId && request.sessionId === original.sessionId && request.sessionKey === original.sessionKey &&
        request.prompt === original.text && request.requestHash === bytesVersion(original.text), "correction_host_request_mismatch");
      archive = prepareHostInputArchive(original, { ...input.archive, speaker: { id: input.ownerId, role: "owner" } });
    }
    const checkpoint = input.checkpoint;
    const receipt = await checkpoint.runtime.archiveLocal({ reader: input.reader, archive, operationId, recovery: checkpoint.recovery,
      purpose: input.purpose, signal: input.signal, assertPublication: checkpoint.assertPublication });
    const recovery = Object.freeze({ resolver: checkpoint.recovery.resolver, expected: receipt.authority });
    await checkpoint.runtime.assert(recovery);
    const current = await CatalogReader.load(input.reader.root, input.reader.catalogPath);
    const resolver = new EpisodeEvidenceResolver(current, input.purpose, async () => { throw new CatalogError("archive_semantic_inference_forbidden"); });
    for (const ref of receipt.evidenceRefs) await resolver.readEvidence(ref);
    await checkpoint.runtime.assert(recovery); input.signal.throwIfAborted();
    return { operationId, evidenceRefs: receipt.evidenceRefs, sourceRefs: [receipt.sourceRef], resolver,
      revision: receipt.authority.revision, recovery, persistenceStatus: "local_committed" as const };
  }
  await input.assertCurrent();
  const diagnostics = await input.durability.diagnostics();
  const expectedRevision = diagnostics.localRevision;
  const purpose = {
    readPurpose: input.purpose.readPurpose,
    derivePurpose: input.purpose.derivePurpose,
    deliveryScope: input.purpose.deliveryScope,
  };
  const ports = {
    reader: input.reader,
    durability: input.durability,
    retentionGuarantees: guarantees,
    objectRoot: input.archive.objectRoot,
    payloadRoot: input.archive.payloadRoot,
    signal: input.signal,
  };

  let result;
  try {
    if (original.schemaVersion === "stella.host-request-snapshot/v1") {
      check(canonicalJson(request) === canonicalJson(original.request), "correction_host_request_mismatch");
      const operationId = `correction_archive_${bytesVersion(request.runId).slice(7)}`;
      result = await ingestHostRequest({
        operationId,
        expectedRevision,
        snapshot: original,
        ownerId: input.ownerId,
        policyRef: input.archive.policyRef,
        purpose,
      }, ports);
    } else {
      check(request.senderIsOwner && request.senderId && request.chatType === "direct" &&
        request.agentId === original.agentId && request.sessionId === original.sessionId && request.sessionKey === original.sessionKey &&
        request.prompt === original.text && request.requestHash === bytesVersion(original.text), "correction_host_request_mismatch");
      const operationId = `correction_archive_${bytesVersion(request.runId).slice(7)}`;
      result = await ingestHostMessage({
        operationId,
        expectedRevision,
        snapshot: original,
        speaker: { id: input.ownerId, role: "owner" },
        policyRef: input.archive.policyRef,
        purpose,
      }, ports);
    }
  } catch (error) {
    if (error instanceof IngestError) {
      if (error.category === "persistence_failed" && error.cause instanceof Error) throw error.cause;
      throw new CatalogError(error.category);
    }
    throw error;
  }

  await input.assertCurrent();
  check(result.state === "synchronized" && result.evidenceRefs.length > 0, "critical_sync_failed");
  const current = await CatalogReader.load(input.reader.root, input.reader.catalogPath);
  const resolver = new EpisodeEvidenceResolver(current, input.purpose, async () => {
    throw new CatalogError("archive_semantic_inference_forbidden");
  });
  for (const ref of result.evidenceRefs) await resolver.readEvidence(ref);
  return {
    operationId: result.operationId,
    evidenceRefs: result.evidenceRefs,
    sourceRefs: result.sourceRefs,
    resolver,
    revision: result.durability.localRevision,
    persistenceStatus: "synchronized" as const,
  };
}

export async function applyHostCorrection(input: Omit<ArchiveCorrectionInput, "durability" | "checkpoint" | "reader"> & { reader: CatalogReader; durability: GitCangHaiDurability; checkpoint?: never } & {
  modelRef: string; complete: Parameters<typeof prepareCorrection>[0]["complete"];
  processingAuthority: ProcessingAuthority;
  processingGrant?: object;
  viewRebuilds?: (context: { resolver: EpisodeEvidenceResolver; before: CatalogReader; after: MemoryCatalog; generationId: string;
    journalPath: string;
    evidenceRefs: readonly VersionedRef[] }) => readonly ViewRebuildAdmission[] | undefined |
    Promise<readonly ViewRebuildAdmission[] | undefined>;
}) {
  input = { ...input, request: structuredClone(input.request), original: structuredClone(input.original),
    archive: structuredClone(input.archive), processingAuthority: structuredClone(input.processingAuthority) };
  assertPrivateContextAudience(resolveTurnAudience(input.request));
  check(input.processingGrant || !input.purpose.sourceAccess, "correction_processing_grant_required");
  const grant = input.processingGrant ? await readPersonalContextAccessBinding(input.processingGrant) : undefined;
  if (grant) check(grant.root === input.reader.root && grant.config.ownerId === input.ownerId &&
    grant.config.requesterIds.includes(input.request.senderId ?? "") && grant.config.viewProcessingModelRefs?.includes(input.modelRef) &&
    canonicalJson(grant.config.purpose) === canonicalJson(input.processingAuthority.purpose), "correction_processing_grant_mismatch");
  const assertScopeCurrent = async () => {
    input.signal.throwIfAborted();
    await input.assertCurrent();
    if (input.processingGrant) await readPersonalContextAccessBinding(input.processingGrant);
  };
  const archived = await archiveCorrectionInput({ ...input, assertCurrent: assertScopeCurrent });
  const rebuildViews = input.viewRebuilds;
  const receipt = await learn({ operationId: input.request.runId, request: input.request.prompt,
    ownerId: input.ownerId, modelRef: input.modelRef, recordedAt: input.original.schemaVersion === "stella.host-request-snapshot/v1" ? input.original.capturedAt : String(input.original.event.timestamp),
    evidenceRefs: archived.evidenceRefs, resolver: archived.resolver, objectRoot: input.archive.objectRoot,
    processingAuthority: input.processingAuthority,
    assertProcessingCurrent: assertScopeCurrent, complete: input.complete, durability: input.durability, signal: input.signal,
    ...(rebuildViews ? { viewRebuilds: (generationId: string, after: MemoryCatalog, journalPath: string) => rebuildViews({
      resolver: archived.resolver, before: archived.resolver.reader, after, generationId, journalPath, evidenceRefs: archived.evidenceRefs,
    }) } : {}),
  });
  const result = { ...receipt, writeOperationIds: [archived.operationId, receipt.operationId] };
  const current = await CatalogReader.load(input.reader.root, input.reader.catalogPath);
  check(current.catalog.generationId === receipt.generationId, "correction_generation_changed");
  const resolver = new EpisodeEvidenceResolver(current, input.purpose, input.complete);
  const sources = collectContextSources(resolver, input.processingAuthority, assertScopeCurrent);
  const receiptPath = path.posix.join(path.posix.dirname(current.catalogPath), "operations", `${receipt.operationId}.correction.json`);
  let recorded: unknown;
  try { recorded = JSON.parse((await sources.pinFile(receiptPath)).toString("utf8")); }
  catch { throw new CatalogError("correction_receipt_unavailable"); }
  check(isRecord(recorded) && ["stella-correction/v1", "stella-correction/v2"].includes(String(recorded.schemaVersion)) && recorded.operationId === receipt.operationId &&
    recorded.requestHash === input.request.requestHash && recorded.ownerId === input.ownerId && recorded.modelRef === input.modelRef &&
    canonicalJson(recorded.changeRef) === canonicalJson(receipt.changeRef) &&
    (recorded.schemaVersion === "stella-correction/v1" ? receipt.clarification === null : recorded.clarification === receipt.clarification),
    "correction_receipt_mismatch");
  if (grant) check(bytesVersion(await sources.pinFile(grant.path)) === grant.sha256, "correction_processing_grant_mismatch");
  await sources.visit(receipt.changeRef);
  for (const ref of archived.evidenceRefs) await sources.visit(ref);
  const change = await current.read(receipt.changeRef, "changes");
  check(change.disposition === receipt.disposition && change.modelRef === input.modelRef &&
    canonicalJson(change.inputRefs) === canonicalJson(archived.evidenceRefs), "correction_receipt_mismatch");
  await sources.assertCurrent();
  const context = [
    "The current owner input has been archived and its learning disposition durably recorded. Preserve the current corrected views. A clarification disposition must remain unresolved; it does not authorize guessing or claiming correction is complete.",
    canonicalJson({ disposition: receipt.disposition, clarification: receipt.clarification, changeRef: receipt.changeRef }),
  ].join("\n");
  appliedContexts.set(result, { result: canonicalJson(result), binding: { ...sources.snapshot(), root: current.root, catalogPath: current.catalogPath,
    generationId: receipt.generationId, ownerId: input.ownerId, modelRef: input.modelRef, request: input.request,
    purpose: structuredClone(input.processingAuthority.purpose), ingressRefs: structuredClone(archived.evidenceRefs), context,
    assertCurrent: sources.assertCurrent } });
  return result;
}
