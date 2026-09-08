import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { isRecord } from "../src/shared/type-guards.js";

const execFileAsync = promisify(execFile);

export async function prepareInitializationFixture(root: string, agentId: string) {
  const prefix = "50_PersonalAgent/stella";
  const profilePath = path.join(root, prefix, "runtime-profile.yaml");
  const profile: unknown = parse(await readFile(profilePath, "utf8"));
  if (!isRecord(profile)) throw new Error("Synthetic runtime profile is missing");
  profile.schema_version = "stella.runtime-profile/v2";
  profile.agent_id = agentId;
  profile.host_materialization_ref = `path:${prefix}/host-materialization.json`;
  await writeFile(profilePath, stringify(profile));
  await mkdir(path.join(root, prefix, "host"), { recursive: true });
  const files = [];
  for (const target of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]) {
    const content = target === "IDENTITY.md" ? canonicalJson({ schema_version: "stella.display-identity/v1", id: "synthetic-identity",
      name: "Synthetic Stella", theme: "Isolated local acceptance", emoji: "🧪" }) : `# Synthetic ${target}\nSynthetic isolated Host acceptance.\n`;
    const source = `${prefix}/host/${target === "IDENTITY.md" ? "display-identity.json" : target}`;
    await writeFile(path.join(root, source), content);
    files.push({ target, source, sha256: bytesVersion(content), executable: false });
  }
  const skill = "---\nname: stella-initialization-probe\ndescription: Synthetic initialization acceptance only.\n---\nNo private data.\n";
  const skillRoot = `${prefix}/host/skills/stella-initialization-probe`;
  await mkdir(path.join(root, skillRoot), { recursive: true });
  const skillSource = `${skillRoot}/SKILL.md`;
  await writeFile(path.join(root, skillSource), skill);
  const save = async (name: string, value: unknown) => {
    const bytes = canonicalJson(value);
    const ref = `path:${prefix}/host/${name}`;
    await writeFile(path.join(root, prefix, "host", name), bytes);
    return { ref, sha256: bytesVersion(bytes) };
  };
  const skillPin = { ref: `path:${skillSource}`, sha256: bytesVersion(skill) };
  const exposure = await save("exposure.json", { schema_version: "stella.projection-exposure/v1", id: "synthetic-public-behavior",
    classification: "public_behavior", audiences: ["public"], targets: [...files.map((file) => file.target), "skills/stella-initialization-probe"] });
  const policy = await save("skill-policy.json", { schemaVersion: "stella.source-policy/v1", id: "synthetic-skill-policy", ownerId: "synthetic-owner",
    readPurposes: ["host_initialization"], derivePurposes: [], deliveryScopes: ["host-workspace"], retention: "retain", authorityEvidenceRefs: [] });
  const registry = await save("skill-registry.json", { schema_version: "stella.skill-registry/v1", id: "synthetic-skills", skills: [{
    id: "initialization-probe", ref: `path:${skillRoot}`, class: "core_behavior", enabled: true, required_capabilities: [], policy_ref: policy.ref,
  }] });
  const manifestPath = path.join(root, prefix, "manifest.yaml");
  const manifest: unknown = parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(manifest)) throw new Error("Synthetic manifest is missing");
  const extensions = manifest.extensions === undefined ? {} : manifest.extensions;
  if (!isRecord(extensions)) throw new Error("Synthetic manifest extensions are invalid");
  manifest.extensions = { ...extensions, skillRegistryRef: registry.ref };
  await writeFile(manifestPath, stringify(manifest));
  const mappingEntries = files.map((file) => ({ id: file.target, source: { ref: `path:${file.source}`, sha256: file.sha256 },
    role: "core_behavior", status: "retained", new_rule_refs: [{ ref: `path:${file.source}`, sha256: file.sha256 }],
    reason: "Synthetic reviewed public behavior", replacement_requirements: [], dependencies: [], required: true }));
  mappingEntries.push({ id: "probe-skill", source: skillPin, role: "core_behavior", status: "retained", new_rule_refs: [skillPin],
    reason: "Synthetic read-only skill", replacement_requirements: [], dependencies: [], required: true });
  const mapping = await save("behavior-mapping.json", { schema_version: "stella.behavior-mapping/v1", id: "synthetic-behavior", entries: mappingEntries });
  const tree = [{ path: "SKILL.md", sha256: skillPin.sha256, executable: false }];
  const materialization = {
    schema_version: "stella.host-materialization/v1", id: "synthetic-host",
    host_adapter: { id: "openclaw", version: "1", host_version: "2026.8.2", harness: "openclaw" }, behavior_mapping_ref: mapping,
    projection_recipes: files.map((file) => ({ target: file.target, template_version: "stella.host-templates/v1", behavior_ids: [file.target],
      input_refs: [{ ref: `path:${file.source}`, sha256: file.sha256 }], exposure_policy_ref: exposure })),
    skill_bindings: [{ registry_ref: registry, registry_id: "synthetic-skills", skill_id: "initialization-probe", name: "stella-initialization-probe",
      source_root: `path:${skillRoot}`, files: tree, tree_digest: bytesVersion(canonicalJson(tree)), purpose: "host_initialization", policy_ref: policy,
      exposure_policy_ref: exposure, behavior_ids: ["probe-skill"] }], automation_declarations: [], required_checks: ["host_files", "host_skills", "host_identity", "host_setup"],
  };
  await writeFile(path.join(root, prefix, "host-materialization.json"), JSON.stringify(materialization));
  return materialization;
}

