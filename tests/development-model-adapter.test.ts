import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("isolated adapter migrates both agents to Flash without restoring sampling or weakening isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-model-adapter-"));
  try {
    const installed = path.join(root, "node_modules/@tower1229/stella-core/dist/src/openclaw");
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(path.join(installed, "completion.js"), "export const PREPARATION_HOOK_TIMEOUT_MS = 12345;");
    await writeFile(path.join(root, "adapter.mjs"), await readFile("scripts/templates/v2-recovery-adapter.mjs"));
    await writeFile(path.join(root, "alpha-adapter.mjs"), 'export async function createEvaluationHarness() { return { judgeAgentId: "judge" }; }');
    const { createEvaluationHarness } = await import(pathToFileURL(path.join(root, "adapter.mjs")).href);
    const agent = { model: "google/previous-model", skills: [] as string[], tools: { deny: ["*"] },
      params: { temperature: 0, topP: 0.9, maxTokens: 1024 } };
    const config = {
      models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-key", models: [] } } },
      agents: { defaults: { model: { primary: "google/previous-model", fallbacks: ["google/previous-model"] },
        models: { "google/previous-model": { params: { temperature: 0, candidateCount: 1, maxTokens: 2048 } } } },
        entries: { main: structuredClone(agent), judge: structuredClone(agent) } },
      plugins: { entries: { "stella-core": { hooks: { timeouts: { before_prompt_build: 1 } } } } },
    };
    const configPath = path.join(root, "openclaw.json");
    const context = { consumerRoot: root, agentId: "main", runtimeStateRoot: root, hostEnv: { OPENCLAW_CONFIG_PATH: configPath } };
    await writeFile(configPath, JSON.stringify(config));
    await createEvaluationHarness(context);
    const result = JSON.parse(await readFile(configPath, "utf8"));
    const modelRef = "google/gemini-3.8-flash";
    assert.equal(result.agents.defaults.model, modelRef);
    assert.equal(result.agents.defaults.thinkingDefault, "low");
    assert.deepEqual(result.agents.defaults.models[modelRef].params, { maxTokens: 2048 });
    for (const id of ["main", "judge"]) {
      assert.equal(result.agents.entries[id].model, modelRef);
      assert.deepEqual(result.agents.entries[id].params, { maxTokens: 1024 });
      assert.deepEqual(result.agents.entries[id].tools.deny, ["*"]);
    }
    assert.equal(result.models.providers.google.apiKey, "synthetic-key");
    assert.equal(result.models.providers.google.models[0].id, "gemini-3.8-flash");
    assert.equal(result.plugins.entries["stella-core"].hooks.timeouts.before_prompt_build, 12345);
    for (const invalid of [
      { ...config, agents: { ...config.agents, entries: { ...config.agents.entries, judge: { ...agent, skills: ["unexpected"] } } } },
      { ...config, agents: { ...config.agents, entries: { ...config.agents.entries, judge: { ...agent, tools: { deny: [] } } } } },
      { ...config, models: { providers: {} } },
    ]) {
      const bytes = JSON.stringify(invalid);
      await writeFile(configPath, bytes);
      await assert.rejects(createEvaluationHarness(context), /v2_acceptance_requires_/);
      assert.equal(await readFile(configPath, "utf8"), bytes, "Failed migration must not rewrite the configuration");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
