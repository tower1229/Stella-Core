import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeProfile } from "../src/canghai/runtime-profile.js";
import { loadRuntimeProfileResources } from "../src/canghai/runtime-profile-resources.js";
import { assertSourcePolicyAccess } from "../src/canghai/source-policy.js";
import { createFixture } from "./consciousness-fixture.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

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

test("initialization uses an explicit v2 reference rather than changing v1 semantics", () => {
  const v2 = { ...fixture(), schema_version: "stella.runtime-profile/v2", host_materialization_ref: "path:host.json" };
  assert.equal(parseRuntimeProfile(v2).host_materialization_ref, "path:host.json");
  assert.throws(() => parseRuntimeProfile({ ...v2, host_materialization_ref: undefined }), /invalid_reference/);
  assert.throws(() => parseRuntimeProfile({ ...fixture(), host_materialization_ref: "path:host.json" }), /migration_required/);
});

test("profile accepts fully validated v2 policy resources without granting runtime access", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = parseRuntimeProfile(parse(await readFile(path.join(root, "50_PersonalAgent/stella/runtime-profile.yaml"), "utf8")));
  const policyPath = path.join(root, "30_PersonalData/memory/policy.json");
  const policy = { ...JSON.parse(await readFile(policyPath, "utf8")), schemaVersion: "stella.source-policy/v2",
    restrictions: { sensitivity: "sensitive", quotePolicy: "never_quote", allowedScenarios: ["self_reflection"], forbiddenScenarios: [] } };
  await writeFile(policyPath, JSON.stringify(policy));
  const resources = await loadRuntimeProfileResources(root, profile);
  assert.ok(resources.authorityPaths.includes("30_PersonalData/memory/policy.json"));
  assert.throws(() => assertSourcePolicyAccess(policy,
    { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat" }), /source_access_context_required/);
  await writeFile(policyPath, JSON.stringify({ ...policy, restrictions: { ...policy.restrictions, quotePolicy: "allow_everything" } }));
  await assert.rejects(loadRuntimeProfileResources(root, profile), /invalid_source_policy/);
  await writeFile(policyPath, JSON.stringify({ ...policy, schemaVersion: "stella.source-policy/v1" }));
  await assert.rejects(loadRuntimeProfileResources(root, profile), /source_policy_migration_required/);
  await writeFile(policyPath, JSON.stringify({ ...policy, id: "unregistered-policy" }));
  await assert.rejects(loadRuntimeProfileResources(root, profile), /source_policy_identity_mismatch/);
});
