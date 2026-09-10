import path from "node:path";
import { CatalogReader, parseMemoryCatalog, readRepositoryBytes, type CatalogEntry } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { stableId } from "../canghai/host-input-archive.js";
import { applyMemoryTransaction, readRecordedMemoryTransaction } from "../canghai/memory-transaction.js";
import { afterDurablePersistPublishView } from "../canghai/managed-durable-write.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import { isRecord } from "../shared/type-guards.js";
import { EpisodeEvidenceResolver, type EvidencePurpose } from "./episode-evidence.js";
import { episodeVersion } from "./episode-repository.js";
import { EpisodeV2Error, parseEpisodeV2, validateEpisodeV2References, validateEpisodeV2Transition, type VersionedRef } from "./episode-v2.js";
import { loadEvidenceBundle, parseEvidenceBundle } from "./evidence-bundle.js";
import { createOutcomeEvidenceBundle } from "./outcome-evidence-bundle.js";
import type { OutcomeLearningProposal } from "./outcome-preparation.js";

function check(value: unknown): asserts value { if (!value) throw new EpisodeV2Error("outcome_recovery_plan_invalid"); }
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const unique = (refs: VersionedRef[]) => [...new Map(refs.map((ref) => [canonicalJson(ref), ref])).values()];

/** Recover one exact journal under explicitly supplied, trusted runtime paths and purpose. Never re-send a reply. */
export async function recoverPendingOutcome(input: {
  root: string; operationId: string; catalogPath: string; episodeRoot: string; objectRoot: string;
  purpose: EvidencePurpose; complete: EpisodeEvidenceResolver["complete"]; durability: GitCangHaiDurability; abortSignal: AbortSignal;
}): Promise<{ revision: string; generationId: string; writeOperationIds: string[] }> {
  const journalPath = path.posix.join(path.posix.dirname(input.catalogPath), "operations", `${input.operationId}.transaction.json`);
  const plan = await readRecordedMemoryTransaction(input.root, input.operationId, journalPath);
  check(/^outcome_[a-f0-9]{64}$/.test(plan.operationId));
  check(plan.journalPath === path.posix.join(path.posix.dirname(input.catalogPath), "operations", `${plan.operationId}.transaction.json`));
  const catalogFile = plan.files.find((file) => file.path === input.catalogPath);
  check(catalogFile?.before);
  const before = parseMemoryCatalog(JSON.parse(catalogFile.before));
  const after = parseMemoryCatalog(JSON.parse(catalogFile.after));
  const episodeFile = plan.files.find((file) => file.path.startsWith(`${input.episodeRoot}/`) && file.path.endsWith("/episode.json"));
  check(episodeFile?.before);
  const previous = await parseEpisodeV2(JSON.parse(episodeFile.before));
  const episode = await parseEpisodeV2(JSON.parse(episodeFile.after));
  check(episode.status === "closed" && episodeFile.path === `${input.episodeRoot}/${episode.id}/episode.json`);
  check(episode.learning?.algorithmVersion === "stella-outcome-preparation/v1");
  const previousBytes = await readRepositoryBytes(input.root, `${input.episodeRoot}/${previous.id}/.versions/${episodeVersion(previous).slice(7)}.json`);
  check(same(JSON.parse(previousBytes.toString("utf8")), previous));
  try {
    const prediction = await readRepositoryBytes(input.root, `${input.episodeRoot}/${previous.id}/prediction.json`);
    check(previous.twin?.prediction && same(JSON.parse(prediction.toString("utf8")), previous.twin.prediction));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && !previous.twin?.prediction)) throw error;
  }
  await validateEpisodeV2Transition(previous, episode);
  const version = episodeVersion(episode);
  const versionPath = `${input.episodeRoot}/${episode.id}/.versions/${version.slice(7)}.json`;
  const immutable = plan.files.find((file) => file.path === versionPath);
  check(immutable?.before === null && immutable.after === canonicalJson(episode));
  const identity = canonicalJson({ episodeId: episode.id, operationId: plan.operationId });
  const changeId = stableId("change", identity);
  const inputRefs = unique([...episode.actual!.evidenceRefs, ...episode.outcome!.evidenceRefs, ...episode.learning!.evidenceRefs]);
  const objects = plan.files.filter((file) => file !== catalogFile && file !== episodeFile && file !== immutable);
  check(objects.length === 2 || objects.length === 3);
  const expected = structuredClone(before);
  const parseObject = (group: "changes" | "understandings" | "bundles", id: string) => {
    const file = objects.find((file) => file.path.startsWith(`${input.objectRoot}/${group}/${id}/`));
    check(file && file.before === null);
    const object: unknown = JSON.parse(file.after);
    check(isRecord(object) && object.id === id && object.version === objectVersion(object));
    const ref = { id, version: String(object.version) };
    check(file.path === `${input.objectRoot}/${group}/${id}/${ref.version.slice(7)}.json` &&
      ![...before.changes, ...before.understandings, ...before.bundles].some((entry) => entry.id === id));
    return { file, object, ref };
  };
  let strategyRef: VersionedRef | undefined;
  let learningStrategy: OutcomeLearningProposal["strategy"];
  if (objects.length === 3) {
    const strategy = parseObject("understandings", stableId("understanding", identity));
    const object = strategy.object;
    check(isRecord(object.scope) && object.scope.global === false && typeof object.statement === "string" && object.statement.trim());
    for (const key of ["workIds", "contexts", "domains"]) check(Array.isArray(object.scope[key]) && object.scope[key].every((value) => typeof value === "string" && value.trim()));
    check(same(object, { schemaVersion: "stella.understanding/v1", id: strategy.ref.id, version: strategy.ref.version,
      statement: object.statement, kind: "strategy", scope: object.scope, status: "candidate", supportRefs: episode.learning!.evidenceRefs,
      counterRefs: [], dependencyRefs: inputRefs, originChangeId: changeId, createdAt: episode.updatedAt, updatedAt: episode.updatedAt }));
    strategyRef = strategy.ref;
    learningStrategy = { statement: object.statement, scope: object.scope as NonNullable<OutcomeLearningProposal["strategy"]>["scope"] };
    expected.understandings.push({ ...strategy.ref, status: "current", dependencies: inputRefs,
      locator: { path: strategy.file.path, sha256: bytesVersion(strategy.file.after) } });
  }
  check(same(episode.learning!.praxis, strategyRef ? [strategyRef] : []) && episode.learning!.twin.length === 0);
  const change = parseObject("changes", changeId);
  check(typeof change.object.modelRef === "string" && change.object.modelRef.trim() && typeof change.object.promptVersion === "string" &&
    change.object.promptVersion.trim() && typeof change.object.rationale === "string" && change.object.rationale.trim());
  check(same(change.object, { schemaVersion: "stella.learning-change/v1", id: changeId, version: change.ref.version, operationId: plan.operationId,
    algorithmVersion: "stella-outcome-preparation/v1", modelRef: change.object.modelRef, promptVersion: change.object.promptVersion,
    inputRefs, targetRefs: strategyRef ? [strategyRef] : [], disposition: strategyRef ? "update" : "no_change", rationale: change.object.rationale,
    changes: strategyRef ? [{ kind: "create", before: null, after: strategyRef, supportRefs: episode.learning!.evidenceRefs, counterRefs: [] }] : [] }));
  const changeEntry: CatalogEntry = { ...change.ref, status: "current", dependencies: [...inputRefs, ...(strategyRef ? [strategyRef] : [])],
    locator: { path: change.file.path, sha256: bytesVersion(change.file.after) } };
  expected.changes.push(changeEntry);
  expected.parentGenerationId = before.generationId;
  expected.generationId = `generation_${bytesVersion(canonicalJson({ operationId: plan.operationId, before: bytesVersion(catalogFile.before), version, changeRef: change.ref })).slice(7)}`;
  const bundleObject = parseObject("bundles", stableId("bundle", plan.operationId));
  const bundle = parseEvidenceBundle(bundleObject.object);
  check(`outcome_${bytesVersion(bundle.requestId).slice(7)}` === plan.operationId);
  const expectedBundle = createOutcomeEvidenceBundle({ operationId: plan.operationId, requestId: bundle.requestId,
    revision: bundle.revision, generationId: before.generationId, prepared: {
      disposition: "ready", expectedVersion: episodeVersion(previous), episode,
      modelRef: change.object.modelRef, promptVersion: change.object.promptVersion,
      readEvidenceRefs: bundle.readEvidenceRefs, searchedCoverageRefs: bundle.searchedCoverageRefs,
      learning: { disposition: strategyRef ? "propose_strategy" : "no_change", rationale: change.object.rationale,
        evidenceRefs: episode.learning!.evidenceRefs, ...(learningStrategy ? { strategy: learningStrategy } : {}) },
    } });
  check(same(bundle, expectedBundle));
  expected.bundles.push({ ...bundleObject.ref, status: "current", dependencies: unique([...bundle.readEvidenceRefs, ...bundle.searchedCoverageRefs]),
    locator: { path: bundleObject.file.path, sha256: bytesVersion(bundleObject.file.after) } });
  check(same(expected, after));
  check(plan.files.length === objects.length + 3);
  await applyMemoryTransaction(input.root, plan, {
    async validate() {
      const current = await CatalogReader.load(input.root, input.catalogPath);
      check([bytesVersion(catalogFile.before!), bytesVersion(catalogFile.after)].includes(current.catalogHash));
      await current.validatePreview(after, objects.map((file) => ({ path: file.path, bytes: file.after })), async (preview) => {
        check(Number.isFinite(Date.parse(input.purpose.evidenceCutoff)));
        const evidenceCutoff = new Date(Math.min(Date.parse(input.purpose.evidenceCutoff), Date.parse(episode.updatedAt))).toISOString();
        const resolver = new EpisodeEvidenceResolver(preview, { ...input.purpose, evidenceCutoff }, input.complete);
        await loadEvidenceBundle(resolver, { bundleRef: bundleObject.ref, requestId: bundle.requestId,
          revision: bundle.revision, generationId: bundle.generationId });
        await validateEpisodeV2References(episode, {
          resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
          verifyActionEvidence: (actual) => resolver.verifyActionEvidence(actual), verifyOutcomeEvidence: (actual, outcome) => resolver.verifyOutcomeEvidence(actual, outcome),
          resolveLearning: (ref) => resolver.resolveLearning(ref),
        });
        for (const ref of inputRefs) await resolver.readEvidence(ref);
        check(await resolver.isCurrentlyEligible(episode));
      });
    },
    async persist(paths, operationId) { await input.durability.syncCritical(paths, `recover outcome ${operationId}`); },
    confirmPreviouslyCommitted: (file) => input.durability.confirmPreviouslyCommitted(file),
    publishView: () => afterDurablePersistPublishView(input.root),
  }, input.abortSignal);
  const diagnostics = await input.durability.diagnostics();
  if (!diagnostics.criticalSynchronized || diagnostics.localRevision !== diagnostics.synchronizedRevision) throw new EpisodeV2Error("critical_sync_failed");
  return { revision: diagnostics.localRevision, generationId: after.generationId, writeOperationIds: [plan.operationId] };
}
