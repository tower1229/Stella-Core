import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exactOpenClawVersion = "2026.8.2";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stella-core-package-smoke-"));
const npmEnv = { ...process.env, NPM_CONFIG_CACHE: path.join(tempRoot, "npm-cache") };

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? npmEnv,
    maxBuffer: 10 * 1024 * 1024,
  });
}

try {
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
  const dummyCangHaiRoot = path.join(tempRoot, "synthetic-canghai");
  await mkdir(consumerRoot, { recursive: true });
  await mkdir(dummyCangHaiRoot, { recursive: true });
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
        canghaiRoot: dummyCangHaiRoot,
        recoveryRevision: "1".repeat(40),
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

  const installedPackage = JSON.parse(
    await readFile(
      path.join(consumerRoot, "node_modules", "@tower1229", "stella-core", "package.json"),
      "utf8",
    ),
  );
  process.stdout.write(
    `${JSON.stringify({
      package: `${installedPackage.name}@${installedPackage.version}`,
      packageIntegrity: packEntry.integrity,
      openclawVersion: exactOpenClawVersion,
      isolatedState: true,
      runtimeLoaded: true,
      privateFixtureIncluded: false,
    })}\n`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
