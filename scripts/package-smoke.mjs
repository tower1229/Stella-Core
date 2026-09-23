import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const hostVersion = "2026.8.2";
const run = (command, args, options = {}) => exec(command, args, {
  cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024, ...options,
});
assert.ok(process.env.npm_execpath, "run package acceptance through npm");
const coreRevision = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
assert.equal((await run("git", ["status", "--porcelain"])).stdout.trim(), "",
  "package acceptance requires a clean Core source; use an isolated committed snapshot for in-progress changes");
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-core-package-smoke-"));
// Retain artifact, consumer and receipts for audit. Never use a personal repository.
process.stderr.write(`Package evidence: ${temp}\n`);
const npm = (args, options) => run(process.execPath, [process.env.npm_execpath, ...args], options);
const [packed] = JSON.parse((await npm(["pack", "--json", "--pack-destination", temp])).stdout);
assert.ok(packed?.filename && Array.isArray(packed.files), "npm pack manifest missing");
const files = packed.files.map((entry) => entry.path);
for (const required of ["dist/src/plugin.js", "dist/src/openclaw/completion-admission.js",
  "dist/src/openclaw/initialization.js", "dist/src/openclaw/initialization-registration.js",
  "dist/src/openclaw/initialization-source.js", "dist/src/openclaw/initialization-templates.js",
  "dist/src/openclaw/initialization-context.js", "dist/src/openclaw/archive-retention-registration.js",
  "dist/src/openclaw/host-memory.js",
  "dist/src/canghai/archive-cleanup.js", "dist/src/canghai/ingest-progress.js",
  "dist/src/openclaw/fragment-read-tool.js",
  "dist/src/canghai/host-request-archive.js", "dist/src/canghai/source-output.js", "dist/src/canghai/source-interpretation.js", "dist/src/canghai/source-policy-migration.js", "dist/src/canghai/source-segments.js", "dist/src/canghai/semantic-retrieval.js", "dist/src/learning/host-correction.js", "dist/src/learning/correction.js",
  "dist/src/acceptance/exact-host-chat.js", "dist/src/acceptance/question-evaluation-answer.js",
  "dist/src/acceptance/alpha-candidate.js", "dist/src/acceptance/model-praxis-evaluator.js",
  "dist/src/acceptance/recovery-drill.js", "dist/src/acceptance/capability-receipt.js",
  "dist/src/openclaw/host-memory-provider.js", "dist/src/openclaw/host-memory-inventory.js",
  "dist/src/openclaw/host-context-engine.js", "dist/src/openclaw/host-context-authority.js",
  "dist/src/openclaw/host-context-graph.js", "dist/src/canghai/view-recipe.js",
  "dist/src/openclaw/host-context-history.js", "dist/src/openclaw/host-context-keys.js",
  "dist/src/openclaw/host-context-head.js",
  "dist/src/openclaw/host-context-turn-store.js", "dist/src/openclaw/host-context-prompt.js",
  "dist/src/acceptance/capability-acceptance.js", "dist/src/openclaw/capability-admission.js",
  "openclaw.plugin.json",
  "schemas/consciousness-manifest.schema.json", "evaluation/praxis-social.synthetic.json"]) {
  assert.ok(files.includes(required), `packed plugin missing ${required}`);
}
assert.ok(!files.some((file) => file.startsWith("tests/") || file.startsWith("dist/tests/") ||
  file.startsWith(".artifacts/") || file.includes("CangHai")), "package contains test/private paths");
