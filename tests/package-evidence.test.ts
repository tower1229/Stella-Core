import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type Manifest = { digest: string };
// The acceptance runner is plain Node ESM, outside the runtime TypeScript build.
const evidence = await import(new URL("../../scripts/lib/package-evidence.mjs", import.meta.url).href) as {
  treeManifest(base: string): Promise<Manifest>;
  sourceIdentity(root: string): Promise<Manifest & { coreRevision: string }>;
  assertSourceUnchanged(root: string, expected: Manifest & { coreRevision: string }): Promise<void>;
  assertTreeUnchanged(base: string, expected: Manifest, label: string): Promise<void>;
  assertDreamingDisabled(config: unknown): void;
  assertProbeDreamingDisabled(report: { evidenceDirectory: string }): Promise<void>;
  installedPackageRoot(consumer: string, name: string): Promise<string>;
};

test("package evidence rejects missing or enabled Dreaming, including actual probe configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-package-config-"));
  try {
    await mkdir(path.join(root, "state"));
    for (const enabled of [undefined, true, false]) {
      const config = { plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } } };
      await writeFile(path.join(root, "state/openclaw.json"), JSON.stringify(config));
      if (enabled === false) await evidence.assertProbeDreamingDisabled({ evidenceDirectory: root });
      else await assert.rejects(evidence.assertProbeDreamingDisabled({ evidenceDirectory: root }), /explicitly disabled/);
    }
    assert.throws(() => evidence.assertDreamingDisabled({ plugins: { entries: {
      "memory-core": { config: { dreaming: { enabled: false } } }, dreaming: { enabled: true },
    } } }), /must not be enabled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installation proof accepts a parent directory alias but rejects redirected packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-package-install-"));
  try {
    const consumer = path.join(root, "consumer"), alias = path.join(root, "alias");
    await mkdir(path.join(consumer, "node_modules/openclaw"), { recursive: true });
    await symlink(consumer, alias);
    assert.equal(await evidence.installedPackageRoot(alias, "openclaw"),
      path.join(await realpath(consumer), "node_modules/openclaw"));
    await rm(path.join(consumer, "node_modules/openclaw"), { recursive: true });
    await mkdir(path.join(root, "external-package"));
    await symlink(path.join(root, "external-package"), path.join(consumer, "node_modules/openclaw"));
    await assert.rejects(evidence.installedPackageRoot(alias, "openclaw"), /must not be a symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("package evidence catches modified, added, deleted and redirected runtime files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-package-files-"));
  try {
    await writeFile(path.join(root, "plugin.js"), "original");
    const manifest = await evidence.treeManifest(root);
    await evidence.assertTreeUnchanged(root, manifest, "Installed runtime");
    await writeFile(path.join(root, "plugin.js"), "changed");
    await assert.rejects(evidence.assertTreeUnchanged(root, manifest, "Installed runtime"), /Installed runtime changed/);
    await writeFile(path.join(root, "plugin.js"), "original");
    await writeFile(path.join(root, "extra.js"), "injected");
    await assert.rejects(evidence.assertTreeUnchanged(root, manifest, "Installed runtime"), /changed/);
    await rm(path.join(root, "extra.js"));
    await rm(path.join(root, "plugin.js"));
    await assert.rejects(evidence.assertTreeUnchanged(root, manifest, "Installed runtime"), /changed/);
    await symlink("/synthetic/redirected-plugin.js", path.join(root, "plugin.js"));
    await assert.rejects(evidence.assertTreeUnchanged(root, manifest, "Installed runtime"), /changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("package evidence requires clean source and the same committed version throughout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-package-source-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "--quiet");
    git("config", "user.name", "Synthetic acceptance");
    git("config", "user.email", "synthetic@example.invalid");
    await writeFile(path.join(root, "source.ts"), "original");
    git("add", "source.ts"); git("commit", "--quiet", "-m", "synthetic initial source");
    const original = await evidence.sourceIdentity(root);
    await evidence.assertSourceUnchanged(root, original);
    await writeFile(path.join(root, "untracked.ts"), "untracked");
    await assert.rejects(evidence.sourceIdentity(root), /clean Core source/);
    await rm(path.join(root, "untracked.ts"));
    await writeFile(path.join(root, "source.ts"), "changed");
    await assert.rejects(evidence.sourceIdentity(root), /clean Core source/);
    git("add", "source.ts");
    await assert.rejects(evidence.sourceIdentity(root), /clean Core source/);
    git("commit", "--quiet", "-m", "synthetic changed source");
    await assert.rejects(evidence.assertSourceUnchanged(root, original), /Source commit changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
