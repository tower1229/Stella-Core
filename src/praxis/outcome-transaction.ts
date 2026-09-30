import path from "node:path";
import { CatalogReader, parseMemoryCatalog, readRepositoryBytes, type CatalogEntry, type MemoryCatalog } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { stableId } from "../canghai/host-input-archive.js";
import { applyMemoryTransaction, type MemoryFileChange, type MemoryTransactionPlan } from "../canghai/memory-transaction.js";
import { afterDurablePersistPublishView } from "../canghai/managed-durable-write.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import { applyViewMigration, planViewMigration, type ViewMigrationPlan, type ViewRebuildAdmission } from "../canghai/view-migration.js";
import { EpisodeEvidenceResolver } from "./episode-evidence.js";
import { episodeVersion } from "./episode-repository.js";
import { EpisodeV2Error, parseEpisodeV2, validateEpisodeV2References, validateEpisodeV2Transition, type VersionedRef } from "./episode-v2.js";
import { readPreparedOutcomeContext, type PreparedOutcome } from "./outcome-preparation.js";
import type { PraxisRuntimeMemory } from "./runtime-memory.js";
import { createOutcomeEvidenceBundle } from "./outcome-evidence-bundle.js";
import { loadEvidenceBundle } from "./evidence-bundle.js";
import { contextHistoryLocation, readContextHistory, type StoredContextHistory } from "../openclaw/host-context-history.js";
import { isRecord } from "../shared/type-guards.js";

type OutcomeProjection = { episode: Extract<PreparedOutcome, { disposition: "ready" }>["episode"]; version: string;
  changeRef: VersionedRef; strategyRef?: VersionedRef; bundleRef: VersionedRef; generationId: string };
const preparedProjections = new WeakMap<object, {
  prepared: object; runtime: PraxisRuntimeMemory; requestId: string; projection: OutcomeProjection;
  verification: { operationId: string; planHash: string }; assertCurrent(): Promise<void>;
}>();

/** Only the transaction builder can attest the projected Episode and learning
 * references. A matching JSON object is not a transaction receipt. */
export async function readPreparedOutcomeProjection(transaction: object, prepared: object) {
  const binding = preparedProjections.get(transaction);
  if (!binding || binding.prepared !== prepared) throw new EpisodeV2Error("outcome_transaction_unbound");
  await binding.assertCurrent();
  return { runtime: binding.runtime, requestId: binding.requestId, projection: structuredClone(binding.projection),
    verification: structuredClone(binding.verification),
    assertCurrent: binding.assertCurrent };
}

