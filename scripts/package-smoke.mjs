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
  "dist/src/acceptance/exact-host-chat.js", "dist/src/acceptance/question-evaluation-answer.js",
  "dist/src/acceptance/alpha-candidate.js", "dist/src/acceptance/model-praxis-evaluator.js",
  "dist/src/acceptance/recovery-drill.js", "openclaw.plugin.json",
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
for (const flag of ["--admission-replay", "--cancel", "--cancel-preparation", "--managed", "--advice-revision", "--outcome", "--question-recovery",
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
