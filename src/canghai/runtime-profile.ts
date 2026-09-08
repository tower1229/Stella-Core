import { isRecord } from "../shared/type-guards.js";
import { parseCangHaiRef } from "./ref.js";

type Model = { provider: string; model: string; required_capabilities: string[] };
export type RuntimeCapability = { id: string; required: boolean; adapter_id: string; adapter_version: string;
  config_ref: string; acceptance_ref: string; required_secret_refs: string[] };
export type RuntimeProfile = {
  schema_version: "stella.runtime-profile/v1" | "stella.runtime-profile/v2"; contract_profile: "alpha_praxis" | "full_memory";
  host_materialization_ref?: string;
  agent_id: string; language: string; timezone: string;
  models: Record<"main" | "router" | "learning" | "framework_compiler", Model>;
  capabilities: RuntimeCapability[]; source_policies_ref: string;
  memory?: { catalog_ref: string; semantic_provider: string; required_views: string[]; archive_max_rpo_seconds: number };
  autonomy: { research_enabled: boolean; proactive_delivery_enabled: boolean; delivery_policy_ref: string; delegation_registry_ref: string };
};
export class RuntimeProfileError extends Error {
  constructor(readonly category: string) { super(`Runtime profile invalid: ${category}`); }
}
function requireValue(value: unknown, category: string): asserts value {
  if (!value) throw new RuntimeProfileError(category);
}
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
function reference(value: unknown): void {
  requireValue(text(value), "invalid_reference");
  try {
    const ref = parseCangHaiRef(value);
    requireValue(!ref.fragment && !ref.relativePath.split("/").some((part) => part.toLowerCase() === ".git"), "invalid_reference");
  } catch { throw new RuntimeProfileError("invalid_reference"); }
}

/** Structural contract only. Acceptance and current Host availability are separate checks. */
export function parseRuntimeProfile(value: unknown): RuntimeProfile {
  requireValue(isRecord(value) && (value.schema_version === "stella.runtime-profile/v1" || value.schema_version === "stella.runtime-profile/v2"), "profile_migration_required");
  if (value.schema_version === "stella.runtime-profile/v2") {
    requireValue(Object.keys(value).every((key) => ["schema_version", "contract_profile", "host_materialization_ref", "agent_id", "language", "timezone",
      "models", "capabilities", "source_policies_ref", "memory", "autonomy"].includes(key)), "unknown_profile_field");
    reference(value.host_materialization_ref);
  }
  else requireValue(value.host_materialization_ref === undefined, "profile_migration_required");
  requireValue(["alpha_praxis", "full_memory"].includes(String(value.contract_profile)) && text(value.agent_id) &&
    text(value.language) && text(value.timezone), "invalid_profile_identity");
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(); }
  catch { throw new RuntimeProfileError("invalid_timezone"); }
  requireValue(Array.isArray(value.capabilities), "capabilities_required");
  const ids = new Set<string>();
  for (const capability of value.capabilities) {
    requireValue(isRecord(capability) && text(capability.id) && !ids.has(capability.id) && typeof capability.required === "boolean" &&
      text(capability.adapter_id) && text(capability.adapter_version) && strings(capability.required_secret_refs), "invalid_capability");
    reference(capability.config_ref); reference(capability.acceptance_ref); ids.add(capability.id);
  }
  requireValue(isRecord(value.models), "models_required");
  for (const role of ["main", "router", "learning", "framework_compiler"]) {
    const model = value.models[role];
    requireValue(isRecord(model) && text(model.provider) && text(model.model) && strings(model.required_capabilities), "invalid_model");
    for (const id of model.required_capabilities) {
      requireValue(value.capabilities.some((capability) => capability.id === id && capability.required === true), "model_capability_not_required");
    }
  }
  reference(value.source_policies_ref);
  if (value.contract_profile === "full_memory" || value.memory !== undefined) {
    requireValue(isRecord(value.memory) && text(value.memory.semantic_provider) && strings(value.memory.required_views) &&
      Number.isFinite(value.memory.archive_max_rpo_seconds) && Number(value.memory.archive_max_rpo_seconds) >= 0, "invalid_memory_profile");
    reference(value.memory.catalog_ref);
  }
  requireValue(isRecord(value.autonomy) && typeof value.autonomy.research_enabled === "boolean" &&
    typeof value.autonomy.proactive_delivery_enabled === "boolean", "invalid_autonomy");
  reference(value.autonomy.delivery_policy_ref); reference(value.autonomy.delegation_registry_ref);
  return structuredClone(value) as RuntimeProfile;
}
