import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { createFixture, prepareInitializationFixture } from "./consciousness-fixture.js";
import { compileInitializationSource } from "../src/openclaw/initialization-source.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { isRecord } from "../src/shared/type-guards.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await createFixture());
  t.after(() => rm(root, { recursive: true, force: true }));
  const document = await prepareInitializationFixture(root, "probe");
  return { root, document, compile: () => compileInitializationSource(root, document, { agentId: "probe", hostVersion: "2026.8.2" }) };
}

test("compiles a complete registered skill tree, native display identity, and reviewed public rules", async (t) => {
  const f = await fixture(t);
  const result = await f.compile();
  assert.equal(result.materialization.files.length, 6);
  assert.deepEqual(result.materialization.skills, ["stella-initialization-probe"]);
  assert.deepEqual(result.identity, { name: "Synthetic Stella", theme: "Isolated local acceptance", emoji: "🧪" });
  assert.equal(result.setup, true);
  assert.match(result.contents.get("IDENTITY.md")!.toString(), /- Name: Synthetic Stella/);
  assert.match(result.contents.get("skills/stella-initialization-probe/SKILL.md")!.toString(), /No private data/);
});

test("an unlisted skill resource cannot be omitted from the deployed tree", async (t) => {
  const f = await fixture(t);
  const skillRoot = f.document.skill_bindings[0]!.source_root.slice(5);
  await writeFile(path.join(f.root, skillRoot, "reference.txt"), "A resource not yet included in the reviewed digest");
  await assert.rejects(f.compile(), /skill_tree_incomplete/);
});

test("a skill source symlink cannot extend the declared source tree", async (t) => {
  const f = await fixture(t);
  const skillRoot = f.document.skill_bindings[0]!.source_root.slice(5);
  await symlink(path.join(f.root, "README.md"), path.join(f.root, skillRoot, "outside.txt"));
  await assert.rejects(f.compile(), /unsafe_skill_source/);
});

test("source policy must authorize the declared installation purpose and exposure", async (t) => {
  const f = await fixture(t);
  const binding = f.document.skill_bindings[0]!;
  const policyPath = path.join(f.root, binding.policy_ref.ref.slice(5));
  const policy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  assert.ok(isRecord(policy));
  policy.readPurposes = [];
  const bytes = canonicalJson(policy);
  await writeFile(policyPath, bytes);
  binding.policy_ref.sha256 = bytesVersion(bytes);
  await assert.rejects(f.compile(), /skill_source_policy_forbidden/);
});

test("enabled skills in a referenced registry cannot silently disappear", async (t) => {
  const f = await fixture(t);
  const binding = f.document.skill_bindings[0]!;
  const registryPath = path.join(f.root, binding.registry_ref.ref.slice(5));
  const registry: unknown = JSON.parse(await readFile(registryPath, "utf8"));
  assert.ok(isRecord(registry) && Array.isArray(registry.skills) && isRecord(registry.skills[0]));
  registry.skills.push({ ...registry.skills[0], id: "unbound-enabled-skill" });
  const bytes = canonicalJson(registry);
  await writeFile(registryPath, bytes);
  binding.registry_ref.sha256 = bytesVersion(bytes);
  await assert.rejects(f.compile(), /enabled_skill_not_bound/);
});

test("the Manifest registry cannot be bypassed by declaring no skill bindings", async (t) => {
  const f = await fixture(t);
  await assert.rejects(compileInitializationSource(f.root, { ...f.document, skill_bindings: [] }, {
    agentId: "probe", hostVersion: "2026.8.2", skillRegistryRef: f.document.skill_bindings[0]!.registry_ref.ref,
  }), /enabled_skill_not_bound/);
});

test("full-memory instructions can be installed without declaring runtime acceptance", async (t) => {
  const f = await fixture(t);
  const result = await compileInitializationSource(f.root, f.document, {
    agentId: "probe", hostVersion: "2026.8.2", contractProfile: "full_memory",
  });
  assert.equal(result.materialization.files.length, 6);
  assert.deepEqual(result.runtimeBlockers, ["full_memory_acceptance_unavailable"]);
});

test("full-memory required capabilities become concrete acceptance blockers until receipts exist", async (t) => {
  const f = await fixture(t);
  const result = await compileInitializationSource(f.root, f.document, {
    agentId: "probe", hostVersion: "2026.8.2", contractProfile: "full_memory",
    requiredCapabilities: ["host_initialization", "memory_access"],
  });
  assert.deepEqual(result.runtimeBlockers, [
    "capability_acceptance_missing:host_initialization",
    "capability_acceptance_missing:memory_access",
  ]);
});

