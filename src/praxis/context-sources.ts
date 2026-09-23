import { CatalogError, readRepositoryBytes, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { sourceSegments } from "../canghai/source-segments.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { isRecord } from "../shared/type-guards.js";
import { assertProcessingStage, type ProcessingAuthority } from "../openclaw/processing-authority.js";
import type { EpisodeEvidenceResolver, OriginalEvidence } from "./episode-evidence.js";
import type { VersionedRef } from "./episode-v2.js";

export type ContextSources = {
  dependencies: Array<{ ref: VersionedRef; digest: string }>; originals: OriginalEvidence[];
  configurationInputs: Array<{ path: string; sha256: string }>;
  payloads: Array<{ source: VersionedRef; sha256: string }>;
};
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const key = (ref: VersionedRef) => canonicalJson({ id: ref.id, version: ref.version });

/** Collect source closures for Core's fixed context compilers. The returned
 * snapshot is data; only a compiler receipt can admit it to a Host authority. */
export function collectContextSources(resolver: EpisodeEvidenceResolver, authority: ProcessingAuthority,
  assertScopeCurrent: () => Promise<void>, seed?: ContextSources) {
  authority = structuredClone(authority);
  seed = seed ? structuredClone({ dependencies: seed.dependencies, originals: seed.originals,
    configurationInputs: seed.configurationInputs, payloads: seed.payloads }) : undefined;
  const reader = resolver.reader;
  const dependencies = new Map((seed?.dependencies ?? []).map(entry => [key(entry.ref), entry]));
  const configurationInputs = new Map((seed?.configurationInputs ?? []).map(entry => [entry.path, entry]));
  const payloads = new Map((seed?.payloads ?? []).map(entry => [canonicalJson([entry.source, entry.sha256]), entry]));
  const originals = new Map((seed?.originals ?? []).map(entry => [key(entry.ref), entry]));
  const readInput = async (path: string) => {
    try { return await readRepositoryBytes(reader.root, path); }
    catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("routing_input_unavailable");
    }
  };
  const pinFile = async (path: string, expected?: string) => {
    check(configurationInputs.has(path) || configurationInputs.size < 512, "routing_context_budget_exhausted");
    const bytes = await readInput(path);
    check(expected === undefined || bytes.toString("utf8") === expected, "routing_input_changed");
    const sha256 = bytesVersion(bytes), previous = configurationInputs.get(path);
    check(!previous || previous.sha256 === sha256, "routing_input_changed");
    configurationInputs.set(path, { path, sha256 });
    return bytes;
  };
  const directSources = new Set<string>();
  const visit = async (ref: VersionedRef, evidenceCarrier = false): Promise<void> => {
    const object = await reader.read(ref);
    if (!evidenceCarrier && ["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(object.schemaVersion)) && !directSources.has(key(ref))) {
      check(validMemoryRef(object.policyRef) && Array.isArray(object.payloads) && object.payloads.length > 0, "invalid_source");
      // A direct Source dependency claims the whole input. Segment-scoped
      // derivations must name Evidence instead; carrier edges below keep that scope.
      await resolver.assertSourceAccess(ref, object.policyRef);
      for (const payload of object.payloads) {
        check(isRecord(payload) && typeof payload.sha256 === "string", "invalid_payload");
        const identity = canonicalJson([ref, payload.sha256]);
        check(payloads.has(identity) || payloads.size < 1024, "routing_context_budget_exhausted");
        await reader.readPayload(ref, payload.sha256);
        payloads.set(identity, { source: { id: ref.id, version: ref.version }, sha256: payload.sha256 });
      }
      directSources.add(key(ref));
    }
    if (dependencies.has(key(ref))) return;
    check(dependencies.size < 1024, "routing_context_budget_exhausted");
    dependencies.set(key(ref), { ref: { id: ref.id, version: ref.version }, digest: bytesVersion(canonicalJson(object)) });
    if (String(object.schemaVersion).startsWith("stella.source-policy/")) {
      check(object.ownerId === authority.ownerId, "routing_context_owner_mismatch");
      assertProcessingStage(authority, object, "derive");
    }
    if (object.schemaVersion === "stella.memory-evidence/v1") originals.set(key(ref), await resolver.readEvidence(ref));
    const entry = reader.entry(ref);
    if (["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(object.schemaVersion))) {
      check(validMemoryRef(object.policyRef) && validMemoryRef(object.coverageRef), "invalid_source");
      const required = [object.policyRef, object.coverageRef, ...sourceSegments(object).map(segment => segment.policyRef)];
      check(required.every(parent => entry.dependencies.some(dependency => key(parent) === key(dependency))), "undeclared_object_dependency");
    }
    for (const dependency of entry.dependencies) await visit(dependency,
      object.schemaVersion === "stella.memory-evidence/v1" && validMemoryRef(object.source) && key(dependency) === key(object.source));
    if (entry.metadataRef) await visit(entry.metadataRef);
  };
  const assertCurrent = async () => {
    await assertScopeCurrent();
    await reader.assertCurrent();
    for (const { path, sha256 } of configurationInputs.values()) check(bytesVersion(await readInput(path)) === sha256, "routing_input_changed");
    for (const { ref, digest } of dependencies.values()) check(bytesVersion(canonicalJson(await reader.read(ref))) === digest, "routing_dependency_changed");
    for (const payload of payloads.values()) {
      const source = await reader.read(payload.source, "sources");
      check(validMemoryRef(source.policyRef), "cognitive_source_policy_required");
      await resolver.assertSourceAccess(payload.source, source.policyRef);
      await reader.readPayload(payload.source, payload.sha256);
    }
    for (const original of originals.values()) check(canonicalJson(await resolver.readEvidence(original.ref)) === canonicalJson(original), "stale_evidence");
    await assertScopeCurrent();
    for (const { path, sha256 } of configurationInputs.values()) check(bytesVersion(await readInput(path)) === sha256, "routing_input_changed");
    await reader.assertCurrent();
  };
  const document = async (ref: string, content: string, sourceRef: VersionedRef) => {
    await visit(sourceRef);
    const source = await reader.read(sourceRef, "sources");
    check(validMemoryRef(source.policyRef), "cognitive_source_policy_required");
    await resolver.assertSourceAccess(sourceRef, source.policyRef);
    const bytes = await pinFile(parseCangHaiRef(ref).relativePath, content);
    await reader.readPayload(sourceRef, bytesVersion(bytes));
  };
  const snapshot = (): ContextSources => structuredClone({ dependencies: [...dependencies.values()], originals: [...originals.values()],
    configurationInputs: [...configurationInputs.values()], payloads: [...payloads.values()] });
  return { pinFile, visit, document, assertCurrent, snapshot };
}
