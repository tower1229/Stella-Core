import { CatalogError, readRepositoryBytes, validMemoryRef, type CatalogReader } from "./catalog-reader.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { createSourceAccessProvider, type SourceAccessDescriptor, type SourceAccessProvider } from "./source-access.js";
import { assertSourcePolicyAccess, parseSourcePolicy, type PolicyPurpose, type SourceAccessContext } from "./source-policy.js";
import { sourceSegments } from "./source-segments.js";
import { isRecord } from "../shared/type-guards.js";
import type { BoundTurnRequest } from "../openclaw/turn-request.js";

export const PERSONAL_CONTEXT_ADAPTER = "stella.personal-context-access";
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
export type PersonalContextAccess = {
  schemaVersion: "stella.personal-context-access/v1";
  ownerId: string;
  requesterIds: string[];
  modelRefs: string[];
  purpose: PolicyPurpose;
  descriptors: SourceAccessDescriptor[];
  viewProcessingModelRefs?: string[];
  operatorRecovery?: true;
};

/** An explicitly configured processing grant for reviewed metadata, separate
 * from the source policies. Never created by a model during a question. */
export function parsePersonalContextAccess(value: unknown): PersonalContextAccess {
  if (!isRecord(value) || value.schemaVersion !== "stella.personal-context-access/v1" ||
      Object.keys(value).some(k => !["schemaVersion", "ownerId", "requesterIds", "modelRefs", "purpose", "descriptors", "viewProcessingModelRefs", "operatorRecovery"].includes(k)) ||
      !text(value.ownerId) || !texts(value.requesterIds) || !value.requesterIds.length ||
      !texts(value.modelRefs) || !value.modelRefs.length || !isRecord(value.purpose) ||
      Object.keys(value.purpose).sort().join() !== "deliveryScope,derivePurpose,readPurpose" ||
      !Object.values(value.purpose).every(text) || !Array.isArray(value.descriptors) || value.descriptors.length > 512) {
    throw new CatalogError("invalid_personal_context_access");
  }
  if (Object.hasOwn(value, "operatorRecovery")) check(value.operatorRecovery === true, "invalid_operator_recovery_grant");
  if (Object.hasOwn(value, "viewProcessingModelRefs")) {
    check(texts(value.viewProcessingModelRefs) && value.viewProcessingModelRefs.length > 0 &&
      value.viewProcessingModelRefs.every(ref => (value.modelRefs as string[]).includes(ref)), "invalid_view_processing_grant");
  }
  const seen = new Set<string>();
  for (const descriptor of value.descriptors) {
    if (!isRecord(descriptor) || Object.keys(descriptor).sort().join() !== "description,policyRef,sourceRef" ||
        !validMemoryRef(descriptor.sourceRef) || !validMemoryRef(descriptor.policyRef) ||
        !text(descriptor.description) || descriptor.description.length > 8_000) {
      throw new CatalogError("invalid_personal_context_descriptor");
    }
    const key = canonicalJson([descriptor.sourceRef, descriptor.policyRef]);
    check(!seen.has(key), "duplicate_personal_context_descriptor"); seen.add(key);
  }
  return structuredClone(value) as PersonalContextAccess;
}

export async function loadPersonalContextAccess(root: string, configPath: string) {
  const bytes = await readRepositoryBytes(root, configPath);
  check(bytes.length <= 256_000, "personal_context_access_budget_exhausted");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CatalogError("invalid_personal_context_access"); }
  const config = parsePersonalContextAccess(value), hash = bytesVersion(bytes);
  return { config, async assertCurrent() {
    check(bytesVersion(await readRepositoryBytes(root, configPath)) === hash, "personal_context_access_changed");
  } };
}

/** The caller obtains request from the active completion permit and pins the
 * exact model passed to complete. A matching string alone is not Host identity. */
