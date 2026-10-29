import { CatalogError, type CatalogReader, validMemoryRef } from "./catalog-reader.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { validateOngoingWork, validateUnderstanding } from "../praxis/personal-views.js";
import { type EpisodeEvidenceResolver, type OriginalEvidence, validateLearningChange } from "../praxis/episode-evidence.js";
import { assertEvidenceSegment, segmentLocator, sourceSegments, type SegmentLocator } from "./source-segments.js";
import { parseSourcePolicy } from "./source-policy.js";
import { isRecord } from "../shared/type-guards.js";

type TargetGroup = "works" | "understandings";
export type ReadGroup = TargetGroup | "evidence";
export type ExactReadbackTarget = { group: ReadGroup; ref: VersionedRef };
type Current = () => void | Promise<void>;

/** Core-owned, request-bound source permission. Host ownership and references confer no data permission. */
export type AuthorizedExactReadScope = {
  reader: CatalogReader;
  /** Same reader, with the admitted request's complete Evidence/fragment policy context. */
  resolver: EpisodeEvidenceResolver;
  assertCurrent: Current;
  /** Explicit source admission and live capability; the resolver independently checks Evidence/fragment permissions. */
  authorizeSources(input: { target: VersionedRef; sourceRefs: readonly VersionedRef[] }): Promise<{ assertCurrent: Current }>;
};

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const key = (ref: VersionedRef) => canonicalJson([ref.id, ref.version]);
function groupOf(reader: CatalogReader, ref: VersionedRef): TargetGroup {
  const group = (["works", "understandings"] as const).find(group => reader.catalog[group].some(entry => key(entry) === key(ref)));
  check(group, "native_readback_target_unsupported");
  check(reader.eligible(ref), "evidence_not_currently_eligible");
  return group;
}
/** Core-only receipt mapping after publication. These references must still pass source authorization on get. */
export async function learningChangeReadbackTargets(input: {
  reader: CatalogReader; changeRef: VersionedRef;
}): Promise<ExactReadbackTarget[]> {
  const change = await input.reader.read(input.changeRef, "changes");
  const validated = validateLearningChange(change);
  const targets = change.targetRefs as VersionedRef[], rows = change.changes as Record<string, unknown>[];
  check(new Set(targets.map(key)).size === targets.length && rows.length === targets.length &&
    targets.every(target => rows.some(row => isRecord(row) && validMemoryRef(row.after) && key(row.after) === key(target))) &&
    validated.dependencies.every(target => input.reader.entry(input.changeRef, "changes").dependencies.some(ref => key(ref) === key(target))),
  "learning_change_target_mismatch");
  return targets.map(ref => ({ group: groupOf(input.reader, ref), ref: { ...ref } }));
}

