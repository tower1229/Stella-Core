import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
test("migration planning pins original bytes, remains read-only and redacts malformed metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-policy-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-c", "core.fsmonitor=false", "-C", root, ...args]);
  await git("init", "--quiet");
  await mkdir(path.join(root, "30_RAG"));
  const file = path.join(root, "30_RAG", "synthetic.md");
  const original = "---\nsource_id: synthetic\nsensitivity: sensitive\nquote_policy: summarize_only\nallowed_scenarios: [self_reflection]\nnot_allowed_scenarios: [relationship_judgment]\n---\nSynthetic private body marker\n";
  await writeFile(file, original);
  const commit = async () => {
    await git("add", "30_RAG");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic source");
    return (await git("rev-parse", "HEAD")).stdout.trim();
  };
  const revision = await commit();
  const plan = (ref: string, reviewFile?: string) => exec(process.execPath,
    [path.resolve("scripts/plan-source-policy-migration.mjs"), root, ref, ...(reviewFile ? [reviewFile] : [])]);
  const output = (await plan(revision)).stdout;
  const result = JSON.parse(output);
  assert.equal(result.sourceRevision, revision);
  assert.equal(result.readyToApply, false);
  assert.equal(result.semanticReviewPerformed, false);
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.plans[0].restrictions.forbiddenScenarios, ["relationship_judgment"]);
  assert.equal(output.includes("Synthetic private body marker"), false);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await git("status", "--porcelain")).stdout, "");
  const reviewRoot = await mkdtemp(path.join(os.tmpdir(), "stella-policy-review-"));
  t.after(() => rm(reviewRoot, { recursive: true, force: true }));
  const reviewFile = path.join(reviewRoot, "review.json");
  const review = { schemaVersion: "stella.source-policy-semantic-review/v1", sourceRevision: revision,
    reviewer: { kind: "llm", id: "synthetic-reviewer" }, entries: [{ sourceId: "synthetic", sourceSha256: result.plans[0].source.sha256,
      interpretation: "Synthetic restriction review", requiredChanges: ["preserve_source_constraints"] }] };
  await writeFile(reviewFile, JSON.stringify(review));
  const reviewed = JSON.parse((await plan(revision, reviewFile)).stdout);
  assert.equal(reviewed.semanticReviewPerformed, true);
  assert.equal(reviewed.semanticReview.sourceBindingsVerified, true);
  assert.equal(reviewed.readyToApply, false);
  assert.equal(reviewed.plans[0].status, "semantic_reviewed");
  assert.deepEqual(reviewed.plans[0].restrictions, result.plans[0].restrictions);
  // A runtime-only commit does not require sending unchanged originals to a
  // model again; the original review revision is retained in the binding proof.
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Runtime-only update");
  const laterRevision = (await git("rev-parse", "HEAD")).stdout.trim();
  const rebound = JSON.parse((await plan(laterRevision, reviewFile)).stdout);
  assert.equal(rebound.semanticReview.reviewedRevision, revision);
  assert.equal(rebound.semanticReview.boundRevision, laterRevision);
  assert.equal(rebound.semanticReview.sourceTreeUnchanged, true);
  assert.equal(JSON.parse(await readFile(reviewFile, "utf8")).sourceRevision, revision);
  await writeFile(reviewFile, JSON.stringify({ ...review, entries: [] }));
  await assert.rejects(plan(laterRevision, reviewFile), /invalid_semantic_review/);
  await writeFile(reviewFile, JSON.stringify({ ...review, entries: [{ ...review.entries[0], sourceSha256: `sha256:${"0".repeat(64)}` }] }));
  await assert.rejects(plan(laterRevision, reviewFile), /semantic_review_source_mismatch/);
  await writeFile(reviewFile, JSON.stringify({ ...review, entries: [{ ...review.entries[0], readyToApply: true }] }));
  await assert.rejects(plan(laterRevision, reviewFile), /invalid_semantic_review/);
  await writeFile(file, "---\nsource_id: [SECRET_PARSE_MARKER\n---\n");
  await assert.rejects(plan(revision), /source_revision_or_cleanliness_changed/);
  const malformedRevision = await commit();
  await assert.rejects(plan(revision), /source_revision_or_cleanliness_changed/);
  await assert.rejects(plan(malformedRevision), (error: unknown) => {
    const failure = error as { stdout: string; stderr: string; code: number };
    assert.equal(failure.code, 2);
    assert.equal(`${failure.stdout}${failure.stderr}`.includes("SECRET_PARSE_MARKER"), false);
    assert.equal(JSON.parse(failure.stdout).blockers[0].category, "invalid_source_metadata");
    return true;
  });
  await writeFile(file, `${original}\nChanged original evidence.\n`);
  const changedRevision = await commit();
  await writeFile(reviewFile, JSON.stringify(review));
  await assert.rejects(plan(changedRevision, reviewFile), /semantic_review_source_tree_changed/);
});
