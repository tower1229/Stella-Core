import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { bytesVersion } from "../dist/src/canghai/content-version.js";
import { parseSourceRestrictions, parseSourceUsageRules } from "../dist/src/canghai/source-policy.js";
import { compileReviewedSourceConstraints } from "../dist/src/canghai/source-policy-migration.js";

// Read-only, exact-revision inventory. Output is private review data, never a fixture or an activation receipt.
const [root, revision, reviewFile] = process.argv.slice(2);
if (!root || !/^[a-f0-9]{40}$/.test(revision ?? "") || ![4, 5].includes(process.argv.length)) throw new Error("Usage: node scripts/plan-source-policy-migration.mjs <root> <full-revision> [semantic-review.json]");
const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 });
const checkSource = () => {
  if (git("rev-parse", "HEAD").toString().trim() !== revision || git("status", "--porcelain").length) throw new Error("source_revision_or_cleanliness_changed");
};
checkSource();
const entries = git("ls-tree", "-rz", revision, "30_RAG").toString().split("\0").filter(Boolean);
const plans = [], blockers = [], ids = new Set();
for (const entry of entries) {
  const split = entry.indexOf("\t"), file = entry.slice(split + 1), [mode, kind, blob] = entry.slice(0, split).split(" ");
  if (!file.endsWith(".md")) continue;
  if (!["100644", "100755"].includes(mode) || kind !== "blob") { blockers.push({ file, category: "unsafe_source" }); continue; }
  const bytes = git("cat-file", "blob", blob);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) { blockers.push({ file, category: "source_metadata_missing" }); continue; }
  try {
    const metadata = parse(frontmatter[1]);
    if (!metadata || typeof metadata.source_id !== "string" || !metadata.source_id.trim() || ids.has(metadata.source_id)) throw new Error("invalid_or_duplicate_source_id");
    const restrictions = parseSourceRestrictions({ sensitivity: metadata.sensitivity, quotePolicy: metadata.quote_policy,
      allowedScenarios: metadata.allowed_scenarios, forbiddenScenarios: metadata.not_allowed_scenarios });
    ids.add(metadata.source_id);
    plans.push({ sourceId: metadata.source_id, source: { path: file, revision, gitBlob: blob, sha256: bytesVersion(bytes) },
      action: "create_versioned_policy", targetSchemaVersion: "stella.source-policy/v2", restrictions,
      status: "requires_semantic_review", remaining: ["review_usage_policy_and_import_notes", "bind_purpose_registry_and_authority", "verify_request_and_quote_authorization_adapters"] });
  } catch (error) {
    // YAML parser messages may contain source excerpts; keep diagnostics categorical.
    const category = error.category === "invalid_source_policy" ? "invalid_source_policy" :
      error.message === "invalid_or_duplicate_source_id" ? "invalid_or_duplicate_source_id" : "invalid_source_metadata";
    blockers.push({ file, category });
  }
}
checkSource();
let semanticReview;
if (reviewFile) {
  // The caller supplies a completed semantic review. This script only validates
  // its source bindings; it never infers meaning or grants migration authority.
  const bytes = readFileSync(reviewFile);
  let review;
  try { review = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("invalid_semantic_review"); }
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
  const texts = value => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim());
  if (!keys(review, ["schemaVersion", "sourceRevision", "reviewer", "entries"]) || review.schemaVersion !== "stella.source-policy-semantic-review/v1" ||
      !/^[a-f0-9]{40}$/.test(review.sourceRevision ?? "") || !keys(review.reviewer, ["kind", "id"]) || review.reviewer.kind !== "llm" ||
      typeof review.reviewer.id !== "string" || !review.reviewer.id.trim() || !Array.isArray(review.entries) ||
      review.entries.length !== plans.length || blockers.length) throw new Error("invalid_semantic_review");
  // A later commit may only change runtime projections. Reuse the interpretation
  // only when the entire reviewed source tree, including names/modes, is identical.
  // Keep the original review and its revision intact; this is a new binding proof.
  let originalTree;
  try { originalTree = git("ls-tree", "-rz", review.sourceRevision, "30_RAG"); }
  catch { throw new Error("semantic_review_revision_unavailable"); }
  if (!originalTree.equals(git("ls-tree", "-rz", revision, "30_RAG"))) throw new Error("semantic_review_source_tree_changed");
  const seen = new Set();
  for (const row of review.entries) {
    if (!keys(row, ["sourceId", "sourceSha256", "interpretation", "requiredChanges"]) || typeof row.sourceId !== "string" || seen.has(row.sourceId) ||
        typeof row.interpretation !== "string" || !row.interpretation.trim() || !texts(row.requiredChanges)) throw new Error("invalid_semantic_review");
    const plan = plans.find(plan => plan.sourceId === row.sourceId);
    if (!plan || row.sourceSha256 !== plan.source.sha256) throw new Error("semantic_review_source_mismatch");
    seen.add(row.sourceId);
    plan.status = "semantic_reviewed";
    plan.review = { interpretation: row.interpretation, requiredChanges: row.requiredChanges };
    try {
      plan.constraintImplementation = compileReviewedSourceConstraints(row.requiredChanges);
      // Preserve the source-specific semantic review as well as the shared rule
      // vocabulary. Generic rule ids alone cannot replace its contextual limits.
      plan.constraintImplementation.usageRules.interpretation.push({ id: "reviewed_source_scope", requirement: row.interpretation });
      plan.constraintImplementation.usageRules = parseSourceUsageRules(plan.constraintImplementation.usageRules);
      plan.targetSchemaVersion = "stella.source-policy/v3";
    } catch {
      plan.constraintImplementation = { implementationReady: false, category: "unsupported_review_constraint" };
    }
    plan.remaining = ["verify_compiled_constraints_against_original", "resolve_required_capability_evidence", ...plan.remaining.filter(item => item !== "review_usage_policy_and_import_notes")];
  }
  semanticReview = { sha256: bytesVersion(bytes), reviewer: review.reviewer, sourceBindingsVerified: true,
    reviewedRevision: review.sourceRevision, boundRevision: revision, sourceTreeUnchanged: true };
}
checkSource();
process.stdout.write(JSON.stringify({ schemaVersion: "stella.source-policy-migration-plan/v1", sourceRevision: revision,
  readyToApply: false, scope: "tracked_30_RAG_markdown_metadata_only", semanticReviewPerformed: Boolean(semanticReview),
  ...(semanticReview ? { semanticReview } : {}),
  plans, blockers }, null, 2) + "\n");
if (blockers.length) process.exitCode = 2;
