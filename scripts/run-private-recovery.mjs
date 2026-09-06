import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseRequiredArguments } from "./lib/cli-args.mjs";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";
import { installHostCompatibility } from "./lib/install-host-compatibility.mjs";
import {
  ALPHA_HOST_VERSION,
  assertStellaHostConfig,
  assertStellaHostHooks,
  assertStellaPluginManifest,
  assertStellaPluginRuntime,
  parseExactHostVersion,
} from "../dist/src/acceptance/exact-host-evidence.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetAgentId = "main";
const hostVersion = ALPHA_HOST_VERSION;

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

const sourceRoot = path.resolve(options["canghai-root"]);
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
  inspectCleanSource("CangHai", sourceRoot, options["canghai-revision"]),
]);
const artifactSha256 = await hashFile(artifactPath);

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "stella-private-recovery-"));
process.stderr.write(`Private recovery evidence: ${isolatedRoot}\n`);
// Retain private journals and native receipts for failure diagnosis. Observation
// timeout does not authorize deleting uncertain-run evidence or resubmission.
{
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
  if (!process.env.npm_execpath) {
    throw new Error("npm CLI path is unavailable; run private recovery through npm");
  }
  const canghaiRoot = path.join(isolatedRoot, "canghai");
  await execFileAsync("git", ["clone", "--no-local", "--quiet", sourceRoot, canghaiRoot]);
  await execFileAsync("git", ["-C", canghaiRoot, "checkout", "--detach", options["canghai-revision"]]);
  await execFileAsync("git", ["-C", canghaiRoot, "remote", "remove", "origin"]);
  await inspectCleanSource("Restored CangHai", canghaiRoot, options["canghai-revision"]);
  await execFileAsync(process.execPath, [process.env.npm_execpath,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    artifactPath,
    `openclaw@${hostVersion}`,
  ], { cwd: consumerRoot });
  const openclawBin = await realpath(path.join(consumerRoot, "node_modules/openclaw/openclaw.mjs"));
  const hostCompatibility = await installHostCompatibility(consumerRoot);
  await writeFile(path.join(isolatedRoot, "host-compatibility.json"), JSON.stringify(hostCompatibility, null, 2));
  const runOpenClaw = (args, commandOptions) =>
    execFileAsync(process.execPath, [openclawBin, ...args], commandOptions);
  const hostEnv = { OPENCLAW_STATE_DIR: runtimeStateRoot };
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
  if ((await readdir(runtimeStateRoot)).length === 0) {
    throw new Error("Exact Host did not initialize the isolated runtime");
  }
  const adapter = await import(pathToFileURL(adapterPath).href);
  if (typeof adapter.createRecoveryHarness !== "function") {
    throw new Error("Recovery adapter must export createRecoveryHarness(context)");
  }
  const harness = await adapter.createRecoveryHarness({
    agentId: targetAgentId,
    artifactPath,
    artifactSha256,
    canghaiRoot,
    dataMode: "read_only",
    canghaiRevision: options["canghai-revision"],
    coreRevision,
    consumerRoot,
    hostEnv,
    hostVersion,
    openclawBin,
    runtimeStateRoot,
  });
  if (typeof harness?.evidenceAgentId !== "string" || !/^[a-z0-9-]+$/.test(harness.evidenceAgentId) ||
    harness.evidenceAgentId === targetAgentId) throw new Error("recovery_evidence_agent_required");
  const hostConfigPath = hostEnv.OPENCLAW_CONFIG_PATH ?? path.join(runtimeStateRoot, "openclaw.json");
  const fullHostConfig = JSON.parse(await readFile(hostConfigPath, "utf8"));
  for (const agentId of [targetAgentId, harness.evidenceAgentId]) {
    const agent = fullHostConfig.agents?.entries?.[agentId];
    if (agent?.model !== "google/gemini-3.1-pro-preview" || !Array.isArray(agent.skills) || agent.skills.length ||
      !Array.isArray(agent.tools?.deny) || !agent.tools.deny.includes("*")) {
      throw new Error("Recovery requires pinned Gemini 3.1 Pro and tool-free isolated agents");
    }
  }
  const { stdout: hostConfigOutput } = await runOpenClaw([
    "config",
    "get",
    "plugins.entries.stella-core.config",
    "--json",
  ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
  assertStellaHostConfig(JSON.parse(hostConfigOutput), {
    canghaiRoot,
    canghaiRevision: options["canghai-revision"],
    agentId: targetAgentId,
  });
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

  const installedPlugin = await import(
    `${pathToFileURL(path.join(installedRoot, "dist/src/plugin.js")).href}?private=${Date.now()}`,
  );
  const installedRecovery = await import(
    `${pathToFileURL(path.join(installedRoot, "dist/src/acceptance/recovery-drill.js")).href}?private=${Date.now()}`,
  );
  const { runExactHostEvaluationChat } = await import(pathToFileURL(path.join(installedRoot, "dist/src/acceptance/exact-host-chat.js")).href);
  const { GatewayClient } = await import(pathToFileURL(path.join(consumerRoot, "node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js")).href);
  const observedTurns = [];
  const runObservations = [];
  const gateway = await startExactHostGateway({
    cwd: consumerRoot,
    env: hostEnv,
    openclawBin,
  });

  let client;
  const listeners = new Set();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("recovery_gateway_connection_timeout")), 15_000);
      client = new GatewayClient({
        url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
        env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"],
        sharedStateMode: "read-only", deviceIdentity: null,
        onHelloOk() { clearTimeout(timer); resolve(); },
        onConnectError() { clearTimeout(timer); reject(new Error("recovery_gateway_connection_failed")); },
        onEvent(event) { for (const listener of listeners) listener(event); },
      });
      client.start();
    });
    const chat = (agentId, message) => {
      const id = randomUUID();
      return runExactHostEvaluationChat({
        request: async (method, params) => {
          const response = await client.request(method, params, { timeoutMs: 35_000 });
          // Host error prose may contain prompts or secrets. Record only the
          // protocol state and explicit machine categories, never raw prose.
          const safeCategory = (value) => typeof value === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : null;
          runObservations.push({ method, runId: response.runId, status: response.status,
            startedAt: response.startedAt, endedAt: response.endedAt,
            timeoutPhase: safeCategory(response.timeoutPhase), stopReason: safeCategory(response.stopReason),
            livenessState: safeCategory(response.livenessState), providerStarted: response.providerStarted,
            errorCategory: safeCategory(response.error), errorPresent: response.error != null,
            terminalReceiptPresent: response.terminalReceipt != null, terminalReplyPresent: response.terminalReply != null });
          await writeFile(path.join(isolatedRoot, "run-observations.json"), JSON.stringify(runObservations, null, 2), { mode: 0o600 });
          return response;
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      }, { sessionKey: `agent:${agentId}:recovery-${id}`, message, idempotencyKey: id });
    };
    const report = await installedRecovery.runRecoveryDrill({
      canghaiRoot,
      recoveryRevision: options["canghai-revision"],
      coreVersion: installedPlugin.STELLA_CORE_COMPATIBILITY_VERSION,
      hostVersion,
      rebuild: harness.rebuild,
      completeEvidence: async ({ prompt }) => {
        if (typeof harness.evidenceAgentId !== "string" || !/^[a-z0-9-]+$/.test(harness.evidenceAgentId) ||
          harness.evidenceAgentId === targetAgentId) throw new Error("recovery_evidence_agent_required");
        return chat(harness.evidenceAgentId, prompt);
      },
      verifyContinuity: async (input) => {
        for (const probe of harness.probes) {
          try {
            const turn = await chat(targetAgentId, probe.message);
            observedTurns.push({
              id: probe.id,
              runId: turn.runId,
              output: turn.text,
            });
          } catch (error) {
            await writeFile(path.join(isolatedRoot, "probe-failure.json"), JSON.stringify({ probeId: probe.id,
              category: /^evaluation_chat_[a-z_]+$/.test(error?.message ?? "") ? error.message : "recovery_probe_failed",
              preparationCategories: [...gateway.diagnostics().matchAll(/Stella turn preparation failed: ([a-z][a-z0-9_]{0,95})/g)].map((match) => match[1]),
              requestNotResubmitted: true, runObservations }, null, 2), { mode: 0o600 });
            throw new Error(`Exact Host recovery probe ${probe.id} failed; no resubmission`);
          }
        }
        await writeFile(path.join(isolatedRoot, "probe-observations.private.json"), JSON.stringify(observedTurns), { mode: 0o600 });
        await writeFile(path.join(isolatedRoot, "assessment-diagnostics.json"), JSON.stringify({ diagnostics: gateway.diagnostics() }), { mode: 0o600 });
        return harness.verifyContinuity(input, { observedTurns, hostEnv: gateway.env,
          runJudge: (prompt) => chat(harness.evidenceAgentId, prompt) });
      },
    });
    if (report.schemaVersion !== "stella.recovery-drill/v2" || typeof report.memoryGeneration !== "string" || !report.memoryGeneration) {
      throw new Error("recovery_artifact_contract_migration_required");
    }
    await inspectCleanSource("Restored CangHai after probes", canghaiRoot, options["canghai-revision"]);
    await inspectCleanSource("Original CangHai after probes", sourceRoot, options["canghai-revision"]);
    await writeFile(path.join(isolatedRoot, "continuity-evidence.json"), JSON.stringify({ report, observedTurns,
      continuityPolicy: harness.continuityPolicy }, null, 2), { mode: 0o600 });

    const receipt = {
      schemaVersion: "stella.exact-host-recovery-receipt/v2",
      hostCompatibility,
      coreRevision,
      canghaiRevision: options["canghai-revision"],
      hostVersion,
      artifactSha256,
      canghaiFixture: "private",
      cleanRuntimeState: true,
      importedLegacyRuntime: false,
      sourceCloneVerified: true,
      transport: "chat.send",
      nativeFinalsBound: true,
      runtimeEpisodeContract: "stella.praxis-episode/v2",
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
    await client?.stopAndWait({ timeoutMs: 2_000 });
    await gateway.stop();
  }
}
