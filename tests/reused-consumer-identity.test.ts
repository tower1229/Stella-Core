import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const { verifyReusedConsumerIdentity: verify } = await import(new URL("../../scripts/lib/reused-consumer-identity.mjs", import.meta.url).href);
const { sha256, treeManifest, sourceIdentity } = await import(new URL("../../scripts/lib/package-evidence.mjs", import.meta.url).href);
const versions = await import(new URL("../../scripts/lib/acceptance-versions.mjs", import.meta.url).href);
const profile = await import(new URL("../../scripts/lib/installed-correction-profile.mjs", import.meta.url).href);
const exec = promisify(execFile), coreName = "@tower1229/stella-core", target = "2026.10.8";
const put = async (file: string, value: unknown) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const mutate = async (file: string, change: (value: any) => void) => { const value = await json(file); change(value); await put(file, value); };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-reused-identity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"), consumerRoot = path.join(root, "consumer"), hostRoot = path.join(root, "existing-sdk");
  const packageRoot = path.join(consumerRoot, "node_modules", coreName), sdkEntry = path.join(hostRoot, "dist/plugin-sdk/plugin-entry.js");
  await mkdir(sourceRoot); await mkdir(packageRoot, { recursive: true });
  const metadata = { name: coreName, version: "0.1.0-alpha.0", type: "module", main: "./dist/src/plugin.js", devDependencies: { openclaw: target },
    dependencies: { yaml: "^2.8.1" }, openclaw: { build: { openclawVersion: target, pluginSdkVersion: target } } };
  const lock = { lockfileVersion: 3, packages: { "": metadata, "node_modules/openclaw": { version: target },
    "node_modules/yaml": { version: "2.9.1" }, "node_modules/fixture-leaf": { version: "1.0.0" } } };
  await put(path.join(sourceRoot, "package.json"), metadata); await put(path.join(sourceRoot, "package-lock.json"), lock);
  const git = (...args: string[]) => exec("git", args, { cwd: sourceRoot,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  await git("init", "--quiet"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic source");
  const source = await sourceIdentity(sourceRoot);
  await put(path.join(packageRoot, "package.json"), metadata);
  await put(path.join(packageRoot, "dist/build-identity.json"), { coreRevision: source.coreRevision, sourceClean: true });
  await mkdir(path.join(packageRoot, "dist/src")); await writeFile(path.join(packageRoot, "dist/src/plugin.js"), "throw Error('PRODUCT_CODE_MUST_NOT_EXECUTE');\n");
  await put(path.join(consumerRoot, "package.json"), { private: true, type: "module" });
  await put(path.join(hostRoot, "package.json"), { name: "openclaw", version: target, type: "module", exports: { "./plugin-sdk/plugin-entry": "./dist/plugin-sdk/plugin-entry.js" } });
  await mkdir(path.dirname(sdkEntry), { recursive: true }); await writeFile(sdkEntry, "throw Error('SDK_CODE_MUST_NOT_EXECUTE');\n");
  await symlink(hostRoot, path.join(consumerRoot, "node_modules/openclaw"), "dir");
  const dependencyManifests: Record<string, string> = {};
  for (const [name, version, dependencies] of [["yaml", "2.9.1", { "fixture-leaf": "1.0.0" }], ["fixture-leaf", "1.0.0", {}]] as const) {
    const dir = path.join(consumerRoot, "node_modules", name);
    await put(path.join(dir, "package.json"), { name, version, main: "index.js", dependencies });
    await writeFile(path.join(dir, "index.js"), "throw Error('DEPENDENCY_CODE_MUST_NOT_EXECUTE');\n");
    dependencyManifests[name] = (await treeManifest(dir)).digest;
  }
  const artifactPath = path.join(root, "fixed-artifact.tgz");
  // Opaque synthetic bytes stand for an independently frozen pack artifact.
  // The collector fingerprints them; it is deliberately not a tar extractor.
  await writeFile(artifactPath, "SYNTHETIC_ARTIFACT_BYTES");
  const input = { sourceRoot, consumerRoot, hostRoot, artifactPath };
  const expected: Record<string, any> = { coreRevision: source.coreRevision, sourceManifestSha256: source.digest,
    sourceLockSha256: sha256(await readFile(path.join(sourceRoot, "package-lock.json"))), artifactSha256: sha256(await readFile(artifactPath)),
    coreManifestSha256: (await treeManifest(packageRoot)).digest, hostPackageSha256: sha256(await readFile(path.join(hostRoot, "package.json"))),
    sdkEntrySha256: sha256(await readFile(sdkEntry)), dependencyManifests };
  const bindCore = async () => { expected.coreManifestSha256 = (await treeManifest(packageRoot)).digest; };
  const bindDependency = async (name: string) => { expected.dependencyManifests[name] = (await treeManifest(path.join(consumerRoot, "node_modules", name))).digest; };
  return { root, input, expected, packageRoot, sdkEntry, bindCore, bindDependency };
}

test("lockless reused identity binds actual files and explicit SDK without executing code or claiming acceptance", async t => {
  const f = await fixture(t), result = await verify(f.input, f.expected), manifest = result.installationManifest;
  assert.equal(result.identityConsistency, "validated_reused_installation");
  assert.equal(manifest.entry, path.join(f.packageRoot, "dist/src/plugin.js")); assert.equal(manifest.hostVersion, target);
  assert.equal(manifest.sourceLockSha256, f.expected.sourceLockSha256); assert.equal(manifest.sdkEntry, f.sdkEntry);
  assert.equal(result.installationManifestSha256, sha256(JSON.stringify(manifest)));
  assert.notEqual(result.installationManifestSha256, manifest.sourceLockSha256);
  assert.equal(result.consumerLock, null); assert.equal(manifest.consumerLock, null); assert.equal(manifest.freshDependencyInstall, false);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["fixture-leaf", "yaml"]);
  for (const name of ["cliVerified", "hostExecutionAccepted", "profileAccepted", "formalConsumerAccepted", "fullMemoryAccepted", "realModelAccepted"]) assert.equal(result[name], false);
  await assert.rejects(readFile(path.join(f.input.consumerRoot, "package-lock.json")), { code: "ENOENT" });
  assert.deepEqual(await verify(f.input, f.expected), result, "stable snapshot has stable digest");
});

test("independent expected identities reject missing, malformed or mismatched digests", async t => {
  for (const name of ["sourceManifestSha256", "sourceLockSha256", "artifactSha256", "coreManifestSha256", "hostPackageSha256", "sdkEntrySha256"]) {
    for (const value of [null, ["a".repeat(64)], "a".repeat(64)]) await t.test(`${name}: ${JSON.stringify(value)?.slice(0, 12)}`, async t => {
      const f = await fixture(t); f.expected[name] = value;
      await assert.rejects(verify(f.input, f.expected));
    });
  }
  for (const value of [null, ["a".repeat(40)], "a".repeat(40)]) await t.test(`revision: ${JSON.stringify(value)?.slice(0, 12)}`, async t => {
    const f = await fixture(t); f.expected.coreRevision = value; await assert.rejects(verify(f.input, f.expected));
  });
});

test("copied source locks and broken aliases cannot masquerade as a consumer installation lock", async t => {
  for (const kind of ["source copy", "empty", "dangling symlink"] as const) await t.test(kind, async t => {
    const f = await fixture(t), lock = path.join(f.input.consumerRoot, "package-lock.json");
    if (kind === "dangling symlink") await symlink(path.join(f.root, "missing"), lock);
    else await writeFile(lock, kind === "empty" ? "{}" : await readFile(path.join(f.input.sourceRoot, "package-lock.json")));
    await assert.rejects(verify(f.input, f.expected), /consumer_lock_present_mode_mismatch/);
  });
});

test("artifact, build, Core and SDK changes fail closed at their actual boundaries", async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, RegExp]> = [
    ["artifact bytes", f => writeFile(f.input.artifactPath, "other artifact"), /artifact_mismatch/],
    ["package file", f => writeFile(path.join(f.packageRoot, "dist/src/plugin.js"), "changed"), /tree_mismatch:core/],
    ["Core version", async f => { await mutate(path.join(f.packageRoot, "package.json"), x => { x.version = "0.0.1"; }); await f.bindCore(); }, /core_version_mismatch/],
    ["build SDK version", async f => { await mutate(path.join(f.packageRoot, "package.json"), x => { x.openclaw.build.pluginSdkVersion = "2026.10.7"; }); await f.bindCore(); }, /build_version_mismatch/],
    ["build revision", async f => { await mutate(path.join(f.packageRoot, "dist/build-identity.json"), x => { x.coreRevision = "a".repeat(40); }); await f.bindCore(); }, /build_identity_mismatch/],
    ["dirty build", async f => { await mutate(path.join(f.packageRoot, "dist/build-identity.json"), x => { x.sourceClean = false; }); await f.bindCore(); }, /build_identity_mismatch/],
    ["entry metadata", async f => { await mutate(path.join(f.packageRoot, "package.json"), x => { x.main = "./other.js"; }); await f.bindCore(); }, /entry_metadata_mismatch/],
    ["Host version", f => mutate(path.join(f.input.hostRoot, "package.json"), x => { x.version = "2026.10.7"; }), /host_version_mismatch/],
    ["SDK bytes", f => writeFile(f.sdkEntry, "changed SDK"), /sdk_identity_mismatch/],
    ["source bytes", f => writeFile(path.join(f.input.sourceRoot, "package.json"), "{}"), /clean Core source/],
  ];
  for (const [name, change, category] of cases) await t.test(name, async t => {
    const f = await fixture(t); await change(f); await assert.rejects(verify(f.input, f.expected), category);
  });
});

