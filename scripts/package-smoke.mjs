import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
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
let providerServer;
let gatewayProcess;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? npmEnv,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function reserveLoopbackPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve loopback port");
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
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
  const coreRevision = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const coreSourceStatus = (await run("git", ["status", "--porcelain"])).stdout.trim();
  const canghaiSourceStatus = (
    await run("git", ["-C", syntheticCangHaiRoot, "status", "--porcelain"])
  ).stdout.trim();
  if (coreSourceStatus || canghaiSourceStatus) {
    throw new Error("package acceptance requires clean Core and CangHai sources");
  }

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
  for (const key of Object.keys(isolatedEnv)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) delete isolatedEnv[key];
  }
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
  await run(
    openclawBin,
    [
      "config",
      "set",
      "plugins.entries.stella-core.hooks.allowConversationAccess",
      "true",
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

  const providerRequests = [];
  providerServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    providerRequests.push({ url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "smoke-model", object: "model" }] }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: "chatcmpl-stella-core-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: "smoke-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "smoke-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address();
  if (!providerAddress || typeof providerAddress === "string") {
    throw new Error("local smoke provider did not expose a TCP port");
  }
  await run(
    openclawBin,
    [
      "config",
      "set",
      "models.providers.stella-smoke",
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        apiKey: "local-smoke-only",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "smoke-model",
            name: "Stella Core Smoke Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131_072,
            maxTokens: 1_024,
          },
        ],
      }),
      "--strict-json",
    ],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  await run(
    openclawBin,
    ["config", "set", "memory.search.enabled", "false", "--strict-json"],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  await run(openclawBin, ["plugins", "enable", "stella-core", "--accept-capabilities"], {
    cwd: consumerRoot,
    env: isolatedEnv,
  });
  for (const agentId of ["stella", "ordinary"]) {
    await run(
      openclawBin,
      [
        "agents",
        "add",
        agentId,
        "--non-interactive",
        "--workspace",
        path.join(stateRoot, `workspace-${agentId}`),
        "--model",
        "stella-smoke/smoke-model",
      ],
      { cwd: consumerRoot, env: isolatedEnv },
    );
  }
  const gatewayPort = await reserveLoopbackPort();
  const gatewayToken = "stella-core-package-smoke-gateway-token";
  await run(
    openclawBin,
    ["config", "set", "gateway.mode", "local"],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  await run(
    openclawBin,
    ["config", "set", "gateway.port", String(gatewayPort), "--strict-json"],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  await run(
    openclawBin,
    ["config", "set", "gateway.auth.mode", "token"],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  await run(
    openclawBin,
    ["config", "set", "gateway.auth.token", gatewayToken],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  let gatewayOutput = "";
  async function startGateway() {
    gatewayOutput = "";
    gatewayProcess = spawn(
      openclawBin,
      ["gateway", "run", "--port", String(gatewayPort)],
      { cwd: consumerRoot, env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    gatewayProcess.stdout.on("data", (chunk) => {
      gatewayOutput = `${gatewayOutput}${chunk}`.slice(-20_000);
    });
    gatewayProcess.stderr.on("data", (chunk) => {
      gatewayOutput = `${gatewayOutput}${chunk}`.slice(-20_000);
    });
    let gatewayReady = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
        if (response.ok) {
          gatewayReady = true;
          break;
        }
      } catch {
        // Gateway startup is asynchronous; retry the public liveness seam.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!gatewayReady) throw new Error(`isolated OpenClaw Gateway did not start: ${gatewayOutput}`);
  }
  async function stopGateway() {
    if (gatewayProcess && gatewayProcess.exitCode === null) {
      gatewayProcess.kill("SIGTERM");
      await new Promise((resolve) => gatewayProcess.once("exit", resolve));
    }
    gatewayProcess = undefined;
  }
  await startGateway();
  for (const agentId of ["stella", "ordinary"]) {
    await run(
      openclawBin,
      [
        "agent",
        "--agent",
        agentId,
        "--message",
        "Stella Core exact-host smoke",
        "--json",
        "--timeout",
        "30",
      ],
      { cwd: consumerRoot, env: isolatedEnv },
    );
  }
  const completionRequests = providerRequests.filter((request) =>
    request.url?.endsWith("/chat/completions"),
  );
  if (
    completionRequests.length !== 2 ||
    !completionRequests[0].body.includes("<stella_core_consciousness") ||
    !completionRequests[0].body.includes(syntheticCangHaiRevision) ||
    completionRequests[1].body.includes("<stella_core_consciousness")
  ) {
    throw new Error(
      `real OpenClaw target injection or non-target bypass acceptance failed: ${JSON.stringify({
        completionRequestCount: completionRequests.length,
        targetHasContext: completionRequests[0]?.body.includes("<stella_core_consciousness"),
        targetHasRevision: completionRequests[0]?.body.includes(syntheticCangHaiRevision),
        nonTargetHasContext: completionRequests[1]?.body.includes("<stella_core_consciousness"),
        urls: providerRequests.map((request) => request.url),
      })}`,
    );
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
  await run(
    openclawBin,
    [
      "config",
      "set",
      "plugins.entries.stella-core.config",
      JSON.stringify({
        canghaiRoot: blockedCangHaiRoot,
        recoveryRevision: blockedRevision,
        agentId: "stella",
      }),
      "--strict-json",
    ],
    { cwd: consumerRoot, env: isolatedEnv },
  );
  await stopGateway();
  await startGateway();
  let blockedHostTurn = "";
  try {
    await run(
      openclawBin,
      [
        "agent",
        "--agent",
        "stella",
        "--message",
        "Stella Core migration gate smoke",
        "--json",
        "--timeout",
        "30",
      ],
      { cwd: consumerRoot, env: isolatedEnv },
    );
  } catch (error) {
    blockedHostTurn = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  if (!blockedHostTurn.includes("stella_migration_required")) {
    throw new Error("real OpenClaw turn did not expose the migration-required block category");
  }
  if (providerRequests.filter((request) => request.url?.endsWith("/chat/completions")).length !== 2) {
    throw new Error("migration-required turn reached the model provider");
  }

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
    exactHostAgentTurns: true,
    privateFixtureIncluded: false,
  };
  if (process.env.STELLA_ACCEPTANCE_RECEIPT_PATH) {
    const receiptPath = path.resolve(process.env.STELLA_ACCEPTANCE_RECEIPT_PATH);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  if (gatewayProcess && gatewayProcess.exitCode === null) {
    gatewayProcess.kill("SIGTERM");
    await new Promise((resolve) => gatewayProcess.once("exit", resolve));
  }
  if (providerServer) {
    await new Promise((resolve) => providerServer.close(resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
  if (syntheticCangHaiRoot) {
    await rm(syntheticCangHaiRoot, { recursive: true, force: true });
  }
  if (blockedCangHaiRoot) {
    await rm(blockedCangHaiRoot, { recursive: true, force: true });
  }
}
