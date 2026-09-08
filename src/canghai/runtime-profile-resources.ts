import { parse as parseYaml } from "yaml";
import { CatalogError, readRepositoryBytes } from "./catalog-reader.js";
import { parseSourcePolicy } from "./source-policy.js";
import { bytesVersion } from "./content-version.js";
import { parseCangHaiRef } from "./ref.js";
import { parseRuntimeProfile, RuntimeProfileError, type RuntimeProfile } from "./runtime-profile.js";
import { isRecord } from "../shared/type-guards.js";

function check(value: unknown, category: string): asserts value {
  if (!value) throw new RuntimeProfileError(category);
}
function locator(ref: unknown): string {
  check(typeof ref === "string", "invalid_reference");
  try {
    const parsed = parseCangHaiRef(ref);
    check(!parsed.fragment && !parsed.relativePath.split("/").some((part) => part.toLowerCase() === ".git"), "invalid_reference");
    return parsed.relativePath;
  } catch { throw new RuntimeProfileError("invalid_reference"); }
}

/** Readability and registry identity only; never an adapter/secret/acceptance verdict. */
export async function loadRuntimeProfileResources(root: string, input: RuntimeProfile): Promise<{ authorityPaths: string[] }> {
  const profile = parseRuntimeProfile(input);
  const documents = new Map<string, { value: Record<string, unknown>; hash: string }>();
  const read = async (ref: string): Promise<Record<string, unknown>> => {
    const file = locator(ref);
    const previous = documents.get(file);
    if (previous) return previous.value;
    check(documents.size < 256, "profile_resource_capacity_exhausted");
    let bytes: Buffer;
    try { bytes = await readRepositoryBytes(root, file); }
    catch { throw new RuntimeProfileError("profile_resource_unavailable"); }
    check(bytes.length > 0 && bytes.length <= 256_000, "profile_resource_capacity_exhausted");
    let value: unknown;
    try { value = parseYaml(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new RuntimeProfileError("invalid_profile_resource"); }
    check(isRecord(value), "invalid_profile_resource");
    documents.set(file, { value, hash: bytesVersion(bytes) });
    return value;
  };
  for (const capability of profile.capabilities) {
    await read(capability.config_ref);
    // A not_evaluated receipt remains not_evaluated. Existence is not success.
    await read(capability.acceptance_ref);
  }
  const policies = await read(profile.source_policies_ref);
  check(policies.schema_version === "stella.source-policy-registry/v1" && typeof policies.id === "string" && policies.id.trim() &&
    Array.isArray(policies.policies), "invalid_source_policy_registry");
  const ids = new Set<string>();
  for (const item of policies.policies) {
    check(isRecord(item) && typeof item.id === "string" && item.id.trim() && !ids.has(item.id) && typeof item.ref === "string",
      "invalid_source_policy_registry");
    ids.add(item.id);
    const policy = await read(item.ref);
    check(policy.id === item.id, "source_policy_identity_mismatch");
    try { parseSourcePolicy(policy); }
    catch (error) { throw new RuntimeProfileError(error instanceof CatalogError ? error.category : "invalid_source_policy"); }
  }
  const delivery = await read(profile.autonomy.delivery_policy_ref);
  check(delivery.schema_version === "stella.delivery-policy/v1", "invalid_delivery_policy");
  const delegations = await read(profile.autonomy.delegation_registry_ref);
  check(delegations.schema_version === "stella.delegation-registry/v1" && typeof delegations.id === "string" && delegations.id.trim() &&
    Array.isArray(delegations.delegations), "invalid_delegation_registry");
  // The catalog is mutable business state: its own loader validates contents and
  // generations. Do not freeze it to the configuration's recovery revision.
  if (profile.memory) {
    try { await readRepositoryBytes(root, locator(profile.memory.catalog_ref)); }
    catch { throw new RuntimeProfileError("profile_catalog_unavailable"); }
  }
  for (const [file, document] of documents) {
    let bytes: Buffer;
    try { bytes = await readRepositoryBytes(root, file); }
    catch { throw new RuntimeProfileError("profile_resource_changed"); }
    check(bytesVersion(bytes) === document.hash, "profile_resource_changed");
  }
  return { authorityPaths: [...documents.keys()] };
}
