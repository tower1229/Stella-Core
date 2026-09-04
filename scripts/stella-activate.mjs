import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assessStellaActivation } from "../dist/src/openclaw/activation.js";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { STELLA_CORE_COMPATIBILITY_VERSION } from "../dist/src/plugin.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(values) {
  const result = {};
  let mode;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--check" || value === "--apply") {
      if (mode) throw new Error("Choose exactly one of --check or --apply");
      mode = value.slice(2);
      continue;
    }
    if (!value?.startsWith("--") || !values[index + 1]) {
      throw new Error("Usage: --canghai-root <path> --agent-id <id> --data-mode <mode> [--check|--apply]");
    }
    result[value.slice(2)] = values[index + 1];
    index += 1;
  }
  if (!mode || !result["canghai-root"] || !result["agent-id"] || !result["data-mode"]) {
    throw new Error("Usage: --canghai-root <path> --agent-id <id> --data-mode <mode> [--check|--apply]");
  }
  return { ...result, mode };
}

async function run(command, args, options = {}) {
  if (command === "openclaw") {
    args = [path.join(projectRoot, "node_modules", "openclaw", "openclaw.mjs"), ...args];
    command = process.execPath;
  }
  return execFileAsync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function git(root, args) {
  return (await run("git", ["-C", root, ...args])).stdout.trim();
}

async function observe(canghaiRoot, dataMode) {
  const [coreStatus, canghaiStatus, canghaiBranch, canghaiRevision, upstream, version, configPath] =
    await Promise.all([
      git(projectRoot, ["status", "--porcelain"]),
      git(canghaiRoot, ["status", "--porcelain"]),
      git(canghaiRoot, ["branch", "--show-current"]),
      git(canghaiRoot, ["rev-parse", "HEAD"]),
      git(canghaiRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      run("openclaw", ["--version"]).then(({ stdout }) => stdout.trim().split(/\s+/)[1] ?? ""),
      run("openclaw", ["config", "file"]).then(({ stdout }) => stdout.trim()),
    ]);
  let configValid = true;
  try {
    await run("openclaw", ["config", "validate", "--json"]);
  } catch {
    configValid = false;
  }
  let pluginEntry = {};
  try {
    pluginEntry = JSON.parse((await run("openclaw", [
      "config", "get", "plugins.entries.stella-core", "--json",
    ])).stdout);
  } catch {
    pluginEntry = {};
  }
  let manifestValid = true;
  try {
    await loadConsciousness(canghaiRoot, "50_PersonalAgent/stella/manifest.yaml", {
      recoveryRevision: canghaiRevision,
      coreVersion: STELLA_CORE_COMPATIBILITY_VERSION,
      openclawVersion: version,
      dataMode,
    });
  } catch {
    manifestValid = false;
  }
  let pluginRuntimeValid = true;
  try {
    const runtime = JSON.parse((await run("openclaw", [
      "plugins", "inspect", "stella-core", "--runtime", "--json",
    ])).stdout);
    pluginRuntimeValid = JSON.stringify(runtime).includes("stella-core");
  } catch {
    pluginRuntimeValid = false;
  }
  const separator = upstream.indexOf("/");
  if (separator <= 0) throw new Error("CangHai branch must have an explicit tracked upstream");
  return {
    coreClean: coreStatus.length === 0,
    canghaiClean: canghaiStatus.length === 0,
    canghaiBranch,
    canghaiRevision,
    durabilityRemote: upstream.slice(0, separator),
    durabilityBranch: upstream.slice(separator + 1),
    openclawVersion: version,
    configValid,
    manifestValid,
    pluginRuntimeValid,
    configPath,
    pluginEntry,
  };
}

const args = parseArguments(process.argv.slice(2));
const canghaiRoot = path.resolve(args["canghai-root"]);
const before = await observe(canghaiRoot, args["data-mode"]);
const request = {
  canghaiRoot,
  recoveryRevision: before.canghaiRevision,
  agentId: args["agent-id"],
  dataMode: args["data-mode"],
  ...(args["data-mode"] === "managed_durable_write"
    ? {
        durabilityRemote: before.durabilityRemote,
        durabilityBranch: before.canghaiBranch,
      }
    : {}),
};
const assessment = assessStellaActivation(request, before);

if (args.mode === "check") {
  process.stdout.write(`${JSON.stringify({ mode: "check", ...assessment })}\n`);
  process.exitCode = assessment.ready ? 0 : 2;
} else {
  if (!before.coreClean || !before.canghaiClean) {
    throw new Error("Stella activation apply requires clean Core and CangHai sources");
  }
  const backupPath = `${before.configPath}.bak.stella-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "stella-activate-"));
  const patchPath = path.join(temporaryRoot, "patch.json");
  await copyFile(before.configPath, backupPath);
  await writeFile(patchPath, `${JSON.stringify({
    plugins: { entries: { "stella-core": assessment.desiredEntry } },
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    await run("openclaw", ["config", "patch", "--file", patchPath, "--dry-run"]);
    await run("openclaw", ["config", "patch", "--file", patchPath]);
    await run("openclaw", ["config", "validate", "--json"]);
    await run("openclaw", ["gateway", "restart"]);
    await run("openclaw", ["plugins", "inspect", "stella-core", "--runtime", "--json"]);
    const after = await observe(canghaiRoot, args["data-mode"]);
    const verified = assessStellaActivation(request, after);
    if (!verified.ready) throw new Error(`Stella activation verification failed: ${verified.issues.join(",")}`);
    process.stdout.write(`${JSON.stringify({
      mode: "apply",
      ready: true,
      recoveryRevision: request.recoveryRevision,
      canghaiBranch: before.canghaiBranch,
      durabilityRemote: before.durabilityRemote,
      backupPath,
    })}\n`);
  } catch (error) {
    await copyFile(backupPath, before.configPath);
    await run("openclaw", ["config", "validate", "--json"]);
    await run("openclaw", ["gateway", "restart"]);
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
