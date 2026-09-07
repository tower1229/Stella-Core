import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parsePraxisEvaluationSuite,
  parsePraxisEvaluationSuiteFragment,
  runPraxisEvaluation,
} from "../dist/src/acceptance/praxis-evaluation.js";
import { createModelPraxisEvaluator, PRAXIS_RUBRIC_VERSION } from "../dist/src/acceptance/model-praxis-evaluator.js";
import { runExactHostEvaluationChat } from "../dist/src/acceptance/exact-host-chat.js";
import { loadQuestionEvaluationAnswer } from "../dist/src/acceptance/question-evaluation-answer.js";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { loadPraxisRuntimeBinding } from "../dist/src/praxis/runtime-binding.js";
import { STELLA_CORE_COMPATIBILITY_VERSION } from "../dist/src/plugin.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";
import { installHostCompatibility } from "./lib/install-host-compatibility.mjs";
import {
  assertStellaHostConfig,
  assertStellaHostHooks,
  assertStellaPluginManifest,
  assertStellaPluginRuntime,
  parseExactHostRecoveryReceipt,
  parseExactHostVersion,
} from "../dist/src/acceptance/exact-host-evidence.js";
import { parseRequiredArguments } from "./lib/cli-args.mjs";
import { assertPublicEvaluationSource } from "../dist/src/acceptance/public-evaluation-source.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetAgentId = "main";

const options = parseRequiredArguments(
  process.argv.slice(2),
  ["suite", "adapter", "recovery-receipt", "output"],
  "Usage: --suite <json> [--private-suite <json> --artifact <tgz> --canghai-root <path> --public-canghai-root <synthetic repository>] --adapter <module> --recovery-receipt <json> --output <json>",
);
const suite = parsePraxisEvaluationSuite(await readFile(path.resolve(options.suite), "utf8"));
const privateSuite = options["private-suite"]
  ? parsePraxisEvaluationSuiteFragment(
      await readFile(path.resolve(options["private-suite"]), "utf8"),
    )
  : undefined;
if (privateSuite?.boundary !== "private_canghai") {
  if (privateSuite) throw new Error("Additional Praxis suite must use the private CangHai boundary");
}
const cases = [...suite.cases, ...(privateSuite?.cases ?? [])];
const adapter = await import(pathToFileURL(path.resolve(options.adapter)).href);
const recoveryReceipt = parseExactHostRecoveryReceipt(JSON.parse(
  await readFile(path.resolve(options["recovery-receipt"]), "utf8"),
));
const execution = {
  ...(recoveryReceipt.hostCompatibility ? { hostCompatibility: recoveryReceipt.hostCompatibility } : {}),
  coreRevision: recoveryReceipt.coreRevision,
  canghaiRevision: recoveryReceipt.canghaiRevision,
  hostVersion: recoveryReceipt.hostVersion,
  artifactSha256: recoveryReceipt.artifactSha256,
};

async function hashFile(filePath) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0) throw new Error("Evaluation artifact must be non-empty");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectSource(label, root, revision) {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", root, "status", "--porcelain"]),
  ]);
  if (head.trim() !== revision || status.trim()) {
    throw new Error(`${label} must be clean at the evaluation receipt revision`);
  }
}

