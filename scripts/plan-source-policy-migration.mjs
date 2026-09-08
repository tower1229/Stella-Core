import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { bytesVersion } from "../dist/src/canghai/content-version.js";
import { parseSourceRestrictions } from "../dist/src/canghai/source-policy.js";

// Read-only, exact-revision inventory. Output is private review data, never a fixture or an activation receipt.
const [root, revision] = process.argv.slice(2);
if (!root || !/^[a-f0-9]{40}$/.test(revision ?? "") || process.argv.length !== 4) throw new Error("Usage: node scripts/plan-source-policy-migration.mjs <root> <full-revision>");
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
process.stdout.write(JSON.stringify({ schemaVersion: "stella.source-policy-migration-plan/v1", sourceRevision: revision,
  readyToApply: false, scope: "tracked_30_RAG_markdown_metadata_only", semanticReviewPerformed: false,
  plans, blockers }, null, 2) + "\n");
if (blockers.length) process.exitCode = 2;
