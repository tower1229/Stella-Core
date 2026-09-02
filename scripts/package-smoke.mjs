import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exactOpenClawVersion = "2026.8.2";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stella-core-package-smoke-"));
const npmEnv = { ...process.env, NPM_CONFIG_CACHE: path.join(tempRoot, "npm-cache") };
let syntheticCangHaiRoot;
let blockedCangHaiRoot;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? npmEnv,
    maxBuffer: 10 * 1024 * 1024,
  });
}

try {
  const fixtureModuleUrl = pathToFileURL(
    path.join(projectRoot, ".test-dist", "tests", "consciousness-fixture.js"),
  ).href;
  const { createFixture, initializeFixtureRepository, updateFixtureManifest } = await import(
    fixtureModuleUrl
  );
  syntheticCangHaiRoot = await createFixture();
  const syntheticCangHaiRevision = await initializeFixtureRepository(syntheticCangHaiRoot);

  const packResult = await run("npm", [
    "pack",
    "--json",
    "--pack-destination",
    tempRoot,
  ]);
  const packEntries = JSON.parse(packResult.stdout);
  const packEntry = packEntries[0];
  if (!packEntry?.filename || !Array.isArray(packEntry.files)) {
    throw new Error("npm pack did not return a package manifest");
  }
  const packageFiles = packEntry.files.map((entry) => entry.path);
  for (const required of [
    "dist/src/plugin.js",
    "openclaw.plugin.json",
    "schemas/consciousness-manifest.schema.json",
  ]) {
    if (!packageFiles.includes(required)) {
      throw new Error(`packed plugin is missing ${required}`);
    }
  }
  if (
    packageFiles.some(
      (file) => file.startsWith("tests/") || file.startsWith("dist/tests/") || file.includes("CangHai"),
    )
  ) {
    throw new Error("packed plugin contains test or private CangHai paths");
  }

  const archivePath = path.join(tempRoot, packEntry.filename);
  const consumerRoot = path.join(tempRoot, "consumer");
  const stateRoot = path.join(tempRoot, "openclaw-state");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({ name: "stella-core-smoke-consumer", private: true }),
    "utf8",
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archivePath,
      `openclaw@${exactOpenClawVersion}`,
    ],
    { cwd: consumerRoot },
  );

  const openclawBin = path.join(consumerRoot, "node_modules", ".bin", "openclaw");
  const isolatedEnv = { ...npmEnv, OPENCLAW_STATE_DIR: stateRoot };
  const versionResult = await run(openclawBin, ["--version"], {
    cwd: consumerRoot,
    env: isolatedEnv,
  });
  if (!versionResult.stdout.includes(exactOpenClawVersion)) {
    throw new Error(`package smoke used unexpected OpenClaw: ${versionResult.stdout.trim()}`);
  }

  await run(
    openclawBin,
    ["plugins", "install", archivePath, "--force", "--accept-capabilities"],
    {
      cwd: consumerRoot,
      env: isolatedEnv,
    },
  );
  await run(
    openclawBin,
    [
      "config",
      "set",
      "plugins.entries.stella-core.config",
      JSON.stringify({
        canghaiRoot: syntheticCangHaiRoot,
        recoveryRevision: syntheticCangHaiRevision,
        agentId: "stella",
      }),
      "--strict-json",
    ],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  const inspectResult = await run(
    openclawBin,
    ["plugins", "inspect", "stella-core", "--runtime", "--json"],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  const inspected = JSON.parse(inspectResult.stdout);
  const inspectedText = JSON.stringify(inspected);
  if (!inspectedText.includes("stella-core")) {
    throw new Error(`OpenClaw did not load packed Stella Core: ${inspectedText}`);
  }

  const installedRoot = path.join(
    consumerRoot,
    "node_modules",
    "@tower1229",
    "stella-core",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  const installedPlugin = await import(
    `${pathToFileURL(path.join(installedRoot, "dist", "src", "plugin.js")).href}?smoke=${Date.now()}`
  );

  function registerHooks(canghaiRoot, recoveryRevision) {
    const hooks = new Map();
    installedPlugin.default.register({
      pluginConfig: { canghaiRoot, recoveryRevision, agentId: "stella" },
      runtime: { version: exactOpenClawVersion },
      on(name, handler) {
        hooks.set(name, handler);
      },
    });
    return hooks;
  }

  const activeHooks = registerHooks(syntheticCangHaiRoot, syntheticCangHaiRevision);
  const beforeAgentRun = activeHooks.get("before_agent_run");
  const beforePromptBuild = activeHooks.get("before_prompt_build");
  if (!beforeAgentRun || !beforePromptBuild) throw new Error("packed plugin hooks were not registered");
  const targetGate = await beforeAgentRun({}, { agentId: "stella" });
  const targetPrompt = await beforePromptBuild({}, { agentId: "stella" });
  const nonTargetGate = await beforeAgentRun({}, { agentId: "ordinary" });
  const nonTargetPrompt = await beforePromptBuild({}, { agentId: "ordinary" });
  if (
    targetGate?.outcome !== "pass" ||
    typeof targetPrompt?.appendContext !== "string" ||
    !targetPrompt.appendContext.includes(syntheticCangHaiRevision) ||
    nonTargetGate?.outcome !== "pass" ||
    nonTargetPrompt !== undefined
  ) {
    throw new Error("packed target injection or non-target bypass acceptance failed");
  }

  blockedCangHaiRoot = await createFixture();
  await updateFixtureManifest(blockedCangHaiRoot, (manifest) =>
    manifest.replace("activationStatus: active", "activationStatus: migration_required"),
  );
  const blockedRevision = await initializeFixtureRepository(blockedCangHaiRoot);
  const blockedHooks = registerHooks(blockedCangHaiRoot, blockedRevision);
  const blockedGate = await blockedHooks.get("before_agent_run")({}, { agentId: "stella" });
  if (blockedGate?.category !== "stella_migration_required") {
    throw new Error("packed migration-required gate did not fail closed");
  }

  const coreRevision = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const coreSourceStatus = (await run("git", ["status", "--porcelain"])).stdout.trim();
  const canghaiSourceStatus = (
    await run("git", ["-C", syntheticCangHaiRoot, "status", "--porcelain"])
  ).stdout.trim();
  const receipt = {
    package: `${installedPackage.name}@${installedPackage.version}`,
    packageIntegrity: packEntry.integrity,
    coreRevision,
    canghaiRevision: syntheticCangHaiRevision,
    canghaiFixture: "synthetic",
    openclawVersion: exactOpenClawVersion,
    sourceClean: coreSourceStatus.length === 0,
    canghaiSourceClean: canghaiSourceStatus.length === 0,
    isolatedState: true,
    runtimeLoaded: true,
    targetAgentInjected: true,
    nonTargetAgentBypassed: true,
    migrationRequiredBlocked: true,
    privateFixtureIncluded: false,
  };
  if (process.env.STELLA_ACCEPTANCE_RECEIPT_PATH) {
    const receiptPath = path.resolve(process.env.STELLA_ACCEPTANCE_RECEIPT_PATH);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  if (syntheticCangHaiRoot) {
    await rm(syntheticCangHaiRoot, { recursive: true, force: true });
  }
  if (blockedCangHaiRoot) {
    await rm(blockedCangHaiRoot, { recursive: true, force: true });
  }
}
