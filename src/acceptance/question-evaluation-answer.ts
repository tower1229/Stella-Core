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
}, progress: { stage: string }): Promise<{ answer: PraxisEvaluationAnswer; resolver: EpisodeEvidenceResolver }> {
  check(input.requestId && input.question.trim() && input.text.trim());
  progress.stage = "catalog";
  const reader = await CatalogReader.load(input.root, input.catalogPath);
  await reader.assertCurrent();
  const operationId = `question_${bytesVersion(input.requestId).slice(7)}`;
  const operations = path.posix.join(path.posix.dirname(input.catalogPath), "operations");
  const bindingPath = `${operations}/${operationId}.evidence.json`;
  progress.stage = "binding_record";
  const binding: unknown = JSON.parse((await readRepositoryBytes(input.root, bindingPath)).toString("utf8"));
  check(isRecord(binding) && binding.schemaVersion === "stella.question-evidence-receipt/v1" &&
    binding.operationId === operationId && binding.requestId === input.requestId && validMemoryRef(binding.bundleRef) &&
    binding.requestHash === bytesVersion(input.question) && binding.draftHash === bytesVersion(input.text) &&
    typeof binding.revision === "string" && /^[a-f0-9]{40}$/.test(binding.revision) &&
    typeof binding.generationId === "string" && typeof binding.evidenceCutoff === "string" &&
    Number.isFinite(Date.parse(binding.evidenceCutoff)));
  progress.stage = "transaction_journal";
  const journal = await readRecordedMemoryTransaction(input.root, operationId, `${operations}/${operationId}.transaction.json`);
  check(journal.files.find((file) => file.path === bindingPath)?.after === canonicalJson(binding));
  progress.stage = "evidence_scope";
  const evidenceCutoff = new Date(Math.min(Date.parse(binding.evidenceCutoff), Date.parse(input.purpose.evidenceCutoff))).toISOString();
  const resolver = new EpisodeEvidenceResolver(reader, { ...input.purpose, evidenceCutoff }, input.complete);
  const answer: PraxisEvaluationAnswer = { text: input.text, requestId: input.requestId, revision: binding.revision,
    generationId: binding.generationId, bundleRef: { id: binding.bundleRef.id, version: binding.bundleRef.version } };
  progress.stage = "evidence_bundle";
  const loaded = await loadEvidenceBundle(resolver, answer);
  const entry = reader.entry(answer.bundleRef, "bundles");
  check(journal.files.find((file) => file.path === entry.locator.path)?.after === canonicalJson(loaded.bundle));
  progress.stage = "final_generation";
  await reader.assertCurrent();
  return { answer, resolver };
}

export async function loadQuestionEvaluationAnswer(input: Parameters<typeof loadBoundQuestionEvaluationAnswer>[0]) {
  const progress = { stage: "input" };
  try { return await loadBoundQuestionEvaluationAnswer(input, progress); }
  catch (error) {
    const category = error instanceof CatalogError || error instanceof MemoryTransactionError
      ? error.category : "evaluation_answer_binding_unavailable";
    const code = isRecord(error) ? error.code : undefined;
    const cause = typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "EBUSY", "ENAMETOOLONG", "EIO"].includes(code)
      ? code : error instanceof SyntaxError ? "invalid_json" : error instanceof RangeError ? "invalid_range"
        : error instanceof TypeError ? "invalid_type" : "unclassified";
    // Never attach the original exception: it may contain a private path or body.
    throw Object.assign(new CatalogError(category), { diagnostics: { stage: progress.stage, cause } });
  }
}
