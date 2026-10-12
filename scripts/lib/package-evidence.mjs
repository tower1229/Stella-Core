import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function fileManifest(base, files) {
  const ordered = [...new Set(files)].sort(), entries = [];
  for (let index = 0; index < ordered.length; index += 64) {
    entries.push(...await Promise.all(ordered.slice(index, index + 64).map(async relative => {
      const file = path.join(base, relative), info = await lstat(file);
      if (info.isSymbolicLink()) return { path: relative, link: await readlink(file) };
      assert.ok(info.isFile(), `Unsupported evidence entry: ${relative}`);
      return { path: relative, sha256: sha256(await readFile(file)) };
    })));
  }
  return { digest: sha256(JSON.stringify(entries)), entries };
}

export async function treeManifest(base) {
  const files = [];
  async function walk(relative) {
    for (const name of (await readdir(path.join(base, relative))).sort()) {
      const file = path.join(relative, name), info = await lstat(path.join(base, file));
      if (info.isDirectory()) await walk(file); else files.push(file);
    }
  }
  await walk("");
  return fileManifest(base, files);
}

export async function sourceIdentity(root) {
  const git = async args => (await exec("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const coreRevision = (await git(["rev-parse", "HEAD"])).trim();
  assert.equal((await git(["status", "--porcelain", "--untracked-files=all"])).trim(), "",
    "package acceptance requires a clean Core source");
  const source = await fileManifest(root, (await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean));
  return { coreRevision, sourceClean: true, ...source };
}

export async function assertSourceUnchanged(root, expected) {
  const current = await sourceIdentity(root);
  assert.equal(current.coreRevision, expected.coreRevision, "Source commit changed during acceptance");
  assert.equal(current.digest, expected.digest, "Source bytes changed during acceptance");
}

export function assertDreamingDisabled(config) {
  assert.equal(config.plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled, false,
    "Dreaming must stay explicitly disabled");
  assert.notEqual(config.plugins?.entries?.dreaming?.enabled, true, "Dreaming plugin must not be enabled");
}

export async function assertProbeDreamingDisabled(report) {
  assert.equal(typeof report.evidenceDirectory, "string", "Probe must expose its isolated Host evidence");
  const config = JSON.parse(await readFile(path.join(report.evidenceDirectory, "state/openclaw.json"), "utf8"));
  assertDreamingDisabled(config);
}

export async function assertTreeUnchanged(base, expected, label) {
  assert.equal((await treeManifest(base)).digest, expected.digest, `${label} changed during acceptance`);
}
