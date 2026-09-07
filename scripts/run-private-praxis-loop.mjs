import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRequiredArguments } from "./lib/cli-args.mjs";
import { runExactHostEvaluationChat } from "../dist/src/acceptance/exact-host-chat.js";
import { listPraxisEpisodeIds, readPraxisEpisodeState } from "../dist/src/acceptance/praxis-loop-state.js";
import { bytesVersion, canonicalJson } from "../dist/src/canghai/content-version.js";
import { readRecordedMemoryTransaction } from "../dist/src/canghai/memory-transaction.js";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { parseCangHaiRef } from "../dist/src/canghai/ref.js";
import { loadPraxisRuntimeBinding } from "../dist/src/praxis/runtime-binding.js";
import { CatalogReader } from "../dist/src/canghai/catalog-reader.js";
import { EpisodeEvidenceResolver } from "../dist/src/praxis/episode-evidence.js";
import { ALPHA_HOST_VERSION, parseExactHostRecoveryReceipt, parseExactHostVersion } from "../dist/src/acceptance/exact-host-evidence.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";
import { installHostCompatibility } from "./lib/install-host-compatibility.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let episodeRootRelative;
const targetAgentId = "main";
const options = parseRequiredArguments(
  process.argv.slice(2),
  ["canghai-root", "canghai-revision", "artifact", "adapter", "output"],
  "Usage: --canghai-root <path> --canghai-revision <sha> --artifact <tgz> --adapter <module> --output <json> [--recovery-receipt <json>]",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0) throw new Error("Praxis artifact must be non-empty");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function git(root, args) {
  return (await execFileAsync("git", ["-C", root, ...args])).stdout.trim();
}

async function assertCleanRevision(label, root, expectedRevision) {
  if (!/^[0-9a-f]{40}$/i.test(expectedRevision)) {
    throw new Error(`${label} revision must be a full Git commit SHA`);
  }
  const [revision, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain"]),
  ]);
  if (revision !== expectedRevision) throw new Error(`${label} HEAD does not match revision`);
  if (status) throw new Error(`${label} source must be clean`);
}

async function resolveRemoteRevision(root, remote, branch) {
  const output = await git(root, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
  const revision = output.split(/\s+/u)[0];
  if (!/^[0-9a-f]{40}$/i.test(revision ?? "")) {
    throw new Error("Managed CangHai remote branch did not resolve to a full SHA");
  }
  return revision;
}

async function listEpisodeIds(canghaiRoot) {
  return listPraxisEpisodeIds(canghaiRoot, episodeRootRelative);
}

async function waitForSingleCreatedEpisodeId(canghaiRoot, baselineIds, label) {
  const deadline = Date.now() + 90_000;
  do {
    const currentIds = await listEpisodeIds(canghaiRoot);
    const createdIds = [...currentIds].filter((id) => !baselineIds.has(id));
    if (createdIds.length === 1) return createdIds[0];
    if (createdIds.length > 1) {
      throw new Error(`${label} turn published more than one new Praxis Episode`);
    }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} turn did not publish a new Praxis Episode before timeout`);
}

async function waitForEpisode(canghaiRoot, id, predicate, label) {
  const deadline = Date.now() + 90_000;
  do {
    const episode = await readEpisode(canghaiRoot, id);
    if (predicate(episode)) return episode;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} Episode state was not persisted before timeout`);
}

async function readEpisode(canghaiRoot, id) {
  return readPraxisEpisodeState(canghaiRoot, episodeRootRelative, id);
}

function validateHarness(harness) {
  if (
    harness?.agentId !== targetAgentId ||
    typeof harness.problemMessage !== "string" ||
    !harness.problemMessage.trim() ||
    typeof harness.createAdviceRevisionMessage !== "function" ||
    typeof harness.createOutcomeMessage !== "function" ||
    typeof harness.createSimilarProblemMessage !== "function" ||
    typeof harness.verifyLearningUse !== "function"
  ) {
    throw new Error("Praxis loop harness must provide four private turns, including an advice revision, and verifyLearningUse");
  }
}