export function createPersonalContextAccess(input: {
  request: BoundTurnRequest; modelRef: string;
  binding: Awaited<ReturnType<typeof loadPersonalContextAccess>>;
  assertRequestCurrent: () => void;
  isPersistenceRevalidation?: () => boolean;
  complete: (input: { prompt: string; maxTokens: number; signal?: AbortSignal }) => Promise<{ text: string }>;
  signal?: AbortSignal;
}): SourceAccessProvider {
  const config = parsePersonalContextAccess(input.binding.config);
  const request = structuredClone(input.request), modelRef = input.modelRef;
  const decisions = new Map<string, SourceAccessContext>();
  check(request.senderIsOwner && request.chatType === "direct" && request.senderId &&
    config.requesterIds.includes(request.senderId), "personal_context_requester_forbidden");
  check(config.modelRefs.includes(modelRef), "personal_context_model_forbidden");
  check(request.requestHash === bytesVersion(request.prompt), "personal_context_request_mismatch");
  const current = async (reader: CatalogReader) => {
    input.assertRequestCurrent();
    check(!input.signal?.aborted, "source_access_cancelled");
    await input.binding.assertCurrent();
    await reader.assertCurrent();
    input.assertRequestCurrent();
  };
  const provider = createSourceAccessProvider({ request: request.prompt, trigger: "user_requested", presentation: "summary", quoteGrants: [],
    signal: input.signal,
    describe: async (reader, target) => {
      await current(reader);
      const policyObject = await reader.read(target.policyRef, "policies");
      check(policyObject.ownerId === config.ownerId, "personal_context_owner_mismatch");
      parseSourcePolicy(policyObject);
      const descriptor = config.descriptors.find(d => canonicalJson([d.sourceRef, d.policyRef]) === canonicalJson([target.sourceRef, target.policyRef]));
      check(descriptor, "personal_context_descriptor_required");
      return structuredClone(descriptor);
    },
    complete: async params => {
      input.assertRequestCurrent(); await input.binding.assertCurrent(); input.assertRequestCurrent();
      return input.complete(params);
    },
  });
  return async (reader, target, purpose) => {
    await current(reader);
    check(canonicalJson({ readPurpose: purpose.readPurpose, derivePurpose: purpose.derivePurpose, deliveryScope: purpose.deliveryScope }) ===
      canonicalJson(config.purpose), "personal_context_purpose_mismatch");
    try {
      const key = canonicalJson([target.sourceRef, target.policyRef, config.purpose]);
      if (input.isPersistenceRevalidation?.()) {
        const decision = decisions.get(key);
        check(decision, "source_access_revalidation_receipt_required");
        assertSourcePolicyAccess(await reader.read(target.policyRef, "policies"), purpose, decision);
        return structuredClone(decision);
      }
      const decision = await provider(reader, target, purpose);
      decisions.set(key, structuredClone(decision));
      return decision;
    }
    finally {
      // Revocation must win even when inference returns a negative decision:
      // callers may treat a policy denial as an exclusion, but never stale data.
      await current(reader);
      await reader.read(target.sourceRef, "sources");
      await reader.read(target.policyRef, "policies");
    }
  };
}

/** Validate descriptor coverage before granting a full-memory runtime binding.
 * A whole-source description cannot stand in for a fragment's policy scope. */
export async function validatePersonalContextCatalog(reader: CatalogReader, input: PersonalContextAccess): Promise<void> {
  const config = parsePersonalContextAccess(input);
  const descriptors = new Set(config.descriptors.map(d => canonicalJson([d.sourceRef, d.policyRef])));
  const declared = new Set<string>();
  for (const entry of reader.catalog.sources.filter(value => value.status === "current")) {
    const sourceRef = { id: entry.id, version: entry.version };
    const source = await reader.read(sourceRef, "sources");
    check(validMemoryRef(source.policyRef), "personal_context_source_policy_missing");
    for (const policyRef of [source.policyRef, ...sourceSegments(source).map(segment => segment.policyRef)]) {
      const object = await reader.read(policyRef, "policies");
      check(object.ownerId === config.ownerId, "personal_context_owner_mismatch");
      const policy = parseSourcePolicy(object);
      const key = canonicalJson([sourceRef, { id: policyRef.id, version: policyRef.version }]);
      declared.add(key);
      if (policy.restrictions) check(descriptors.has(key), "personal_context_descriptor_required");
    }
  }
  for (const key of descriptors) check(declared.has(key), "personal_context_descriptor_not_current");
  await reader.assertCurrent();
}
