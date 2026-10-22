import path from "node:path";
import { readCheckpointCommittedDocument } from "./checkpoint-committed-document.js";
import { CatalogError, CatalogReader, parseMemoryCatalog, validMemoryRef, type MemoryCatalog } from "./catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import type { HostInputArchive } from "./host-input-archive.js";
import { assertRetentionAdmission, DEFAULT_RETENTION_GUARANTEES, type HostRetentionGuarantees } from "./ingest.js";
import { applyMemoryTransaction, readRecordedMemoryTransaction } from "./memory-transaction.js";
import type { CheckpointTransactionRecovery } from "./memory-transaction.js";
import type { MemoryTransactionPlan } from "./memory-transaction-plan.js";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";
import { applyViewMigration, planViewMigration, type ViewRebuildAdmission } from "./view-migration.js";

export type CheckpointArchivePorts = Readonly<{
  recovery: CheckpointTransactionRecovery;
  /** Local Git commit only. This API makes no remote synchronization claim. */
  commit(paths: string[], operationId: string): Promise<void>;
  signal?: AbortSignal;
  viewRebuilds?: (generationId: string) => Promise<readonly ViewRebuildAdmission[] | undefined>;
}>;
type Input = { reader: Pick<CatalogReader, "root" | "catalogPath" | "catalogHash">; archive: HostInputArchive; operationId: string;
  purpose: { readPurpose: string; derivePurpose: string; deliveryScope: string }; retentionGuarantees?: HostRetentionGuarantees };
const check = (value: unknown, category: string) => { if (!value) throw new CatalogError(category); };