async function runPrivateTurn({ openclawBin, env, message, sessionKey, label }) {
  const gatewayModule = path.join(path.dirname(openclawBin), "dist/plugin-sdk/gateway-runtime.js");
  const { GatewayClient } = await import(pathToFileURL(gatewayModule).href);
  const listeners = new Set();
  let client;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("praxis_gateway_connect_timeout")), 15000);
      client = new GatewayClient({ url: `ws://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}`, token: env.OPENCLAW_GATEWAY_TOKEN,
        env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
        onHelloOk() { clearTimeout(timer); resolve(); },
        onConnectError() { clearTimeout(timer); reject(new Error("praxis_gateway_connect_failed")); },
        onEvent(event) { for (const listener of listeners) listener(event); },
      });
      client.start();
    });
    const answer = await runExactHostEvaluationChat({
      request: (method, params) => client.request(method, params, { timeoutMs: 35000 }),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    }, { sessionKey, idempotencyKey: randomUUID(), message });
    return answer;
  } catch (error) {
    // The native error may contain the private question or model text.
    const category = error instanceof Error && /^(?:evaluation_chat|praxis_gateway)_[a-z_]+$/.test(error.message)
      ? error.message : "praxis_gateway_failed";
    throw new Error(`Exact Host private Praxis turn failed: ${label} (${category})`);
  } finally { await client?.stopAndWait({ timeoutMs: 2000 }); }
}

const canghaiRoot = path.resolve(options["canghai-root"]);
const artifactPath = path.resolve(options.artifact);
const adapterPath = path.resolve(options.adapter);
const outputPath = path.resolve(options.output);
const outputRelative = path.relative(projectRoot, outputPath);
if (!outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) {
  throw new Error("Private Praxis receipt must be written outside Stella Core");
}

const coreRevision = await git(projectRoot, ["rev-parse", "HEAD"]);
const artifactSha256 = await hashFile(artifactPath);
const recoveryReceipt = options["recovery-receipt"] ? parseExactHostRecoveryReceipt(JSON.parse(
  await readFile(path.resolve(options["recovery-receipt"]), "utf8"),
)) : undefined;
if (recoveryReceipt && (recoveryReceipt.coreRevision !== coreRevision ||
  recoveryReceipt.artifactSha256 !== artifactSha256 ||
  recoveryReceipt.canghaiRevision !== options["canghai-revision"] ||
  recoveryReceipt.canghaiFixture !== "private")) {
  throw new Error("Praxis inputs do not match the private recovery receipt");
}
await Promise.all([
  assertCleanRevision("Core", projectRoot, coreRevision),
  assertCleanRevision("CangHai", canghaiRoot, options["canghai-revision"]),
]);
const branch = await git(canghaiRoot, ["branch", "--show-current"]);
if (branch !== "local/stella-alpha") {
  throw new Error("Private Praxis loop requires CangHai branch local/stella-alpha");
}
const remote = "origin";
const initialRemoteRevision = await resolveRemoteRevision(canghaiRoot, remote, branch);
if (initialRemoteRevision !== options["canghai-revision"]) {
  throw new Error("Initial CangHai revision is not synchronized to origin/local/stella-alpha");
}
const source = await loadConsciousness(canghaiRoot);
episodeRootRelative = parseCangHaiRef(source.manifest.praxis.episodeRootRef).relativePath;
const initialEpisodeIds = await listEpisodeIds(canghaiRoot);
const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "stella-private-praxis-"));

