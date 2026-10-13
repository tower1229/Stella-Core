import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertProbeDreamingDisabled, assertSourceUnchanged,
  fileManifest, installedPackageRoot, sha256, sourceIdentity, treeManifest } from "./lib/package-evidence.mjs";
import { alignHostMemoryEvidence, assertHostMemoryBoundaryReport, assertNativeMemoryConsumptionReport, HOST_MEMORY_BOUNDARY_FLAGS, NATIVE_MEMORY_CONSUMPTION_FLAGS } from "./lib/host-memory-evidence.mjs";

// Formal acceptance for the explicitly Dreaming-disabled profile. No Dreaming
// generator or cron.run is invoked; full_memory remains independently blocked.
assert.deepEqual(process.argv.slice(2), ["--dreaming-disabled"], "Select --dreaming-disabled explicitly");
assert.ok(process.env.npm_execpath, "run package acceptance through npm");
const exec = promisify(execFile);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const hostVersion = "2026.8.2";
const source = await sourceIdentity(root);
const workspaceHost = path.join(root, "node_modules/openclaw");
const workspaceHostBefore = await treeManifest(workspaceHost);
const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-core-package-smoke-")));
process.stderr.write(`Package evidence: ${temp}\n`);
const env = { ...process.env, npm_config_cache: path.join(temp, "npm-cache") };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const run = (command, args, options = {}) => exec(command, args, {
  cwd: root, env, maxBuffer: 24 * 1024 * 1024, ...options,
});
const receipt = {
  schemaVersion: "stella.package-main-smoke/v3", status: "running", evidenceDirectory: temp,
  coreRevision: source.coreRevision, sourceClean: true, sourceManifestSha256: source.digest,
  hostVersion, profile: "dreaming-disabled", dreamingEnabled: false, dreamingExecuted: false,
  installedArtifactTested: false, freshDependencyInstallTested: false,
  transport: "chat.send", fixture: "synthetic", semanticVerdicts: "injected", finalModel: "loopback-synthetic",
  privateRecoveryAccepted: false, realLearningAccepted: false, mixedEvaluationAccepted: false,
  fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false,
  nativeStandaloneCompactionAdmitted: false, checks: [], probes: [],
};
let saving = Promise.resolve();
const save = () => {
  const body = JSON.stringify(receipt, null, 2);
  saving = saving.then(async () => {
    await writeFile(path.join(temp, "package-smoke.json"), body);
    if (process.env.STELLA_ACCEPTANCE_RECEIPT_PATH) {
      const destination = path.resolve(process.env.STELLA_ACCEPTANCE_RECEIPT_PATH);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, body);
    }
  });
  return saving;
};
async function capture(name, command, args, options) {
  try {
    const result = await run(command, args, options);
    await writeFile(path.join(temp, `${name}.stdout`), result.stdout);
    await writeFile(path.join(temp, `${name}.stderr`), result.stderr);
    return result;
  } catch (error) {
    await writeFile(path.join(temp, `${name}.stdout`), error.stdout ?? "");
    await writeFile(path.join(temp, `${name}.stderr`), error.stderr ?? "");
    throw error;
  }
}
const npm = (name, args, options) => capture(name, process.execPath, [process.env.npm_execpath, ...args], options);
await writeFile(path.join(temp, "source-manifest.json"), JSON.stringify(source, null, 2));
await writeFile(path.join(temp, "workspace-host-before.json"), JSON.stringify(workspaceHostBefore, null, 2));
await save();
let artifact, fixtures, build, hostRoot, hostBefore, packageRoot, installed, dependencies, lockSha256, failure;
try {
  for (const script of ["check", "check:schemas", "test"]) {
    process.stderr.write(`Verify ${script}\n`);
    await npm(script.replaceAll(":", "-"), ["run", script, "--silent"]);
    receipt.checks.push({ script, passed: true });
    await save();
  }
  await assertSourceUnchanged(root, source);
  fixtures = await treeManifest(path.join(root, ".test-dist"));
  build = await treeManifest(path.join(root, "dist"));
  for (const directory of [".test-dist", "dist"]) {
    assert.deepEqual(JSON.parse(await readFile(path.join(root, directory, "build-identity.json"), "utf8")),
      { coreRevision: source.coreRevision, sourceClean: true }, "Compiled artifact has another source identity");
  }
  receipt.compiledFixtureSha256 = fixtures.digest;
  receipt.compiledBuildSha256 = build.digest;
  await writeFile(path.join(temp, "compiled-fixtures.json"), JSON.stringify(fixtures, null, 2));
  await writeFile(path.join(temp, "compiled-build.json"), JSON.stringify(build, null, 2));
  const [packed] = JSON.parse((await npm("pack", ["pack", "--json", "--pack-destination", temp])).stdout);
  assert.ok(packed?.filename && Array.isArray(packed.files), "npm pack manifest missing");
  const files = packed.files.map(entry => entry.path);
  for (const required of ["dist/src/plugin.js", "dist/src/openclaw/completion-admission.js",
    "dist/src/openclaw/initialization.js", "dist/src/openclaw/initialization-registration.js",
    "dist/src/openclaw/initialization-source.js", "dist/src/openclaw/initialization-templates.js",
    "dist/src/openclaw/initialization-context.js", "dist/src/openclaw/archive-retention-registration.js",
    "dist/src/openclaw/host-memory.js",
    "dist/src/canghai/archive-cleanup.js", "dist/src/canghai/ingest-progress.js",
    "dist/src/openclaw/fragment-read-tool.js",
    "dist/src/openclaw/native-memory-reader.js", "dist/src/canghai/native-memory-origin.js",
    "dist/src/canghai/host-request-archive.js", "dist/src/canghai/source-output.js", "dist/src/canghai/source-interpretation.js", "dist/src/canghai/source-policy-migration.js", "dist/src/canghai/source-segments.js", "dist/src/canghai/semantic-retrieval.js", "dist/src/learning/host-correction.js", "dist/src/learning/correction.js",
    "dist/src/acceptance/exact-host-chat.js", "dist/src/acceptance/question-evaluation-answer.js",
    "dist/src/acceptance/alpha-candidate.js", "dist/src/acceptance/model-praxis-evaluator.js",
    "dist/src/acceptance/recovery-drill.js", "dist/src/acceptance/capability-receipt.js",
    "dist/src/openclaw/host-history-compaction.js", "dist/src/openclaw/host-memory-provider.js", "dist/src/openclaw/host-memory-inventory.js",
    "dist/src/openclaw/host-context-engine.js", "dist/src/openclaw/host-context-authority.js",
    "dist/src/openclaw/host-context-graph.js", "dist/src/canghai/view-recipe.js",
    "dist/src/openclaw/host-context-history.js", "dist/src/openclaw/host-context-keys.js",
    "dist/src/openclaw/host-context-head.js",
    "dist/src/openclaw/host-context-turn-store.js", "dist/src/openclaw/host-context-prompt.js", "dist/src/openclaw/host-context-replay.js",
    "dist/src/acceptance/capability-acceptance.js", "dist/src/openclaw/capability-admission.js",
    "openclaw.plugin.json",
    "schemas/consciousness-manifest.schema.json", "evaluation/praxis-social.synthetic.json"]) {
    assert.ok(files.includes(required), `packed plugin missing ${required}`);
  }
  assert.ok(!files.some((file) => file.startsWith("tests/") || file.startsWith("dist/tests/") ||
    file.startsWith(".artifacts/") || file.includes("CangHai")), "package contains test/private paths");
  artifact = path.join(temp, packed.filename);
  const artifactBytes = await readFile(artifact);
  receipt.artifactSha256 = sha256(artifactBytes);
  receipt.packageIntegrity = packed.integrity;
  assert.equal(`sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`, packed.integrity);
  await capture("extract", "tar", ["-xzf", artifact, "-C", temp]);
  const extracted = await fileManifest(path.join(temp, "package"), files);
  // npm may normalize package.json; every runtime byte must match the build.
  assert.deepEqual(await fileManifest(root, files.filter(file => file !== "package.json")),
    await fileManifest(path.join(temp, "package"), files.filter(file => file !== "package.json")));
  assert.deepEqual(JSON.parse(await readFile(path.join(temp, "package/package.json"), "utf8")),
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  receipt.packagedFilesSha256 = extracted.digest;
  await writeFile(path.join(temp, "packaged-files.json"), JSON.stringify(extracted, null, 2));
  const consumer = path.join(temp, "consumer");
  // mkdtemp owns this previously nonexistent consumer, outside the source tree.
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  process.stderr.write("Fresh consumer install (registry dependencies, lifecycle scripts disabled)\n");
  await npm("install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", artifact, `openclaw@${hostVersion}`], { cwd: consumer });
  packageRoot = await installedPackageRoot(consumer, "@tower1229/stella-core");
  hostRoot = await installedPackageRoot(consumer, "openclaw");
  assert.equal(JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8")).version, hostVersion);
  assert.deepEqual(await fileManifest(packageRoot, files), extracted, "Installed package differs from the one tarball");
  const locked = JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
  assert.equal(locked.packages["node_modules/@tower1229/stella-core"].integrity, packed.integrity);
  assert.equal(locked.packages["node_modules/openclaw"].version, hostVersion);
  receipt.hostPackageIntegrity = locked.packages["node_modules/openclaw"].integrity;
  // --ignore-scripts leaves OpenClaw's published pending marker. Its public
  // launcher owns deferred installation; finish it before freezing consumers.
  // Every other installed Host byte must stay exactly as npm delivered it.
  const hostInstalled = await treeManifest(hostRoot);
  await writeFile(path.join(temp, "host-installed-before-lifecycle.json"), JSON.stringify(hostInstalled, null, 2));
  const version = await capture("host-install-lifecycle", process.execPath, [path.join(hostRoot, "openclaw.mjs"), "--version"], {
    cwd: consumer, env: { ...env, OPENCLAW_STATE_DIR: path.join(temp, "installation-state"),
      OPENCLAW_CONFIG_PATH: path.join(temp, "installation-state/openclaw.json") },
  });
  assert.ok(version.stdout.includes(hostVersion), "Installed Host launcher version mismatch");
  const hostReady = await treeManifest(hostRoot);
  assert.deepEqual(hostReady.entries, hostInstalled.entries.filter(file => file.path !== ".openclaw-lifecycle-pending"),
    "Host installation changed files beyond its lifecycle marker");
  receipt.hostDeferredLifecycleCompleted = true;
  receipt.hostCodeUnchangedDuringInstall = true;
  receipt.hostVersionOutput = version.stdout.trim();
  lockSha256 = sha256(await readFile(path.join(consumer, "package-lock.json")));
  receipt.consumerLockSha256 = lockSha256;
  const require = createRequire(path.join(packageRoot, "package.json"));
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  receipt.dependencyResolution = [];
  for (const name of [...Object.keys(metadata.dependencies), "openclaw/plugin-sdk/plugin-entry"]) {
    const resolved = await realpath(require.resolve(name));
    assert.ok(resolved.startsWith(`${consumer}/node_modules/`), `Dependency escaped the fresh consumer: ${name}`);
    receipt.dependencyResolution.push({ name, path: path.relative(consumer, resolved), sha256: sha256(await readFile(resolved)) });
  }
  installed = await treeManifest(packageRoot);
  hostBefore = await treeManifest(hostRoot);
  dependencies = await treeManifest(path.join(consumer, "node_modules"));
  receipt.installedArtifactTested = true;
  receipt.freshDependencyInstallTested = true;
  receipt.installScriptsEnabled = false;
  receipt.installedPackageTreeSha256 = installed.digest;
  receipt.hostTreeSha256 = hostBefore.digest;
  receipt.dependencyTreeSha256 = dependencies.digest;
  await writeFile(path.join(temp, "installed-package.json"), JSON.stringify(installed, null, 2));
  await writeFile(path.join(temp, "host-before.json"), JSON.stringify(hostBefore, null, 2));
  await writeFile(path.join(temp, "dependencies-before.json"), JSON.stringify(dependencies, null, 2));
  await save();
  const probeEnv = { ...env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot,
    STELLA_NATIVE_ACTIVE_EVIDENCE: "", STELLA_NATIVE_DREAMING_EVIDENCE: "",
    STELLA_CONTEXT_FAIL_PERSISTENCE: "0", STELLA_CONTEXT_NATIVE_CONTROL: "0" };
  async function probe(name, script, args = [], extraEnv = {}, validate = () => {}) {
    process.stderr.write(`Packed probe: ${name}\n`);
    try {
      const result = await capture(name, process.execPath, [path.join(root, "scripts", script), ...args],
        { cwd: consumer, env: { ...probeEnv, ...extraEnv } });
      const report = JSON.parse(result.stdout);
      assert.equal(report.host ?? report.hostVersion, hostVersion);
      await assertProbeDreamingDisabled(report);
      validate(report);
      receipt.probes.push({ flag: name, passed: true, coreRevision: source.coreRevision, artifactSha256: receipt.artifactSha256, report });
      await save();
      return report;
    } catch (error) {
      receipt.probes.push({ flag: name, passed: false, error: String(error.message ?? error) });
      await save();
      throw error;
    }
  }
  const active = await probe("native-active-memory-artifact", "probe-native-active-memory.mjs", [], {}, report => {
    assert.equal(report.scope, "native-artifact-generation");
    assert.equal(report.nativeReadExecuted, true);
    assert.equal(report.nativeSummaryInjected, true);
    assert.equal(report.stellaReinjectionVerified, false);
    assert.equal(report.dreamingEnabled, false);
    assert.equal(report.memoryCoreEnabled, true);
  });
  const nativeProducers = await probe("native-memory-producers", "probe-native-memory-producers.mjs", [], {}, report => {
    assert.equal(report.nativeSessionNewExecuted, true); assert.equal(report.nativeWikiIngestExecuted, true);
    assert.equal(report.nativeWikiCompileExecuted, true); assert.equal(report.stellaConsumptionVerified, false);
    assert.equal(report.nativeCompiledClaimRead, true);
  });
  await probe("main-native-artifact-active-memory", "probe-main-plugin.mjs",
    ["--native-artifact", path.join(active.evidenceDirectory, "native-active-memory.json")], {}, report => {
      assert.equal(report.providerRequests, 0); assert.equal(report.finalAnswers, 0);
      assert.equal(report.persistence.finalInputRejected, true);
      assert.equal(report.persistence.generationArtifactSha256, active.artifactSha256);
      assert.equal(report.persistence.entry, "before_prompt_build.prependContext");
      assert.equal(report.persistence.hostFallbackRejected, true);
    });
  for (const mode of ["history", "persistence-failure", "native-control", "native-reinjection"]) {
    await probe(`managed-context-${mode}`, "probe-managed-host-context.mjs", [], {
      STELLA_CONTEXT_FAIL_PERSISTENCE: mode === "persistence-failure" ? "1" : "0",
      STELLA_CONTEXT_NATIVE_CONTROL: mode === "native-control" ? "1" : "0",
      STELLA_NATIVE_ACTIVE_EVIDENCE: mode === "native-reinjection" ? active.evidenceDirectory : "",
    }, report => {
      assert.equal(report.productionMainVerified, false);
      assert.equal(report.otherAgentHistoryConsumed, true); assert.equal(report.otherAgentCompactionConsumed, true);
      if (mode === "history") {
        assert.equal(report.nextTurnHistoryConsumed, true);
        assert.equal(report.durabilityScope, "synthetic-local-git-remote");
        assert.equal(report.productionRecoveryPointerVerified, false);
      }
      if (mode === "persistence-failure") assert.equal(report.historyPersistenceFailureBlocked, true);
      if (mode === "native-control") assert.equal(report.scope, "native-context-control");
      if (mode === "native-reinjection") {
        assert.equal(report.nativeArtifactRejected, true); assert.equal(report.nativeArtifactSha256, active.artifactSha256);
        assert.equal(report.nativeArtifactKind, "active-memory-recall");
      }
    });
  }
  const flags = ["--managed-context", "--managed-business-failure", "--guarded-active-memory", "--guarded-active-memory-stale",
    "--guarded-provider", "--guarded-payload-transform", "--guarded-semantic", "--guarded-provider-stale",
    "--initialization", "--fragment-skill", "--correction", "--correction-recovery", "--correction-output-rejected",
    "--admission-replay", "--cancel", "--cancel-preparation", "--managed", "--advice-revision", "--outcome", "--question-recovery",
    "--advice-evidence-recovery", "--advice-revision-recovery", "--outcome-recovery", "--outcome-history-recovery",
    "--standalone-compact", "--standalone-compact-stale", "--standalone-compact-grant-denied", "--standalone-compact-persist-failure",
    "--history-view-followup", "--source-deletion-history", "--completion-lifecycle", "--completion-status-changed", ...HOST_MEMORY_BOUNDARY_FLAGS,
    ...NATIVE_MEMORY_CONSUMPTION_FLAGS];
  // Each probe owns its Host state and synthetic repositories. Never repack or
  // rebuild while any installed-package consumer is running. Preserve failures.
  let probeFailure;
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: 2 }, async () => {
    while (next < flags.length) {
      const flag = flags[next++];
      const name = flag === "--outcome-recovery" ? "outcome-recovery-unbound-history" : flag.slice(2);
      try {
        await probe(name, "probe-main-plugin.mjs", [flag], {
          STELLA_NATIVE_PRODUCERS_REPORT: path.join(nativeProducers.evidenceDirectory, "native-memory-producers.json"),
        }, report => {
          if (HOST_MEMORY_BOUNDARY_FLAGS.includes(flag)) assertHostMemoryBoundaryReport(report, flag);
          if (NATIVE_MEMORY_CONSUMPTION_FLAGS.includes(flag)) assertNativeMemoryConsumptionReport(report, flag);
          if (flag === "--outcome-recovery") {
            assert.equal(report.persistence.recovery.blocked, true);
            assert.equal(report.persistence.recovery.pendingTransactionPreserved, true);
            assert.equal(report.persistence.recovery.modelRequests, 0);
            assert.equal(report.persistence.recovery.replyResent, false);
          }
          if (flag === "--outcome-history-recovery") {
            assert.equal(report.outcomeHistory.recovery.signedPlanBound, true);
            assert.equal(report.outcomeHistory.recovery.bootstrapReverified, true);
            assert.equal(report.outcomeHistory.recovery.modelRequests, 0);
            assert.equal(report.outcomeHistory.followup.answer, "SYNTHETIC_MAIN_ANSWER");
          }
        });
      } catch (error) { probeFailure ??= error; }
    }
  }));
  for (const result of workers) if (result.status === "rejected") probeFailure ??= result.reason;
  const finalProbes = await Promise.allSettled([
    probe("capability-acceptance", "probe-capability-acceptance.mjs", [], {}, report => {
      assert.equal(report.capabilityId, "host_initialization"); assert.equal(report.clearedOneBlocker, true);
      assert.equal(report.businessAdmission, false); assert.equal(report.invalidated, true); assert.equal(report.visitorDenied, true);
      assert.equal(report.hostMemoryConsumption, "blocked_unverifiable"); assert.equal(report.modelCalls, 0);
    }),
    probe("archive-retention", "probe-archive-retention.mjs", [], {}, report => {
      assert.equal(report.sourceRevision, source.coreRevision); assert.equal(report.sourceClean, true);
      assert.equal(report.installedArtifactTested, true); assert.equal(report.probes.length, 8);
    }),
  ]);
  for (const result of finalProbes) if (result.status === "rejected") probeFailure ??= result.reason;
  if (probeFailure) throw probeFailure;
  const declarations = await import(pathToFileURL(path.join(packageRoot, "dist/src/openclaw/host-memory-inventory.js")).href);
  receipt.hostMemoryEvidence = alignHostMemoryEvidence({ nativeEntrances: declarations.HOST_NATIVE_MEMORY_ENTRANCES,
    pluginIds: declarations.HOST_MEMORY_PLUGIN_IDS, probes: receipt.probes,
    coreRevision: source.coreRevision, artifactSha256: receipt.artifactSha256 });
  await writeFile(path.join(temp, "host-memory-alignment.json"), JSON.stringify(receipt.hostMemoryEvidence, null, 2));
  receipt.status = "passed";
} catch (error) {
  failure = error;
  receipt.status = "failed";
  receipt.error = String(error.message ?? error);
} finally {
  // A green probe cannot conceal a changed source, package, dependency or Host.
  const recordTree = async (name, base, expected) => {
    const after = await treeManifest(base);
    await writeFile(path.join(temp, `${name}-after.json`), JSON.stringify(after, null, 2));
    assert.equal(after.digest, expected.digest, `${name} changed during acceptance`);
  };
  const checks = [
    ["sourceUnchanged", async () => {
      await assertSourceUnchanged(root, source);
      await writeFile(path.join(temp, "source-after.json"), JSON.stringify(await sourceIdentity(root), null, 2));
    }],
    ["workspaceHostUnchanged", () => recordTree("workspace-host", workspaceHost, workspaceHostBefore)],
  ];
  if (fixtures) checks.push(["fixturesUnchanged", () => recordTree("compiled-fixtures", path.join(root, ".test-dist"), fixtures)]);
  if (build) checks.push(["buildUnchanged", () => recordTree("compiled-build", path.join(root, "dist"), build)]);
  if (artifact) checks.push(["artifactUnchanged", async () => assert.equal(sha256(await readFile(artifact)), receipt.artifactSha256, "Package bytes changed")]);
  if (installed) checks.push(["installedPackageUnchanged", () => recordTree("installed-package", packageRoot, installed)]);
  if (hostBefore) checks.push(["hostUnchanged", () => recordTree("host", hostRoot, hostBefore)]);
  if (dependencies) checks.push(["dependenciesUnchanged", () => recordTree("dependencies", path.join(temp, "consumer/node_modules"), dependencies)]);
  if (lockSha256) checks.push(["consumerLockUnchanged", async () => assert.equal(sha256(await readFile(path.join(temp, "consumer/package-lock.json"))), lockSha256, "Consumer lock changed")]);
  for (const [name, check] of checks) {
    try { await check(); receipt[name] = true; }
    catch (error) { receipt[name] = false; receipt.status = "failed"; receipt.error ??= String(error.message ?? error); failure ??= error; }
  }
  await save();
}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (failure) { process.stderr.write(`${receipt.error}\n`); process.exitCode = 1; }
