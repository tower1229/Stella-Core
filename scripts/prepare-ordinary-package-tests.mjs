import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fileManifest, sha256 } from "./lib/package-evidence.mjs";

// Stage existing contract tests against bytes extracted from npm pack. This
// neither installs/starts OpenClaw nor creates a new Host execution harness.
assert.ok(process.argv.length <= 3, "prepare-ordinary-package-tests takes an optional artifact directory name");
const artifactDirectory = process.argv[2] ?? "ordinary-package";
assert.match(artifactDirectory, /^ordinary-package(?:-[a-zA-Z0-9_-]+)?$/);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const out = path.join(root, ".artifacts", artifactDirectory);
assert.equal(await realpath(out), out, "artifact directory must not be a symlink");
const packed = JSON.parse(await readFile(path.join(out, "pack.json"), "utf8"));
assert.equal(packed.length, 1);
const pack = packed[0];
assert.match(pack.filename, /^[a-zA-Z0-9_.-]+\.tgz$/);
const artifact = await readFile(path.join(out, pack.filename));
assert.equal(pack.integrity, `sha512-${createHash("sha512").update(artifact).digest("base64")}`);
const files = pack.files.map(item => item.path);
assert.equal(new Set(files).size, files.length);
// A current plugin tarball must not offer the retired runtime as another entry.
// Check actual packed bytes, not just package.json's default export.
for (const retired of ["dist/src/plugin.js", "dist/src/openclaw/native-memory-reader.js",
  "dist/src/openclaw/host-context-engine.js", "dist/src/openclaw/host-memory-provider.js",
  "dist/src/openclaw/completion.js", "dist/src/openclaw/host-input.js",
  "dist/src/praxis/episode-store.js", "dist/src/praxis/episode-v2.js",
  "dist/src/praxis/episode-evidence.js", "dist/src/praxis/runtime-binding.js",
  "dist/src/praxis/packet.js", "dist/src/canghai/checkpoint-snapshot-import.js", "legacy/openclaw.plugin.json",
  "docs/EXPERIMENTAL-OWNER-CHAT.md", "docs/EXPLICIT-SNAPSHOT-IMPORT.md",
  "docs/CHECKPOINT-WORK-SUPPLY.md", "docs/CHECKPOINT-CORRECTION-WRITER.md"]) {
  assert.ok(!files.includes(retired), `retired runtime member was packed: ${retired}`);
}
for (const file of files) {
  assert.equal(typeof file, "string");
  assert.ok(file && !file.includes("\\") && !path.posix.isAbsolute(file) &&
    file.split("/").every(part => part && part !== "." && part !== ".."), "invalid package path");
}
const exec = promisify(execFile);
const { stdout: listing } = await exec("tar", ["-tzf", path.join(out, pack.filename)], { maxBuffer: 4 * 1024 * 1024 });
assert.deepEqual(listing.trim().split("\n").sort(), files.map(file => `package/${file}`).sort());
const run = path.join(out, "run"); await mkdir(run); // Refuse to overwrite an earlier run.
await exec("tar", ["-xzf", path.join(out, pack.filename), "-C", run]);
const pkg = path.join(run, "package"), harness = path.join(run, "harness");
for (const file of files) {
  const stat = await lstat(path.join(pkg, file));
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "packed file must be regular");
}
const packageFiles = await fileManifest(pkg, files);
assert.deepEqual(packageFiles, await fileManifest(root, files), "package differs from compiled source");
const metadata = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8"));
assert.equal(metadata.main, "./dist/src/ordinary-plugin.js");
assert.deepEqual(metadata.openclaw.extensions, [metadata.main]);
for (const required of [metadata.main.slice(2), "openclaw.plugin.json",
  "dist/src/canghai/repository-source.js", "dist/src/canghai/durability.js",
  "dist/src/canghai/evidence-reader.js", "dist/src/canghai/ref.js",
  "skills/stella-understand-sources/SKILL.md", "skills/stella-continue/SKILL.md"]) {
  assert.ok(files.includes(required), `required ordinary package file missing: ${required}`);
}
const buildIdentity = JSON.parse(await readFile(path.join(pkg, "dist/build-identity.json"), "utf8"));
if (process.env.GITHUB_ACTIONS === "true") assert.equal(buildIdentity.sourceClean, true, "CI source must be clean");
assert.deepEqual(buildIdentity, JSON.parse(await readFile(path.join(root, ".test-dist/build-identity.json"), "utf8")));

const suites = ["ordinary-plugin", "ordinary-startup-seam", "ordinary-source-read", "ordinary-source-admission",
  "tool-request-binding", "current-input-metadata", "source-understanding-skill",
  "candidate-work-brief", "author-intent-repository", "memory-transaction", "memory-transaction-journal",
  "native-memory-origin"];
const testFiles = [...suites.map(name => `${name}.test.js`), "fixtures/ordinary-source-read.js"];
await mkdir(path.join(harness, "tests/fixtures"), { recursive: true });
for (const file of testFiles) await copyFile(path.join(root, ".test-dist/tests", file), path.join(harness, "tests", file));
await writeFile(path.join(harness, "package.json"), '{"type":"module"}\n');
// Copied tests resolve ../src to the tarball, never to .test-dist/src.
await symlink(path.join(pkg, "dist/src"), path.join(harness, "src"), "dir");
assert.equal(await realpath(path.join(harness, "src/ordinary-plugin.js")), path.join(pkg, "dist/src/ordinary-plugin.js"));
for (const name of ["home", "tmp"]) await mkdir(path.join(run, name));
const sdk = JSON.parse(await readFile(path.join(root, "node_modules/openclaw/package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
if (process.env.GITHUB_ACTIONS === "true") assert.equal(sdk.version, lock.packages["node_modules/openclaw"].version);
await writeFile(path.join(out, "PREPARED.json"), JSON.stringify({
  schemaVersion: "stella.ordinary-package-contract/v1", phase: "prepared_not_test_result",
  buildIdentity, artifactSha256: sha256(artifact), packageIntegrity: pack.integrity,
  packageFiles, testFiles: await fileManifest(path.join(harness, "tests"), testFiles),
  sdkVersion: sdk.version, lockedSdkVersion: lock.packages["node_modules/openclaw"].version,
  syntheticSourceFixtureHostVersion: "2026.10.9",
  scope: "extracted npm package; existing synthetic source, draft, repository, transaction/journal contracts and public skill discovery using workspace dependencies",
  freshInstall: false, liveHost: false, realModel: false, privateSources: false, fullMemory: false,
  testCommand: "node --test --test-timeout=30000 ../harness/tests/*.test.js",
  testCwd: `.artifacts/${artifactDirectory}/run/package`,
}, null, 2) + "\n");
console.log("Ordinary package prepared; test exit status is still required.");
