import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { installedPackageRoot, sha256, sourceIdentity, treeManifest } from "./package-evidence.mjs";

const coreName = "@tower1229/stella-core", hostVersion = "2026.10.8";
const check = (condition, category) => assert.ok(condition, `reused_consumer_identity:${category}`);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const json = async file => JSON.parse(await readFile(file, "utf8"));
const within = (file, root) => file.startsWith(root + path.sep);
const packageName = value => typeof value === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
async function rootPath(value) {
  check(typeof value === "string" && path.isAbsolute(value), "absolute_root_required");
  const resolved = await realpath(value);
  check(resolved === path.resolve(value) && (await lstat(resolved)).isDirectory(), "root_alias_or_not_directory");
  return resolved;
}
async function packageTree(root, expected, label) {
  check(digest(expected), `expected_digest_required:${label}`);
  const manifest = await treeManifest(root);
  check(manifest.entries.every(entry => digest(entry.sha256)), `package_symlink:${label}`);
  check(manifest.digest === expected, `tree_mismatch:${label}`);
  return manifest.digest;
}

/** Read-only identity binding for a lockless consumer assembled from an artifact
 * and existing dependencies/SDK. Expected digests must come from independently
 * frozen source, pack and dependency-copy evidence, never from a candidate report.
 * No imports of product/SDK code, CLI execution, installation or Host acceptance.
 * This is a bounded snapshot, not an atomic filesystem or registry attestation. */