test("package/source aliases, escaping files and nested SDK fallback are rejected", async t => {
  for (const kind of ["consumer alias", "Core alias", "package file symlink", "SDK escape", "nested SDK"] as const) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === "consumer alias") { const alias = path.join(f.root, "alias"); await symlink(f.input.consumerRoot, alias, "dir"); f.input.consumerRoot = alias; }
    else if (kind === "Core alias") { const other = path.join(f.root, "outside-core"); await rm(f.packageRoot, { recursive: true }); await mkdir(other); await symlink(other, f.packageRoot, "dir"); }
    else if (kind === "package file symlink") { const file = path.join(f.packageRoot, "dist/src/plugin.js"); await rm(file); await symlink(f.sdkEntry, file); await f.bindCore(); }
    else if (kind === "SDK escape") { const file = path.join(f.root, "outside-sdk.js"); await writeFile(file, "synthetic"); await rm(f.sdkEntry); await symlink(file, f.sdkEntry); }
    else { const nested = path.join(f.packageRoot, "node_modules/openclaw"); await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, "entry.js"), "synthetic"); await put(path.join(nested, "package.json"), { name: "openclaw", exports: { "./plugin-sdk/plugin-entry": "./entry.js" } }); await f.bindCore(); }
    await assert.rejects(verify(f.input, f.expected));
  });
});

