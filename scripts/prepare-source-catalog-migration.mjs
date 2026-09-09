import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { CatalogReader, parseMemoryCatalog, readRepositoryBytes } from '../dist/src/canghai/catalog-reader.js';
import { bytesVersion, canonicalJson, objectVersion } from '../dist/src/canghai/content-version.js';
import { prepareRepositorySource } from '../dist/src/canghai/repository-source.js';
import { parseSourcePolicy } from '../dist/src/canghai/source-policy.js';

// Offline bootstrap migration only: preserve existing grants and original files.
// The output is a local publication plan, never a runtime acceptance receipt.
const [root, revision, planFile, segmentFile, descriptorFile, output] = process.argv.slice(2);
const check = (value, category) => { if (!value) throw new Error(category); };
check(process.argv.length === 8 && /^[a-f0-9]{40}$/.test(revision ?? ''), 'invalid_catalog_migration_arguments');
const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args]);
const current = () => check(git('rev-parse', 'HEAD').toString().trim() === revision && git('status', '--porcelain').length === 0, 'source_revision_or_cleanliness_changed');
current();
const planBytes = readFileSync(planFile), segmentBytes = readFileSync(segmentFile), descriptorBytes = readFileSync(descriptorFile);
const plan = JSON.parse(planBytes), segmented = JSON.parse(segmentBytes), descriptions = JSON.parse(descriptorBytes);
check(plan.schemaVersion === 'stella.source-policy-migration-plan/v1' && plan.sourceRevision === revision && plan.semanticReview?.sourceBindingsVerified === true, 'invalid_policy_plan');
check(segmented.schemaVersion === 'stella.source-segmentation-candidate/v1' && segmented.sourceRevision === revision && segmented.planSha256 === bytesVersion(planBytes), 'invalid_segment_plan');
check(descriptions.schemaVersion === 'stella.source-descriptor-migration-candidate/v1' && descriptions.readyToActivate === false && descriptions.semanticReview?.sha256 === plan.semanticReview.sha256, 'invalid_descriptor_plan');
const catalogPath = '50_PersonalAgent/stella/initialization/memory/catalog.json';
const objectRoot = '50_PersonalAgent/stella/initialization/memory/objects';
const reader = await CatalogReader.load(root, catalogPath);
check(reader.catalogHash === segmented.catalogHash && reader.catalogHash === descriptions.catalogHash, 'stale_catalog_plan');
check(['understandings', 'works', 'changes', 'bundles', 'views'].every(group => reader.catalog[group].length === 0), 'derived_state_requires_dependency_migration');
const catalog = structuredClone(reader.catalog), objects = [], descriptors = [], seen = new Set(), usedSegments = new Set();
const key = ref => canonicalJson({ id: ref.id, version: ref.version });
const add = object => {
  const group = catalog[object.group];
  const old = group.find(entry => key(entry) === key(object.ref));
  if (old) { check(canonicalJson({ ...old, locator: { ...old.locator, path: object.entry.locator.path } }) === canonicalJson(object.entry), 'existing_object_conflict'); return; }
  for (const entry of group) if (entry.id === object.ref.id && entry.status === 'current') entry.status = 'superseded';
  group.push(object.entry); objects.push(object);
};
const policyObject = raw => {
  const { version: _version, ...body } = raw;
  parseSourcePolicy(body);
  const ref = { id: body.id, version: objectVersion(body) }, object = { ...body, version: ref.version }, bytes = canonicalJson(object);
  const result = { group: 'policies', ref, object, bytes, entry: { ...ref, status: 'current', dependencies: body.authorityEvidenceRefs,
    locator: { path: `${objectRoot}/${encodeURIComponent(ref.id)}/${ref.version.slice(7)}.json`, sha256: bytesVersion(bytes) } } };
  add(result); return ref;
};
for (const entry of reader.catalog.sources.filter(entry => entry.status === 'current')) {
  const source = await reader.read(entry, 'sources');
  check(source.schemaVersion === 'stella.memory-source/v1' && source.payloads.length === 1, 'unsupported_bootstrap_source');
  const rows = plan.plans.filter(row => row.sourceId === source.origin.upstreamId);
  check(rows.length === 1 && !seen.has(rows[0].sourceId), 'ambiguous_source_plan');
  const row = rows[0]; seen.add(row.sourceId);
  check(source.payloads[0].path === row.source.path && source.payloads[0].sha256 === row.source.sha256 &&
    bytesVersion(await readRepositoryBytes(root, row.source.path)) === row.source.sha256, 'source_plan_digest_mismatch');
  const originalPolicy = await reader.read(source.policyRef, 'policies');
  check(canonicalJson(originalPolicy.restrictions) === canonicalJson(row.restrictions), 'source_restrictions_changed');
  const policyRef = policyObject({ ...originalPolicy, schemaVersion: 'stella.source-policy/v3', usageRules: row.constraintImplementation.usageRules });
  const parts = segmented.proposals.filter(part => part.sourceId === row.sourceId);
  check(parts.length <= 1, 'duplicate_segment_source');
  let reviewedSegments;
  if (parts.length) {
    const part = parts[0]; usedSegments.add(row.sourceId);
    check(key(part.supersedesSourceRef) === key(entry) && part.originalSha256 === row.source.sha256, 'segment_source_changed');
    const segmentedSource = part.objects.find(object => object.group === 'sources').object;
    reviewedSegments = segmentedSource.accessSegments.map(segment => {
      const policies = part.policies.filter(policy => key(policy.ref) === key(segment.policyRef));
      check(policies.length === 1 && objectVersion(policies[0].object) === segment.policyRef.version, 'segment_policy_mismatch');
      const raw = policies[0].object;
      check(raw.restrictions.sensitivity === originalPolicy.restrictions.sensitivity || raw.restrictions.sensitivity === 'sensitive', 'segment_sensitivity_expansion');
      check(raw.restrictions.quotePolicy === originalPolicy.restrictions.quotePolicy || raw.restrictions.quotePolicy === 'never_quote' ||
        originalPolicy.restrictions.quotePolicy === 'internal_summary_preferred' && raw.restrictions.quotePolicy === 'confirm_before_use', 'segment_quote_expansion');
      for (const field of ['allowedScenarios', 'forbiddenScenarios'])
        check(canonicalJson(raw.restrictions[field]) === canonicalJson(originalPolicy.restrictions[field]), 'segment_scenarios_changed');
      check(canonicalJson(raw.usageRules) === canonicalJson(row.constraintImplementation.usageRules), 'segment_rules_changed');
      for (const field of ['ownerId', 'readPurposes', 'derivePurposes', 'deliveryScopes', 'retention', 'authorityEvidenceRefs'])
        check(canonicalJson(raw[field]) === canonicalJson(originalPolicy[field]), 'segment_authority_changed');
      return { start: segment.start, end: segment.end, policyRef: policyObject(raw) };
    });
  }
  const imported = await prepareRepositorySource({ root, sourceId: row.sourceId, collectionId: source.origin.collectionId,
    relativePath: row.source.path, expectedSha256: row.source.sha256, capturedAt: source.capturedAt, policyRef, objectRoot, ...(reviewedSegments ? { reviewedSegments } : {}) });
  check(imported.sourceRef.id === entry.id, 'source_identity_changed');
  for (const old of reader.catalog.evidence.filter(entry => entry.status === 'current')) {
    const evidence = await reader.read(old, 'evidence');
    if (key(evidence.source) === key(entry)) catalog.evidence.find(item => key(item) === key(old)).status = 'superseded';
  }
  for (const object of imported.objects) add(object);
  const oldDescriptors = descriptions.descriptors.filter(value => key(value.sourceRef) === key(entry) && key(value.policyRef) === key(source.policyRef));
  check(oldDescriptors.length === 1, 'source_descriptor_missing');
  descriptors.push({ ...oldDescriptors[0], sourceRef: imported.sourceRef, policyRef });
}
check(seen.size === plan.plans.length && usedSegments.size === segmented.proposals.length && descriptors.length === descriptions.descriptors.length, 'migration_scope_mismatch');
catalog.parentGenerationId = catalog.generationId;
catalog.generationId = `source-migration-${bytesVersion(canonicalJson({ catalog, plan: bytesVersion(planBytes), segments: bytesVersion(segmentBytes) })).slice(7)}`;
parseMemoryCatalog(catalog);
const entries = new Map(['sources', 'evidence', 'policies', 'coverage'].flatMap(group => catalog[group]).map(entry => [key(entry), entry]));
const eligible = (entry, trail = new Set()) => {
  check(entry?.status === 'current' && !trail.has(key(entry)), 'migration_dependency_not_current');
  const next = new Set([...trail, key(entry)]);
  for (const ref of [...entry.dependencies, ...(entry.metadataRef ? [entry.metadataRef] : [])]) eligible(entries.get(key(ref)), next);
};
for (const entry of entries.values()) if (entry.status === 'current') eligible(entry);
await reader.assertCurrent(); current();
writeFileSync(output, canonicalJson({ schemaVersion: 'stella.source-catalog-migration/v1', sourceRevision: revision,
  catalogPath, beforeCatalogHash: reader.catalogHash, catalog, objects, descriptors,
  readyToActivate: false, processingAuthorityChanged: false,
  remaining: ['segment_specific_descriptors_required', 'processing_authority_binding_required', 'full_memory_acceptance_required'],
  inputs: { plan: bytesVersion(planBytes), segments: bytesVersion(segmentBytes), descriptors: bytesVersion(descriptorBytes) } }), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ sources: descriptors.length, evidence: catalog.evidence.filter(entry => entry.status === 'current').length, objects: objects.length, readyToActivate: false }));
