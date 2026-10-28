import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const versionsApi = await import(new URL("../../scripts/lib/acceptance-versions.mjs", import.meta.url).href);
const packageEvidence = await import(new URL("../../scripts/lib/package-evidence.mjs", import.meta.url).href);
const { PACKAGE_PLAN_VERSION } = await import(new URL("../../scripts/lib/package-shards.mjs", import.meta.url).href);
const exec = promisify(execFile), target = "2026.10.8", coreName = "@tower1229/stella-core", coreVersion = "0.1.0-alpha.0";
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const put = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
async function change(file: string, mutate: (value: any) => void) { const value = await json(file); mutate(value); await put(file, value); }
const coreMetadata = () => ({ name: coreName, version: coreVersion, devDependencies: { openclaw: target },
  openclaw: { build: { openclawVersion: target, pluginSdkVersion: target } } });
const lockMetadata = () => ({ packages: { "": { name: coreName, version: coreVersion, devDependencies: { openclaw: target } },
  "node_modules/openclaw": { version: target }, [`node_modules/${coreName}`]: { version: coreVersion } } });
async function hostMetadata(root: string) {
  await mkdir(path.join(root, "dist/plugin-sdk"), { recursive: true });
  await put(path.join(root, "package.json"), { name: "openclaw", version: target,
    exports: { "./plugin-sdk/plugin-entry": "./dist/plugin-sdk/plugin-entry.js" } });
  await writeFile(path.join(root, "dist/plugin-sdk/plugin-entry.js"), "throw Error('This metadata fixture must never execute SDK code');");
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-version-facts-")); t.after(() => rm(root, { recursive: true, force: true }));
  const host = path.join(root, "node_modules/openclaw"), metadata = path.join(root, "package.json"), lock = path.join(root, "package-lock.json");
  await hostMetadata(host); await put(metadata, coreMetadata()); await put(lock, lockMetadata());
  return { root, host, metadata, lock, versions: versionsApi.initialAcceptanceVersions() };
}
async function consumerFixture(t: TestContext) {
  const f = await fixture(t), consumer = path.join(f.root, "consumer"), packageRoot = path.join(consumer, "node_modules", coreName), hostRoot = path.join(consumer, "node_modules/openclaw");
  await mkdir(packageRoot, { recursive: true }); await hostMetadata(hostRoot);
  await put(path.join(packageRoot, "package.json"), coreMetadata()); await put(path.join(consumer, "package-lock.json"), lockMetadata());
  await versionsApi.verifyWorkspaceVersions(f.root, f.versions);
  return { ...f, params: { consumer, packageRoot, hostRoot } };
}

test("workspace observations name the actual SDK and Core package without inventing a consumer", async t => {
  const f = await fixture(t); assert.equal(f.versions.consumer, null);
  await versionsApi.verifyWorkspaceVersions(f.root, f.versions);
  assert.deepEqual(f.versions, { targetHostVersion: target, workspaceSdkVersion: target, corePackageVersion: coreVersion, consumer: null });
});

test("missing, ranged or inconsistent workspace metadata fails closed", async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, RegExp]> = [
    ["SDK", f => change(path.join(f.host, "package.json"), x => { x.version = "2026.10.7"; }), /workspace_sdk_version_mismatch/],
    ["lock host", f => change(f.lock, x => { x.packages["node_modules/openclaw"].version = "2026.8.2"; }), /lock_host_version_mismatch/],
    ["lock target", f => change(f.lock, x => { x.packages[""].devDependencies.openclaw = "2026.8.2"; }), /lock_target_mismatch/],
    ["Core lock", f => change(f.lock, x => { x.packages[""].version = "0.0.1"; }), /lock_core_version_mismatch/],
    ["build", f => change(f.metadata, x => { x.openclaw.build.pluginSdkVersion = "2026.8.2"; }), /build_version_mismatch/],
    ["range", f => change(f.metadata, x => { x.devDependencies.openclaw = "^2026.10.8"; }), /target_not_exact/],
    ["missing pin", f => change(f.metadata, x => { delete x.devDependencies.openclaw; }), /target_not_exact/],
    ["missing lock", f => rm(f.lock), /ENOENT/],
  ];
  for (const [name, mutate, category] of cases) await t.test(name, async t => {
    const f = await fixture(t); await mutate(f);
    await assert.rejects(versionsApi.verifyWorkspaceVersions(f.root, f.versions), category);
    assert.equal(f.versions.consumer, null);
    if (name === "SDK") assert.equal(f.versions.workspaceSdkVersion, "2026.10.7");
  });
});

