import { definePluginEntry, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { isRecord } from "./shared/type-guards.js";

export const CANDIDATE_TOOL = "stella_author_intent_candidate";
export const STATUS_TOOL = "stella_status";
const text = () => Type.String({ minLength: 1, maxLength: 4000 });
const list = () => Type.Array(text(), { maxItems: 16 });
export const CANDIDATE_PARAMETERS = Type.Object({
  topic: text(),
  interpretation: text(),
  proposedPremises: list(),
  openQuestions: list(),
  evidenceReferences: list(),
}, { additionalProperties: false });

type Proposal = {
  topic: string; interpretation: string; proposedPremises: string[];
  openQuestions: string[]; evidenceReferences: string[];
};
const keys = ["topic", "interpretation", "proposedPremises", "openQuestions", "evidenceReferences"];
function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4000;
}
function validList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16 && value.every(validText);
}
export function parseProposal(value: unknown): Proposal {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      !validText(value.topic) || !validText(value.interpretation) ||
      !validList(value.proposedPremises) || !validList(value.openQuestions) || !validList(value.evidenceReferences)) {
    throw new Error("stella_candidate_arguments_invalid");
  }
  return structuredClone(value) as Proposal;
}

export function parseOrdinaryConfig(value: unknown): { agentId: string; publisher: false } {
  const config = value ?? {};
  if (!isRecord(config) || Object.keys(config).some(key => key !== "agentId" && key !== "publisher") ||
      (config.publisher !== undefined && config.publisher !== false) ||
      (config.agentId !== undefined && (typeof config.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.agentId)))) {
    throw new Error("stella_ordinary_configuration_invalid: use agentId and publisher:false; legacy configuration is not migrated implicitly");
  }
  return { agentId: typeof config.agentId === "string" ? config.agentId : "main", publisher: false };
}

function result(details: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(isError ? { isError: true } : {}) };
}

/** Ordinary, data-free entry. No legacy loader, provider, context engine,
 * filesystem reader/writer, model client or automatic background task is bound.
 * The Host's model supplies semantics; this tool only validates and labels its
 * proposal. References remain unverified and cannot become author admission. */
export default definePluginEntry({
  id: "stella-core",
  name: "Stella Core",
  description: "Source-aware work-brief candidates alongside native OpenClaw memory and context",
  register(api) {
    const config = parseOrdinaryConfig(api.pluginConfig);
    const status = () => ({
      architecture: "ordinary-plugin", stage: "candidate-only", agentId: config.agentId,
      publisher: false, sourceAdapter: "not_connected", authorConfirmation: false,
      persistence: "none", modelCalls: false, legacyRuntime: "inactive",
      memory: "host-owned", context: "host-owned", agentLoop: "host-owned",
    });
    api.registerTool({ contextVersion: 2, create(context: OpenClawPluginToolContext<2>) {
      if (context.agentId !== config.agentId) return null;
      // Capture the Host guard once. The mutable factory object cannot replace it.
      const invocationGuard = context.assertInvocationCurrent.bind(context);
      const check = (signal?: AbortSignal) => { invocationGuard(); signal?.throwIfAborted(); };
      return [
        { name: STATUS_TOOL, label: "Stella status", description: "Show Stella's active architecture and available capabilities. No model or personal files are accessed.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_callId, parameters, signal) {
            check(signal);
            if (!isRecord(parameters) || Object.keys(parameters).length) return result({ status: "rejected", code: "stella_status_arguments_invalid" }, true);
            return result(status());
          } },
        { name: CANDIDATE_TOOL, label: "Author intent candidate",
          description: "Structure your proposed understanding of an author's work. Preserve unresolved questions and distinguish proposed premises from verified author intent. This returns an unconfirmed, unsaved candidate only. Evidence references are model-supplied and unverified. Never use this tool as confirmation, publication or memory saving.",
          parameters: CANDIDATE_PARAMETERS,
          async execute(callId, parameters, signal) {
            check(signal);
            let proposal: Proposal;
            try { proposal = parseProposal(parameters); }
            catch { return result({ status: "rejected", code: "stella_candidate_arguments_invalid" }, true); }
            check(signal);
            return result({ status: "candidate", code: "author_source_unavailable", toolCallId: callId,
              proposal, evidenceStatus: "model_supplied_unverified", authorConfirmation: false,
              publisher: false, saved: false });
          } },
      ];
    } }, { names: [STATUS_TOOL, CANDIDATE_TOOL] });
    api.registerCommand({ name: "stella-status", description: "Show Stella architecture and candidate-only limits without a model call", requireAuth: true,
      handler: () => ({ text: JSON.stringify(status(), null, 2) }) });
  },
});