/** Read metadata with body/declared-dependency agreement before allowing any provenance payload. */
async function provenance(scope: AuthorizedExactReadScope, target: VersionedRef, assertRead: Current) {
  const reader = scope.reader, records = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, { ref: VersionedRef; policyRef: VersionedRef; segmented: boolean }>(), evidence = new Map<string, VersionedRef>();
  const covered = new Set<string>();
  const declared = (ref: VersionedRef, required: VersionedRef[]) => {
    const entry = reader.entry(ref);
    check(required.every(dependency => entry.dependencies.some(value => key(value) === key(dependency))), "undeclared_object_dependency");
  };
  const visit = async (ref: VersionedRef): Promise<void> => {
    if (records.has(key(ref))) return;
    check(records.size < 512, "native_readback_dependency_budget_exhausted");
    await assertRead(); const record = await reader.read(ref); await assertRead(); records.set(key(ref), record);
    let required: VersionedRef[] = [], origin: string | undefined;
    if (record.schemaVersion === "stella.understanding/v1") {
      reader.entry(ref, "understandings"); validateUnderstanding(record);
      required = [...record.supportRefs as VersionedRef[], ...record.counterRefs as VersionedRef[], ...record.dependencyRefs as VersionedRef[]];
      origin = record.originChangeId as string;
    } else if (record.schemaVersion === "stella.ongoing-work/v1") {
      reader.entry(ref, "works"); required = validateOngoingWork(record);
      if (record.lastAppliedChangeId !== null) origin = record.lastAppliedChangeId as string;
    } else if (record.schemaVersion === "stella.learning-change/v1") {
      reader.entry(ref, "changes"); required = validateLearningChange(record).dependencies;
    } else if (record.schemaVersion === "stella.memory-evidence/v1") {
      reader.entry(ref, "evidence");
      check(validMemoryRef(record.source) && validMemoryRef(record.policyRef) && Array.isArray(record.derivedFrom) && record.derivedFrom.every(validMemoryRef), "invalid_evidence");
      required = [record.source, record.policyRef, ...record.derivedFrom];
      for (const dependency of record.derivedFrom) reader.entry(dependency, "evidence");
      evidence.set(key(ref), ref); covered.add(key(record.source));
    } else if (["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(record.schemaVersion))) {
      reader.entry(ref, "sources"); check(validMemoryRef(record.policyRef) && validMemoryRef(record.coverageRef), "invalid_source");
      const segments = sourceSegments(record);
      required = [record.policyRef, record.coverageRef, ...segments.map(segment => segment.policyRef)];
      sources.set(key(ref), { ref, policyRef: record.policyRef, segmented: segments.length > 0 });
    } else if (["stella.source-policy/v1", "stella.source-policy/v2", "stella.source-policy/v3"].includes(String(record.schemaVersion))) {
      reader.entry(ref, "policies"); parseSourcePolicy(record); required = record.authorityEvidenceRefs as VersionedRef[];
    } else {
      check(record.schemaVersion === "stella.archive-coverage/v1", "native_readback_dependency_unsupported"); reader.entry(ref, "coverage");
    }
    declared(ref, required);
    if (origin) {
      const changeRef = reader.currentRef(origin, "changes"); await visit(changeRef);
      const change = records.get(key(changeRef))!;
      check((change.targetRefs as VersionedRef[]).some(value => key(value) === key(ref)), "learning_change_target_mismatch");
    }
    const entry = reader.entry(ref);
    for (const dependency of [...entry.dependencies, ...(entry.metadataRef ? [entry.metadataRef] : [])]) await visit(dependency);
  };
  await visit(target);
  check(evidence.size > 0, "personal_view_provenance_required");
  check([...sources].every(([id, source]) => !source.segmented || covered.has(id)), "segmented_source_requires_evidence");
  return { record: records.get(key(target))!, sources: [...sources.values()], evidenceRefs: [...evidence.values()], records };
}

/** Structural reachability is not permission to disclose a policy's free text.
 * Follow applicable dependency edges separately, retaining each source/segment
 * context so a shared policy cannot borrow another fragment's authorization. */
async function evidencePolicies(scope: AuthorizedExactReadScope, target: VersionedRef,
  verified: Awaited<ReturnType<typeof provenance>>, assertRead: Current) {
  type Context = { sourceRef: VersionedRef; segment?: SegmentLocator };
  const recordFor = (ref: VersionedRef) => {
    const record = verified.records.get(key(ref)); check(record, "reference_unavailable"); return record;
  };
  const evidenceContext = (record: Record<string, unknown>): Context => {
    const sourceRef = record.source as VersionedRef, segment = assertEvidenceSegment(sourceSegments(recordFor(sourceRef)), record);
    return { sourceRef, ...(segment ? { segment: segmentLocator(segment) } : {}) };
  };
  const contextKey = (ref: VersionedRef, context: Context) => canonicalJson([key(ref), key(context.sourceRef), context.segment ?? null]);
  const authorized = new Set<string>(), visited = new Set<string>();
  const policies = new Map<string, NonNullable<OriginalEvidence["usageConstraints"]>[number]>();
  // These exact Evidence/source policy contexts already passed readEvidence.
  for (const ref of verified.evidenceRefs) {
    const record = recordFor(ref), context = evidenceContext(record);
    for (const policy of [record.policyRef, recordFor(context.sourceRef).policyRef] as VersionedRef[]) authorized.add(contextKey(policy, context));
  }
  const visit = async (ref: VersionedRef, context: Context): Promise<void> => {
    const record = recordFor(ref), source = ["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(record.schemaVersion));
    if (record.schemaVersion === "stella.memory-evidence/v1") context = evidenceContext(record);
    else if (source && key(context.sourceRef) !== key(ref)) context = { sourceRef: ref };
    const identity = contextKey(ref, context); if (visited.has(identity)) return; visited.add(identity);
    if (["stella.source-policy/v1", "stella.source-policy/v2", "stella.source-policy/v3"].includes(String(record.schemaVersion))) {
      if (!authorized.has(identity)) {
        await assertRead(); await scope.resolver.assertSourceMetadataAccess(context.sourceRef, ref, context.segment); await assertRead();
        authorized.add(identity);
      }
      const policy = parseSourcePolicy(record);
      if (policy.usageRules?.interpretation.length || policy.restrictions) policies.set(key(ref), { policyRef: { id: ref.id, version: ref.version },
        rules: policy.usageRules?.interpretation ?? [], ...(policy.restrictions ? { quotePolicy: policy.restrictions.quotePolicy } : {}) });
    }
    const entry = scope.reader.entry(ref);
    // Source declares every segment for structural validation. Only its parent
    // policy applies here; a selected Evidence reaches its own segment policy
    // directly. Explicit metadataRef/derivedFrom edges remain applicable even
    // when the same policy is also listed for a neighboring segment.
    const segmentPolicies = new Set(source ? sourceSegments(record).map(segment => key(segment.policyRef)) : []);
    for (const dependency of entry.dependencies) {
      if (!segmentPolicies.has(key(dependency)) || key(dependency) === key(record.policyRef as VersionedRef)) await visit(dependency, context);
    }
    if (entry.metadataRef) await visit(entry.metadataRef, context);
    const origin = record.schemaVersion === "stella.understanding/v1" ? record.originChangeId :
      record.schemaVersion === "stella.ongoing-work/v1" ? record.lastAppliedChangeId : null;
    if (typeof origin === "string") await visit(scope.reader.currentRef(origin, "changes"), context);
  };
  await visit(target, evidenceContext(recordFor(target)));
  return [...policies.values()];
}

/** Declaration-based admission precheck only; provenance above verifies the object bodies. */
function sourceDependencies(reader: CatalogReader, target: VersionedRef): VersionedRef[] {
  const sources = new Set(reader.catalog.sources.map(key)), found = new Map<string, VersionedRef>(), seen = new Set<string>(), active = new Set<string>();
  const visit = (ref: VersionedRef) => {
    const id = key(ref); check(!active.has(id), "dependency_cycle"); if (seen.has(id)) return;
    check(seen.size < 512, "native_readback_dependency_budget_exhausted"); seen.add(id);
    active.add(id);
    const entry = reader.entry(ref);
    if (sources.has(id)) found.set(id, { id: ref.id, version: ref.version });
    for (const dependency of [...entry.dependencies, ...(entry.metadataRef ? [entry.metadataRef] : [])]) visit(dependency);
    active.delete(id);
  };
  visit(target);
  check(found.size > 0, "native_readback_source_permission_required");
  return [...found.values()];
}

/** Transport-independent exact read. Every caller supplies its own trusted request
 * scope; object identity, Host ownership and native references grant no permission. */
export async function readAuthorizedExact(input: {
  scope: AuthorizedExactReadScope; target: ExactReadbackTarget; assertCurrent: Current;
}): Promise<{ target: ExactReadbackTarget; text: string }> {
  const { scope } = input, { group, ref: target } = structuredClone(input.target);
  const current = input.assertCurrent;
  await current();
  check(["works", "understandings", "evidence"].includes(group) && validMemoryRef(target), "native_readback_reference_invalid");
  check(scope.resolver?.reader === scope.reader, "native_readback_resolver_binding_required");
  const assertScope = async () => { await current(); await scope.assertCurrent(); await current(); await scope.reader.assertCurrent(); await current(); };
  await assertScope();
  if (group === "evidence") scope.reader.entry(target, "evidence");
  else check(groupOf(scope.reader, target) === group, "native_readback_target_unsupported");
  const sourceRefs = sourceDependencies(scope.reader, target);
  check(scope.reader.eligible(target), "evidence_not_currently_eligible");
  const grants: Array<{ assertCurrent: Current }> = [];
  const authorize = async (refs: VersionedRef[]) => {
    const grant = await scope.authorizeSources({ target: { ...target }, sourceRefs: refs });
    check(grant && typeof grant.assertCurrent === "function", "native_readback_source_permission_required"); grants.push(grant);
  };
  await authorize(sourceRefs);
  const assertRead = async () => { await assertScope(); for (const grant of grants) { await grant.assertCurrent(); await current(); } };
  await assertRead();
  const verified = await provenance(scope, target, assertRead);
  const fullSources = verified.sources.map(source => source.ref);
  if (canonicalJson(fullSources.map(key).sort()) !== canonicalJson(sourceRefs.map(key).sort())) await authorize(fullSources);
  // Reuse the ordinary resolver: independent Evidence policies, exact segments,
  // transitive Evidence and payload provenance are never reduced to Source permission.
  for (const source of verified.sources) if (!source.segmented) {
    await assertRead(); await scope.resolver.assertSourceAccess(source.ref, source.policyRef); await assertRead();
  }
  let original: OriginalEvidence | undefined;
  for (const ref of verified.evidenceRefs) {
    await assertRead(); const read = await scope.resolver.readEvidence(ref); await assertRead();
    if (key(ref) === key(target)) original = read;
  }
  await assertRead();
  if (group === "evidence") {
    check(original && key(original.ref) === key(target), "native_readback_evidence_required");
    const policies = await evidencePolicies(scope, target, verified, assertRead); await assertRead();
    // Whitelist the transport document; never return source records, internal
    // locators, full payloads or other dependencies' text. Only applicable,
    // authorized policy constraints accompany the derived target.
    const ref = (value: VersionedRef) => ({ id: value.id, version: value.version });
    const constraints = (values: NonNullable<OriginalEvidence["usageConstraints"]>) => values.map(value => ({
      policyRef: ref(value.policyRef), rules: value.rules.map(rule => ({ id: rule.id, requirement: rule.requirement })),
      ...(value.quotePolicy ? { quotePolicy: value.quotePolicy } : {}),
    }));
    return { target: { group, ref: { ...target } }, text: canonicalJson({
      evidence: { ref: ref(original.ref), text: original.text, role: original.role, kind: original.kind,
        independentOriginId: original.independentOriginId, sourceAdapterId: original.sourceAdapterId,
        occurredAt: original.occurredAt, authoredAt: original.authoredAt, capturedAt: original.capturedAt,
        coverageComplete: original.coverageComplete,
        ...(original.usageConstraints ? { usageConstraints: constraints(original.usageConstraints) } : {}) },
      sourceRef: ref(verified.record.source as VersionedRef), payloadSha256: verified.record.payloadSha256,
      selector: { kind: (verified.record.selector as { kind: string }).kind, value: (verified.record.selector as { value: string }).value },
      speakerId: verified.record.speakerId, derivedFrom: (verified.record.derivedFrom as VersionedRef[]).map(ref),
      fragmentSha256: bytesVersion(original.text),
      dependencyUsageConstraints: { appliesTo: ref(target), policies: constraints(policies) },
    }) };
  }
  return { target: { group, ref: { ...target } }, text: canonicalJson(verified.record) };
}
