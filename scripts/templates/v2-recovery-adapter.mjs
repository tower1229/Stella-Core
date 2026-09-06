// Materialize beside the preserved alpha-adapter.mjs in a private staging copy.
// The legacy adapter is reused only to configure isolated Host credentials/agents.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createEvaluationHarness as configureLegacyHost } from "./alpha-adapter.mjs";

async function configure(context) {
  const harness = await configureLegacyHost(context);
  const configPath = context.hostEnv.OPENCLAW_CONFIG_PATH ?? path.join(context.runtimeStateRoot, "openclaw.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  for (const id of [context.agentId, harness.judgeAgentId]) {
    const agent = config.agents?.entries?.[id];
    if (agent?.model !== "google/gemini-3.1-pro-preview" || !Array.isArray(agent.skills) || agent.skills.length ||
      !Array.isArray(agent.tools?.deny) || !agent.tools.deny.includes("*") ||
      (agent.params?.temperature !== undefined && agent.params.temperature !== 0)) {
      throw new Error("v2_acceptance_requires_exact_Gemini_and_isolated_agents");
    }
  }
  const model = config.agents.defaults.models["google/gemini-3.1-pro-preview"];
  model.params = { ...model.params, temperature: 0 };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return harness;
}

export async function createEvaluationHarness(context) { return configure(context); }

export async function createRecoveryHarness(context) {
  const configured = await configure(context);
  const installed = path.join(context.consumerRoot, "node_modules/@tower1229/stella-core/dist/src");
  const { loadConsciousness } = await import(pathToFileURL(path.join(installed, "canghai/manifest.js")).href);
  const { loadContinuitySuite } = await import(pathToFileURL(path.join(installed, "acceptance/continuity-suite.js")).href);
  const loaded = await loadConsciousness(context.canghaiRoot, undefined, {
    recoveryRevision: context.canghaiRevision, coreVersion: "3.0.0-alpha.0", openclawVersion: context.hostVersion, dataMode: "read_only",
  });
  const suiteRef = loaded.manifest.evaluation?.continuitySuiteRef;
  if (!suiteRef) throw new Error("continuity_suite_not_declared");
  const suite = await loadContinuitySuite(context.canghaiRoot, suiteRef);
  const { parse } = createRequire(path.join(context.consumerRoot, "package.json"))("yaml");
  const { parseRuntimeProfile } = await import(pathToFileURL(path.join(installed, "canghai/runtime-profile.js")).href);
  const profile = parseRuntimeProfile(parse(loaded.bootstrapDocuments.find((document) => document.field === "identity.runtimeProfileRef")?.content ?? ""));
  if (suite.requiredCapabilities.some((id) => !profile.capabilities.some((capability) => capability.id === id && capability.required))) {
    throw new Error("continuity_required_capability_not_declared");
  }
  return {
    continuityPolicy: { suiteId: suite.id, suiteVersion: suite.version, judge: suite.judgePolicy },
    evidenceAgentId: configured.judgeAgentId,
    probes: suite.probes.map(({ id, message }) => ({ id, message })),
    async rebuild() {
      // The old fallback wrote only hashes and called every unknown target rebuilt.
      // Actual recipe/Host adapters must be supplied before recovery can succeed.
      throw new Error("declared_view_recipe_adapter_required");
    },
    async verifyContinuity(input, { observedTurns, runJudge }) {
      if (typeof runJudge !== "function") throw new Error("native_chat_judge_required");
      const { judgeRecoveryContinuity } = await import(pathToFileURL(path.join(installed, "acceptance/continuity-judgment.js")).href);
      return judgeRecoveryContinuity({
        recoveryRevision: context.canghaiRevision,
        documents: input.loaded.bootstrapDocuments,
        memory: input.memory,
        probes: suite.probes.map(({ id, required, rubric }) => ({ id, required, rubric })),
        observedTurns,
      }, runJudge);
    },
  };
}

export async function createPraxisLoopHarness() {
  throw new Error("original_action_outcome_mapping_required; legacy generated feedback replay is disabled");
}