/** The existing retain-archive writer's explicit checkpoint branch, not the synchronized ingest API. */
export async function persistCheckpointArchive(input: Input, ports: CheckpointArchivePorts) {
  const { reader, operationId } = input;
  check(/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(operationId), "invalid_archive_operation_id");
  const archive = JSON.parse(canonicalJson(input.archive)) as HostInputArchive;
  const purpose = Object.freeze({ ...input.purpose });
  check(bytesVersion(archive.payload.bytes) === archive.payload.sha256, "payload_digest_mismatch");
  for (const object of archive.objects) {
    check(["sources", "evidence", "coverage"].includes(object.group) && validMemoryRef(object.ref) &&
      objectVersion(object.object) === object.ref.version && object.object.id === object.ref.id &&
      canonicalJson(JSON.parse(object.bytes)) === canonicalJson(object.object) && bytesVersion(object.bytes) === object.entry.locator.sha256 &&
      object.entry.id === object.ref.id && object.entry.version === object.ref.version &&
      (object.group === "coverage" || validMemoryRef(object.object.policyRef)), "invalid_archive_object");
  }
  const permissions = async (current: CatalogReader) => {
    for (const object of archive.objects) {
      if (!validMemoryRef(object.object.policyRef)) continue;
      const policy = await current.read(object.object.policyRef, "policies");
      assertRetentionAdmission(policy, input.retentionGuarantees ?? DEFAULT_RETENTION_GUARANTEES);
      check(policy.schemaVersion === "stella.source-policy/v1" && policy.retention === "retain" &&
        Array.isArray(policy.readPurposes) && policy.readPurposes.includes(purpose.readPurpose) &&
        Array.isArray(policy.derivePurposes) && policy.derivePurposes.includes(purpose.derivePurpose) &&
        Array.isArray(policy.deliveryScopes) && policy.deliveryScopes.includes(purpose.deliveryScope), "archive_permission_denied");
    }
    await current.assertCurrent();
  };
  return withExclusiveFileLock(path.join(reader.root, ".stella-memory-transaction.json"), async () => {
    ports.signal?.throwIfAborted();
    const businessPath = path.posix.join(path.posix.dirname(reader.catalogPath), "operations", `${operationId}.archive.json`);
    const business = { schemaVersion: "stella.checkpoint-archive/v1", operationId, archiveSha256: bytesVersion(canonicalJson(archive)), purpose };
    const journalPath = path.posix.join(path.posix.dirname(reader.catalogPath), "operations", `${operationId}.checkpoint.json`);
    // Replay must use the recorded original tuple and bytes. Never regenerate expected from HEAD/current.
    let plan: MemoryTransactionPlan | undefined;
    try { plan = await readRecordedMemoryTransaction(reader.root, operationId, journalPath); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") &&
          !(error && typeof error === "object" && "category" in error && error.category === "pending_transaction_not_found")) throw error;
    }
    let generationId: string;
    if (plan) {
      check(plan.journalPath === journalPath && plan.recoveryCheckpoint &&
        canonicalJson(plan.recoveryCheckpoint.binding) === canonicalJson(ports.recovery.expected.binding) &&
        canonicalJson(plan.recoveryCheckpoint.expected) === canonicalJson({ revision: ports.recovery.expected.revision, token: ports.recovery.expected.token }), "archive_operation_conflict");
      const beforeBytes = await readCheckpointCommittedDocument(reader.root, ports.recovery.expected.revision, reader.catalogPath);
      check(bytesVersion(beforeBytes) === reader.catalogHash, "archive_operation_conflict");
      const before = parseMemoryCatalog(JSON.parse(beforeBytes));
      let after = JSON.parse(canonicalJson(before)) as MemoryCatalog;
      for (const object of archive.objects) {
        check(!after[object.group].some(entry => entry.id === object.ref.id), "archive_operation_conflict");
        after[object.group].push(object.entry);
      }
      after.parentGenerationId = before.generationId;
      after.generationId = `generation_${bytesVersion(canonicalJson([reader.catalogHash, archive, purpose])).slice(7)}`;
      const migration = planViewMigration({ before, after, rebuilds: await ports.viewRebuilds?.(after.generationId) });
      after = applyViewMigration(after, migration); parseMemoryCatalog(after); generationId = after.generationId;
      const files = [
        { path: archive.payload.path, before: null, after: archive.payload.bytes },
        ...archive.objects.map(object => ({ path: object.entry.locator.path, before: null, after: object.bytes })),
        ...migration.files.map(file => { check(typeof file.after === "string", "required_view_rebuild_invalid"); return { ...file, after: file.after! }; }),
        { path: businessPath, before: null, after: canonicalJson({ ...business, generationId }) },
        { path: reader.catalogPath, before: canonicalJson(before), after: canonicalJson(after) },
      ];
      // A checksum is not an authorization. Rebuild the entire business plan from A;
      // reject extra files, changed purposes, paths or catalog edits even if rehashed.
      check(canonicalJson(plan) === canonicalJson({ operationId, journalPath, recoveryCheckpoint: { binding: ports.recovery.expected.binding,
        expected: { revision: ports.recovery.expected.revision, token: ports.recovery.expected.token } }, files }), "archive_operation_conflict");
    } else {
      await ports.recovery.authority.assertCurrent(ports.recovery.expected);
      const current = await CatalogReader.load(reader.root, reader.catalogPath);
      await permissions(current);
      check(current.catalogHash === reader.catalogHash, "stale_generation");
      let after = JSON.parse(canonicalJson(current.catalog)) as MemoryCatalog;
      for (const object of archive.objects) {
        const entries = after[object.group];
        // This first Core branch appends a new immutable event; reuse/conflicting events fail before writes.
        check(!entries.some(entry => entry.id === object.ref.id), "archive_event_already_recorded");
        entries.push(object.entry);
      }
      after.parentGenerationId = current.catalog.generationId;
      after.generationId = `generation_${bytesVersion(canonicalJson([current.catalogHash, archive, purpose])).slice(7)}`;
      const migration = planViewMigration({ before: current.catalog, after, rebuilds: await ports.viewRebuilds?.(after.generationId) });
      after = applyViewMigration(after, migration); parseMemoryCatalog(after); generationId = after.generationId;
      plan = { operationId, journalPath, recoveryCheckpoint: { binding: ports.recovery.expected.binding,
        expected: { revision: ports.recovery.expected.revision, token: ports.recovery.expected.token } }, files: [
        { path: archive.payload.path, before: null, after: archive.payload.bytes },
        ...archive.objects.map(object => ({ path: object.entry.locator.path, before: null, after: object.bytes })),
        ...migration.files.map(file => { check(typeof file.after === "string", "required_view_rebuild_invalid"); return { ...file, after: file.after! }; }),
        { path: businessPath, before: null, after: canonicalJson({ ...business, generationId }) },
        { path: reader.catalogPath, before: canonicalJson(current.catalog), after: canonicalJson(after) },
      ] };
    }
    const result = await applyMemoryTransaction(reader.root, plan, {
      recovery: { ...ports.recovery, async assertPublication(accepted) {
        const current = await CatalogReader.load(reader.root, reader.catalogPath);
        check(current.catalog.generationId === generationId, "stale_generation");
        await permissions(current);
        await ports.recovery.assertPublication(accepted);
        await permissions(current);
      } },
      async validate() { await permissions(await CatalogReader.load(reader.root, reader.catalogPath)); },
      persist: ports.commit,
      async confirmPreviouslyCommitted() { throw new CatalogError("checkpoint_replay_adapter_required"); },
    }, ports.signal);
    return { ...result, generationId, sourceRef: archive.sourceRef, evidenceRefs: archive.evidenceRefs, persistenceStatus: "local_committed" as const };
  });
}