test("runtime dependency closure, exact locked versions and every resolved edge stay bound", async t => {
  for (const kind of ["wrong version", "changed payload", "missing manifest", "extra manifest", "new transitive", "nested shadow", "dependency alias"] as const) await t.test(kind, async t => {
    const f = await fixture(t), yaml = path.join(f.input.consumerRoot, "node_modules/yaml");
    if (kind === "wrong version") { await mutate(path.join(yaml, "package.json"), x => { x.version = "2.9.0"; }); await f.bindDependency("yaml"); }
    else if (kind === "changed payload") await writeFile(path.join(yaml, "index.js"), "different dependency");
    else if (kind === "missing manifest") delete f.expected.dependencyManifests["fixture-leaf"];
    else if (kind === "extra manifest") f.expected.dependencyManifests.extra = "a".repeat(64);
    else if (kind === "new transitive") { await mutate(path.join(yaml, "package.json"), x => { x.dependencies.extra = "1.0.0"; }); await f.bindDependency("yaml"); }
    else if (kind === "nested shadow") { const nested = path.join(yaml, "node_modules/fixture-leaf"); await put(path.join(nested, "package.json"), { name: "fixture-leaf", main: "index.js" }); await writeFile(path.join(nested, "index.js"), "synthetic"); await f.bindDependency("yaml"); }
    else { await rm(yaml, { recursive: true }); await symlink(f.input.hostRoot, yaml, "dir"); }
    await assert.rejects(verify(f.input, f.expected));
  });
});

test("a repeated cyclic dependency still checks its resolution before deduplication", async t => {
  for (const shadow of [false, true]) await t.test(shadow ? "repeated edge shadow rejected" : "bounded cycle accepted", async t => {
    const f = await fixture(t), leaf = path.join(f.input.consumerRoot, "node_modules/fixture-leaf");
    await mutate(path.join(leaf, "package.json"), x => { x.dependencies.yaml = "^2.8.1"; });
    if (shadow) {
      const nested = path.join(leaf, "node_modules/yaml");
      await put(path.join(nested, "package.json"), { name: "yaml", main: "index.js" });
      await writeFile(path.join(nested, "index.js"), "synthetic nested shadow");
    }
    await f.bindDependency("fixture-leaf");
    if (shadow) await assert.rejects(verify(f.input, f.expected), /dependency_resolution_mismatch:yaml/);
    else assert.equal((await verify(f.input, f.expected)).consumerLock, null);
  });
});

test("reused identity never supplies missing CLI or loosens old consumer/profile contracts", async t => {
  const f = await fixture(t); f.expected.hostExecutionAccepted = true;
  const result = await verify(f.input, f.expected);
  assert.equal(result.cliVerified, false); assert.equal(result.hostExecutionAccepted, false); assert.equal(result.profileAccepted, false);
  const facts = { targetHostVersion: target, workspaceSdkVersion: target, corePackageVersion: "0.1.0-alpha.0", consumer: null };
  await assert.rejects(versions.verifyConsumerVersions({ consumer: f.input.consumerRoot, packageRoot: f.packageRoot, hostRoot: f.input.hostRoot }, facts), { code: "ENOENT" });
  assert.throws(() => versions.verifyConsumerCliVersion(facts, target), /metadata_required/);
  assert.equal(profile.INSTALLED_CORRECTION_PROFILE.executionConnected, false);
  assert.throws(() => profile.validateInstalledCorrectionReport({ schemaVersion: profile.INSTALLED_CORRECTION_PROFILE.reportSchema,
    profileId: profile.INSTALLED_CORRECTION_PROFILE.id, evidenceKind: "host_capture", profileAccepted: false, hostExecutionAccepted: false,
    experimentalOwnerChatAccepted: false, fullMemoryAccepted: false, realModelAccepted: false, privateMainAccepted: false,
    formalConsumerAccepted: false, issue23Complete: false }, {}, { canonicalJson() {}, objectVersion() {} }), /host_capture_not_connected/);
});
