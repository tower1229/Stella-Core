import path from "node:path";
import { CatalogError, CatalogReader, readRepositoryBytes, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { MemoryTransactionError, readRecordedMemoryTransaction } from "../canghai/memory-transaction.js";
import { EpisodeEvidenceResolver, type EvidencePurpose } from "../praxis/episode-evidence.js";
import { loadEvidenceBundle } from "../praxis/evidence-bundle.js";
import { isRecord } from "../shared/type-guards.js";
import type { PraxisEvaluationAnswer } from "./model-praxis-evaluator.js";

function check(value: unknown): asserts value { if (!value) throw new CatalogError("evaluation_answer_binding_mismatch"); }

/** Evaluates the exact delivered question/answer pair, not an adapter-supplied replacement. */
async function loadBoundQuestionEvaluationAnswer(input: {
  root: string; catalogPath: string; requestId: string; question: string; text: string;
  purpose: EvidencePurpose; complete: EpisodeEvidenceResolver["complete"];
}): Promise<{ answer: PraxisEvaluationAnswer; resolver: EpisodeEvidenceResolver }> {
  check(input.requestId && input.question.trim() && input.text.trim());
  const reader = await CatalogReader.load(input.root, input.catalogPath);
  await reader.assertCurrent();
  const operationId = `question_${bytesVersion(input.requestId).slice(7)}`;
  const operations = path.posix.join(path.posix.dirname(input.catalogPath), "operations");
  const bindingPath = `${operations}/${operationId}.evidence.json`;
  const binding: unknown = JSON.parse((await readRepositoryBytes(input.root, bindingPath)).toString("utf8"));
  check(isRecord(binding) && binding.schemaVersion === "stella.question-evidence-receipt/v1" &&
    binding.operationId === operationId && binding.requestId === input.requestId && validMemoryRef(binding.bundleRef) &&
    binding.requestHash === bytesVersion(input.question) && binding.draftHash === bytesVersion(input.text) &&
    typeof binding.revision === "string" && /^[a-f0-9]{40}$/.test(binding.revision) &&
    typeof binding.generationId === "string" && typeof binding.evidenceCutoff === "string" &&
    Number.isFinite(Date.parse(binding.evidenceCutoff)));
  const journal = await readRecordedMemoryTransaction(input.root, operationId, `${operations}/${operationId}.transaction.json`);
  check(journal.files.find((file) => file.path === bindingPath)?.after === canonicalJson(binding));
  const evidenceCutoff = new Date(Math.min(Date.parse(binding.evidenceCutoff), Date.parse(input.purpose.evidenceCutoff))).toISOString();
  const resolver = new EpisodeEvidenceResolver(reader, { ...input.purpose, evidenceCutoff }, input.complete);
  const answer: PraxisEvaluationAnswer = { text: input.text, requestId: input.requestId, revision: binding.revision,
    generationId: binding.generationId, bundleRef: { id: binding.bundleRef.id, version: binding.bundleRef.version } };
  const loaded = await loadEvidenceBundle(resolver, answer);
  const entry = reader.entry(answer.bundleRef, "bundles");
  check(journal.files.find((file) => file.path === entry.locator.path)?.after === canonicalJson(loaded.bundle));
  await reader.assertCurrent();
  return { answer, resolver };
}

export async function loadQuestionEvaluationAnswer(input: Parameters<typeof loadBoundQuestionEvaluationAnswer>[0]) {
  try { return await loadBoundQuestionEvaluationAnswer(input); }
  catch (error) {
    if (error instanceof CatalogError) throw error;
    if (error instanceof MemoryTransactionError) throw new CatalogError(error.category);
    throw new CatalogError("evaluation_answer_binding_unavailable");
  }
}
