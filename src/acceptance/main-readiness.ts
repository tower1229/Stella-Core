import { parse as parseYaml } from "yaml";
import { CatalogReader, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion } from "../canghai/content-version.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { loadRuntimeProfileResources } from "../canghai/runtime-profile-resources.js";
import { parseSourcePolicy } from "../canghai/source-policy.js";
import { isRecord } from "../shared/type-guards.js";

/** A diagnostic, never authority to open a runtime gate or enable source access. */
export async function inspectMainReadiness(input: {
  root: string; profilePath: string; agentId: string; modelRef: string;
  fallbackModelRefs: readonly string[]; initialization: unknown;
}) {
  const bytes = await readRepositoryBytes(input.root, input.profilePath);
  const profile = parseRuntimeProfile(parseYaml(bytes.toString("utf8")));
  await loadRuntimeProfileResources(input.root, profile);
  const blockers = new Set<string>();
  if (profile.agent_id !== input.agentId) blockers.add("profile_agent_mismatch");
  if (profile.contract_profile !== "full_memory") blockers.add("full_memory_profile_required");
  for (const [role, model] of Object.entries(profile.models)) {
    if (`${model.provider}/${model.model}` !== input.modelRef) blockers.add(`model_route_mismatch:${role}`);
  }
  if (input.fallbackModelRefs.length) blockers.add("personal_view_fallback_route_forbidden");
  const status = input.initialization;
  if (!isRecord(status) || status.scope !== "host_bootstrap" || status.state !== "ready") blockers.add("host_initialization_not_ready");
  if (!isRecord(status) || !isRecord(status.runtime) || !Array.isArray(status.runtime.blockers) ||
    !status.runtime.blockers.every(value => typeof value === "string" && /^[a-z0-9_:-]+$/.test(value))) {
    blockers.add("invalid_host_runtime_status");
  } else {
    for (const value of status.runtime.blockers as string[]) blockers.add(value);
    if (status.runtime.state !== "ready" && !status.runtime.blockers.length) blockers.add("runtime_acceptance_not_evaluated");
  }
  const capabilities = [];
  for (const capability of profile.capabilities) {
    const config = parseYaml((await readRepositoryBytes(input.root, parseCangHaiRef(capability.config_ref).relativePath)).toString("utf8"));
    const receipt = parseYaml((await readRepositoryBytes(input.root, parseCangHaiRef(capability.acceptance_ref).relativePath)).toString("utf8"));
    const placeholder = isRecord(config) && config.implementation_state === "requires_adapter_validation";
    // Even a success string in this declaration is not current Host proof.
    const evaluated = isRecord(receipt) && (receipt.state === "passed" || receipt.status === "passed");
    capabilities.push({ id: capability.id, required: capability.required, placeholder, declaredPassed: evaluated });
    if (capability.required && placeholder) blockers.add(`capability_configuration_missing:${capability.id}`);
    if (capability.required && !evaluated) blockers.add(`capability_acceptance_missing:${capability.id}`);
  }
  const sourceAccess = profile.capabilities.find(capability => capability.id === "source_access_context");
  if (!sourceAccess || sourceAccess.adapter_id !== "stella.personal-context-access" || sourceAccess.adapter_version !== "1") {
    blockers.add("personal_context_access_binding_missing");
  }
  const custody = profile.capabilities.find(capability => capability.id === (profile.contract_profile === "full_memory" ? "memory_lifecycle" : "transcript_archive"));
  const custodyConfig = custody ? parseYaml((await readRepositoryBytes(input.root, parseCangHaiRef(custody.config_ref).relativePath)).toString("utf8")) : null;
  if (!isRecord(custodyConfig) || custodyConfig.schemaVersion !== (profile.contract_profile === "full_memory" ? "stella.memory-runtime-binding/v1" : "stella.alpha-praxis-binding/v2")) {
    blockers.add("owner_input_archive_binding_missing");
  }
  const counts = { sources: 0, policies: 0, policiesWithoutPurposes: 0, understandings: 0, works: 0 };
  if (profile.memory) {
    const reader = await CatalogReader.load(input.root, parseCangHaiRef(profile.memory.catalog_ref).relativePath);
    counts.sources = reader.catalog.sources.filter(entry => entry.status === "current").length;
    counts.policies = reader.catalog.policies.filter(entry => entry.status === "current").length;
    counts.understandings = reader.catalog.understandings.filter(entry => entry.status === "current").length;
    counts.works = reader.catalog.works.filter(entry => entry.status === "current").length;
    for (const ref of reader.catalog.policies.filter(entry => entry.status === "current")) {
      const policy = parseSourcePolicy(await reader.read(ref, "policies"));
      if (!policy.readPurposes.length || !policy.derivePurposes.length || !policy.deliveryScopes.length) counts.policiesWithoutPurposes++;
    }
    if (counts.policiesWithoutPurposes) blockers.add("source_purpose_migration_pending");
    await reader.assertCurrent();
  } else blockers.add("memory_catalog_missing");
  if (bytesVersion(await readRepositoryBytes(input.root, input.profilePath)) !== bytesVersion(bytes)) throw new Error("profile_changed_during_inspection");
  return { schemaVersion: "stella.main-readiness/v1", scope: "real_main_preflight", diagnosticOnly: true,
    behavioralAcceptance: "not_executed", agentId: input.agentId, contractProfile: profile.contract_profile,
    modelRef: input.modelRef, profileSha256: bytesVersion(bytes), capabilities, counts, blockers: [...blockers].sort() };
}
