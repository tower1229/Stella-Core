import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parsePraxisEvaluationSuite,
  parsePraxisEvaluationSuiteFragment,
  runPraxisEvaluation,
} from "../dist/src/acceptance/praxis-evaluation.js";
import { createModelPraxisEvaluator } from "../dist/src/acceptance/model-praxis-evaluator.js";
import {
  buildExactHostAgentArguments,
  parseExactHostAgentOutput,
} from "../dist/src/acceptance/exact-host-agent.js";
import {
  assertStellaHostConfig,
  parseExactHostRecoveryReceipt,
  parseExactHostVersion,
} from "../dist/src/acceptance/exact-host-evidence.js";
import { parseRequiredArguments } from "./lib/cli-args.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const options = parseRequiredArguments(
  process.argv.slice(2),
  ["suite", "adapter", "recovery-receipt", "output"],
  "Usage: --suite <json> [--private-suite <json> --artifact <tgz> --canghai-root <path>] --adapter <module> --recovery-receipt <json> --output <json>",
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
  for (const key of ["artifact", "canghai-root"]) {
    if (!options[key]) throw new Error(`Private Praxis evaluation requires --${key}`);
  }
  if (recoveryReceipt.canghaiFixture !== "private" || recoveryReceipt.cleanRuntimeState !== true) {
    throw new Error("Private Praxis evaluation requires a clean private recovery receipt");
  }
  const artifactPath = path.resolve(options.artifact);
  const canghaiRoot = path.resolve(options["canghai-root"]);
  await Promise.all([
    inspectSource("Core", projectRoot, execution.coreRevision),
    inspectSource("CangHai", canghaiRoot, execution.canghaiRevision),
  ]);
  if (await hashFile(artifactPath) !== execution.artifactSha256) {
    throw new Error("Evaluation artifact does not match the recovery receipt");
  }
  if (typeof adapter.createEvaluationHarness !== "function") {
    throw new Error("Private Praxis adapter must export createEvaluationHarness(context)");
  }

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "stella-private-evaluation-"));
  try {
    const consumerRoot = path.join(isolatedRoot, "consumer");
    const runtimeStateRoot = path.join(isolatedRoot, "openclaw-state");
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "stella-private-evaluation", private: true })}\n`,
    );
    await execFileAsync("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifactPath,
      `openclaw@${execution.hostVersion}`,
    ], { cwd: consumerRoot });
    const openclawBin = path.join(consumerRoot, "node_modules/.bin/openclaw");
    const hostEnv = { OPENCLAW_STATE_DIR: runtimeStateRoot };
    const { stdout: versionOutput } = await execFileAsync(openclawBin, ["--version"], {
      cwd: consumerRoot,
      env: { ...process.env, ...hostEnv },
    });
    parseExactHostVersion(versionOutput);
    await execFileAsync(openclawBin, [
      "plugins",
      "install",
      artifactPath,
      "--force",
      "--accept-capabilities",
    ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    const harness = await adapter.createEvaluationHarness({
      artifactPath,
      canghaiRoot,
      canghaiRevision: execution.canghaiRevision,
      consumerRoot,
      coreRevision: execution.coreRevision,
      hostEnv,
      hostVersion: execution.hostVersion,
      openclawBin,
      runtimeStateRoot,
    });
    if (
      typeof harness?.answerAgentId !== "string" ||
      !harness.answerAgentId.trim() ||
      typeof harness?.judgeAgentId !== "string" ||
      !harness.judgeAgentId.trim()
    ) {
      throw new Error("Private evaluation harness must provide answerAgentId and judgeAgentId");
    }
    const { stdout: hostConfigOutput } = await execFileAsync(openclawBin, [
      "config",
      "get",
      "plugins.entries.stella-core.config",
      "--json",
    ], { cwd: consumerRoot, env: { ...process.env, ...hostEnv } });
    assertStellaHostConfig(JSON.parse(hostConfigOutput), {
      canghaiRoot,
      canghaiRevision: execution.canghaiRevision,
      agentId: harness.answerAgentId,
    });
    let judgeIndex = 0;
    const runTurn = async (agentId, sessionKey, message) => {
      const result = await execFileAsync(
        openclawBin,
        buildExactHostAgentArguments({ agentId, message, sessionKey }),
        { cwd: consumerRoot, env: { ...process.env, ...hostEnv }, maxBuffer: 4 * 1024 * 1024 },
      );
      return parseExactHostAgentOutput(result.stdout, sessionKey);
    };
    return runPraxisEvaluation(
      cases,
      createModelPraxisEvaluator({
        answerCase: (evaluationCase) => runTurn(
          harness.answerAgentId,
          `agent:${harness.answerAgentId}:alpha-eval-${evaluationCase.id}`,
          evaluationCase.prompt,
        ),
        judge: async (prompt) => ({
          text: await runTurn(
            harness.judgeAgentId,
            `agent:${harness.judgeAgentId}:alpha-judge-${++judgeIndex}`,
            prompt,
          ),
        }),
      }),
      execution,
    );
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
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
    createModelPraxisEvaluator({ answerCase: adapter.answerCase, judge: adapter.judge }),
    execution,
  );
}
const outputPath = path.resolve(options.output);
await mkdir(path.dirname(outputPath), { recursive: true });
const stagingPath = `${outputPath}.${process.pid}.staging`;
await writeFile(stagingPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(stagingPath, outputPath);
process.stdout.write(`${JSON.stringify({ output: outputPath, ...report })}\n`);