async function runPrivateExactHostEvaluation() {
  for (const key of ["artifact", "canghai-root", "public-canghai-root"]) {
    if (!options[key]) throw new Error(`Private Praxis evaluation requires --${key}`);
  }
  if (recoveryReceipt.canghaiFixture !== "private" || recoveryReceipt.cleanRuntimeState !== true) {
    throw new Error("Private Praxis evaluation requires a clean private recovery receipt");
  }
  const artifactPath = path.resolve(options.artifact);
  const canghaiRoot = path.resolve(options["canghai-root"]);
  const publicRoot = await realpath(path.resolve(options["public-canghai-root"]));
  if (publicRoot.toLowerCase() === (await realpath(canghaiRoot)).toLowerCase()) {
    throw new Error("Public evaluation requires a separate synthetic source repository");
  }
  const publicRevision = (await execFileAsync("git", ["-C", publicRoot, "rev-parse", "HEAD"])).stdout.trim();
  await Promise.all([
    inspectSource("Core", projectRoot, execution.coreRevision),
    inspectSource("CangHai", canghaiRoot, execution.canghaiRevision),
    inspectSource("Public synthetic source", publicRoot, publicRevision),
  ]);
  await assertPublicEvaluationSource(publicRoot);
  if (await hashFile(artifactPath) !== execution.artifactSha256) {
    throw new Error("Evaluation artifact does not match the recovery receipt");
  }
  if (typeof adapter.createEvaluationHarness !== "function") {
    throw new Error("Private Praxis adapter must export createEvaluationHarness(context)");
  }

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "stella-private-evaluation-"));
  const runtimes = [];
  try {
    const consumerRoot = path.join(isolatedRoot, "consumer");
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "stella-private-evaluation", private: true })}\n`,
    );
    if (!process.env.npm_execpath) {
      throw new Error("npm CLI path is unavailable; run Praxis evaluation through npm");
    }
    await execFileAsync(process.execPath, [process.env.npm_execpath,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifactPath,
      `openclaw@${execution.hostVersion}`,
    ], { cwd: consumerRoot });
    const openclawBin = await realpath(path.join(consumerRoot, "node_modules/openclaw/openclaw.mjs"));
    if (recoveryReceipt.hostCompatibility) {
      const installed = await installHostCompatibility(consumerRoot);
      await writeFile(path.join(isolatedRoot, "host-compatibility.json"), JSON.stringify(installed, null, 2));
    }
    const runOpenClaw = (args, commandOptions) =>
      execFileAsync(process.execPath, [openclawBin, ...args], commandOptions);
    const hostEnv = { OPENCLAW_STATE_DIR: path.join(isolatedRoot, "install-state") };
    const { stdout: versionOutput } = await runOpenClaw(["--version"], {
      cwd: consumerRoot,
      env: { ...process.env, ...hostEnv },
    });
    parseExactHostVersion(versionOutput);
    await runOpenClaw([
      "plugins",
      "install",
      artifactPath,
      "--force",
      "--accept-capabilities",
    ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    const installedRoot = path.join(
      consumerRoot,
      "node_modules",
      "@tower1229",
      "stella-core",
    );
    assertStellaPluginManifest(JSON.parse(
      await readFile(path.join(installedRoot, "openclaw.plugin.json"), "utf8"),
    ));
    // Independent Host states and repositories, not merely different session keys.
    // The synthetic source is an explicit input; it must never be copied from private memory.
    const gatewayRuntime = await import(pathToFileURL(path.join(consumerRoot,
      "node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js")).href);
    async function createCaseRuntime(boundary) {
    const [sourceRoot, sourceRevision] = boundary === "public_synthetic"
      ? [publicRoot, publicRevision] : [canghaiRoot, execution.canghaiRevision];
    const caseRoot = path.join(isolatedRoot, `${boundary}-${randomUUID()}`);
    const runtimeStateRoot = path.join(caseRoot, "openclaw-state");
    const workingRoot = path.join(caseRoot, "canghai");
    const remoteRoot = path.join(caseRoot, "canghai.git");
    await mkdir(path.dirname(workingRoot), { recursive: true });
    await execFileAsync("git", ["clone", "--no-local", sourceRoot, workingRoot]);
    await execFileAsync("git", ["-C", workingRoot, "checkout", "-b", "evaluation", sourceRevision]);
    await execFileAsync("git", ["clone", "--bare", "--no-local", workingRoot, remoteRoot]);
    await execFileAsync("git", ["-C", workingRoot, "remote", "set-url", "origin", remoteRoot]);
    await execFileAsync("git", ["-C", workingRoot, "config", "user.name", "Stella Evaluation"]);
    await execFileAsync("git", ["-C", workingRoot, "config", "user.email", "evaluation@stella.invalid"]);
    const hostEnv = { OPENCLAW_STATE_DIR: runtimeStateRoot, OPENCLAW_CONFIG_PATH: path.join(runtimeStateRoot, "openclaw.json") };
    await runOpenClaw(["plugins", "install", artifactPath, "--force", "--accept-capabilities"],
      { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    const harness = await adapter.createEvaluationHarness({
      agentId: targetAgentId,
      artifactPath,
      boundary,
      canghaiRoot: workingRoot,
      canghaiRevision: sourceRevision,
      dataMode: "managed_durable_write",
      durabilityRemote: "origin",
      durabilityBranch: "evaluation",
      consumerRoot,
      coreRevision: execution.coreRevision,
      hostEnv,
      hostVersion: execution.hostVersion,
      openclawBin,
      runtimeStateRoot,
    });
    if (typeof harness?.judgeAgentId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(harness.judgeAgentId) || harness.judgeAgentId === targetAgentId) {
      throw new Error("Evaluation requires a non-target judge agent");
    }
    const { stdout: hostConfigOutput } = await runOpenClaw([
      "config",
      "get",
      "plugins.entries.stella-core.config",
      "--json",
    ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    const hostConfig = JSON.parse(hostConfigOutput);
    const completeHostConfig = JSON.parse(await readFile(hostEnv.OPENCLAW_CONFIG_PATH, "utf8"));
    for (const agentId of [targetAgentId, harness.judgeAgentId]) {
      const agent = completeHostConfig.agents?.entries?.[agentId];
      if (agent?.model !== "google/gemini-3.1-pro-preview" || !Array.isArray(agent.skills) || agent.skills.length ||
        !Array.isArray(agent.tools?.deny) || !agent.tools.deny.includes("*")) {
        throw new Error("Evaluation requires pinned Gemini 3.1 Pro and tool-free isolated agents");
      }
    }
    assertStellaHostConfig(hostConfig, {
      canghaiRoot: workingRoot,
      canghaiRevision: sourceRevision,
      agentId: targetAgentId,
      dataMode: "managed_durable_write",
    });
    if (hostConfig.durabilityRemote !== "origin" || hostConfig.durabilityBranch !== "evaluation") {
      throw new Error("Evaluation writes must synchronize to the isolated local remote");
    }
    const loaded = await loadConsciousness(workingRoot, hostConfig.manifestPath, {
      recoveryRevision: sourceRevision, coreVersion: STELLA_CORE_COMPATIBILITY_VERSION, openclawVersion: execution.hostVersion,
      dataMode: "managed_durable_write",
    });
    const binding = await loadPraxisRuntimeBinding(loaded);
    const { stdout: hostHooksOutput } = await runOpenClaw([
      "config",
      "get",
      "plugins.entries.stella-core.hooks",
      "--json",
    ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    assertStellaHostHooks(JSON.parse(hostHooksOutput));
    const { stdout: pluginRuntimeOutput } = await runOpenClaw([
      "plugins",
      "inspect",
      "stella-core",
      "--runtime",
      "--json",
    ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    assertStellaPluginRuntime(JSON.parse(pluginRuntimeOutput));
    const gateway = await startExactHostGateway({
      cwd: consumerRoot,
      env: hostEnv,
      openclawBin,
    });
    const listeners = new Set();
    const runtime = { boundary, gateway, workingRoot, caseRoot, binding, harness, listeners };
    runtimes.push(runtime);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Evaluation Gateway connection timeout")), 15_000);
      runtime.client = new gatewayRuntime.GatewayClient({
        url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
        env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"],
        sharedStateMode: "read-only", deviceIdentity: null,
        onHelloOk() { clearTimeout(timer); resolve(); },
        onConnectError() { clearTimeout(timer); reject(new Error("Evaluation Gateway connection failed")); },
        onEvent(event) { for (const listener of listeners) listener(event); },
      });
      runtime.client.start();
    });
    runtime.turn = (agentId, message) => {
      const id = randomUUID();
      return runExactHostEvaluationChat({
        request: (method, params) => runtime.client.request(method, params, { timeoutMs: 35_000 }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      }, { sessionKey: `agent:${agentId}:evaluation-${id}`, message, idempotencyKey: id });
    };
    return runtime;
    }
    const answers = new Map();
    let currentRuntime;
    const evidenceRecords = [];
    const evaluator = createModelPraxisEvaluator({
      answerCase: async (evaluationCase) => {
        // Fresh source copies prevent evaluation scenarios from becoming later history.
        if (currentRuntime) {
          await currentRuntime.client.stopAndWait({ timeoutMs: 2_000 });
          await currentRuntime.gateway.stop();
          runtimes.splice(runtimes.indexOf(currentRuntime), 1);
        }
        const runtime = currentRuntime = await createCaseRuntime(evaluationCase.boundary);
        const delivered = await runtime.turn(targetAgentId, evaluationCase.prompt);
        await writeFile(path.join(runtime.caseRoot, "native-turn-binding.json"), JSON.stringify({
          runId: delivered.runId,
          questionSha256: createHash("sha256").update(evaluationCase.prompt).digest("hex"),
          answerSha256: createHash("sha256").update(delivered.text).digest("hex"),
        }, null, 2), { mode: 0o600 });
        const bound = await loadQuestionEvaluationAnswer({
          root: runtime.workingRoot, catalogPath: runtime.binding.catalogPath,
          requestId: delivered.runId, question: evaluationCase.prompt, text: delivered.text,
          purpose: { ...runtime.binding.purpose, evidenceCutoff: new Date().toISOString(),
            trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
          complete: async ({ prompt }) => ({ text: (await runtime.turn(runtime.harness.judgeAgentId, prompt)).text }),
        });
        answers.set(evaluationCase.id, { ...bound, clientRunId: delivered.runId });
        return bound.answer;
      },
      evidenceResolver: async (evaluationCase) => answers.get(evaluationCase.id).resolver,
      judge: async (prompt) => ({
        text: (await currentRuntime.turn(currentRuntime.harness.judgeAgentId, prompt)).text,
      }),
    });
      return await runPraxisEvaluation(
        cases,
        async (evaluationCase) => {
          const observation = await evaluator(evaluationCase);
          const { answer, resolver, clientRunId } = answers.get(evaluationCase.id);
          evidenceRecords.push({ caseId: evaluationCase.id, boundary: evaluationCase.boundary,
            clientRunId,
            requestId: answer.requestId, revision: answer.revision, generationId: answer.generationId,
            bundleRef: answer.bundleRef, evidenceCutoff: resolver.purpose.evidenceCutoff,
            questionSha256: createHash("sha256").update(evaluationCase.prompt).digest("hex"),
            answerSha256: createHash("sha256").update(answer.text).digest("hex"),
            observation });
          await writeFile(path.join(isolatedRoot, "evaluation-evidence.json"), JSON.stringify({
            schemaVersion: "stella.evaluation-evidence/v1", execution, publicRevision,
            configuredModel: "google/gemini-3.1-pro-preview", rubricVersion: PRAXIS_RUBRIC_VERSION,
            scope: "diagnostic; isolated per-case writable copies and local synchronization, not original private remote durability proof",
            cases: evidenceRecords,
          }, null, 2), { mode: 0o600 });
          return observation;
        },
        execution,
      );
  } finally {
    for (const runtime of runtimes) {
      await runtime.client?.stopAndWait({ timeoutMs: 2_000 });
      await runtime.gateway.stop();
    }
    // Retain the journals and exact Host state, including failed pending transactions.
    // This local path is not included in the shareable evaluation report.
    process.stderr.write(`Evaluation evidence retained locally: ${isolatedRoot}\n`);
  }
}

let report;
if (privateSuite) {
  report = await runPrivateExactHostEvaluation();
} else {
  if (typeof adapter.answerCase !== "function" || typeof adapter.judge !== "function") {
    throw new Error("Praxis evaluation adapter must export answerCase(case) and judge(prompt)");
  }
  report = await runPraxisEvaluation(
    cases,
    createModelPraxisEvaluator({ answerCase: adapter.answerCase, evidenceResolver: adapter.evidenceResolver, judge: adapter.judge }),
    execution,
  );
}
const outputPath = path.resolve(options.output);
await mkdir(path.dirname(outputPath), { recursive: true });
const stagingPath = `${outputPath}.${process.pid}.staging`;
await writeFile(stagingPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(stagingPath, outputPath);
process.stdout.write(`${JSON.stringify({ output: outputPath, ...report })}\n`);
if (report.failedCount > 0) process.exitCode = 1;
