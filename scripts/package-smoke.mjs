import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  if (command === "npm") {
    if (!process.env.npm_execpath) {
      throw new Error("npm CLI path is unavailable; run package acceptance through npm");
    }
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  } else if (path.basename(command) === "openclaw.mjs") {
    args = [command, ...args];
    command = process.execPath;
  }
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
  const continuityPrediction = { possibleActions: { wait: 0.7, ask: 0.3 } };
  for (const record of [
    {
      id: "praxis-smoke-open",
      status: "recommended",
      summary: "Synthetic important open state",
      decision: { recommendation: "wait once", rationale: ["preserve space"] },
    },
    {
      id: "praxis-smoke-learned",
      status: "closed",
      summary: "Synthetic closed learning",
      learning: {
        algorithmVersion: "stella.praxis-learning/v1",
        predictionAssessment: "supported",
        evidenceRefs: [
          "path:30_PersonalData/praxis/episodes/praxis-smoke-learned/episode.json",
        ],
        praxis: ["Synthetic sealed Praxis learning: verify assumptions before escalating."],
      },
    },
  ]) {
    const episodeDirectory = path.join(
      syntheticCangHaiRoot,
      "30_PersonalData/praxis/episodes",
      record.id,
    );
    await mkdir(episodeDirectory, { recursive: true });
    await writeFile(
      path.join(episodeDirectory, "prediction.json"),
      `${JSON.stringify(continuityPrediction, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(episodeDirectory, "episode.json"),
      `${JSON.stringify({
        schemaVersion: "stella.praxis-episode/v1",
        id: record.id,
        status: record.status,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        recoveryPriority: record.status === "closed" ? "normal" : "important",
        provenance: {},
        situation: {
          summary: record.summary,
          domains: ["relationship"],
          observations: [],
        },
        twin: { prediction: continuityPrediction },
        ...(record.decision ? { decision: record.decision } : {}),
        ...(record.learning
          ? {
              decision: { recommendation: "verify once", rationale: ["reduce uncertainty"] },
              actual: {
                action: "verified once",
                occurredAt: "2026-09-02T00:00:00.000Z",
                source: "user_report",
              },
              outcome: {
                observations: ["assumption checked"],
                result: "uncertainty reduced",
                observedAt: "2026-09-02T00:00:00.000Z",
              },
              learning: record.learning,
            }
          : {}),
      }, null, 2)}\n`,
      "utf8",
    );
  }
  await updateFixtureManifest(syntheticCangHaiRoot, (manifest) => manifest.replace(
    "derived:\n  rebuild: [bootstrap_projection, memory_index]",
    "derived:\n  rebuild: [bootstrap_projection, framework_registry, praxis_index]",
  ));
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
    "dist/src/acceptance/alpha-candidate.js",
    "dist/src/acceptance/model-praxis-evaluator.js",
    "dist/src/acceptance/recovery-drill.js",
    "openclaw.plugin.json",
    "schemas/consciousness-manifest.schema.json",
    "evaluation/praxis-social.synthetic.json",
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
  const artifactSha256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
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

  const openclawBin = path.join(consumerRoot, "node_modules", "openclaw", "openclaw.mjs");
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
        dataMode: "read_only",
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
      "plugins.entries.stella-core.llm.allowAgentIdOverride",
      "true",
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
  let forceInvalidSemanticRoute = false;
  const semanticRouteResponses = [];
  const fixtureOperatorRefs = [
    "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:reversible_test",
    "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:observation_test",
  ];
  const ordinaryRoute = {
    mode: "ordinary",
    domains: ["general"],
    needsTwin: false,
    needsFramework: false,
    needsReality: false,
    needsExternalResearch: false,
  };
  const praxisRoute = {
    mode: "praxis",
    domains: ["relationship"],
    stakes: "medium",
    reversibility: "high",
    needsTwin: true,
    needsFramework: true,
    needsReality: true,
    needsExternalResearch: false,
    candidateFrameworks: fixtureOperatorRefs,
    candidateTwinRefs: ["path:30_PersonalData/twin/hypotheses/twin_fixture.md"],
    candidatePraxisRefs: [],
    twinPrediction: {
      possibleActions: { "send-one-message": 0.65, wait: 0.35 },
      likelyInterpretations: ["用户会优先选择可逆行动"],
      keyFactors: ["不想给对方压力"],
    },
    situation: {
      actors: ["self", "other"],
      observations: ["她两天没回我消息"],
      interpretations: ["我觉得她可能在疏远我"],
      unknowns: ["她没有回复的原因"],
      userGoals: ["判断是否再发一条消息"],
      constraints: ["不想给她压力"],
    },
  };
  const twinRoute = {
    mode: "twin",
    domains: ["identity"],
    needsTwin: true,
    needsFramework: false,
    needsReality: false,
    needsExternalResearch: false,
    candidateTwinRefs: ["path:30_PersonalData/twin/hypotheses/twin_fixture.md"],
  };
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
    const isSemanticRouting = body.includes("Semantically classify one user turn");
    const isOpenEpisodeSelection = body.includes(
      "Judge whether this owner turn asks to recall, inspect, or continue exactly one supplied open Praxis Episode",
    );
    const responseContent = isOpenEpisodeSelection
      ? JSON.stringify({ openEpisodeRef: null })
      : isSemanticRouting
        ? forceInvalidSemanticRoute
          ? "not-json"
          : JSON.stringify(semanticRouteResponses.shift() ?? ordinaryRoute)
        : body.includes("<stella_core_praxis_context")
          ? "建议你只发一次低压消息，并明确让对方按自己的节奏回复；先准备草稿，不替你发送。"
          : body.includes("<stella_core_consciousness")
            ? "identity-restored"
            : "smoke-ok";
    response.end(
      JSON.stringify({
        id: "chatcmpl-stella-core-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: "smoke-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseContent },
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
      process.execPath,
      [openclawBin, "gateway", "run", "--port", String(gatewayPort)],
      { cwd: consumerRoot, env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    gatewayProcess.stdout.on("data", (chunk) => {
      gatewayOutput = `${gatewayOutput}${chunk}`.slice(-20_000);
    });
    gatewayProcess.stderr.on("data", (chunk) => {
      gatewayOutput = `${gatewayOutput}${chunk}`.slice(-20_000);
    });
    let gatewayReady = false;
    for (let attempt = 0; attempt < 240; attempt += 1) {
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
  const exactHostTurns = [
    {
      agentId: "stella",
      message: "TypeScript 的 satisfies 是什么？",
    },
    {
      agentId: "stella",
      message: "她两天没回我消息，我觉得她可能在疏远我。我想知道要不要再发一条，又不想给她压力。",
    },
    {
      agentId: "stella",
      message: "请恢复我的核心身份，并说明一个稳定倾向。",
    },
    {
      agentId: "ordinary",
      message: "Stella Core non-target smoke",
    },
  ];
  const exactHostResults = [];
  for (const turn of exactHostTurns) {
    if (turn.agentId === "stella") {
      semanticRouteResponses.push(
        exactHostResults.length === 0
          ? ordinaryRoute
          : exactHostResults.length === 1
            ? praxisRoute
            : twinRoute,
      );
    }
    exactHostResults.push(await run(
      openclawBin,
      [
        "agent",
        "--agent",
        turn.agentId,
        "--message",
        turn.message,
        "--json",
        "--timeout",
        "30",
      ],
      { cwd: consumerRoot, env: isolatedEnv },
    ));
  }
  const completionRequests = providerRequests.filter((request) =>
    request.url?.endsWith("/chat/completions"),
  );
  const routingRequests = completionRequests.filter((request) =>
    request.body.includes("Semantically classify one user turn"),
  );
  const openEpisodeSelectionRequests = completionRequests.filter((request) =>
    request.body.includes(
      "Judge whether this owner turn asks to recall, inspect, or continue exactly one supplied open Praxis Episode",
    ),
  );
  const answerRequests = completionRequests.filter((request) =>
    !request.body.includes("Semantically classify one user turn") &&
    !request.body.includes(
      "Judge whether this owner turn asks to recall, inspect, or continue exactly one supplied open Praxis Episode",
    ),
  );
  if (
    routingRequests.length !== 3 ||
    openEpisodeSelectionRequests.length !== 3 ||
    answerRequests.length !== 4 ||
    answerRequests[0].body.includes("<stella_core_praxis_context") ||
    !answerRequests[1].body.includes("<stella_core_praxis_context") ||
    !answerRequests[1].body.includes("#operator:reversible_test") ||
    !answerRequests[2].body.includes("<stella_core_consciousness") ||
    !answerRequests[2].body.includes("Evidence-driven and direct") ||
    !answerRequests[2].body.includes("Prefers reversible experiments") ||
    answerRequests[3].body.includes("<stella_core_praxis_context") ||
    !routingRequests[1].body.includes("Synthetic important open state") ||
    !routingRequests[1].body.includes("Synthetic sealed Praxis learning") ||
    !exactHostResults[1]?.stdout.includes("低压消息") ||
    !exactHostResults[1]?.stdout.includes("不替你发送") ||
    !exactHostResults[2]?.stdout.includes("identity-restored")
  ) {
    throw new Error(
      `real OpenClaw target injection or non-target bypass acceptance failed: ${JSON.stringify({
        completionRequestCount: completionRequests.length,
        semanticRoutingRequestCount: routingRequests.length,
        openEpisodeSelectionRequestCount: openEpisodeSelectionRequests.length,
        answerRequestCount: answerRequests.length,
        ordinaryTargetBypassed: !answerRequests[0]?.body.includes("<stella_core_praxis_context"),
        praxisTargetInjected: answerRequests[1]?.body.includes("<stella_core_praxis_context"),
        praxisOperatorTrace: answerRequests[1]?.body.includes("#operator:reversible_test"),
        identityContextRestored: answerRequests[2]?.body.includes("<stella_core_consciousness"),
        praxisLearningRestored: routingRequests[1]?.body.includes("Synthetic sealed Praxis learning"),
        importantOpenStateRestored: routingRequests[1]?.body.includes("Synthetic important open state"),
        nonTargetBypassed: !answerRequests[3]?.body.includes("<stella_core_praxis_context"),
        praxisAnswer: exactHostResults[1]?.stdout,
        urls: providerRequests.map((request) => request.url),
      })}`,
    );
  }

  const completionCountBeforeRoutingFailure = completionRequests.length;
  forceInvalidSemanticRoute = true;
  let blockedRoutingTurn = "";
  try {
    const result = await run(
      openclawBin,
      [
        "agent",
        "--agent",
        "stella",
        "--message",
        "Synthetic semantic routing failure smoke",
        "--json",
        "--timeout",
        "30",
      ],
      { cwd: consumerRoot, env: isolatedEnv },
    );
    blockedRoutingTurn = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    blockedRoutingTurn = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  } finally {
    forceInvalidSemanticRoute = false;
  }
  const completionCountAfterRoutingFailure = providerRequests.filter((request) =>
    request.url?.endsWith("/chat/completions"),
  ).length;
  if (
    !blockedRoutingTurn.includes("Your message could not be sent") ||
    completionCountAfterRoutingFailure !== completionCountBeforeRoutingFailure + 4
  ) {
    throw new Error(
      `semantic routing failure did not fail closed before the answer model: ${JSON.stringify({
        completionCountBeforeRoutingFailure,
        completionCountAfterRoutingFailure,
        exposedBlockMessage: blockedRoutingTurn.includes(
          "Your message could not be sent",
        ),
        blockedRoutingTurn: blockedRoutingTurn.slice(0, 2_000),
        gatewayOutput: gatewayOutput.slice(-5_000),
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
  const installedRecovery = await import(
    `${pathToFileURL(path.join(installedRoot, "dist", "src", "acceptance", "recovery-drill.js")).href}?smoke=${Date.now()}`
  );
  const recoveryReport = await installedRecovery.runRecoveryDrill({
    canghaiRoot: syntheticCangHaiRoot,
    recoveryRevision: syntheticCangHaiRevision,
    coreVersion: installedPlugin.STELLA_CORE_COMPATIBILITY_VERSION,
    hostVersion: exactOpenClawVersion,
    rebuild: async (target) => ({ target, evidence: `clean-host:${target}` }),
    verifyContinuity: async () => ({
      accepted:
        answerRequests[2].body.includes("Evidence-driven and direct") &&
        answerRequests[2].body.includes("Prefers reversible experiments") &&
        answerRequests[1].body.includes("#operator:reversible_test") &&
        routingRequests[1].body.includes("Synthetic sealed Praxis learning") &&
        routingRequests[1].body.includes("Synthetic important open state"),
      evidence: ["exact OpenClaw target turns used restored identity, Twin, Framework, learning, and open state"],
    }),
  });

  function registerHooks(canghaiRoot, recoveryRevision) {
    const hooks = new Map();
    const structuredRoutes = [ordinaryRoute, praxisRoute];
    installedPlugin.default.register({
      pluginConfig: { canghaiRoot, recoveryRevision, agentId: "stella", dataMode: "read_only" },
      runtime: {
        version: exactOpenClawVersion,
        llm: {
          complete: async ({ messages, purpose }) => purpose === "stella-core-open-episode-selection"
            ? { text: JSON.stringify({ openEpisodeRef: null }) }
            : { text: JSON.stringify(structuredRoutes.shift() ?? ordinaryRoute) },
        },
      },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      on(name, handler) {
        hooks.set(name, handler);
      },
    });
    return hooks;
  }

  const activeHooks = registerHooks(syntheticCangHaiRoot, syntheticCangHaiRevision);
  const beforeAgentRun = activeHooks.get("before_agent_run");
  const beforeAgentFinalize = activeHooks.get("before_agent_finalize");
  const beforePromptBuild = activeHooks.get("before_prompt_build");
  if (!beforeAgentRun || !beforeAgentFinalize || !beforePromptBuild) {
    throw new Error("packed plugin hooks were not registered");
  }
  const ordinaryEvent = { prompt: "TypeScript 的 satisfies 是什么？", messages: [] };
  const ordinaryContext = {
    agentId: "stella",
    runId: "packed-ordinary-run",
    sessionKey: "agent:stella:packed",
  };
  const ordinaryTargetPrompt = await beforePromptBuild(
    ordinaryEvent,
    ordinaryContext,
  );
  const targetGate = await beforeAgentRun(ordinaryEvent, ordinaryContext);
  const praxisEvent = { prompt: "她没回我消息，我要不要再发一条？", messages: [] };
  const praxisContext = {
    agentId: "stella",
    runId: "packed-praxis-run",
    sessionKey: "agent:stella:packed",
  };
  const praxisTargetPrompt = await beforePromptBuild(
    praxisEvent,
    praxisContext,
  );
  const praxisGate = await beforeAgentRun(praxisEvent, praxisContext);
  const nonTargetGate = await beforeAgentRun({}, { agentId: "ordinary" });
  const nonTargetPrompt = await beforePromptBuild(
    { prompt: "她没回我消息，我要不要再发一条？", messages: [] },
    { agentId: "ordinary" },
  );
  if (
    targetGate?.outcome !== "pass" ||
    praxisGate?.outcome !== "pass" ||
    typeof ordinaryTargetPrompt?.appendContext !== "string" ||
    !ordinaryTargetPrompt.appendContext.includes("CangHai is the sole authority") ||
    ordinaryTargetPrompt.appendContext.includes("<stella_core_consciousness") ||
    ordinaryTargetPrompt.appendContext.includes("<stella_core_praxis_context") ||
    typeof praxisTargetPrompt?.appendContext !== "string" ||
    !praxisTargetPrompt.appendContext.includes("<stella_core_praxis_context") ||
    !praxisTargetPrompt.appendContext.includes("#operator:reversible_test") ||
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
  const blockedEvent = { prompt: "Stella Core migration gate smoke", messages: [] };
  const blockedContext = {
    agentId: "stella",
    runId: "packed-blocked-run",
    sessionKey: "agent:stella:packed-blocked",
  };
  await blockedHooks.get("before_prompt_build")(blockedEvent, blockedContext);
  const blockedGate = await blockedHooks.get("before_agent_run")(
    blockedEvent,
    blockedContext,
  );
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
        dataMode: "read_only",
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
    const result = await run(
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
    blockedHostTurn = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    blockedHostTurn = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  }
  if (!blockedHostTurn.includes("Stella Core 无法加载或验证 CangHai 核心意识数据")) {
    throw new Error("real OpenClaw turn did not expose the migration-required block message");
  }
  if (
    providerRequests.filter((request) => request.url?.endsWith("/chat/completions")).length !==
    completionCountAfterRoutingFailure
  ) {
    throw new Error("migration-required turn reached the model provider");
  }

  const receipt = {
    schemaVersion: "stella.exact-host-recovery-receipt/v1",
    package: `${installedPackage.name}@${installedPackage.version}`,
    packageIntegrity: packEntry.integrity,
    coreRevision,
    canghaiRevision: syntheticCangHaiRevision,
    canghaiFixture: "synthetic",
    hostVersion: exactOpenClawVersion,
    artifactSha256,
    cleanRuntimeState: true,
    importedLegacyRuntime: false,
    dataReadable: recoveryReport.levels.dataReadable,
    cognitiveBootstrapRestored: recoveryReport.levels.cognitiveBootstrapRestored,
    derivedRuntimeRebuilt: recoveryReport.levels.derivedRuntimeRebuilt,
    continuityAccepted: recoveryReport.levels.continuityAccepted,
    identityRestored: recoveryReport.restored.identity,
    frameworkRestored: recoveryReport.restored.framework,
    twinRestored: recoveryReport.restored.twin,
    praxisLearningRestored: recoveryReport.restored.praxisLearning,
    importantOpenStateRestored: recoveryReport.restored.importantOpenState,
    openclawVersion: exactOpenClawVersion,
    sourceClean: coreSourceStatus.length === 0,
    canghaiSourceClean: canghaiSourceStatus.length === 0,
    isolatedState: true,
    runtimeLoaded: true,
    semanticRouting: true,
    semanticRoutingFailureBlocked: true,
    ordinaryTargetBypassed: true,
    praxisTargetInjected: true,
    praxisOperatorTrace: true,
    praxisConcreteNextAction: true,
    praxisOwnerBoundary: true,
    nonTargetAgentBypassed: true,
    migrationRequiredBlocked: true,
    exactHostAgentTurns: true,
    recoveryLevels: recoveryReport.levels,
    restored: recoveryReport.restored,
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
