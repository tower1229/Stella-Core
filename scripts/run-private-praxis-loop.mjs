import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRequiredArguments } from "./lib/cli-args.mjs";
import {
  buildExactHostAgentArguments,
  parseExactHostAgentTurn,
} from "../dist/src/acceptance/exact-host-agent.js";
import { ALPHA_HOST_VERSION } from "../dist/src/acceptance/exact-host-evidence.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const episodeRootRelative = "30_PersonalData/praxis/episodes";
const options = parseRequiredArguments(
  process.argv.slice(2),
  ["canghai-root", "canghai-revision", "artifact", "adapter", "output"],
  "Usage: --canghai-root <path> --canghai-revision <sha> --artifact <tgz> --adapter <module> --output <json>",
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
  const entries = await readdir(path.join(canghaiRoot, episodeRootRelative), {
    withFileTypes: true,
  });
  return new Set(entries
    .filter((entry) => entry.isDirectory() && /^praxis-[a-zA-Z0-9_-]+$/u.test(entry.name))
    .map((entry) => entry.name));
}

async function readEpisode(canghaiRoot, id) {
  const directory = path.join(canghaiRoot, episodeRootRelative, id);
  const [episodeText, predictionText] = await Promise.all([
    readFile(path.join(directory, "episode.json"), "utf8"),
    readFile(path.join(directory, "prediction.json"), "utf8"),
  ]);
  return {
    episode: JSON.parse(episodeText),
    predictionHash: sha256(predictionText),
  };
}

function validateHarness(harness) {
  if (
    harness?.agentId !== "main" ||
    typeof harness.problemMessage !== "string" ||
    !harness.problemMessage.trim() ||
    typeof harness.createOutcomeMessage !== "function" ||
    typeof harness.createSimilarProblemMessage !== "function" ||
    typeof harness.verifyLearningUse !== "function"
  ) {
    throw new Error("Praxis loop harness must provide three private turns and verifyLearningUse");
  }
}

