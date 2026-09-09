import { prepareHostRequestArchive, type HostRequestSnapshot } from "../canghai/host-request-archive.js";
import path from "node:path";
import { CatalogError, CatalogReader, parseMemoryCatalog, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { prepareHostInputArchive } from "../canghai/host-input-archive.js";
import { applyMemoryTransaction, readRecordedMemoryTransaction, MemoryTransactionError } from "../canghai/memory-transaction.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import type { HostInputSnapshot } from "../openclaw/host-input.js";
import type { BoundTurnRequest } from "../openclaw/turn-request.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { prepareCorrection } from "./correction.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Canonical Host input custody, before any semantic correction or answer generation. */
export async function archiveCorrectionInput(input: {
  request: BoundTurnRequest; original: HostInputSnapshot | HostRequestSnapshot; ownerId: string; reader: CatalogReader;
  archive: { policyRef: VersionedRef; objectRoot: string; payloadRoot: string };
  purpose: EpisodeEvidenceResolver["purpose"]; durability: GitCangHaiDurability; signal: AbortSignal;
  assertCurrent: () => Promise<void>;
}) {
  const request = structuredClone(input.request), original = structuredClone(input.original);
  let archive;
  if (original.schemaVersion === "stella.host-request-snapshot/v1") {
    check(canonicalJson(request) === canonicalJson(original.request), "correction_host_request_mismatch");
    archive = prepareHostRequestArchive(original, { ...input.archive, ownerId: input.ownerId });
  } else {
    check(request.senderIsOwner && request.senderId && request.chatType === "direct" &&
      request.agentId === original.agentId && request.sessionId === original.sessionId && request.sessionKey === original.sessionKey &&
      request.prompt === original.text && request.requestHash === bytesVersion(original.text), "correction_host_request_mismatch");
    archive = prepareHostInputArchive(original, { ...input.archive, speaker: { id: input.ownerId, role: "owner" } });
  }
  const operationId = `correction_archive_${bytesVersion(request.runId).slice(7)}`;
  const reader = input.reader, journalPath = path.posix.join(path.posix.dirname(reader.catalogPath), "operations", `${operationId}.transaction.json`);
  let recorded;
  try { recorded = await readRecordedMemoryTransaction(reader.root, operationId, journalPath); }
  catch (error) {
    if (!(error instanceof MemoryTransactionError && error.category === "pending_transaction_not_found") &&
      !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const before = recorded ? recorded.files.find(file => file.path === reader.catalogPath)?.before : (await readRepositoryBytes(reader.root, reader.catalogPath)).toString("utf8");
  check(typeof before === "string", "invalid_correction_archive_transaction");
  const after = parseMemoryCatalog(JSON.parse(before));
  for (const object of archive.objects) {
    check(!after[object.group].some(entry => entry.id === object.ref.id), "correction_archive_identity_conflict");
    after[object.group].push(object.entry);
  }
  after.parentGenerationId = after.generationId;
  after.generationId = `generation_${bytesVersion(canonicalJson({ operationId, before: bytesVersion(before), sourceRef: archive.sourceRef })).slice(7)}`;
  parseMemoryCatalog(after);
  const plan = { operationId, journalPath, files: [
    { path: archive.payload.path, before: null, after: archive.payload.bytes },
    ...archive.objects.map(object => ({ path: object.entry.locator.path, before: null, after: object.bytes })),
    { path: reader.catalogPath, before, after: canonicalJson(after) },
  ] };
  if (recorded) check(canonicalJson(recorded) === canonicalJson(plan), "correction_archive_operation_conflict");
  await input.assertCurrent();
  await applyMemoryTransaction(reader.root, plan, {
    async validate() {
      await input.assertCurrent();
      const current = await CatalogReader.load(reader.root, reader.catalogPath);
      check([bytesVersion(before), bytesVersion(canonicalJson(after))].includes(current.catalogHash), "stale_generation");
      const policy = await current.read(input.archive.policyRef, "policies");
      check(policy.schemaVersion === "stella.source-policy/v1" && policy.ownerId === input.ownerId && policy.retention === "retain" &&
        Array.isArray(policy.readPurposes) && policy.readPurposes.includes(input.purpose.readPurpose) &&
        Array.isArray(policy.derivePurposes) && policy.derivePurposes.includes(input.purpose.derivePurpose) &&
        Array.isArray(policy.deliveryScopes) && policy.deliveryScopes.includes(input.purpose.deliveryScope), "archive_permission_denied");
      await current.assertCurrent(); await input.assertCurrent();
    },
    persist: async paths => { await input.durability.syncCritical(paths, `stella archive ${operationId}`); },
    confirmPreviouslyCommitted: file => input.durability.confirmPreviouslyCommitted(file),
  }, input.signal);
  await input.assertCurrent();
  const current = await CatalogReader.load(reader.root, reader.catalogPath);
  const resolver = new EpisodeEvidenceResolver(current, input.purpose, async () => { throw new CatalogError("archive_semantic_inference_forbidden"); });
  for (const ref of archive.evidenceRefs) await resolver.readEvidence(ref);
  const diagnostics = await input.durability.diagnostics();
  check(diagnostics.criticalSynchronized && diagnostics.localRevision === diagnostics.synchronizedRevision, "critical_sync_failed");
  return { operationId, evidenceRefs: archive.evidenceRefs, resolver, revision: diagnostics.localRevision };
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