test("consumer versions require observed manifest, lock, SDK resolution and exact CLI agreement", async t => {
  const f = await consumerFixture(t);
  await versionsApi.verifyConsumerVersions(f.params, f.versions);
  assert.equal(f.versions.consumer.hostVersion, target); assert.equal(f.versions.consumer.corePackageVersion, coreVersion);
  assert.equal(f.versions.consumer.cliHostVersion, null); assert.equal(f.versions.consumer.cliVerified, false);
  versionsApi.verifyConsumerCliVersion(f.versions, `OpenClaw ${target} (abc1234)\n`);
  assert.equal(f.versions.consumer.cliVerified, true);
  for (const output of ["OpenClaw 2026.10.7", "OpenClaw 2026.10.80", `warning: expected ${target}`, `${target}\n2026.10.7`]) {
    assert.throws(() => versionsApi.verifyConsumerCliVersion(f.versions, output), /cli_version_mismatch/);
    assert.equal(f.versions.consumer.cliVerified, false);
  }
  versionsApi.verifyConsumerCliVersion(f.versions, target); assert.equal(f.versions.consumer.cliVerified, true);
  assert.throws(() => versionsApi.assertLegacyProbesMigrated(f.versions), /legacy_probes_not_migrated/);
});

test("consumer mismatch observations survive while verification stays false", async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof consumerFixture>>) => Promise<unknown>, RegExp]> = [
    ["Host manifest", f => change(path.join(f.params.hostRoot, "package.json"), x => { x.version = "2026.8.2"; }), /consumer_host_version_mismatch/],
    ["Host lock", f => change(path.join(f.params.consumer, "package-lock.json"), x => { x.packages["node_modules/openclaw"].version = "2026.8.2"; }), /consumer_lock_host_mismatch/],
    ["Core manifest", f => change(path.join(f.params.packageRoot, "package.json"), x => { x.version = "0.0.1"; }), /consumer_core_version_mismatch/],
    ["Core lock", f => change(path.join(f.params.consumer, "package-lock.json"), x => { x.packages[`node_modules/${coreName}`].version = "0.0.1"; }), /consumer_lock_core_mismatch/],
    ["build", f => change(path.join(f.params.packageRoot, "package.json"), x => { x.openclaw.build.openclawVersion = "2026.8.2"; }), /consumer_build_version_mismatch/],
    ["escaped SDK", async f => { await rm(f.params.hostRoot, { recursive: true }); await hostMetadata(f.params.hostRoot);
      const other = path.join(f.params.packageRoot, "node_modules/openclaw"); await hostMetadata(other); }, /consumer_sdk_root_mismatch/],
  ];
  for (const [name, mutate, category] of cases) await t.test(name, async t => {
    const f = await consumerFixture(t); await mutate(f);
    await assert.rejects(versionsApi.verifyConsumerVersions(f.params, f.versions), category);
    assert.equal(f.versions.consumer.metadataVerified, false); assert.equal(f.versions.consumer.cliVerified, false);
    assert.throws(() => versionsApi.verifyConsumerCliVersion(f.versions, target), /metadata_required/);
  });
});

test("prepared versions bind the target, actual workspace SDK and Core without a prior consumer", async t => {
  const f = await fixture(t); await versionsApi.verifyWorkspaceVersions(f.root, f.versions);
  const prepared = { hostVersion: target, versions: structuredClone(f.versions) };
  versionsApi.assertPreparedVersions(prepared, f.versions);
  for (const key of ["targetHostVersion", "workspaceSdkVersion", "corePackageVersion", "consumer"]) {
    const wrong = structuredClone(prepared); wrong.versions[key] = "old";
    assert.throws(() => versionsApi.assertPreparedVersions(wrong, f.versions), /prepared_versions_mismatch/);
  }
  assert.throws(() => versionsApi.assertPreparedVersions({ hostVersion: "2026.8.2" }, f.versions), /prepared_versions_mismatch/);
  assert.throws(() => versionsApi.assertPreparedVersions({ ...prepared, hostVersion: "2026.8.2" }, f.versions), /prepared_host_version_mismatch/);
});

test("missing target facts cannot pass via matching null observations or asserted success flags", async t => {
  const f = await consumerFixture(t), empty = versionsApi.initialAcceptanceVersions();
  await assert.rejects(versionsApi.verifyConsumerVersions(f.params, empty), /target_not_exact/);
  assert.throws(() => versionsApi.assertPreparedVersions({ hostVersion: null, versions: structuredClone(empty) }, empty), /target_not_exact/);
  empty.consumer = { metadataVerified: true, cliVerified: true, hostVersion: null, cliHostVersion: null };
  assert.throws(() => versionsApi.verifyConsumerCliVersion(empty, "unknown"), /target_not_exact/);
  assert.throws(() => versionsApi.assertLegacyProbesMigrated(empty), /target_not_exact/);
});