export async function verifyReusedConsumerIdentity(input, expected) {
  check(record(input) && record(expected), "facts_required");
  for (const name of ["sourceManifestSha256", "sourceLockSha256", "artifactSha256", "coreManifestSha256", "hostPackageSha256", "sdkEntrySha256"])
    check(digest(expected[name]), `expected_digest_required:${name}`);
  check(typeof expected.coreRevision === "string" && /^[a-f0-9]{40}$/.test(expected.coreRevision), "source_revision_required");
  check(record(expected.dependencyManifests), "dependency_manifests_required");
  for (const [name, hash] of Object.entries(expected.dependencyManifests))
    check(packageName(name) && digest(hash), "dependency_manifest_invalid");
  const consumerRoot = await rootPath(input.consumerRoot), hostRoot = await rootPath(input.hostRoot), sourceRoot = await rootPath(input.sourceRoot);
  check(!within(consumerRoot, sourceRoot) && !within(sourceRoot, consumerRoot) && consumerRoot !== sourceRoot, "source_consumer_overlap");
  check(!within(hostRoot, sourceRoot) && hostRoot !== sourceRoot, "sdk_source_fallback");
  // A real installation lock belongs to a different verification mode. Never
  // substitute the source lock or silently ignore a stale/copied consumer lock.
  const lockExists = await lstat(path.join(consumerRoot, "package-lock.json")).then(() => true, error => {
    if (error.code === "ENOENT") return false; throw error;
  });
  check(!lockExists, "consumer_lock_present_mode_mismatch");
  const source = await sourceIdentity(sourceRoot);
  check(source.coreRevision === expected.coreRevision && source.digest === expected.sourceManifestSha256, "source_identity_mismatch");
  const sourceMetadata = await json(path.join(sourceRoot, "package.json")), lockBytes = await readFile(path.join(sourceRoot, "package-lock.json"));
  check(sha256(lockBytes) === expected.sourceLockSha256, "source_lock_mismatch");
  const lock = JSON.parse(lockBytes), target = sourceMetadata.devDependencies?.openclaw;
  check(sourceMetadata.name === coreName && typeof sourceMetadata.version === "string" && target === hostVersion, "source_version_mismatch");
  check(lock.packages?.[""]?.name === coreName && lock.packages[""].version === sourceMetadata.version &&
    lock.packages[""].devDependencies?.openclaw === target && lock.packages?.["node_modules/openclaw"]?.version === target, "source_lock_version_mismatch");
  check(typeof input.artifactPath === "string" && path.isAbsolute(input.artifactPath), "artifact_path_required");
  const artifactSha256 = sha256(await readFile(input.artifactPath));
  check(artifactSha256 === expected.artifactSha256, "artifact_mismatch");
  const packageRoot = await installedPackageRoot(consumerRoot, coreName);
  const coreManifestSha256 = await packageTree(packageRoot, expected.coreManifestSha256, "core");
  const core = await json(path.join(packageRoot, "package.json"));
  check(core.name === coreName && core.version === sourceMetadata.version, "core_version_mismatch");
  for (const metadata of [sourceMetadata, core]) for (const key of ["openclawVersion", "pluginSdkVersion"])
    check(metadata.openclaw?.build?.[key] === target, `build_version_mismatch:${key}`);
  check(core.main === "./dist/src/plugin.js", "entry_metadata_mismatch");
  assert.deepEqual(core.dependencies, sourceMetadata.dependencies, "reused_consumer_identity:dependency_declarations_mismatch");
  const buildIdentity = await json(path.join(packageRoot, "dist/build-identity.json"));
  check(buildIdentity.coreRevision === expected.coreRevision && buildIdentity.sourceClean === true, "build_identity_mismatch");
  const resolve = createRequire(path.join(consumerRoot, "package.json"));
  const entry = await realpath(resolve.resolve(coreName));
  check(entry === path.join(packageRoot, "dist/src/plugin.js"), "entry_resolution_mismatch");
  const sdkEntry = await realpath(createRequire(path.join(packageRoot, "package.json")).resolve("openclaw/plugin-sdk/plugin-entry"));
  check(within(sdkEntry, hostRoot), "sdk_resolution_mismatch");
  const hostBytes = await readFile(path.join(hostRoot, "package.json")), host = JSON.parse(hostBytes);
  check(host.name === "openclaw" && host.version === target, "host_version_mismatch");
  const sdkEntrySha256 = sha256(await readFile(sdkEntry));
  check(sha256(hostBytes) === expected.hostPackageSha256 && sdkEntrySha256 === expected.sdkEntrySha256, "sdk_identity_mismatch");
  const dependencies = {}, pending = Object.keys(core.dependencies ?? {}).map(name => ({ name, owner: packageRoot })), visited = new Set();
  while (pending.length) {
    const { name, owner } = pending.shift(); check(packageName(name), "dependency_name_invalid");
    check(Object.hasOwn(expected.dependencyManifests, name), "dependency_manifest_missing");
    const dependencyRoot = await installedPackageRoot(consumerRoot, name);
    // Check every declared edge, including repeated/cyclic dependencies.
    check(within(await realpath(createRequire(path.join(owner, "package.json")).resolve(name)), dependencyRoot), `dependency_resolution_mismatch:${name}`);
    if (visited.has(name)) continue; visited.add(name);
    const metadata = await json(path.join(dependencyRoot, "package.json"));
    check(metadata.name === name && typeof metadata.version === "string" &&
      metadata.version === lock.packages?.[`node_modules/${name}`]?.version, `dependency_version_mismatch:${name}`);
    const manifestSha256 = await packageTree(dependencyRoot, expected.dependencyManifests[name], name);
    const declared = Object.keys(metadata.dependencies ?? {}); pending.push(...declared.map(name => ({ name, owner: dependencyRoot })));
    dependencies[name] = { version: metadata.version, manifestSha256, declared };
  }
  assert.deepEqual(Object.keys(dependencies).sort(), Object.keys(expected.dependencyManifests).sort(), "reused_consumer_identity:dependency_closure_mismatch");
  // Recheck source bytes after the filesystem observations. This does not claim
  // protection against mutation of a live installation after this snapshot.
  const after = await sourceIdentity(sourceRoot);
  check(after.coreRevision === source.coreRevision && after.digest === source.digest, "source_changed_during_observation");
  const installationManifest = { schemaVersion: "stella.reused-consumer-installation/v1", mode: "artifact-with-existing-dependencies-and-sdk",
    consumerRoot, packageRoot, entry, hostRoot, sdkEntry, hostVersion: host.version, corePackageVersion: core.version,
    coreRevision: source.coreRevision, sourceManifestSha256: source.digest, sourceLockSha256: sha256(lockBytes), artifactSha256,
    coreManifestSha256, hostPackageSha256: sha256(hostBytes), sdkEntrySha256, dependencies,
    consumerLock: null, freshDependencyInstall: false };
  return { schemaVersion: "stella.reused-consumer-identity/v1", identityConsistency: "validated_reused_installation",
    installationManifest, installationManifestSha256: sha256(JSON.stringify(installationManifest)), consumerLock: null,
    cliVerified: false, hostExecutionAccepted: false, profileAccepted: false, formalConsumerAccepted: false,
    fullMemoryAccepted: false, realModelAccepted: false };
}
