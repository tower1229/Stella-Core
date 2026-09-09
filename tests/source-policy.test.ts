import assert from "node:assert/strict";
import test from "node:test";
import { assertSourcePolicyAccess, parseSourcePolicy, type SourceAccessContext } from "../src/canghai/source-policy.js";
import { objectVersion } from "../src/canghai/content-version.js";

const purpose = { readPurpose: "retrieve", derivePurpose: "understand", deliveryScope: "owner-direct" };
const policy = {
  schemaVersion: "stella.source-policy/v2", id: "policy-synthetic", ownerId: "synthetic-owner",
  readPurposes: ["retrieve"], derivePurposes: ["understand"], deliveryScopes: ["owner-direct"], retention: "retain", authorityEvidenceRefs: [],
  restrictions: { sensitivity: "sensitive", quotePolicy: "summarize_only", allowedScenarios: ["self_reflection", "relationship_context"],
    forbiddenScenarios: ["relationship_judgment", "current_state_inference"] },
};
const context: SourceAccessContext = { judgment: { scenarios: ["self_reflection"], trigger: "user_requested", topicRequested: true, topicExplicitlyNamed: true, presentation: "summary" }, quoteGrants: [] };

test("v3 usage rules are versioned, bounded and never silently accepted by an older policy", () => {
  const usageRules = { access: [{ id: "specific_topic", requirement: "Only the exact requested subject." }],
    interpretation: [{ id: "dated", requirement: "Keep the observation in historical scope." }] };
  const v3 = { ...policy, schemaVersion: "stella.source-policy/v3", usageRules };
  assert.deepEqual(parseSourcePolicy(v3).usageRules, usageRules);
  assert.throws(() => parseSourcePolicy({ ...policy, usageRules }), /source_policy_migration_required/);
  assert.throws(() => parseSourcePolicy({ ...v3, usageRules: { ...usageRules, grant: true } }), /invalid_source_policy/);
  assert.throws(() => parseSourcePolicy({ ...v3, usageRules: { ...usageRules, access: [...usageRules.access, ...usageRules.access] } }), /invalid_source_policy/);
  assert.throws(() => assertSourcePolicyAccess(v3, purpose, context), /source_rule_context_required/);
  const checked = { ...context, ruleChecks: { policyRef: { id: policy.id, version: objectVersion(v3) }, checks: [{ id: "specific_topic", satisfied: true }] } };
  assert.doesNotThrow(() => assertSourcePolicyAccess(v3, purpose, checked));
  assert.throws(() => assertSourcePolicyAccess({ ...v3, usageRules: { ...usageRules, interpretation: [] } }, purpose, checked), /source_rule_context_required/);
});

test("restricted sources remain usable for allowed purposes while every forbidden purpose is denied", () => {
  assert.doesNotThrow(() => assertSourcePolicyAccess(policy, purpose, context));
  for (const scenario of ["relationship_judgment", "current_state_inference", "unknown-purpose"]) {
    assert.throws(() => assertSourcePolicyAccess(policy, purpose, { ...context, judgment: { ...context.judgment, scenarios: ["self_reflection", scenario] } }), /source_scenario_forbidden/);
  }
  assert.throws(() => assertSourcePolicyAccess({ ...policy, restrictions: { ...policy.restrictions, forbiddenScenarios: ["self_reflection"] } }, purpose, context), /source_scenario_forbidden/);
});
test("sensitivity gates and Host delivery scopes intersect with semantic purposes", () => {
  assert.throws(() => assertSourcePolicyAccess(policy, purpose), /source_access_context_required/);
  assert.throws(() => assertSourcePolicyAccess(policy, purpose, { ...context, judgment: { ...context.judgment, trigger: "proactive" } }), /source_trigger_forbidden/);
  assert.throws(() => assertSourcePolicyAccess(policy, purpose, { ...context, judgment: { ...context.judgment, topicExplicitlyNamed: false } }), /source_topic_required/);
  assert.throws(() => assertSourcePolicyAccess({ ...policy, restrictions: { ...policy.restrictions, sensitivity: "private" } }, purpose,
    { ...context, judgment: { ...context.judgment, topicRequested: false } }), /source_topic_required/);
  assert.throws(() => assertSourcePolicyAccess(policy, { ...purpose, deliveryScope: "public" }, context), /permission_denied/);
  assert.throws(() => assertSourcePolicyAccess({ ...policy, restrictions: { ...policy.restrictions, sensitivity: "work-private" } }, purpose, context), /source_scenario_forbidden/);
});
test("quote authority is separate from model judgment and bound to the current policy version", () => {
  const quoting: SourceAccessContext = { ...context, judgment: { ...context.judgment, presentation: "quote" } };
  assert.throws(() => assertSourcePolicyAccess(policy, purpose, quoting), /source_quote_authorization_required/);
  assert.throws(() => assertSourcePolicyAccess(policy, purpose, { ...quoting, quoteGrants: [{ id: policy.id, version: `sha256:${"b".repeat(64)}` }] }), /source_quote_authorization_required/);
  assert.doesNotThrow(() => assertSourcePolicyAccess(policy, purpose, { ...quoting, quoteGrants: [{ id: policy.id, version: objectVersion(policy) }] }));
  assert.throws(() => parseSourcePolicy({ ...policy, version: `sha256:${"a".repeat(64)}` }), /object_version_mismatch/);
  assert.equal(parseSourcePolicy({ ...policy, version: objectVersion(policy) }).version, objectVersion(policy));
});
test("v1 cannot silently carry v2 restrictions; changing restrictions changes policy identity", () => {
  assert.throws(() => parseSourcePolicy({ ...policy, schemaVersion: "stella.source-policy/v1" }), /source_policy_migration_required/);
  assert.throws(() => parseSourcePolicy({ ...policy, restrictions: { ...policy.restrictions, quotePolicy: "anything" } }), /invalid_source_policy/);
  assert.notEqual(objectVersion(policy), objectVersion({ ...policy, restrictions: { ...policy.restrictions, sensitivity: "private" } }));
  const { restrictions: _restrictions, ...base } = policy;
  assert.doesNotThrow(() => assertSourcePolicyAccess({ ...base, schemaVersion: "stella.source-policy/v1" }, purpose));
});

test("an absolute source quote prohibition survives an exact-version Host quote grant", () => {
  const restricted = { ...policy, restrictions: { ...policy.restrictions, quotePolicy: "never_quote" } };
  const granted: SourceAccessContext = { ...context, judgment: { ...context.judgment, presentation: "quote" },
    quoteGrants: [{ id: restricted.id, version: objectVersion(restricted) }] };
  assert.throws(() => assertSourcePolicyAccess(restricted, purpose, granted), /source_quote_forbidden/);
  assert.doesNotThrow(() => assertSourcePolicyAccess(restricted, purpose, context));
});
