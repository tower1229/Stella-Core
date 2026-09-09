import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { CatalogReader, readRepositoryBytes } from "../dist/src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../dist/src/canghai/content-version.js";
import { prepareRepositorySource } from "../dist/src/canghai/repository-source.js";
import { parseSourcePolicy, parseSourceRestrictions } from "../dist/src/canghai/source-policy.js";

// Private, write-free repository migration candidate. No capability acceptance
// or processing permission is manufactured by this script.
const [root, revision, planFile, reviewFile, output] = process.argv.slice(2);
const check = (value, category) => { if (!value) throw new Error(category); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
check(process.argv.length === 7 && /^[a-f0-9]{40}$/.test(revision ?? ""), "invalid_segment_candidate_arguments");
const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args]);
const current = () => check(git("rev-parse", "HEAD").toString().trim() === revision && git("status", "--porcelain").length === 0, "source_revision_or_cleanliness_changed");
current();
const planBytes = readFileSync(planFile), reviewBytes = readFileSync(reviewFile);
const plan = JSON.parse(planBytes), review = JSON.parse(reviewBytes);
check(plan.schemaVersion === "stella.source-policy-migration-plan/v1" && plan.sourceRevision === revision &&
  plan.semanticReview?.sourceBindingsVerified === true && Array.isArray(plan.plans), "invalid_source_migration_plan");
check(record(review) && Object.keys(review).sort().join() === "catalogPath,objectRoot,reviewer,schemaVersion,sourceRevision,sources" &&
  review.schemaVersion === "stella.source-segmentation-review/v1" && review.sourceRevision === revision &&
  record(review.reviewer) && review.reviewer.kind === "llm" && typeof review.reviewer.id === "string" && review.reviewer.id.trim() &&
  Array.isArray(review.sources) && review.sources.length > 0 && review.sources.length <= 100, "invalid_source_segmentation_review");
const reader = await CatalogReader.load(root, review.catalogPath);
const proposals = [], seen = new Set();
for (const row of review.sources) {
  check(record(row) && Object.keys(row).sort().join() === "segments,sourceId,sourceSha256" && !seen.has(row.sourceId) &&
    Array.isArray(row.segments) && row.segments.length > 0 && row.segments.length <= 512, "invalid_source_segmentation_review");
  seen.add(row.sourceId);
  const planned = plan.plans.filter(entry => entry.sourceId === row.sourceId);
  check(planned.length === 1 && planned[0].source.sha256 === row.sourceSha256 && planned[0].constraintImplementation?.usageRules, "segmentation_source_review_mismatch");
  const expected = planned[0];
  const originals = [];
  for (const entry of reader.catalog.sources) if (entry.status === "current") {
    const source = await reader.read(entry, "sources");
    if (source.origin?.upstreamId === row.sourceId && source.payloads?.some(payload => payload.path === expected.source.path)) originals.push({ entry, source });
  }
  check(originals.length === 1, "segmentation_catalog_source_mismatch");
  const { entry, source } = originals[0];
  check(source.schemaVersion === "stella.memory-source/v1" && source.payloads.length === 1, "segmentation_migration_source_unsupported");
  const bytes = await readRepositoryBytes(root, expected.source.path);
  check(bytesVersion(bytes) === row.sourceSha256, "segmentation_original_changed");
  const basePolicy = await reader.read(source.policyRef, "policies");
  const base = parseSourcePolicy(basePolicy);
  const policies = [], segments = [];
  for (const segment of row.segments) {
    check(record(segment) && Object.keys(segment).sort().join() === "end,quotePolicy,sensitivity,start", "invalid_segment_review_fields");
    // The supplied semantic review may narrow these two axes only. It cannot
    // expand purposes, delivery scopes, scenarios, or existing explicit bans.
    check(segment.sensitivity === base.restrictions?.sensitivity || segment.sensitivity === "sensitive", "segment_sensitivity_expansion");
    check(segment.quotePolicy === base.restrictions?.quotePolicy || segment.quotePolicy === "never_quote" ||
      base.restrictions?.quotePolicy === "internal_summary_preferred" && segment.quotePolicy === "confirm_before_use", "segment_quote_expansion");
    const restrictions = parseSourceRestrictions({ ...base.restrictions, sensitivity: segment.sensitivity, quotePolicy: segment.quotePolicy });
    const { version: _version, ...body } = basePolicy;
    const policy = { ...body, schemaVersion: "stella.source-policy/v3", id: `policy_${bytesVersion(canonicalJson([row.sourceId, segment.start, segment.end])).slice(7)}`,
      restrictions, usageRules: expected.constraintImplementation.usageRules };
    parseSourcePolicy(policy);
    const ref = { id: policy.id, version: objectVersion(policy) };
    policies.push({ ref, object: { ...policy, version: ref.version } });
    segments.push({ start: segment.start, end: segment.end, policyRef: ref });
  }
  const imported = await prepareRepositorySource({ root, sourceId: row.sourceId, collectionId: source.origin.collectionId,
    relativePath: expected.source.path, expectedSha256: row.sourceSha256, capturedAt: source.capturedAt,
    policyRef: source.policyRef, objectRoot: review.objectRoot, reviewedSegments: segments });
  const evidenceRefs = [];
  for (const evidenceEntry of reader.catalog.evidence) if (evidenceEntry.status === "current") {
    const evidence = await reader.read(evidenceEntry, "evidence");
    if (evidence.source?.id === entry.id && evidence.source.version === entry.version) evidenceRefs.push({ id: evidenceEntry.id, version: evidenceEntry.version });
  }
  check(imported.sourceRef.id === entry.id, "segmentation_source_identity_changed");
  proposals.push({ sourceId: row.sourceId, originalSha256: row.sourceSha256, supersedesSourceRef: { id: entry.id, version: entry.version },
    supersedesEvidenceRefs: evidenceRefs, policies, ...imported });
}
await reader.assertCurrent(); current();
writeFileSync(output, canonicalJson({ schemaVersion: "stella.source-segmentation-candidate/v1", sourceRevision: revision, catalogHash: reader.catalogHash,
  planSha256: bytesVersion(planBytes), reviewSha256: bytesVersion(reviewBytes), reviewer: review.reviewer,
  readyToActivate: false, sourceFilesModified: false, proposals }), { mode: 0o600, flag: "wx" });
process.stdout.write(JSON.stringify({ sources: proposals.length, segments: proposals.reduce((total, value) => total + value.evidenceRefs.length, 0), readyToActivate: false }) + "\n");
