import { CatalogError, CatalogReader, validMemoryRef } from "./catalog-reader.js";
import { canonicalJson } from "./content-version.js";
import { assertProcessingStage, type ProcessingAuthority } from "../openclaw/processing-authority.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

const key = (ref: VersionedRef) => canonicalJson({ id: ref.id, version: ref.version });
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Source metadata admission shared by views and exact correction reads.
 * This is not a grant to read payloads: Evidence still selects and authorizes
 * its exact parent/fragment policy intersection through readEvidence. */
export async function assertPersonalSourceMetadata(input: {
  reader: CatalogReader; sourceRef: VersionedRef; ownerId: string; processingAuthority: ProcessingAuthority;
  read?: (ref: VersionedRef) => Promise<Record<string, unknown>>;
}) {
  const read = input.read ?? (ref => input.reader.read(ref));
  const source = await read(input.sourceRef);
  check(["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(source.schemaVersion)) &&
    validMemoryRef(source.policyRef) && validMemoryRef(source.coverageRef), "invalid_source");
  const available = new Set(input.reader.entry(input.sourceRef, "sources").dependencies.map(key));
  check([source.policyRef, source.coverageRef].every(ref => available.has(key(ref))), "undeclared_object_dependency");
  const policy = await read(source.policyRef);
  check(policy.ownerId === input.ownerId, "personal_context_owner_mismatch");
  assertProcessingStage(input.processingAuthority, policy, "derive");
  return { policyRef: source.policyRef };
}