test("installed skills report every unverified capability instead of disappearing", async (t) => {
  const f = await fixture(t);
  const binding = f.document.skill_bindings[0]!;
  const file = path.join(f.root, binding.registry_ref.ref.slice(5));
  const registry: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(isRecord(registry) && Array.isArray(registry.skills) && isRecord(registry.skills[0]));
  registry.skills[0].required_capabilities = ["memory_access", "semantic_retrieval"];
  const bytes = canonicalJson(registry);
  await writeFile(file, bytes);
  binding.registry_ref.sha256 = bytesVersion(bytes);
  const result = await f.compile();
  assert.deepEqual(result.materialization.skills, [binding.name]);
  assert.deepEqual(result.runtimeBlockers, ["skill_capability_unverified:memory_access", "skill_capability_unverified:semantic_retrieval"]);
});

test("disabled automation declarations are retained but enabled jobs require a Host adapter", async (t) => {
  const f = await fixture(t);
  const task = await readFile(path.join(f.root, f.document.behavior_mapping_ref.ref.slice(5)));
  const declaration = { id: "weekly-check", trigger: { kind: "cron", expression: "0 19 * * 5" }, timezone: "Asia/Shanghai",
    task_ref: { ref: f.document.behavior_mapping_ref.ref, sha256: bytesVersion(task) },
    delegation_ref: "path:delegations.json", delivery_policy_ref: "path:delivery.json", enabled: false };
  const compile = (enabled: boolean) => compileInitializationSource(f.root, { ...f.document,
    automation_declarations: [{ ...declaration, enabled }] }, { agentId: "probe", hostVersion: "2026.8.2" });
  assert.equal((await compile(false)).materialization.skills.length, 1);
  await assert.rejects(compile(true), /automation_adapter_unavailable/);
  await assert.rejects(compileInitializationSource(f.root, { ...f.document,
    automation_declarations: [{ ...declaration, task_ref: { ...declaration.task_ref, sha256: `sha256:${"0".repeat(64)}` } }] },
  { agentId: "probe", hostVersion: "2026.8.2" }), /source_pin_mismatch/);
});

test("complete reviewed documents are rendered without a second template policy", async (t) => {
  const f = await fixture(t);
  const result = await f.compile();
  for (const recipe of f.document.projection_recipes) {
    if (recipe.target === "IDENTITY.md") continue;
    const source = await readFile(path.join(f.root, recipe.input_refs[0]!.ref.slice(5)), "utf8");
    assert.equal(result.contents.get(recipe.target)!.toString(), `<!-- stella.host-templates/v2 -->\n\n${source.trimEnd()}\n`);
  }
});

test("legacy template recipes are rejected rather than silently changing behavior", async (t) => {
  const f = await fixture(t);
  f.document.projection_recipes[0]!.template_version = "stella.host-templates/v1";
  await assert.rejects(f.compile(), /projection_template_migration_required/);
});

test("split or empty behavior documents cannot masquerade as complete content", async (t) => {
  const f = await fixture(t);
  f.document.projection_recipes[0]!.input_refs = [];
  await assert.rejects(f.compile(), /complete_reviewed_document_required/);
});

test("display role affects the prompt without introducing unsupported Host identity fields", async (t) => {
  const f = await fixture(t);
  const recipe = f.document.projection_recipes.find(item => item.target === "IDENTITY.md")!;
  const old = recipe.input_refs[0]!;
  const value = JSON.parse(await readFile(path.join(f.root, old.ref.slice(5)), "utf8"));
  value.role = "Synthetic collaboration partner";
  const bytes = canonicalJson(value);
  await writeFile(path.join(f.root, old.ref.slice(5)), bytes);
  const next = { ...old, sha256: bytesVersion(bytes) };
  recipe.input_refs = [next];
  const mappingPath = path.join(f.root, f.document.behavior_mapping_ref.ref.slice(5));
  const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
  for (const entry of mapping.entries) {
    if (entry.source.ref === old.ref) entry.source = next;
    entry.new_rule_refs = entry.new_rule_refs.map((ref: { ref: string; sha256: string }) => ref.ref === old.ref ? next : ref);
  }
  const mappingBytes = canonicalJson(mapping);
  await writeFile(mappingPath, mappingBytes);
  f.document.behavior_mapping_ref.sha256 = bytesVersion(mappingBytes);
  const result = await f.compile();
  assert.match(result.contents.get("IDENTITY.md")!.toString(), /Role: Synthetic collaboration partner/);
  assert.equal("role" in result.identity, false);
  assert.equal(result.identity.theme, "Isolated local acceptance");
});