export async function prepareOutcomeTransaction(input: { operationId: string; runtime: PraxisRuntimeMemory;
  objectRoot: string; revision: string; requestId: string; prepared: Extract<PreparedOutcome, { disposition: "ready" }>;
  /** Structured rebuild admissions for required views whose inputs or open evidence plane changed. */
  viewRebuilds?: (generationId: string, after: MemoryCatalog, journalPath: string, changes: readonly MemoryFileChange[]) =>
    | readonly ViewRebuildAdmission[]
    | undefined
    | Promise<readonly ViewRebuildAdmission[] | undefined>;
}) {
  input = { ...input };
  if (input.requestId !== input.operationId) throw new EpisodeV2Error("outcome_request_binding_mismatch");
  const binding = await readPreparedOutcomeContext(input.prepared);
  if (binding.resolver !== input.runtime.evidence || binding.result.disposition !== "ready") {
    throw new EpisodeV2Error("outcome_transaction_producer_mismatch");
  }
  const prepared = binding.result;
  const { runtime } = input;
  const reader = runtime.evidence.reader;
  await reader.assertCurrent();
  const previous = await runtime.repository.read(prepared.episode.id);
  if (previous.version !== prepared.expectedVersion || canonicalJson(previous) !== canonicalJson(binding.selected)) {
    throw new EpisodeV2Error("stale_episode_selection");
  }
  const beforeCatalog = (await readRepositoryBytes(reader.root, reader.catalogPath)).toString("utf8");
  let after: MemoryCatalog = structuredClone(reader.catalog);
  const changes: MemoryFileChange[] = [];
  const objects: Array<{ path: string; bytes: string }> = [];
  const operationId = `outcome_${bytesVersion(input.operationId).slice(7)}`;
  const identity = canonicalJson({ episodeId: previous.episode.id, operationId });
  const changeId = stableId("change", identity);
  const unique = (refs: VersionedRef[]) => [...new Map(refs.map((ref) => [canonicalJson(ref), ref])).values()];
  const inputRefs = unique([...prepared.episode.actual!.evidenceRefs, ...prepared.episode.outcome!.evidenceRefs, ...prepared.learning.evidenceRefs]);
  const add = (group: "changes" | "understandings" | "bundles", object: Record<string, unknown>, dependencies: VersionedRef[]): VersionedRef => {
    const ref = { id: String(object.id), version: objectVersion(object) };
    if ([...after.changes, ...after.understandings, ...after.bundles].some((entry) => entry.id === ref.id)) throw new EpisodeV2Error("learning_identity_conflict");
    const bytes = canonicalJson({ ...object, version: ref.version });
    const locator = `${input.objectRoot}/${group}/${ref.id}/${ref.version.slice(7)}.json`;
    const entry: CatalogEntry = { ...ref, locator: { path: locator, sha256: bytesVersion(bytes) }, status: "current", dependencies: unique(dependencies) };
    after[group].push(entry);
    changes.push({ path: locator, before: null, after: bytes });
    objects.push({ path: locator, bytes });
    return ref;
  };
  let strategyRef: VersionedRef | undefined;
  if (prepared.learning.disposition === "propose_strategy") {
    if (!prepared.learning.strategy) throw new EpisodeV2Error("invalid_learning_proposal");
    strategyRef = add("understandings", { schemaVersion: "stella.understanding/v1", id: stableId("understanding", identity),
      statement: prepared.learning.strategy.statement, kind: "strategy", scope: prepared.learning.strategy.scope, status: "candidate",
      supportRefs: prepared.learning.evidenceRefs, counterRefs: [], dependencyRefs: inputRefs, originChangeId: changeId,
      createdAt: prepared.episode.updatedAt, updatedAt: prepared.episode.updatedAt }, inputRefs);
  }
  const changeRef = add("changes", { schemaVersion: "stella.learning-change/v1", id: changeId, operationId,
    algorithmVersion: "stella-outcome-preparation/v1", modelRef: prepared.modelRef, promptVersion: prepared.promptVersion,
    inputRefs, targetRefs: strategyRef ? [strategyRef] : [],
    changes: strategyRef ? [{ kind: "create", before: null, after: strategyRef, supportRefs: prepared.learning.evidenceRefs, counterRefs: [] }] : [],
    rationale: prepared.learning.rationale, disposition: strategyRef ? "update" : "no_change" }, [...inputRefs, ...(strategyRef ? [strategyRef] : [])]);
  const episode = await parseEpisodeV2({ ...prepared.episode, learning: { ...prepared.episode.learning, praxis: strategyRef ? [strategyRef] : [] } });
  await validateEpisodeV2Transition(previous.episode, episode);
  const version = episodeVersion(episode);
  const episodeDirectory = path.posix.dirname(path.posix.dirname(runtime.repository.historicalPath(episode.id, previous.version)));
  const episodePath = `${episodeDirectory}/episode.json`;
  const beforeEpisode = (await readRepositoryBytes(reader.root, episodePath)).toString("utf8");
  if (episodeVersion(await parseEpisodeV2(JSON.parse(beforeEpisode))) !== previous.version) throw new EpisodeV2Error("stale_episode_selection");
  changes.push({ path: runtime.repository.historicalPath(episode.id, version), before: null, after: canonicalJson(episode) });
  changes.push({ path: episodePath, before: beforeEpisode, after: canonicalJson(episode) });
  after.parentGenerationId = reader.catalog.generationId;
  after.generationId = `generation_${bytesVersion(canonicalJson({ operationId, before: reader.catalogHash, version, changeRef })).slice(7)}`;
  const bundle = createOutcomeEvidenceBundle({ operationId, requestId: input.requestId, revision: input.revision, generationId: reader.catalog.generationId, prepared });
  const bundleRef = add("bundles", bundle, [...bundle.readEvidenceRefs, ...bundle.searchedCoverageRefs]);
  const extraChangedPaths = new Set([episodePath, runtime.repository.historicalPath(episode.id, version)]);
  const journalPath = path.posix.join(path.posix.dirname(reader.catalogPath), "operations", `${operationId}.transaction.json`);
  const viewRebuilds = await input.viewRebuilds?.(after.generationId, structuredClone(after), journalPath, structuredClone(changes));
  const viewMigration: ViewMigrationPlan = planViewMigration({
    before: reader.catalog, after, rebuilds: viewRebuilds, extraChangedPaths,
  });
  after = applyViewMigration(after, viewMigration);
  parseMemoryCatalog(after);
  const afterCatalog = canonicalJson(after);
  changes.push(...viewMigration.files);
  changes.push({ path: reader.catalogPath, before: beforeCatalog, after: afterCatalog });
  const plan: MemoryTransactionPlan = { operationId, journalPath, files: changes };
  const verification = { operationId, planHash: bytesVersion(canonicalJson(plan)) };
  let persistencePlan = plan;
  await reader.assertCurrent();
  const transaction = {
    episode, version, changeRef, ...(strategyRef ? { strategyRef } : {}), bundle, bundleRef, plan, generationId: after.generationId,
    viewMigration,
    async persist(durability: GitCangHaiDurability, abortSignal: AbortSignal, archive?: StoredContextHistory) {
      assertProjection();
      if (archive) {
        const stored = await readContextHistory(archive, reader.root);
        if (!Array.isArray(stored.outcomeTransactions) || !stored.outcomeTransactions.some((receipt: unknown) =>
          isRecord(receipt) && receipt.operationId === verification.operationId && receipt.planHash === verification.planHash)) {
          throw new EpisodeV2Error("outcome_recovery_verification_required");
        }
        const { archiveRoot, digest } = contextHistoryLocation(archive);
        persistencePlan = { ...plan, contextArchive: { archiveRoot, digest } };
      }
      await applyMemoryTransaction(reader.root, persistencePlan, {
        async validate() {
          const current = await CatalogReader.load(reader.root, reader.catalogPath);
          if (![bytesVersion(beforeCatalog), bytesVersion(afterCatalog)].includes(current.catalogHash)) throw new EpisodeV2Error("stale_generation");
          await current.validatePreview(after, objects, async (preview) => {
            const resolver = new EpisodeEvidenceResolver(preview, runtime.evidence.purpose, runtime.evidence.complete);
            await loadEvidenceBundle(resolver, { bundleRef, requestId: input.requestId, revision: input.revision, generationId: bundle.generationId });
            await validateEpisodeV2References(episode, {
              resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
              // The opaque prepared outcome already passed both semantic checks.
              // Execute that exact result while rereading its current evidence.
              verifyActionEvidence: async actual => canonicalJson(actual) === canonicalJson(prepared.episode.actual),
              verifyOutcomeEvidence: async (actual, outcome) => canonicalJson(actual) === canonicalJson(prepared.episode.actual) &&
                canonicalJson(outcome) === canonicalJson(prepared.episode.outcome),
              resolveLearning: (ref) => resolver.resolveLearning(ref),
            });
            for (const original of binding.originals) {
              if (canonicalJson(await resolver.readEvidence(original.ref)) !== canonicalJson(original)) throw new EpisodeV2Error("stale_evidence");
            }
            for (const ref of inputRefs) await resolver.readEvidence(ref);
            if (!await resolver.isCurrentlyEligible(episode)) throw new EpisodeV2Error("evidence_not_currently_eligible");
          }, { viewMigration, viewRebuilds, viewExtraChangedPaths: extraChangedPaths });
        },
        async persist(paths, id) { await durability.syncCritical(paths, `close and evaluate ${id}`); },
        confirmPreviouslyCommitted: (file) => durability.confirmPreviouslyCommitted(file),
        publishView: () => afterDurablePersistPublishView(reader.root),
      }, abortSignal);
      const diagnostics = await durability.diagnostics();
      if (!diagnostics.criticalSynchronized || diagnostics.localRevision !== diagnostics.synchronizedRevision) throw new EpisodeV2Error("critical_sync_failed");
      return { revision: diagnostics.localRevision, generationId: after.generationId, writeOperationIds: [operationId] };
    },
  };
  const projection = { episode, version, changeRef, ...(strategyRef ? { strategyRef } : {}), bundleRef, generationId: after.generationId };
  const snapshot = canonicalJson({ ...projection, bundle, plan, viewMigration });
  const assertProjection = () => {
    const { persist: _persist, ...current } = transaction;
    if (canonicalJson(current) !== snapshot) throw new EpisodeV2Error("outcome_transaction_changed");
  };
  const assertCurrent = async () => {
    assertProjection();
    await readPreparedOutcomeContext(input.prepared);
    await reader.assertCurrent();
    if ((await readRepositoryBytes(reader.root, episodePath)).toString("utf8") !== beforeEpisode) {
      throw new EpisodeV2Error("stale_episode_selection");
    }
    assertProjection();
  };
  await assertCurrent();
  preparedProjections.set(transaction, { prepared: input.prepared, runtime, requestId: input.requestId,
    projection: structuredClone(projection), verification, assertCurrent });
  return transaction;
}