try {
  const consumerRoot = path.join(isolatedRoot, "consumer");
  const runtimeStateRoot = path.join(isolatedRoot, "openclaw-state");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "stella-private-praxis", private: true })}\n`,
  );
  if (!process.env.npm_execpath) {
    throw new Error("npm CLI path is unavailable; run the private Praxis loop through npm");
  }
  await execFileAsync(process.execPath, [process.env.npm_execpath,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    artifactPath,
    `openclaw@${ALPHA_HOST_VERSION}`,
  ], { cwd: consumerRoot });
  if (recoveryReceipt?.hostCompatibility) {
    const installed = await installHostCompatibility(consumerRoot);
    await writeFile(path.join(isolatedRoot, "host-compatibility.json"), JSON.stringify(installed, null, 2));
  }
  const openclawBin = await realpath(path.join(consumerRoot, "node_modules/openclaw/openclaw.mjs"));
  const runOpenClaw = (args, commandOptions) =>
    execFileAsync(process.execPath, [openclawBin, ...args], commandOptions);
  const hostEnv = { OPENCLAW_STATE_DIR: runtimeStateRoot };
  const commandEnv = { ...process.env, ...hostEnv };
  const version = (await runOpenClaw(["--version"], {
    cwd: consumerRoot,
    env: commandEnv,
  })).stdout.trim();
  parseExactHostVersion(version);
  await runOpenClaw([
    "plugins",
    "install",
    artifactPath,
    "--force",
    "--accept-capabilities",
  ], { cwd: consumerRoot, env: commandEnv });

  const adapter = await import(`${pathToFileURL(adapterPath).href}?praxis=${Date.now()}`);
  if (typeof adapter.createPraxisLoopHarness !== "function") {
    throw new Error("Private adapter must export createPraxisLoopHarness(context)");
  }
  const harness = await adapter.createPraxisLoopHarness({
    artifactPath,
    artifactSha256,
    canghaiRoot,
    canghaiRevision: options["canghai-revision"],
    consumerRoot,
    hostEnv,
    hostVersion: ALPHA_HOST_VERSION,
    openclawBin,
    runtimeStateRoot,
    agentId: targetAgentId,
    dataMode: "managed_durable_write",
    durabilityRemote: remote,
    durabilityBranch: branch,
  });
  validateHarness(harness);

  const configText = await readFile(path.join(runtimeStateRoot, "openclaw.json"), "utf8");
  const pluginEntry = JSON.parse(configText).plugins?.entries?.["stella-core"];
  if (
    pluginEntry?.config?.canghaiRoot !== canghaiRoot ||
    pluginEntry?.config?.recoveryRevision !== options["canghai-revision"] ||
    pluginEntry?.config?.dataMode !== "managed_durable_write" ||
    pluginEntry?.config?.durabilityRemote !== remote ||
    pluginEntry?.config?.durabilityBranch !== branch ||
    pluginEntry?.llm?.allowAgentIdOverride !== true ||
    pluginEntry?.hooks?.allowConversationAccess !== true ||
    pluginEntry?.hooks?.allowPromptInjection !== true ||
    (pluginEntry?.hooks?.timeouts?.before_prompt_build ?? 0) < 60_000
  ) {
    throw new Error("Private Praxis Host configuration does not satisfy the managed-write contract");
  }

  let gateway = await startExactHostGateway({ cwd: consumerRoot, env: hostEnv, openclawBin });
  let recommendationAnswer;
  let outcomeAnswer;
  try {
    const recommendationTurn = await runPrivateTurn({
      openclawBin,
      consumerRoot,
      env: gateway.env,
      message: harness.problemMessage,
      sessionKey: `agent:${targetAgentId}:private-praxis-problem`,
      label: "problem",
    });
    recommendationAnswer = recommendationTurn.text;
    let episodeId;
    try {
      episodeId = await waitForSingleCreatedEpisodeId(canghaiRoot, initialEpisodeIds, "Problem");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "Problem turn finalization failed"}; diagnostics=${gateway.diagnostics() || "none"}`,
      );
    }
    let recommended = await readEpisode(canghaiRoot, episodeId);
    if (
      recommended.episode.status !== "recommended" ||
      typeof recommended.episode.decision?.recommendation !== "string" ||
      !recommended.episode.decision.recommendation.trim() ||
      recommended.episode.decision.recommendation !== recommendationAnswer ||
      recommended.episode.provenance.runId !== recommendationTurn.runId ||
      recommended.episode.actual !== undefined ||
      recommended.episode.outcome !== undefined ||
      recommended.episode.learning !== undefined
    ) {
      throw new Error("Problem turn did not persist a valid recommended Episode");
    }

    const episodeRef = `path:${episodeRootRelative}/${episodeId}/episode.json`;
    const originalRecommendation = recommended;
    const revisionMessage = await harness.createAdviceRevisionMessage({
      episodeRef, recommendation: recommended.episode.decision.recommendation,
    });
    if (typeof revisionMessage !== "string" || !revisionMessage.trim()) throw new Error("Private Praxis harness returned an invalid revision turn");
    const revisionTurn = await runPrivateTurn({ openclawBin, consumerRoot, env: gateway.env, message: revisionMessage,
      sessionKey: `agent:${targetAgentId}:private-praxis-revision`, label: "advice-revision" });
    recommended = await readEpisode(canghaiRoot, episodeId);
    const afterRevisionIds = await listEpisodeIds(canghaiRoot);
    if (recommended.version === originalRecommendation.version || recommended.episode.status !== "recommended" ||
        recommended.predictionHash !== originalRecommendation.predictionHash ||
        canonicalJson(recommended.episode.historicalInputRefs) !== canonicalJson(originalRecommendation.episode.historicalInputRefs) ||
        !recommended.episode.decision?.inputRefs?.length || recommended.episode.decision.recommendation !== revisionTurn.text ||
        recommended.episode.provenance.runId !== revisionTurn.runId ||
        afterRevisionIds.size !== initialEpisodeIds.size + 1 || [...initialEpisodeIds].some(id => !afterRevisionIds.has(id))) {
      throw new Error("Advice revision did not preserve the same matter and sealed history");
    }
    const outcomeMessage = await harness.createOutcomeMessage({
      episodeRef,
      recommendation: recommended.episode.decision.recommendation,
    });
    if (typeof outcomeMessage !== "string" || !outcomeMessage.trim()) {
      throw new Error("Private Praxis harness returned an invalid outcome turn");
    }
    const outcomeTurn = await runPrivateTurn({
      openclawBin,
      consumerRoot,
      env: gateway.env,
      message: outcomeMessage,
      sessionKey: `agent:${targetAgentId}:private-praxis-outcome`,
      label: "outcome",
    });
    outcomeAnswer = outcomeTurn.text;
    const closed = await waitForEpisode(
      canghaiRoot,
      episodeId,
      ({ episode }) => episode.status === "closed",
      "Outcome",
    );
    if (
      closed.predictionHash !== recommended.predictionHash ||
      closed.episode.status !== "closed" ||
      typeof closed.episode.actual?.action !== "string" ||
      !closed.episode.actual.action.trim() ||
      typeof closed.episode.outcome?.result !== "string" ||
      !closed.episode.outcome.result.trim() ||
      !closed.episode.learning ||
      [...closed.episode.learning.twin, ...closed.episode.learning.praxis].length === 0
    ) {
      throw new Error("Outcome turn did not atomically close the Episode with sealed learning");
    }

    await gateway.stop();
    gateway = undefined;
    const installedRoot = path.join(consumerRoot, "node_modules/@tower1229/stella-core");
    const { GitCangHaiDurability } = await import(
      `${pathToFileURL(path.join(installedRoot, "dist/src/canghai/durability.js")).href}?flush=${Date.now()}`
    );
    const durability = new GitCangHaiDurability({
      root: canghaiRoot,
      remote,
      branch,
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
    });
    await durability.flushNormal();

    gateway = await startExactHostGateway({ cwd: consumerRoot, env: hostEnv, openclawBin });
    const similarProblemMessage = await harness.createSimilarProblemMessage({
      episodeRef,
      learning: closed.episode.learning,
    });
    if (typeof similarProblemMessage !== "string" || !similarProblemMessage.trim()) {
      throw new Error("Private Praxis harness returned an invalid similar-problem turn");
    }
    const currentSource = await loadConsciousness(canghaiRoot);
    const currentBinding = await loadPraxisRuntimeBinding(currentSource);
    const outcomeOperationId = `outcome_${bytesVersion(outcomeTurn.runId).slice(7)}`;
    const outcomeJournal = await readRecordedMemoryTransaction(canghaiRoot, outcomeOperationId,
      path.posix.join(path.posix.dirname(currentBinding.catalogPath), "operations", `${outcomeOperationId}.transaction.json`));
    if (outcomeJournal.files.find(file => file.path === `${episodeRootRelative}/${episodeId}/episode.json`)?.after !== canonicalJson(closed.episode)) {
      throw new Error("Outcome completion does not match the native run transaction");
    }
    const reader = await CatalogReader.load(canghaiRoot, currentBinding.catalogPath);
    const resolver = new EpisodeEvidenceResolver(reader, { ...currentBinding.purpose, evidenceCutoff: new Date().toISOString(),
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
      async () => { throw new Error("Acceptance readback cannot manufacture action evidence"); });
    const reusable = [];
    for (const ref of [...closed.episode.learning.twin, ...closed.episode.learning.praxis]) {
      if (!reader.eligible(ref)) continue;
      const understanding = await reader.read(ref, "understandings");
      if (understanding.kind !== "strategy" || !["active", "contested"].includes(understanding.status)) continue;
      await resolver.resolveLearning(ref);
      reusable.push(ref);
    }
    if (!reusable.length) throw new Error("learning_not_eligible_for_reuse: candidate creation does not prove active learning");
    const afterOutcomeIds = await listEpisodeIds(canghaiRoot);
    const similarTurn = await runPrivateTurn({
      openclawBin,
      consumerRoot,
      env: gateway.env,
      message: similarProblemMessage,
      sessionKey: `agent:${targetAgentId}:private-praxis-similar`,
      label: "similar-problem",
    });
    const similarAnswer = similarTurn.text;
    const followupId = await waitForSingleCreatedEpisodeId(
      canghaiRoot,
      afterOutcomeIds,
      "Similar problem",
    );
    const followup = await readEpisode(canghaiRoot, followupId);
    const learningRefs = [...closed.episode.learning.twin, ...closed.episode.learning.praxis];
    const usedRefs = followup.episode.decision?.inputRefs ?? followup.episode.historicalInputRefs;
    if (followup.episode.status !== "recommended" || followup.episode.provenance.runId !== similarTurn.runId ||
        followup.episode.decision.recommendation !== similarAnswer || !learningRefs.some(ref =>
      usedRefs.some(used => used.id === ref.id && used.version === ref.version))) {
      throw new Error("Similar problem did not select the exact newly persisted learning version");
    }
    const verdict = await harness.verifyLearningUse({
      recommendationAnswer,
      outcomeAnswer,
      similarAnswer,
      episodeRef,
      learning: closed.episode.learning,
    }, { hostEnv: gateway.env });
    if (verdict?.accepted !== true) {
      throw new Error("Private verifier rejected next-turn learning use");
    }

    const finalRevision = await git(canghaiRoot, ["rev-parse", "HEAD"]);
    const [finalRemoteRevision, finalStatus] = await Promise.all([
      resolveRemoteRevision(canghaiRoot, remote, branch),
      git(canghaiRoot, ["status", "--porcelain"]),
    ]);
    if (finalRemoteRevision !== finalRevision || finalStatus) {
      throw new Error("Final CangHai revision is not clean and synchronized");
    }
    const finalConfig = JSON.parse(
      await readFile(path.join(runtimeStateRoot, "openclaw.json"), "utf8"),
    );
    if (finalConfig.plugins?.entries?.["stella-core"]?.config?.recoveryRevision !== finalRevision) {
      throw new Error("Persistent recovery pointer does not match final CangHai revision");
    }
    const finalDurability = new GitCangHaiDurability({
      root: canghaiRoot,
      remote,
      branch,
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
    });
    const finalDiagnostics = await finalDurability.diagnostics();
    if (
      finalDiagnostics.normalState !== "current" ||
      finalDiagnostics.synchronizedRevision !== finalRevision ||
      finalDiagnostics.criticalSynchronized !== true
    ) {
      throw new Error("Final durability diagnostics are not synchronized");
    }

    const receipt = {
      ...(recoveryReceipt?.hostCompatibility ? { hostCompatibility: recoveryReceipt.hostCompatibility } : {}),
      schemaVersion: "stella.exact-host-praxis-receipt/v2",
      episodeSchemaVersion: "stella.praxis-episode/v2",
      transport: "chat.send",
      adviceRevisionPersisted: true,
      predictionStatus: originalRecommendation.predictionHash === null ? "not_applicable" : "sealed",
      coreRevision,
      initialCanghaiRevision: options["canghai-revision"],
      finalCanghaiRevision: finalRevision,
      hostVersion: ALPHA_HOST_VERSION,
      artifactSha256,
      dataMode: "managed_durable_write",
      predictionSealedBeforeOutcome: originalRecommendation.predictionHash !== null,
      recommendationPersisted: true,
      actualRecorded: true,
      outcomeClosed: true,
      learningPersisted: true,
      learningRetrievedAfterRestart: true,
      finalRevisionRemoteSynchronized: true,
      sourceClean: true,
      exactHostAgentTurns: 4,
      episodeRefHash: sha256(episodeRef),
      learningRefHash: sha256(canonicalJson(learningRefs)),
      privateFixtureIncluded: true,
    };
    const installedPraxisReceipt = await import(
      `${pathToFileURL(path.join(installedRoot, "dist/src/acceptance/exact-host-praxis.js")).href}?receipt=${Date.now()}`
    );
    installedPraxisReceipt.parseExactHostPraxisReceipt(receipt);
    const stagingPath = `${outputPath}.${process.pid}.staging`;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(stagingPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(stagingPath, outputPath);
    const diagnosticsPath = path.join(path.dirname(outputPath), "durability-diagnostics.json");
    await writeFile(
      diagnosticsPath,
      `${JSON.stringify(finalDiagnostics, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({ output: outputPath, diagnostics: diagnosticsPath, ...receipt })}\n`);
  } finally {
    await gateway?.stop();
  }
} finally {
  await rm(isolatedRoot, { recursive: true, force: true });
}
