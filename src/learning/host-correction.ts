import { CatalogError, CatalogReader } from "../canghai/catalog-reader.js";
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
import type { BoundTurnRequest } from "../openclaw/turn-request.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { prepareCorrection } from "./correction.js";
import type { HostRequestSnapshot } from "../canghai/host-request-archive.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Canonical Host input custody, before any semantic correction or answer generation. */
export async function archiveCorrectionInput(input: {
  request: BoundTurnRequest; original: HostInputSnapshot | HostRequestSnapshot; ownerId: string; reader: CatalogReader;
  archive: { policyRef: VersionedRef; objectRoot: string; payloadRoot: string };
  purpose: EpisodeEvidenceResolver["purpose"]; durability: GitCangHaiDurability; signal: AbortSignal;
  assertCurrent: () => Promise<void>;
  /** Fail-closed defaults: do_not_retain requires explicit Host guarantees before any disk write. */
  retentionGuarantees?: HostRetentionGuarantees;
}) {
  const request = structuredClone(input.request), original = structuredClone(input.original);
  const guarantees = input.retentionGuarantees ?? DEFAULT_RETENTION_GUARANTEES;
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
  };
}

export async function applyHostCorrection(input: Parameters<typeof archiveCorrectionInput>[0] & {
  modelRef: string; complete: Parameters<typeof prepareCorrection>[0]["complete"];
}) {
  const archived = await archiveCorrectionInput(input);
  const correction = await prepareCorrection({ operationId: input.request.runId, request: input.request.prompt,
    ownerId: input.ownerId, modelRef: input.modelRef, recordedAt: input.original.schemaVersion === "stella.host-request-snapshot/v1" ? input.original.capturedAt : String(input.original.event.timestamp),
    evidenceRefs: archived.evidenceRefs, resolver: archived.resolver, objectRoot: input.archive.objectRoot,
    assertProcessingCurrent: input.assertCurrent, complete: input.complete });
  const receipt = await correction.persist(input.durability, input.signal);
  return { ...receipt, writeOperationIds: [archived.operationId, receipt.operationId], disposition: correction.disposition,
    clarification: correction.clarification };
}
