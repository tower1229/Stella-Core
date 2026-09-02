import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createFixture(): Promise<string> {
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
    "# Soul\nEvidence-driven and direct.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "50_PersonalAgent/stella/twin/hypotheses-registry.yaml"),
    "hypotheses:\n  - id: twin_fixture\n    ref: path:30_PersonalData/twin/hypotheses/twin_fixture.md\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "30_PersonalData/twin/hypotheses/twin_fixture.md"),
    `---
schema_version: stella.twin-hypothesis/v1
id: twin_fixture
status: active
scope:
  domains: [testing]
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
cognitiveJobs: [test]
detection:
  positiveSignals: [test]
operators:
  - id: reversible_test
    purpose: Test a reversible action
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
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Stella Core Tests"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "tests@stella-core.invalid"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return stdout.trim();
}
