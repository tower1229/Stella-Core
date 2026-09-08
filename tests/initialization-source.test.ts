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

test("Host bootstrap cannot advertise a full-memory profile while its adapter is unavailable", async (t) => {
  const f = await fixture(t);
  await assert.rejects(compileInitializationSource(f.root, f.document, {
    agentId: "probe", hostVersion: "2026.8.2", contractProfile: "full_memory",
  }), /full_memory_initialization_adapter_unavailable/);
});
