import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, objectVersion } from "../src/canghai/content-version.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { stableId } from "../src/canghai/host-input-archive.js";
import { loadEvidenceBundle } from "../src/praxis/evidence-bundle.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { prepareQuestionTransaction, recoverPendingQuestion } from "../src/praxis/question-transaction.js";
import { bundleFixture } from "./evidence-bundle-fixture.js";
import { loadQuestionEvaluationAnswer } from "../src/acceptance/question-evaluation-answer.js";

const run = promisify(execFile);
for (const responseKind of ["clarification", "collaboration"] as const) {
test(`${responseKind} evidence commits without an Episode and recovers after pointer failure with exact answer binding`, async (t) => {
  const fixture = await bundleFixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "stella-question-remote-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await run("git", ["init", "--quiet", "--initial-branch=main", fixture.root]);
  for (const [key, value] of [["user.name", "Synthetic Test"], ["user.email", "synthetic@example.invalid"], ["core.autocrlf", "false"]]) {
    await run("git", ["-C", fixture.root, "config", key!, value!]);
  }
  await run("git", ["-C", fixture.root, "add", "."]);
  await run("git", ["-C", fixture.root, "commit", "--quiet", "-m", "Synthetic question baseline"]);
  const initial = (await run("git", ["-C", fixture.root, "rev-parse", "HEAD"])).stdout.trim();
  const remote = path.join(external, "remote.git");
  await run("git", ["init", "--quiet", "--bare", remote]);
  await run("git", ["-C", fixture.root, "remote", "add", "origin", remote]);
  await run("git", ["-C", fixture.root, "push", "origin", "main"]);
  const resolver = await fixture.resolver();
  const content = { ...fixture.bundle, id: stableId("bundle", `question:${fixture.bundle.requestId}`), revision: initial,
    suggestedResponseKind: responseKind,
    ...(responseKind === "collaboration" ? { status: "sufficient" as const, unresolvedLeads: [] } : {}) };
  const prepared = await prepareQuestionTransaction({ resolver, objectRoot: "objects", bundle: { ...content, version: objectVersion(content) } });
  assert.equal(prepared.bundle.version, objectVersion(content));
  assert.equal((await run("git", ["-C", fixture.root, "status", "--porcelain"])).stdout.trim(), "");
  const answerText = `Synthetic ${responseKind}`;
  const answer = { requestHash: bytesVersion("Synthetic question"), draftHash: bytesVersion(answerText) };
  let fail = true;
  const pointer = path.join(external, "pointer");
  const createDurability = () => new GitCangHaiDurability({ root: fixture.root, remote: "origin", branch: "main",
    criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
    onRevision: async (revision) => { if (fail) throw new Error("Synthetic pointer failure"); await writeFile(pointer, revision); } });
  const signal = new AbortController().signal;
  await assert.rejects(prepared.persist(createDurability(), signal, answer), /Synthetic pointer failure/);
  await assert.rejects((await CatalogReader.load(fixture.root, "catalog.json")).assertCurrent(), /memory_transaction_pending/);
  assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), initial);
  fail = false;
  const durability = createDurability();
  const recovery = { root: fixture.root, operationId: `question_${bytesVersion(content.requestId).slice(7)}`, catalogPath: "catalog.json", objectRoot: "objects",
    purpose: resolver.purpose, complete: resolver.complete, durability, abortSignal: signal };
  await assert.rejects(recoverPendingQuestion({ ...recovery, objectRoot: "unrelated" }), /question_transaction_invalid/);
  const receipt = await recoverPendingQuestion(recovery);
  assert.deepEqual(await recoverPendingQuestion(recovery), receipt);
  assert.deepEqual(await prepared.persist(durability, signal, answer), receipt);
  await assert.rejects(prepared.persist(durability, signal, { ...answer, draftHash: bytesVersion("Different answer") }), /transaction_operation_conflict/);
  assert.equal(await readFile(pointer, "utf8"), receipt.revision);
  assert.equal((await run("git", ["-C", fixture.root, "rev-list", "--count", "HEAD"])).stdout.trim(), "2");
  const restored = path.join(external, "restored");
  await run("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--branch", "main", remote, restored]);
  const reader = await CatalogReader.load(restored, "catalog.json");
  const loaded = await loadEvidenceBundle(new EpisodeEvidenceResolver(reader, resolver.purpose, resolver.complete), {
    bundleRef: prepared.bundleRef, requestId: content.requestId, revision: initial, generationId: prepared.bundle.generationId });
  assert.equal(loaded.validatedGenerationId, receipt.generationId);
  assert.equal(loaded.bundle.generationId, fixture.bundle.generationId);
  assert.deepEqual(loaded.bundle, prepared.bundle);
  assert.deepEqual(reader.catalog.changes, []);
  assert.deepEqual(reader.catalog.understandings, []);
  const binding = JSON.parse(await readFile(path.join(restored, prepared.bindingPath), "utf8")) as Record<string, unknown>;
  assert.equal(binding.requestHash, answer.requestHash);
  assert.equal(binding.draftHash, answer.draftHash);
  assert.equal(binding.evidenceCutoff, resolver.purpose.evidenceCutoff);
  const evaluationInput = { root: restored, catalogPath: "catalog.json", requestId: content.requestId,
    question: "Synthetic question", text: answerText, purpose: resolver.purpose, complete: resolver.complete };
  const evaluation = await loadQuestionEvaluationAnswer(evaluationInput);
  assert.deepEqual(evaluation.answer.bundleRef, prepared.bundleRef);
  assert.equal(Date.parse(evaluation.resolver.purpose.evidenceCutoff), Date.parse(resolver.purpose.evidenceCutoff));
  await assert.rejects(loadQuestionEvaluationAnswer({ ...evaluationInput, text: "Replacement answer" }), /evaluation_answer_binding_mismatch/);
  await assert.rejects(loadQuestionEvaluationAnswer({ ...evaluationInput, question: "Different question" }), /evaluation_answer_binding_mismatch/);
  await assert.rejects(loadQuestionEvaluationAnswer({ ...evaluationInput, requestId: "missing-operation" }),
    (error: unknown) => {
      assert.deepEqual((error as { diagnostics?: unknown }).diagnostics, { stage: "binding_record", cause: "ENOENT" });
      return true;
    });
  assert.equal((await run("git", ["-C", fixture.root, "status", "--porcelain"])).stdout.trim(), "");
});
}