const artifact = path.join(temp, packed.filename);
const artifactSha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
const consumer = path.join(temp, "consumer");
await mkdir(consumer);
await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", artifact, `openclaw@${hostVersion}`], { cwd: consumer });
const packageRoot = path.join(consumer, "node_modules/@tower1229/stella-core");
const hostRoot = path.join(consumer, "node_modules/openclaw");
assert.equal(JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8")).version, hostVersion);
const probes = [];
process.stderr.write("Native Active Memory artifact probe\n");
const nativeActiveProbe = await run(process.execPath, [path.join(root, "scripts/probe-native-active-memory.mjs")], {
  cwd: consumer,
  env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot },
});
const nativeActiveReport = JSON.parse(nativeActiveProbe.stdout);
assert.equal(nativeActiveReport.hostVersion, hostVersion);
assert.equal(nativeActiveReport.scope, "native-artifact-generation");
assert.equal(nativeActiveReport.nativeReadExecuted, true);
assert.equal(nativeActiveReport.nativeSummaryInjected, true);
assert.equal(nativeActiveReport.stellaReinjectionVerified, false);
probes.push({ flag: "--native-active-memory-artifact", report: nativeActiveReport });
process.stderr.write("Native Dreaming artifact probe\n");
const nativeDreamingProbe = await run(process.execPath, [path.join(root, "scripts/probe-native-dreaming.mjs")], {
  cwd: consumer,
  env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot },
});
const nativeDreamingReport = JSON.parse(nativeDreamingProbe.stdout);
assert.equal(nativeDreamingReport.hostVersion, hostVersion);
assert.equal(nativeDreamingReport.scope, "native-artifact-generation");
assert.equal(nativeDreamingReport.nativeCronExecuted, true);
assert.equal(nativeDreamingReport.nativeNarrativeExecuted, true);
assert.equal(nativeDreamingReport.nativeSourceRead, true);
assert.equal(nativeDreamingReport.stellaReinjectionVerified, false);
probes.push({ flag: "--native-dreaming-artifact", report: nativeDreamingReport });
await writeFile(path.join(temp, "probes.json"), JSON.stringify(probes, null, 2));
for (const [kind, generated, file] of [
  ["active-memory", nativeActiveReport, "native-active-memory.json"],
  ["dreaming", nativeDreamingReport, "native-dreaming.json"],
]) {
  process.stderr.write(`Packed main native artifact replay: ${kind}\n`);
  const result = await run(process.execPath, [path.join(root, "scripts/probe-main-plugin.mjs"), "--native-artifact",
    path.join(generated.evidenceDirectory, file)], {
    cwd: consumer,
    env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot },
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.host, hostVersion);
  assert.equal(report.providerRequests, 0);
  assert.equal(report.finalAnswers, 0);
  assert.equal(report.persistence.finalInputRejected, true);
  assert.equal(report.persistence.generationArtifactSha256, generated.artifactSha256);
  assert.equal(report.persistence.entry, kind === "active-memory" ? "before_prompt_build.prependContext" : "before_prompt_build.appendSystemContext");
  if (kind === "active-memory") assert.equal(report.persistence.hostFallbackRejected, true);
  probes.push({ flag: `--main-native-artifact-${kind}`, report });
  await writeFile(path.join(temp, "probes.json"), JSON.stringify(probes, null, 2));
}
for (const mode of ["history", "persistence-failure", "native-control", "native-reinjection", "dreaming-reinjection"]) {
  process.stderr.write(`Packed managed context seam: ${mode}\n`);
  const result = await run(process.execPath, [path.join(root, "scripts/probe-managed-host-context.mjs")], {
    cwd: consumer,
    env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot,
      STELLA_CONTEXT_FAIL_PERSISTENCE: mode === "persistence-failure" ? "1" : "0",
      STELLA_CONTEXT_NATIVE_CONTROL: mode === "native-control" ? "1" : "0",
      STELLA_NATIVE_ACTIVE_EVIDENCE: mode === "native-reinjection" ? nativeActiveReport.evidenceDirectory : "",
      STELLA_NATIVE_DREAMING_EVIDENCE: mode === "dreaming-reinjection" ? nativeDreamingReport.evidenceDirectory : "" },
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.hostVersion, hostVersion);
  assert.equal(report.productionMainVerified, false);
  assert.equal(report.otherAgentHistoryConsumed, true);
  assert.equal(report.otherAgentCompactionConsumed, true);
  if (mode === "history") {
    assert.equal(report.nextTurnHistoryConsumed, true);
    assert.equal(report.durabilityScope, "synthetic-local-git-remote");
    assert.equal(report.productionRecoveryPointerVerified, false);
  }
  if (mode === "persistence-failure") assert.equal(report.historyPersistenceFailureBlocked, true);
  if (mode === "native-control") assert.equal(report.scope, "native-context-control");
  if (mode === "native-reinjection") {
    assert.equal(report.nativeArtifactRejected, true);
    assert.equal(report.nativeArtifactSha256, nativeActiveReport.artifactSha256);
    assert.equal(report.nativeArtifactKind, "active-memory-recall");
  }
  if (mode === "dreaming-reinjection") {
    assert.equal(report.nativeArtifactRejected, true);
    assert.equal(report.nativeArtifactSha256, nativeDreamingReport.artifactSha256);
    assert.equal(report.nativeArtifactKind, "dreaming-diary");
  }
  probes.push({ flag: `--managed-context-${mode}`, report });
  await writeFile(path.join(temp, "probes.json"), JSON.stringify(probes, null, 2));
}
for (const flag of ["--managed-context", "--managed-business-failure", "--guarded-active-memory", "--guarded-dreaming", "--guarded-provider", "--guarded-payload-transform", "--guarded-semantic", "--guarded-provider-stale", "--initialization", "--fragment-skill", "--correction", "--correction-recovery", "--correction-output-rejected", "--admission-replay", "--cancel", "--cancel-preparation", "--managed", "--advice-revision", "--outcome", "--question-recovery",
  "--advice-evidence-recovery", "--advice-revision-recovery", "--outcome-recovery"]) {
  process.stderr.write(`Packed main probe: ${flag}\n`);
  const result = await run(process.execPath, [path.join(root, "scripts/probe-main-plugin.mjs"), flag], {
    cwd: consumer,
    env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot },
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.host, hostVersion);
  probes.push({ flag, report });
  await writeFile(path.join(temp, "probes.json"), JSON.stringify(probes, null, 2));
}
process.stderr.write("Packed capability acceptance probe\n");
const capabilityProbe = await run(process.execPath, [path.join(root, "scripts/probe-capability-acceptance.mjs")], {
  cwd: consumer,
  env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot },
});
const capabilityReport = JSON.parse(capabilityProbe.stdout);
assert.equal(capabilityReport.host, hostVersion);
assert.equal(capabilityReport.capabilityId, "host_initialization");
assert.equal(capabilityReport.clearedOneBlocker, true);
assert.equal(capabilityReport.businessAdmission, false);
assert.equal(capabilityReport.invalidated, true);
assert.equal(capabilityReport.visitorDenied, true);
assert.equal(capabilityReport.hostMemoryConsumption, "blocked_unverifiable");
assert.equal(capabilityReport.modelCalls, 0);
probes.push({ flag: "--capability-acceptance", report: capabilityReport });
await writeFile(path.join(temp, "probes.json"), JSON.stringify(probes, null, 2));
process.stderr.write("Packed archive retention probe\n");
const archiveProbe = await run(process.execPath, [path.join(root, "scripts/probe-archive-retention.mjs")], {
  cwd: consumer,
  env: { ...process.env, STELLA_PROBE_PACKAGE_ROOT: packageRoot, STELLA_PROBE_HOST_ROOT: hostRoot },
});
const archiveReport = JSON.parse(archiveProbe.stdout);
assert.equal(archiveReport.hostVersion, hostVersion);
assert.equal(archiveReport.sourceRevision, coreRevision);
assert.equal(archiveReport.sourceClean, true);
assert.equal(archiveReport.installedArtifactTested, true);
assert.equal(archiveReport.probes.length, 8);
probes.push({ flag: "--archive-retention", report: archiveReport });
await writeFile(path.join(temp, "probes.json"), JSON.stringify(probes, null, 2));
const receipt = {
  schemaVersion: "stella.package-main-smoke/v2", coreRevision, sourceClean: true,
  artifactSha256, packageIntegrity: packed.integrity, hostVersion,
  installedArtifactTested: true, transport: "chat.send", fixture: "synthetic",
  semanticVerdicts: "injected", finalModel: "loopback-synthetic",
  privateRecoveryAccepted: false, realLearningAccepted: false, mixedEvaluationAccepted: false,
  probes,
};
await writeFile(path.join(temp, "package-smoke.json"), JSON.stringify(receipt, null, 2));
if (process.env.STELLA_ACCEPTANCE_RECEIPT_PATH) {
  const destination = path.resolve(process.env.STELLA_ACCEPTANCE_RECEIPT_PATH);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(receipt, null, 2));
}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
