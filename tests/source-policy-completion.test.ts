import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createSourcePolicyCompletion } from "../src/ordinary-plugin.js";

function setup(change: (cfg: any) => void = () => {}) {
  const cfg: any = { agents: { defaults: { model: { primary: "google/gemini-3.8-flash", fallbacks: [] } }, entries: { main: {} } } };
  change(cfg);
  const requests: any[] = [];
  let denied = false;
  const response: any = { text: "synthetic-policy-verdict", agentId: "main", provider: "google", model: "gemini-3.8-flash", execution: { mode: "direct-provider" } };
  const complete = createSourcePolicyCompletion({ runtime: { config: { current: () => cfg }, llm: {
    complete: async (request: unknown) => { requests.push(request); if (denied) throw Error("LLM_COMPLETION_NOT_AUTHORIZED"); return response; },
  } } } as unknown as OpenClawPluginApi, "main");
  return { complete, requests, response, deny() { denied = true; } };
}
const input = { prompt: "A fictional source-policy question", maxTokens: 192 };

test("proven native main/default Gemini completes without requesting model or agent overrides", async () => {
  for (const change of [() => {}, (cfg: any) => { cfg.agents.entries.other = {}; cfg.agents.defaults.systemAgent = { agentId: "main" }; }]) {
    const f = setup(change), abort = new AbortController();
    assert.deepEqual(await f.complete({ ...input, signal: abort.signal }), { text: "synthetic-policy-verdict" });
    assert.deepEqual(f.requests, [{ purpose: "stella-source-access", reasoning: "low", maxTokens: 192, signal: abort.signal,
      messages: [{ role: "user", content: input.prompt }] }]);
    assert.equal(Object.hasOwn(f.requests[0], "agentId"), false); assert.equal(Object.hasOwn(f.requests[0], "model"), false);
    assert.equal(Object.hasOwn(f.requests[0], "temperature"), false);
  }
});

test("unknown owner, ambiguous fleet, wrong default and any configured fallback fail before completion", async () => {
  for (const change of [
    (cfg: any) => { cfg.agents.entries = { other: {} }; },
    (cfg: any) => { cfg.agents.entries.other = {}; },
    (cfg: any) => { cfg.agents.defaults.systemAgent = { agentId: "other" }; },
    (cfg: any) => { cfg.agents.defaults.model.primary = "google/old-model"; },
    (cfg: any) => { cfg.agents.entries.main.model = "google/old-model"; },
    (cfg: any) => { delete cfg.agents.defaults.model; },
    (cfg: any) => { cfg.agents.defaults.model.fallbacks = ["google/gemini-3.8-flash"]; },
    (cfg: any) => { cfg.agents.entries.main.model = { primary: "google/gemini-3.8-flash", fallbacks: ["google/old-model"] }; },
  ]) {
    const f = setup(change); await assert.rejects(f.complete(input)); assert.equal(f.requests.length, 0);
  }
});

test("Host denial is propagated once; no fallback or override permission is introduced", async () => {
  const f = setup(); f.deny(); await assert.rejects(f.complete(input), /LLM_COMPLETION_NOT_AUTHORIZED/);
  assert.equal(f.requests.length, 1);
  assert.equal(Object.keys(f.requests[0]).some(k => k.includes("Override") || k.includes("fallback")), false);
});

test("returned agent, model and execution route must still match the admitted source-policy target", async () => {
  for (const change of [
    { agentId: "other" }, { provider: "other" }, { model: "old-model" }, { execution: { mode: "subagent" } },
  ]) {
    const f = setup(); Object.assign(f.response, change);
    await assert.rejects(f.complete(input), /personal_context_model_mismatch/); assert.equal(f.requests.length, 1);
  }
});