async function runPrivateTurn({ openclawBin, consumerRoot, env, message, sessionKey, label }) {
  try {
    const result = await execFileAsync(
      openclawBin,
      buildExactHostAgentArguments({ agentId: "main", message, sessionKey }),
      { cwd: consumerRoot, env, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseExactHostAgentTurn(result.stdout, label).text;
  } catch (error) {
    const stdout = `${error?.stdout ?? ""}`;
    const output = `${stdout}\n${error?.stderr ?? ""}`;
    const category = /(?:api key|unauthorized|authentication|\b401\b|\b403\b)/iu.test(output)
      ? "provider_authentication"
      : /(?:model[^\n]{0,80}(?:not found|unavailable)|\b404\b)/iu.test(output)
        ? "model_unavailable"
        : /(?:unknown agent|agent[^\n]{0,80}(?:not found|not configured|does not exist))/iu.test(output)
          ? "agent_unavailable"
          : /(?:message could not be sent|stella turn admission|stella[_ ]core|canghai|recovery revision)/iu.test(output)
          ? "stella_preparation"
            : /(?:provider|model)/iu.test(output)
              ? "provider_execution"
              : /(?:eperm|eacces|permission denied)/iu.test(output)
                ? "filesystem_permission"
                : /(?:invalid config|configuration|schema)/iu.test(output)
                  ? "host_configuration"
                  : /(?:timed out|timeout)/iu.test(output)
                    ? "timeout"
                    : /(?:econnrefused|gateway)/iu.test(output)
                      ? "gateway"
                      : output.trim()
                        ? "host_error"
                        : "process_error";
    let envelope = "unparsed";
    const jsonStart = Math.max(stdout.lastIndexOf("\n{"), stdout.trimStart().startsWith("{") ? 0 : -1);
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(stdout.slice(jsonStart === 0 ? 0 : jsonStart + 1).trim());
        const safeToken = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value)
          ? value
          : undefined;
        const status = safeToken(parsed.status);
        const code = safeToken(parsed.error?.code) ?? safeToken(parsed.error?.category) ??
          safeToken(parsed.result?.error?.code) ?? safeToken(parsed.result?.error?.category);
        const errorMessage = typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.error?.message === "string"
            ? parsed.error.message
            : undefined;
        const safeError = errorMessage
          ? errorMessage
            .replaceAll(message, "<private-message>")
            .replace(/https?:\/\/\S+/giu, "<url>")
            .replace(/\/(?:Users|private|var|tmp)\/\S+/gu, "<path>")
            .replace(/[a-zA-Z0-9_=-]{32,}/gu, "<token>")
            .slice(0, 300)
          : undefined;
        envelope = [
          `keys=${Object.keys(parsed).sort().join(",")}`,
          ...(status ? [`status=${status}`] : []),
          ...(code ? [`code=${code}`] : []),
          ...(parsed.error && typeof parsed.error === "object"
            ? [`errorKeys=${Object.keys(parsed.error).sort().join(",")}`]
            : []),
          ...(safeError ? [`error=${safeError}`] : []),
        ].join(";");
      } catch {
        envelope = "invalid-json";
      }
    }
    throw new Error(`Exact Host private Praxis turn failed: ${label} (${category};${envelope})`);
  }
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
const artifactSha256 = await hashFile(artifactPath);
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
  await execFileAsync("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    artifactPath,
    `openclaw@${ALPHA_HOST_VERSION}`,
  ], { cwd: consumerRoot });
  const openclawBin = await realpath(path.join(consumerRoot, "node_modules/.bin/openclaw"));
  const hostEnv = { OPENCLAW_STATE_DIR: runtimeStateRoot };
  const commandEnv = { ...process.env, ...hostEnv };
  const version = (await execFileAsync(openclawBin, ["--version"], {
    cwd: consumerRoot,
    env: commandEnv,
  })).stdout.trim();
  if (!version.includes(ALPHA_HOST_VERSION)) {
    throw new Error(`Private Praxis loop requires OpenClaw ${ALPHA_HOST_VERSION}`);
  }
  await execFileAsync(openclawBin, [
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
    agentId: "main",
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
    recommendationAnswer = await runPrivateTurn({
      openclawBin,
      consumerRoot,
      env: gateway.env,
      message: harness.problemMessage,
      sessionKey: "agent:stella:private-praxis-problem",
      label: "problem",
    });
    const afterRecommendationIds = await listEpisodeIds(canghaiRoot);
    const createdIds = [...afterRecommendationIds].filter((id) => !initialEpisodeIds.has(id));
    if (createdIds.length !== 1) {
      throw new Error("Problem turn must publish exactly one new Praxis Episode");
    }
    const episodeId = createdIds[0];
    const recommended = await readEpisode(canghaiRoot, episodeId);
    if (
      recommended.episode.status !== "recommended" ||
      typeof recommended.episode.decision?.recommendation !== "string" ||
      !recommended.episode.decision.recommendation.trim() ||
      recommended.episode.actual !== undefined ||
      recommended.episode.outcome !== undefined ||
      recommended.episode.learning !== undefined
    ) {
      throw new Error("Problem turn did not persist a valid recommended Episode");
    }

    const episodeRef = `path:${episodeRootRelative}/${episodeId}/episode.json`;
    const outcomeMessage = await harness.createOutcomeMessage({
      episodeRef,
      recommendation: recommended.episode.decision.recommendation,
    });
    if (typeof outcomeMessage !== "string" || !outcomeMessage.trim()) {
      throw new Error("Private Praxis harness returned an invalid outcome turn");
    }
    outcomeAnswer = await runPrivateTurn({
      openclawBin,
      consumerRoot,
      env: gateway.env,
      message: outcomeMessage,
      sessionKey: "agent:stella:private-praxis-outcome",
      label: "outcome",
    });
    const closed = await readEpisode(canghaiRoot, episodeId);
    if (
      closed.predictionHash !== recommended.predictionHash ||
      closed.episode.status !== "closed" ||
      typeof closed.episode.actual?.action !== "string" ||
      !closed.episode.actual.action.trim() ||
      typeof closed.episode.outcome?.result !== "string" ||
      !closed.episode.outcome.result.trim() ||
      !Array.isArray(closed.episode.learning?.praxis) ||
      closed.episode.learning.praxis.length === 0
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
    const similarAnswer = await runPrivateTurn({
      openclawBin,
      consumerRoot,
      env: gateway.env,
      message: similarProblemMessage,
      sessionKey: "agent:stella:private-praxis-similar",
      label: "similar-problem",
    });
    const finalEpisodeIds = await listEpisodeIds(canghaiRoot);
    const followupIds = [...finalEpisodeIds].filter(
      (id) => !initialEpisodeIds.has(id) && id !== episodeId,
    );
    if (followupIds.length !== 1) {
      throw new Error("Similar problem turn must publish exactly one follow-up Episode");
    }
    const followup = await readEpisode(canghaiRoot, followupIds[0]);
    const learningRef = `${episodeRef}#learning:praxis:0`;
    if (
      followup.episode.status !== "recommended" ||
      followup.episode.sourceSnapshot?.[learningRef] === undefined ||
      !followup.episode.reality?.similarEpisodeRefs?.includes(learningRef)
    ) {
      throw new Error("Similar problem did not select the newly persisted Praxis learning");
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
      schemaVersion: "stella.exact-host-praxis-receipt/v1",
      coreRevision,
      initialCanghaiRevision: options["canghai-revision"],
      finalCanghaiRevision: finalRevision,
      hostVersion: ALPHA_HOST_VERSION,
      artifactSha256,
      dataMode: "managed_durable_write",
      predictionSealedBeforeOutcome: true,
      recommendationPersisted: true,
      actualRecorded: true,
      outcomeClosed: true,
      learningPersisted: true,
      learningRetrievedAfterRestart: true,
      finalRevisionRemoteSynchronized: true,
      sourceClean: true,
      exactHostAgentTurns: 3,
      episodeRefHash: sha256(episodeRef),
      learningRefHash: sha256(learningRef),
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
