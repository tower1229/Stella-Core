import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseRequiredArguments } from "./lib/cli-args.mjs";
import {
  buildExactHostAgentArguments,
  parseExactHostAgentOutput,
} from "../dist/src/acceptance/exact-host-agent.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostVersion = "2026.8.2";

const options = parseRequiredArguments(
  process.argv.slice(2),
  ["canghai-root", "canghai-revision", "artifact", "adapter", "output"],
  "Usage: --canghai-root <path> --canghai-revision <sha> --artifact <tgz> --adapter <module> --output <json>",
);

async function inspectCleanSource(label, root, expectedRevision) {
  if (!/^[0-9a-f]{40}$/i.test(expectedRevision)) {
    throw new Error(`${label} revision must be a full Git commit SHA`);
  }
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", root, "status", "--porcelain"]),
  ]);
  if (revision.trim() !== expectedRevision) throw new Error(`${label} HEAD does not match revision`);
  if (status.trim()) throw new Error(`${label} source must be clean`);
}

async function hashFile(filePath) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0) throw new Error("Recovery artifact must be non-empty");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

const canghaiRoot = path.resolve(options["canghai-root"]);
const artifactPath = path.resolve(options.artifact);
const adapterPath = path.resolve(options.adapter);
const outputPath = path.resolve(options.output);
const outputRelative = path.relative(projectRoot, outputPath);
if (!outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) {
  throw new Error("Private recovery receipt must be written outside Stella Core");
}
const { stdout: coreRevisionOutput } = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"]);
const coreRevision = coreRevisionOutput.trim();
await Promise.all([
  inspectCleanSource("Core", projectRoot, coreRevision),
  inspectCleanSource("CangHai", canghaiRoot, options["canghai-revision"]),
]);
const artifactSha256 = await hashFile(artifactPath);

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "stella-private-recovery-"));
try {
  if ((await readdir(isolatedRoot)).length !== 0) {
    throw new Error("Private recovery runtime must start empty");
  }
  const consumerRoot = path.join(isolatedRoot, "consumer");
  const runtimeStateRoot = path.join(isolatedRoot, "openclaw-state");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "stella-private-recovery", private: true })}\n`,
  );
  await execFileAsync("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    artifactPath,
    `openclaw@${hostVersion}`,
  ], { cwd: consumerRoot });
  const openclawBin = path.join(consumerRoot, "node_modules/.bin/openclaw");
  const hostEnv = { OPENCLAW_STATE_DIR: runtimeStateRoot };
  const { stdout: versionOutput } = await execFileAsync(openclawBin, ["--version"], {
    cwd: consumerRoot,
    env: { ...process.env, ...hostEnv },
  });
  const versionMatch = /^OpenClaw ([^ ]+)/u.exec(versionOutput.trim());
  if (versionMatch?.[1] !== hostVersion) {
    throw new Error(`Private recovery requires exact OpenClaw ${hostVersion}`);
  }
  await execFileAsync(openclawBin, [
    "plugins",
    "install",
    artifactPath,
    "--force",
    "--accept-capabilities",
  ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
  if ((await readdir(runtimeStateRoot)).length === 0) {
    throw new Error("Exact Host did not initialize the isolated runtime");
  }
  const adapter = await import(pathToFileURL(adapterPath).href);
  if (typeof adapter.createRecoveryHarness !== "function") {
    throw new Error("Recovery adapter must export createRecoveryHarness(context)");
  }
  const harness = await adapter.createRecoveryHarness({
    artifactPath,
    artifactSha256,
    canghaiRoot,
    canghaiRevision: options["canghai-revision"],
    coreRevision,
    consumerRoot,
    hostEnv,
    hostVersion,
    openclawBin,
    runtimeStateRoot,
  });
  if (
    typeof harness?.rebuild !== "function" ||
    typeof harness?.verifyContinuity !== "function" ||
    !Array.isArray(harness?.probes) ||
    harness.probes.length === 0 ||
    harness.probes.length > 10
  ) {
    throw new Error("Recovery harness must provide rebuild, verifyContinuity, and 1 to 10 probes");
  }
  const probeIds = new Set();
  for (const probe of harness.probes) {
    if (
      typeof probe?.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/u.test(probe.id) ||
      probeIds.has(probe.id) ||
      typeof probe.message !== "string" ||
      !probe.message.trim()
    ) {
      throw new Error("Recovery probes require unique safe IDs and non-empty messages");
    }
    probeIds.add(probe.id);
  }

  const installedRoot = path.join(
    consumerRoot,
    "node_modules",
    "@tower1229",
    "stella-core",
  );
  const installedPlugin = await import(
    `${pathToFileURL(path.join(installedRoot, "dist/src/plugin.js")).href}?private=${Date.now()}`,
  );
  const installedRecovery = await import(
    `${pathToFileURL(path.join(installedRoot, "dist/src/acceptance/recovery-drill.js")).href}?private=${Date.now()}`,
  );
  const observedTurns = [];

  const report = await installedRecovery.runRecoveryDrill({
    canghaiRoot,
    recoveryRevision: options["canghai-revision"],
    coreVersion: installedPlugin.STELLA_CORE_COMPATIBILITY_VERSION,
    hostVersion,
    rebuild: harness.rebuild,
    verifyContinuity: async (input) => {
      for (const probe of harness.probes) {
        const result = await execFileAsync(
          openclawBin,
          buildExactHostAgentArguments({
            agentId: "stella",
            message: probe.message,
            sessionKey: `agent:stella:private-recovery-${probe.id}`,
          }),
          { cwd: consumerRoot, env: { ...process.env, ...hostEnv } },
        );
        if (!result.stdout.trim()) throw new Error(`Exact Host probe ${probe.id} returned no result`);
        observedTurns.push({
          id: probe.id,
          output: parseExactHostAgentOutput(result.stdout, probe.id),
        });
      }
      return harness.verifyContinuity(input, { observedTurns });
    },
  });

  const receipt = {
    schemaVersion: "stella.exact-host-recovery-receipt/v1",
    coreRevision,
    canghaiRevision: options["canghai-revision"],
    hostVersion,
    artifactSha256,
    canghaiFixture: "private",
    cleanRuntimeState: true,
    importedLegacyRuntime: false,
    dataReadable: report.levels.dataReadable,
    cognitiveBootstrapRestored: report.levels.cognitiveBootstrapRestored,
    derivedRuntimeRebuilt: report.levels.derivedRuntimeRebuilt,
    continuityAccepted: report.levels.continuityAccepted,
    identityRestored: report.restored.identity,
    frameworkRestored: report.restored.framework,
    twinRestored: report.restored.twin,
    praxisLearningRestored: report.restored.praxisLearning,
    importantOpenStateRestored: report.restored.importantOpenState,
    exactHostAgentTurns: observedTurns.length,
    privateFixtureIncluded: true,
  };
  const stagingPath = `${outputPath}.${process.pid}.staging`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(stagingPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(stagingPath, outputPath);
  process.stdout.write(`${JSON.stringify({ output: outputPath, ...receipt })}\n`);
} finally {
  await rm(isolatedRoot, { recursive: true, force: true });
}
