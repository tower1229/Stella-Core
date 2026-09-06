import path from "node:path";
import { CatalogReader, parseMemoryCatalog, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { stableId } from "../canghai/host-input-archive.js";
import { applyMemoryTransaction, readRecordedMemoryTransaction, type MemoryTransactionPlan } from "../canghai/memory-transaction.js";
import type { GitCangHaiDurability } from "../canghai/durability.js";
import { isRecord } from "../shared/type-guards.js";
import { EpisodeV2Error } from "./episode-v2.js";
import { EpisodeEvidenceResolver, type EvidencePurpose } from "./episode-evidence.js";
import { loadEvidenceBundle, parseEvidenceBundle, type EvidenceBundle } from "./evidence-bundle.js";

function check(value: unknown): asserts value { if (!value) throw new EpisodeV2Error("question_transaction_invalid"); }
const hash = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
type AnswerBinding = { requestHash: string; draftHash: string };

function preparePlan(catalogPath: string, beforeBytes: string, objectRoot: string, original: EvidenceBundle, evidenceCutoff: string) {
  const before = parseMemoryCatalog(JSON.parse(beforeBytes));
  const source = parseEvidenceBundle(structuredClone(original));
  check(source.generationId === before.generationId && ["answer", "clarification"].includes(source.suggestedResponseKind));
  check(source.id === stableId("bundle", `question:${source.requestId}`) && !before.bundles.some((entry) => entry.id === source.id));
  check(Number.isFinite(Date.parse(evidenceCutoff)) && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(evidenceCutoff));
  const operationId = `question_${bytesVersion(source.requestId).slice(7)}`;
  const after = structuredClone(before);
  after.parentGenerationId = before.generationId;
  after.generationId = `generation_${bytesVersion(canonicalJson({ operationId, before: bytesVersion(beforeBytes), bundleVersion: source.version })).slice(7)}`;
  const content = { ...source, generationId: after.generationId };
  const bundle = parseEvidenceBundle({ ...content, version: objectVersion(content) });
  const bundleRef = { id: bundle.id, version: bundle.version };
  const bundlePath = `${objectRoot}/bundles/${bundle.id}/${bundle.version.slice(7)}.json`;
  const bundleBytes = canonicalJson(bundle);
  const dependencies = [...new Map([...bundle.readEvidenceRefs, ...bundle.searchedCoverageRefs].map((ref) => [canonicalJson(ref), ref])).values()];
  after.bundles.push({ ...bundleRef, status: "current", dependencies, locator: { path: bundlePath, sha256: bytesVersion(bundleBytes) } });
  const operations = path.posix.join(path.posix.dirname(catalogPath), "operations");
  const bindingPath = `${operations}/${operationId}.evidence.json`;
  const binding = { schemaVersion: "stella.question-evidence-receipt/v1", operationId, bundleRef,
    requestId: bundle.requestId, revision: bundle.revision, generationId: bundle.generationId, evidenceCutoff };
  return { bundle, bundleRef, after, bundlePath, bundleBytes, bindingPath,
    plan(answer: AnswerBinding): MemoryTransactionPlan {
      check(hash(answer.requestHash) && hash(answer.draftHash));
      return { operationId, journalPath: `${operations}/${operationId}.transaction.json`, files: [
        { path: bundlePath, before: null, after: bundleBytes },
        { path: bindingPath, before: null, after: canonicalJson({ ...binding, ...answer }) },
        { path: catalogPath, before: beforeBytes, after: canonicalJson(after) },
      ] };
    } };
}

async function persist(input: { root: string; catalogPath: string; prepared: ReturnType<typeof preparePlan>; plan: MemoryTransactionPlan;
  purpose: EvidencePurpose; complete: EpisodeEvidenceResolver["complete"]; durability: GitCangHaiDurability; abortSignal: AbortSignal }) {
  const { prepared } = input;
  const catalogFile = input.plan.files.find((file) => file.path === input.catalogPath)!;
  await applyMemoryTransaction(input.root, input.plan, {
    async validate() {
      const current = await CatalogReader.load(input.root, input.catalogPath);
      check([bytesVersion(catalogFile.before!), bytesVersion(catalogFile.after)].includes(current.catalogHash));
      await current.validatePreview(prepared.after, [{ path: prepared.bundlePath, bytes: prepared.bundleBytes }], async (preview) => {
        const resolver = new EpisodeEvidenceResolver(preview, input.purpose, input.complete);
        await loadEvidenceBundle(resolver, { bundleRef: prepared.bundleRef, requestId: prepared.bundle.requestId,
          revision: prepared.bundle.revision, generationId: prepared.bundle.generationId });
      });
    },
    async persist(paths, operationId) { await input.durability.syncCritical(paths, `preserve question evidence ${operationId}`); },
    confirmPreviouslyCommitted: (file) => input.durability.confirmPreviouslyCommitted(file),
  }, input.abortSignal);
  const diagnostics = await input.durability.diagnostics();
  if (!diagnostics.criticalSynchronized || diagnostics.localRevision !== diagnostics.synchronizedRevision) throw new EpisodeV2Error("critical_sync_failed");
  return { revision: diagnostics.localRevision, generationId: prepared.bundle.generationId, writeOperationIds: [input.plan.operationId] };
}

export async function prepareQuestionTransaction(input: { resolver: EpisodeEvidenceResolver; objectRoot: string; bundle: EvidenceBundle }) {
  const reader = input.resolver.reader;
  await reader.assertCurrent();
  const before = (await readRepositoryBytes(reader.root, reader.catalogPath)).toString("utf8");
  const prepared = preparePlan(reader.catalogPath, before, input.objectRoot, input.bundle, input.resolver.purpose.evidenceCutoff);
  await reader.assertCurrent();
  return { bundle: prepared.bundle, bundleRef: prepared.bundleRef, bindingPath: prepared.bindingPath,
    persist: (durability: GitCangHaiDurability, abortSignal: AbortSignal, answer: AnswerBinding) => persist({ root: reader.root,
      catalogPath: reader.catalogPath, prepared, plan: prepared.plan(answer), purpose: input.resolver.purpose,
      complete: input.resolver.complete, durability, abortSignal }),
  };
}

/** Only the recorded bundle/catalog/binding can be recovered; no reply is regenerated or sent. */
export async function recoverPendingQuestion(input: { root: string; operationId: string; catalogPath: string; objectRoot: string;
  purpose: EvidencePurpose; complete: EpisodeEvidenceResolver["complete"]; durability: GitCangHaiDurability; abortSignal: AbortSignal }) {
  check(/^question_[a-f0-9]{64}$/.test(input.operationId));
  const journal = path.posix.join(path.posix.dirname(input.catalogPath), "operations", `${input.operationId}.transaction.json`);
  const plan = await readRecordedMemoryTransaction(input.root, input.operationId, journal);
  check(plan.files.length === 3);
  const catalog = plan.files.find((file) => file.path === input.catalogPath);
  const bindingFile = plan.files.find((file) => file.path === path.posix.join(path.posix.dirname(input.catalogPath), "operations", `${input.operationId}.evidence.json`));
  check(catalog?.before && bindingFile?.before === null);
  const binding: unknown = JSON.parse(bindingFile.after);
  check(isRecord(binding) && isRecord(binding.bundleRef) && typeof binding.evidenceCutoff === "string");
  const bundleRef = binding.bundleRef;
  const bundleFile = plan.files.find((file) => file.path === `${input.objectRoot}/bundles/${String(bundleRef.id)}/${String(bundleRef.version).slice(7)}.json`);
  check(bundleFile?.before === null);
  const stored = parseEvidenceBundle(JSON.parse(bundleFile.after));
  const original = { ...stored, generationId: parseMemoryCatalog(JSON.parse(catalog.before)).generationId };
  const prepared = preparePlan(input.catalogPath, catalog.before, input.objectRoot,
    parseEvidenceBundle({ ...original, version: objectVersion(original) }), binding.evidenceCutoff);
  check(hash(binding.requestHash) && hash(binding.draftHash));
  const expected = prepared.plan({ requestHash: String(binding.requestHash), draftHash: String(binding.draftHash) });
  check(canonicalJson(plan) === canonicalJson(expected));
  const evidenceCutoff = new Date(Math.min(Date.parse(input.purpose.evidenceCutoff), Date.parse(binding.evidenceCutoff))).toISOString();
  return persist({ ...input, prepared, plan, purpose: { ...input.purpose, evidenceCutoff } });
}