export async function createFixture(options: { ownerProfile?: "synthetic" | "case_only" } = {}): Promise<string> {
  const includeOwnerProfile = options.ownerProfile !== "case_only";
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-core-test-"));
  const files = [
    "50_PersonalAgent/corpus-registry.yaml",
    "50_PersonalAgent/openclaw/openclaw.json",
    "50_PersonalAgent/stella/runtime-profile.yaml",
    "30_PersonalData/praxis/playbook/registry.yaml",
  ];

  for (const relative of files) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "fixture: true\n", "utf8");
  }
  await writeFile(
    path.join(root, "30_PersonalData/praxis/playbook/registry.yaml"),
    "schema_version: stella.praxis-playbook-registry/v1alpha\nitems: []\n",
    "utf8",
  );

  const policy = { schemaVersion: "stella.source-policy/v1", id: "policy-fixture", ownerId: "owner-fixture",
    readPurposes: ["alpha_praxis"], derivePurposes: ["alpha_praxis"], deliveryScopes: ["host-chat"], retention: "retain", authorityEvidenceRefs: [] };
  const policyRef = { id: policy.id, version: objectVersion(policy) };
  const policyBytes = canonicalJson(policy);
  await mkdir(path.join(root, "30_PersonalData/memory"), { recursive: true });
  await writeFile(path.join(root, "30_PersonalData/memory/policy.json"), policyBytes);
  await writeFile(path.join(root, "30_PersonalData/memory/catalog.json"), canonicalJson({
    schemaVersion: "stella.memory-catalog/v1", generationId: "fixture-empty-v2", parentGenerationId: null,
    sources: [], evidence: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [],
    policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "30_PersonalData/memory/policy.json", sha256: bytesVersion(policyBytes) } }],
  }));
  await writeFile(path.join(root, "50_PersonalAgent/stella/praxis-binding.json"), canonicalJson({
    schemaVersion: "stella.alpha-praxis-binding/v2", archive: { policyRef, objectRoot: "30_PersonalData/memory/objects", payloadRoot: "30_PersonalData/host-archive" },
    purpose: { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat" }, referenceBindings: [],
  }));
  const prefix = "50_PersonalAgent/stella";
  await writeFile(path.join(root, `${prefix}/source-policies.yaml`), stringify({ schema_version: "stella.source-policy-registry/v1",
    id: "fixture-policies", policies: [{ id: policy.id, ref: "path:30_PersonalData/memory/policy.json" }] }));
  await writeFile(path.join(root, `${prefix}/delivery.yaml`), stringify({ schema_version: "stella.delivery-policy/v1", timezone: "Asia/Shanghai",
    allowed_windows: [], max_initiations_per_day: 0, channel_ref: "host-chat" }));
  await writeFile(path.join(root, `${prefix}/delegations.yaml`), stringify({ schema_version: "stella.delegation-registry/v1", id: "fixture-delegations", delegations: [] }));
  await writeFile(path.join(root, `${prefix}/capability-acceptance.json`), canonicalJson({ status: "not_evaluated", scope: "synthetic structural fixture" }));
  await writeFile(path.join(root, `${prefix}/runtime-profile.yaml`), stringify({
    schema_version: "stella.runtime-profile/v1", contract_profile: "alpha_praxis", agent_id: "stella", language: "zh-CN", timezone: "Asia/Shanghai",
    models: Object.fromEntries(["main", "router", "learning", "framework_compiler"].map((role) => [role,
      { provider: "synthetic", model: "synthetic", required_capabilities: ["structured_model"] }])),
    memory: { catalog_ref: "path:30_PersonalData/memory/catalog.json", semantic_provider: "synthetic", required_views: [], archive_max_rpo_seconds: 300 },
    capabilities: ["transcript_archive", "structured_model"].map((id) => ({ id, required: true,
      adapter_id: id === "transcript_archive" ? "openclaw-transcript-2026.8.2" : "synthetic", adapter_version: "1",
      config_ref: `path:${prefix}/praxis-binding.json`, acceptance_ref: `path:${prefix}/capability-acceptance.json`, required_secret_refs: [] })),
    source_policies_ref: `path:${prefix}/source-policies.yaml`,
    autonomy: { research_enabled: false, proactive_delivery_enabled: false,
      delivery_policy_ref: `path:${prefix}/delivery.yaml`, delegation_registry_ref: `path:${prefix}/delegations.yaml` },
  }));

  await mkdir(path.join(root, "30_PersonalData/praxis/episodes"), { recursive: true });
  await writeFile(path.join(root, "30_PersonalData/praxis/episodes/.gitkeep"), "", "utf8");
  await mkdir(path.join(root, "50_PersonalAgent/stella"), { recursive: true });
  await mkdir(path.join(root, "50_PersonalAgent/stella/twin"), { recursive: true });
  await mkdir(path.join(root, "50_PersonalAgent/stella/frameworks"), { recursive: true });
  await mkdir(path.join(root, "50_PersonalAgent/openclaw/workspace"), { recursive: true });
  await mkdir(path.join(root, "30_PersonalData/twin/hypotheses"), { recursive: true });
  await mkdir(path.join(root, "30_PersonalData/framework-runtime/active-ir"), { recursive: true });
  await mkdir(path.join(root, "30_RAG/frameworks"), { recursive: true });

  await writeFile(
    path.join(root, "50_PersonalAgent/openclaw/workspace/SOUL.md"),
    includeOwnerProfile ? "# Soul\nEvidence-driven and direct.\n"
      : "# Synthetic assistant role\nAssist the current case speaker with their request. No prior personal profile is known. Personal facts come only from the current case; general reasoning is not a known personal trait.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "50_PersonalAgent/stella/twin/hypotheses-registry.yaml"),
    includeOwnerProfile ? "hypotheses:\n  - id: twin_fixture\n    ref: path:30_PersonalData/twin/hypotheses/twin_fixture.md\n" : "hypotheses: []\n",
    "utf8",
  );
  if (includeOwnerProfile) await writeFile(
    path.join(root, "30_PersonalData/twin/hypotheses/twin_fixture.md"),
    `---
schema_version: stella.twin-hypothesis/v1
id: twin_fixture
status: active
scope:
  domains: [relationship, testing]
predicts: [action]
strength: 0.75
supporting_refs: []
counter_refs: []
created_at: "2026-09-02T00:00:00Z"
updated_at: "2026-09-02T00:00:00Z"
---

# Hypothesis

Prefers reversible experiments.
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "50_PersonalAgent/stella/frameworks/source-registry.yaml"),
    "sources:\n  - id: framework_fixture\n    source_ref: path:30_RAG/frameworks/fixture.md\n",
    "utf8",
  );
  await writeFile(path.join(root, "30_RAG/frameworks/fixture.md"), "# Framework source\n", "utf8");
  await writeFile(
    path.join(root, "50_PersonalAgent/stella/frameworks/active-ir-registry.yaml"),
    "active:\n  - ir_id: fw_ir_fixture\n    source_ref: path:30_RAG/frameworks/fixture.md\n    ir_ref: path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml"),
    `schemaVersion: stella.framework-ir/v1
id: fw_ir_fixture
name: Reversible Test
source:
  ref: path:30_RAG/frameworks/fixture.md
  contentHash: "11111111"
compiler:
  version: fixture/v1
cognitiveJobs: [relationship, uncertainty]
domainHints: [relationship]
detection:
  positiveSignals: [消息, 回复, 压力]
operators:
  - id: reversible_test
    purpose: Design one low-pressure reversible action
  - id: observation_test
    purpose: Separate the observation from an identity-level interpretation
  - id: unrelated_test
    purpose: Optimize a generic unrelated workflow
failureModes: []
compiledAt: "2026-09-02T00:00:00Z"
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "50_PersonalAgent/stella/manifest.yaml"),
    `schemaVersion: stella.consciousness-manifest/v1
sourceBaseline:
  repository: tower1229/CangHai
  commit: "1111111111111111111111111111111111111111"
instance:
  id: stella
  ownerRef: path:50_PersonalAgent/corpus-registry.yaml#canonical_subject
compatibility:
  stellaCore: ">=3.0.0-alpha <4.0.0"
  openclaw: ">=2026.8.1"
  modelPolicyRef: path:50_PersonalAgent/openclaw/openclaw.json
runtimeState:
  activationStatus: active
  requiredOpenClawVersion: ">=2026.8.1"
  runtimeProfileRef: path:50_PersonalAgent/stella/runtime-profile.yaml
identity:
  soulRef: path:50_PersonalAgent/openclaw/workspace/SOUL.md
  runtimeProfileRef: path:50_PersonalAgent/stella/runtime-profile.yaml
twin:
  hypothesisRegistryRef: path:50_PersonalAgent/stella/twin/hypotheses-registry.yaml
frameworks:
  sourceRegistryRef: path:50_PersonalAgent/stella/frameworks/source-registry.yaml
  activeIrRegistryRef: path:50_PersonalAgent/stella/frameworks/active-ir-registry.yaml
praxis:
  episodeRootRef: path:30_PersonalData/praxis/episodes
  playbookRegistryRef: path:30_PersonalData/praxis/playbook/registry.yaml
experience:
  corpusRegistryRef: path:50_PersonalAgent/corpus-registry.yaml
durability:
  criticalWritePolicy: sync_immediately
  normalWritePolicy: bounded_batch
  maxNormalRpoSeconds: 300
derived:
  rebuild: [bootstrap_projection, memory_index]
`,
    "utf8",
  );

  return root;
}

export async function updateFixtureManifest(
  root: string,
  update: (manifest: string) => string,
): Promise<void> {
  const manifestPath = path.join(root, "50_PersonalAgent/stella/manifest.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, update(manifest), "utf8");
}

export async function initializeFixtureRepository(root: string): Promise<string> {
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Stella Core Tests"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "tests@stella-core.invalid"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return stdout.trim();
}
