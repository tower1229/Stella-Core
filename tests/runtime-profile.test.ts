import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeProfile } from "../src/canghai/runtime-profile.js";

const fixture = () => ({ schema_version: "stella.runtime-profile/v1", contract_profile: "alpha_praxis", agent_id: "main", language: "zh-CN", timezone: "Asia/Shanghai",
  models: Object.fromEntries(["main", "router", "learning", "framework_compiler"].map((role) => [role,
    { provider: "synthetic", model: "synthetic", required_capabilities: ["structured_model"] }])),
  capabilities: [{ id: "structured_model", required: true, adapter_id: "synthetic", adapter_version: "1",
    config_ref: "path:config.json", acceptance_ref: "path:acceptance.json", required_secret_refs: [] }],
  source_policies_ref: "path:policies.yaml", memory: { catalog_ref: "path:catalog.json", semantic_provider: "synthetic", required_views: [], archive_max_rpo_seconds: 300 },
  autonomy: { research_enabled: false, proactive_delivery_enabled: false, delivery_policy_ref: "path:delivery.yaml", delegation_registry_ref: "path:delegations.yaml" } });

test("profile structural parsing preserves explicit roles, empty views and disabled autonomy without asserting acceptance", () => {
  const value = fixture(); const parsed = parseRuntimeProfile(value);
  assert.deepEqual(parsed, value); assert.notEqual(parsed, value);
  assert.equal("accepted" in parsed, false);
});
test("missing or optional model dependencies cannot masquerade as a complete profile", () => {
  const missing = fixture(); missing.capabilities = [];
  assert.throws(() => parseRuntimeProfile(missing), /model_capability_not_required/);
  const optional = fixture(); optional.capabilities[0]!.required = false;
  assert.throws(() => parseRuntimeProfile(optional), /model_capability_not_required/);
  const duplicate = fixture(); duplicate.capabilities.push(duplicate.capabilities[0]!);
  assert.throws(() => parseRuntimeProfile(duplicate), /invalid_capability/);
});
test("profile rejects unknown versions, absent roles, unsafe refs and invalid timezones", () => {
  assert.throws(() => parseRuntimeProfile({ ...fixture(), schema_version: "stella.runtime-profile/v1alpha" }), /migration_required/);
  assert.throws(() => parseRuntimeProfile({ ...fixture(), models: {} }), /invalid_model/);
  assert.throws(() => parseRuntimeProfile({ ...fixture(), timezone: "invalid-zone" }), /invalid_timezone/);
  assert.throws(() => parseRuntimeProfile({ ...fixture(), source_policies_ref: "path:../secret" }), /invalid_reference/);
  assert.throws(() => parseRuntimeProfile({ ...fixture(), source_policies_ref: "path:.git/config" }), /invalid_reference/);
});
