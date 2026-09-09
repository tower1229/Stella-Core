import { CatalogError, validMemoryRef } from "./catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import { objectVersion } from "./content-version.js";

const sensitivities = ["local-private", "semi-private", "private", "sensitive", "work-private"] as const;
const quotePolicies = ["cite_with_time_and_source", "summarize_only", "confirm_before_use", "internal_summary_preferred", "never_quote"] as const;
export type SourceRestrictions = {
  sensitivity: typeof sensitivities[number];
  quotePolicy: typeof quotePolicies[number];
  allowedScenarios: string[];
  forbiddenScenarios: string[];
};
type Ref = { id: string; version: string };
export type SourceUsageRule = { id: string; requirement: string };
export type SourceUsageRules = { access: SourceUsageRule[]; interpretation: SourceUsageRule[] };
export function parseSourceUsageRules(value: unknown): SourceUsageRules {
  check(isRecord(value) && Object.keys(value).sort().join() === "access,interpretation");
  for (const rules of [value.access, value.interpretation]) {
    check(Array.isArray(rules) && rules.length <= 32);
    const ids = new Set<string>();
    for (const rule of rules) {
      check(isRecord(rule) && Object.keys(rule).sort().join() === "id,requirement" &&
        typeof rule.id === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(rule.id) && !ids.has(rule.id) &&
        typeof rule.requirement === "string" && rule.requirement.trim() && rule.requirement.length <= 2000);
      ids.add(rule.id);
    }
  }
  check(JSON.stringify(value).length <= 24_000);
  return structuredClone(value) as SourceUsageRules;
}
export type SourceAccessContext = {
  /** Structured semantic judgment supplied by the caller, never keyword matching. */
  judgment: { scenarios: string[]; trigger: "user_requested" | "proactive"; topicRequested: boolean; topicExplicitlyNamed: boolean; presentation: "summary" | "quote" };
  /** Host-owned grants bound to the exact policy version; never supplied by a model verdict. */
  quoteGrants: Ref[];
  ruleChecks?: { policyRef: Ref; checks: Array<{ id: string; satisfied: boolean }> };
};
export type PolicyPurpose = { readPurpose: string; derivePurpose: string; deliveryScope: string };
function check(value: unknown, category = "invalid_source_policy"): asserts value {
  if (!value) throw new CatalogError(category);
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0) && new Set(value).size === value.length;
}
export function parseSourceRestrictions(value: unknown): SourceRestrictions {
  check(isRecord(value) && Object.keys(value).every((key) => ["sensitivity", "quotePolicy", "allowedScenarios", "forbiddenScenarios"].includes(key)));
  check(sensitivities.includes(value.sensitivity as SourceRestrictions["sensitivity"]) &&
    quotePolicies.includes(value.quotePolicy as SourceRestrictions["quotePolicy"]) && texts(value.allowedScenarios) && texts(value.forbiddenScenarios));
  // Empty allowlists deny all uses. Contradictory entries remain denied, never silently removed.
  return structuredClone(value) as SourceRestrictions;
}
export function parseSourcePolicy(value: unknown) {
  check(isRecord(value) && ["stella.source-policy/v1", "stella.source-policy/v2", "stella.source-policy/v3"].includes(String(value.schemaVersion)));
  check(typeof value.id === "string" && value.id.trim() && typeof value.ownerId === "string" && value.ownerId.trim() &&
    texts(value.readPurposes) && texts(value.derivePurposes) && texts(value.deliveryScopes) &&
    ["retain", "do_not_retain"].includes(String(value.retention)) && Array.isArray(value.authorityEvidenceRefs) && value.authorityEvidenceRefs.every(validMemoryRef));
  check(Object.keys(value).every((key) => ["schemaVersion", "id", "version", "ownerId", "readPurposes", "derivePurposes", "deliveryScopes", "retention", "authorityEvidenceRefs", "restrictions", "usageRules"].includes(key)));
  const restrictions = value.schemaVersion !== "stella.source-policy/v1" ? parseSourceRestrictions(value.restrictions) : undefined;
  const usageRules = value.schemaVersion === "stella.source-policy/v3" ? parseSourceUsageRules(value.usageRules) : undefined;
  check(value.schemaVersion === "stella.source-policy/v3" || value.usageRules === undefined, "source_policy_migration_required");
  check(value.schemaVersion !== "stella.source-policy/v1" || value.restrictions === undefined, "source_policy_migration_required");
  const version = objectVersion(value);
  check(value.version === undefined || value.version === version, "object_version_mismatch");
  return { id: value.id, version, readPurposes: value.readPurposes, derivePurposes: value.derivePurposes,
    deliveryScopes: value.deliveryScopes, retention: value.retention, restrictions, ...(usageRules ? { usageRules } : {}) };
}