test("both real runners preserve truthful failed receipts before any consumer install or Host invocation", async t => {
  for (const runner of ["package-smoke.mjs", "package-experimental-owner-chat.mjs"])
    for (const scenario of runner === "package-smoke.mjs" ? ["pre-install check failure", "SDK mismatch", "old prepared"] : ["pre-install check failure", "SDK mismatch"])
    await t.test(`${runner}: ${scenario}`, async t => {
      const badSdk = scenario === "SDK mismatch";
      const f = await fixture(t);
      await mkdir(path.join(f.root, "scripts"));
      await cp(new URL(`../../scripts/${runner}`, import.meta.url), path.join(f.root, "scripts", runner));
      await cp(new URL("../../scripts/lib", import.meta.url), path.join(f.root, "scripts/lib"), { recursive: true });
      await writeFile(path.join(f.root, ".gitignore"), "node_modules/\n.artifacts/\ndist/\n.test-dist/\n");
      if (badSdk) await change(path.join(f.host, "package.json"), x => { x.version = "2026.10.7"; });
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
      for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "metadata fixture"]])
        await exec("git", args, { cwd: f.root, env: gitEnv });
      const outside = await mkdtemp(path.join(os.tmpdir(), "stella-version-runner-")); t.after(() => rm(outside, { recursive: true, force: true }));
      const calls = path.join(outside, "calls.jsonl"), fakeNpm = path.join(outside, "npm.cjs"), receipt = path.join(outside, "receipt.json");
      await writeFile(fakeNpm, `require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(17);`);
      const preparedDirectory = path.join(outside, "prepared");
      if (scenario === "old prepared") {
        const source = await packageEvidence.sourceIdentity(f.root), trees: Record<string, any> = {};
        for (const name of ["compiled-fixtures", "compiled-build"]) {
          await mkdir(path.join(preparedDirectory, name), { recursive: true });
          await put(path.join(preparedDirectory, name, "build-identity.json"), { coreRevision: source.coreRevision, sourceClean: true });
          trees[name] = await packageEvidence.treeManifest(path.join(preparedDirectory, name));
        }
        await writeFile(path.join(preparedDirectory, "package.tgz"), "synthetic frozen bytes; never installed");
        await put(path.join(preparedDirectory, "prepared.json"), { schemaVersion: "stella.prepared-package/v1", planVersion: PACKAGE_PLAN_VERSION,
          status: "prepared", source, coreRevision: source.coreRevision, sourceManifestSha256: source.digest, hostVersion: "2026.8.2",
          packed: { filename: "package.tgz", files: [] }, artifactSha256: packageEvidence.sha256(await readFile(path.join(preparedDirectory, "package.tgz"))),
          fixtures: trees["compiled-fixtures"], build: trees["compiled-build"], compiledFixtureSha256: trees["compiled-fixtures"].digest,
          compiledBuildSha256: trees["compiled-build"].digest, extracted: { entries: [] } });
      }
      const args = [path.join(f.root, "scripts", runner), ...runner === "package-smoke.mjs"
        ? ["--dreaming-disabled", ...scenario === "old prepared" ? ["--shard", "memory-access", "--prepared", preparedDirectory] : ["--prepare", preparedDirectory]] : []];
      await assert.rejects(exec(process.execPath, args, { cwd: f.root, env: { ...gitEnv, npm_execpath: fakeNpm, STELLA_ACCEPTANCE_RECEIPT_PATH: receipt }, timeout: 30_000 }));
      const result = runner === "package-smoke.mjs" ? await json(receipt)
        : await json(path.join(f.root, ".artifacts/experimental-owner-chat", (await readdir(path.join(f.root, ".artifacts/experimental-owner-chat")))[0]!, "receipt.json"));
      assert.equal(result.status, "failed"); assert.equal(result.versions.targetHostVersion, target);
      assert.equal(result.versions.workspaceSdkVersion, badSdk ? "2026.10.7" : target);
      assert.equal(result.versions.corePackageVersion, coreVersion); assert.equal(result.versions.consumer, null);
      assert.equal(result.hostVersion, badSdk ? null : target); assert.equal(result.fullMemoryAccepted, false);
      if (badSdk) { await assert.rejects(readFile(calls), /ENOENT/); assert.match(result.error, /workspace_sdk_version_mismatch/); }
      else if (scenario === "old prepared") { await assert.rejects(readFile(calls), /ENOENT/); assert.match(result.error, /prepared_versions_mismatch/); }
      else assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["run", "check", "--silent"]]);
      if (runner === "package-smoke.mjs") assert.equal(result.installedArtifactTested, false);
      else assert.equal(result.experimentalOwnerChatAccepted, false);
    });
});
