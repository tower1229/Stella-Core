import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConsciousness } from "../src/canghai/manifest.js";

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-core-test-"));

  const files = [
    "50_PersonalAgent/corpus-registry.yaml",
    "50_PersonalAgent/openclaw/openclaw.json",
    "50_PersonalAgent/openclaw/workspace/SOUL.md",
    "50_PersonalAgent/stella/runtime-profile.yaml",
    "50_PersonalAgent/stella/twin/hypotheses-registry.yaml",
    "50_PersonalAgent/stella/frameworks/source-registry.yaml",
    "50_PersonalAgent/stella/frameworks/active-ir-registry.yaml",
    "30_PersonalData/praxis/playbook/registry.yaml",
  ];

  for (const relative of files) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "fixture: true\n", "utf8");
  }

  await mkdir(path.join(root, "30_PersonalData/praxis/episodes"), { recursive: true });
  await mkdir(path.join(root, "50_PersonalAgent/stella"), { recursive: true });

  await writeFile(
    path.join(root, "50_PersonalAgent/stella/manifest.yaml"),
    `schemaVersion: stella.consciousness-manifest/v1
instance:
  id: stella
  ownerRef: path:50_PersonalAgent/corpus-registry.yaml#canonical_subject
compatibility:
  stellaCore: ">=3.0.0-alpha <4.0.0"
  openclaw: ">=2026.8.1"
  modelPolicyRef: path:50_PersonalAgent/openclaw/openclaw.json
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

test("loads and validates a minimal recoverable consciousness manifest", async () => {
  const root = await createFixture();
  try {
    const loaded = await loadConsciousness(root);
    assert.equal(loaded.manifest.instance.id, "stella");
    assert.ok(loaded.requiredReferences.length >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when a required durable reference is missing", async () => {
  const root = await createFixture();
  try {
    await rm(path.join(root, "50_PersonalAgent/stella/twin/hypotheses-registry.yaml"));
    await assert.rejects(() => loadConsciousness(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
