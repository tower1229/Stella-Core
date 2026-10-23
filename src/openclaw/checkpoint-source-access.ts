import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds, resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { CatalogError } from "../canghai/catalog-reader.js";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../canghai/personal-context-access.js";
import { canonicalJson } from "../canghai/content-version.js";
import type { SourceAccessProvider } from "../canghai/source-access.js";
import type { PolicyPurpose } from "../canghai/source-policy.js";
import type { BoundTurnRequest } from "./turn-request.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Adapt an admitted stock Host owner request to the existing source-specific
 * policy evaluator. The processing grant authorizes metadata, not the original.
 * No model-supplied identity, scenario, quote grant or policy override is accepted.
 */
export async function createCheckpointSourceAccess(input: {
  api: OpenClawPluginApi; agentId: string; root: string; bindingPath?: string;
  request: BoundTurnRequest; purpose: PolicyPurpose; signal: AbortSignal;
  assertCurrent: () => Promise<void>;
}): Promise<SourceAccessProvider | undefined> {
  if (!input.bindingPath) return undefined;
  const model = () => {
    const cfg = structuredClone(input.api.runtime.config.current()) as OpenClawConfig;
    const entry = cfg.agents?.entries?.[input.agentId] ?? cfg.agents?.list?.find(agent => agent.id === input.agentId);
    for (const value of [cfg.agents?.defaults?.model, entry?.model]) {
      check(typeof value !== "object" || value === null || !value.fallbacks?.length, "checkpoint_source_fallback_forbidden");
    }
    const selected = resolveDefaultModelForAgent({ cfg, agentId: input.agentId });
    const agents = listAgentIds(cfg), systemAgent = cfg.agents?.defaults?.systemAgent?.agentId;
    return { ref: `${selected.provider}/${selected.model}`,
      implicitAgent: agents.length === 1 && agents[0] === input.agentId && (!systemAgent || systemAgent === input.agentId) };
  };
  const selected = model(), modelRef = selected.ref, processing = await loadPersonalContextAccess(input.root, input.bindingPath);
  check(canonicalJson(processing.config.purpose) === canonicalJson(input.purpose), "personal_context_purpose_mismatch");
  const current = async () => {
    input.signal.throwIfAborted();
    await input.assertCurrent();
    input.signal.throwIfAborted();
    check(canonicalJson(model()) === canonicalJson(selected), "personal_context_model_changed");
  };
  await current();
  return createPersonalContextAccess({ request: input.request, modelRef, binding: processing,
    assertRequestCurrent: current, reuseWithinRequest: true, signal: input.signal,
    async complete({ prompt, maxTokens }) {
      await current();
      // A sole matching Host owner needs no target/model override. A different
      // or ambiguous fleet still goes through the Host's explicit-agent policy.
      const result = await input.api.runtime.llm.complete({ ...selected.implicitAgent ? {} : { agentId: input.agentId },
        purpose: "stella-source-access", reasoning: "low", maxTokens, signal: input.signal,
        messages: [{ role: "user", content: prompt }] });
      await current();
      check(result.agentId === input.agentId && `${result.provider}/${result.model}` === modelRef &&
        result.execution.mode === "direct-provider", "personal_context_model_mismatch");
      return { text: result.text };
    },
  });
}
