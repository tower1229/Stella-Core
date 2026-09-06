import path from "node:path";
import { CatalogReader, readRepositoryBytes, type CatalogEntry, type MemoryCatalog } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { stableId } from "../canghai/host-input-archive.js";
import { applyMemoryTransaction, type MemoryFileChange, type MemoryTransactionPlan } from "../canghai/memory-transaction.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import { EpisodeEvidenceResolver } from "./episode-evidence.js";
import { episodeVersion } from "./episode-repository.js";
import { EpisodeV2Error, parseEpisodeV2, validateEpisodeV2References, validateEpisodeV2Transition, type VersionedRef } from "./episode-v2.js";
import type { PreparedOutcome } from "./outcome-preparation.js";
import type { PraxisRuntimeMemory } from "./runtime-memory.js";
import { createOutcomeEvidenceBundle } from "./outcome-evidence-bundle.js";
import { loadEvidenceBundle } from "./evidence-bundle.js";

export async function prepareOutcomeTransaction(input: { operationId: string; runtime: PraxisRuntimeMemory;
  objectRoot: string; revision: string; requestId: string; prepared: Extract<PreparedOutcome, { disposition: "ready" }> }) {
  if (input.requestId !== input.operationId) throw new EpisodeV2Error("outcome_request_binding_mismatch");
  const prepared = structuredClone(input.prepared);
  const { runtime } = input;
  const reader = runtime.evidence.reader;
  await reader.assertCurrent();
  const previous = await runtime.repository.read(prepared.episode.id);
  if (previous.version !== prepared.expectedVersion) throw new EpisodeV2Error("stale_episode_selection");
  const beforeCatalog = (await readRepositoryBytes(reader.root, reader.catalogPath)).toString("utf8");
  const after: MemoryCatalog = structuredClone(reader.catalog);
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
  const bundle = createOutcomeEvidenceBundle({ operationId, requestId: input.requestId, revision: input.revision, generationId: after.generationId, prepared });
  const bundleRef = add("bundles", bundle, [...bundle.readEvidenceRefs, ...bundle.searchedCoverageRefs]);
  const afterCatalog = canonicalJson(after);
  changes.push({ path: reader.catalogPath, before: beforeCatalog, after: afterCatalog });
  const plan: MemoryTransactionPlan = { operationId, journalPath: path.posix.join(path.posix.dirname(reader.catalogPath), "operations", `${operationId}.transaction.json`), files: changes };
  await reader.assertCurrent();
  return {
    episode, version, changeRef, strategyRef, bundle, bundleRef, plan, generationId: after.generationId,
    async persist(durability: GitCangHaiDurability, abortSignal: AbortSignal) {
      await applyMemoryTransaction(reader.root, plan, {
        async validate() {
          const current = await CatalogReader.load(reader.root, reader.catalogPath);
          if (![bytesVersion(beforeCatalog), bytesVersion(afterCatalog)].includes(current.catalogHash)) throw new EpisodeV2Error("stale_generation");
          await current.validatePreview(after, objects, async (preview) => {
            const resolver = new EpisodeEvidenceResolver(preview, runtime.evidence.purpose, runtime.evidence.complete);
            await loadEvidenceBundle(resolver, { bundleRef, requestId: input.requestId, revision: input.revision, generationId: after.generationId });
            await validateEpisodeV2References(episode, {
              resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
              verifyActionEvidence: (actual) => resolver.verifyActionEvidence(actual), verifyOutcomeEvidence: (actual, outcome) => resolver.verifyOutcomeEvidence(actual, outcome),
              resolveLearning: (ref) => resolver.resolveLearning(ref),
            });
            for (const ref of inputRefs) await resolver.readEvidence(ref);
            if (!await resolver.isCurrentlyEligible(episode)) throw new EpisodeV2Error("evidence_not_currently_eligible");
          });
        },
        async persist(paths, id) { await durability.syncCritical(paths, `close and evaluate ${id}`); },
        confirmPreviouslyCommitted: (file) => durability.confirmPreviouslyCommitted(file),
      }, abortSignal);
      const diagnostics = await durability.diagnostics();
      if (!diagnostics.criticalSynchronized || diagnostics.localRevision !== diagnostics.synchronizedRevision) throw new EpisodeV2Error("critical_sync_failed");
      return { revision: diagnostics.localRevision, generationId: after.generationId, writeOperationIds: [operationId] };
    },
  };
}