/** Fail before loading payload bytes. Source and evidence policies must both pass. */
export function assertSourcePolicyAccess(value: unknown, purpose: PolicyPurpose, context?: SourceAccessContext): void {
  const policy = parseSourcePolicy(value);
  check(policy.readPurposes.includes(purpose.readPurpose) && policy.derivePurposes.includes(purpose.derivePurpose) &&
    policy.deliveryScopes.includes(purpose.deliveryScope), "permission_denied");
  if (!policy.restrictions) return;
  check(context && isRecord(context.judgment) && texts(context.judgment.scenarios) && context.judgment.scenarios.length > 0 &&
    ["user_requested", "proactive"].includes(context.judgment.trigger) && typeof context.judgment.topicRequested === "boolean" && typeof context.judgment.topicExplicitlyNamed === "boolean" &&
    ["summary", "quote"].includes(context.judgment.presentation) && Array.isArray(context.quoteGrants) && context.quoteGrants.every(validMemoryRef), "source_access_context_required");
  const { restrictions } = policy, { judgment } = context;
  if (policy.usageRules?.access.length) {
    const result = context.ruleChecks;
    check(result && isRecord(result) && Object.keys(result).sort().join() === "checks,policyRef" && validMemoryRef(result.policyRef) && result.policyRef.id === policy.id && result.policyRef.version === policy.version &&
      Array.isArray(result.checks) && result.checks.length === policy.usageRules.access.length &&
      result.checks.every(rule =>
        isRecord(rule) && Object.keys(rule).sort().join() === "id,satisfied" && typeof rule.satisfied === "boolean" &&
        policy.usageRules!.access.some(expected => expected.id === rule.id)) &&
      new Set(result.checks.map(rule => rule.id)).size === result.checks.length, "source_rule_context_required");
    check(result.checks.every(rule => rule.satisfied), "source_rule_forbidden");
  }
  check(judgment.scenarios.every((scenario) => restrictions.allowedScenarios.includes(scenario) &&
    !restrictions.forbiddenScenarios.includes(scenario)), "source_scenario_forbidden");
  check(!["private", "sensitive"].includes(restrictions.sensitivity) || judgment.trigger === "user_requested", "source_trigger_forbidden");
  check(!["private", "sensitive"].includes(restrictions.sensitivity) || judgment.topicRequested, "source_topic_required");
  check(restrictions.sensitivity !== "sensitive" || judgment.topicExplicitlyNamed, "source_topic_required");
  if (restrictions.sensitivity === "work-private") {
    check(judgment.scenarios.every((scenario) => ["technical_writing", "technical_collaboration", "work_decision"].includes(scenario)), "source_scenario_forbidden");
  }
  if (judgment.presentation === "quote") {
    check(restrictions.quotePolicy !== "never_quote", "source_quote_forbidden");
    check(restrictions.sensitivity !== "semi-private" || judgment.trigger === "user_requested", "source_trigger_forbidden");
    check(restrictions.quotePolicy !== "internal_summary_preferred" || judgment.trigger === "user_requested", "source_trigger_forbidden");
    if (["summarize_only", "confirm_before_use"].includes(restrictions.quotePolicy)) {
      check(context.quoteGrants.some((grant) => grant.id === policy.id && grant.version === policy.version), "source_quote_authorization_required");
    }
  }
}
