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
  const { PREPARATION_HOOK_TIMEOUT_MS } = await import(pathToFileURL(path.join(
    context.consumerRoot, "node_modules/@tower1229/stella-core/dist/src/openclaw/completion.js")).href);
  config.plugins.entries["stella-core"].hooks.timeouts.before_prompt_build = PREPARATION_HOOK_TIMEOUT_MS;
  const modelRef = "google/gemini-3.8-flash";
  const google = config.models?.providers?.google;
  if (google?.api !== "google-generative-ai" || !Array.isArray(google.models) ||
    !config.agents?.defaults?.models) throw new Error("v2_acceptance_requires_explicit_google_provider");
  const samplingKeys = ["temperature", "topP", "topK", "candidateCount", "frequencyPenalty", "presencePenalty",
    "top_p", "top_k", "candidate_count", "frequency_penalty", "presence_penalty"];
  const paramsForFlash = params => Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => !samplingKeys.includes(key)));
  for (const id of [context.agentId, harness.judgeAgentId]) {
    const agent = config.agents?.entries?.[id];
    if (!agent || !Array.isArray(agent.skills) || agent.skills.length ||
      !Array.isArray(agent.tools?.deny) || !agent.tools.deny.includes("*")) {
      throw new Error("v2_acceptance_requires_exact_Gemini_and_isolated_agents");
    }
    agent.model = modelRef;
    agent.params = paramsForFlash(agent.params);
  }
  const defaults = config.agents.defaults;
  const previousRef = typeof defaults.model === "string" ? defaults.model : defaults.model?.primary;
  const previous = defaults.models[modelRef] ?? defaults.models[previousRef] ?? {};
  defaults.models[modelRef] = { ...previous, params: paramsForFlash(previous.params) };
  defaults.model = modelRef;
  defaults.thinkingDefault = "low";
  google.models = google.models.filter(model => model.id !== "gemini-3.8-flash");
  google.models.push({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true, input: ["text"],
    cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536 });
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
