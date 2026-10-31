import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { canonicalJson } from "../canghai/content-version.js";
import { intentCheck, parseIntentPublication, type IntentPublication } from "../canghai/author-intent-asset.js";
import { isRecord } from "../shared/type-guards.js";

export const AUTHOR_INTENT_CANDIDATE_TOOL = "stella_author_intent_candidate";
type Scalar = string | number | boolean | null;
export type IntentToolObservation = Record<string, Scalar>;
const id = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
function aborted(signal?: AbortSignal): boolean | null { const value = signal?.aborted; return bool(value); }

/** Inactive until explicitly registered by an entry. It has no publisher, source
 * reader, filesystem port or author attestation. A fixture/model proposal cannot
 * acquire confirmation through owner/session/audience metadata. */
export function registerAuthorIntentCandidateTool(api: OpenClawPluginApi, input: {
  candidate: IntentPublication; observe?: (event: IntentToolObservation) => void;
}) {
  const candidate = parseIntentPublication(input.candidate);
  intentCheck(candidate.confirmation === "candidate", "author_source_unavailable");
  const observe = input.observe;
  const counts = { factories: 0, executions: 0, guardCalls: 0, candidateReturns: 0, argumentRejections: 0 };
  let sequence = 0;
  const emit = (event: IntentToolObservation) => {
    try { observe?.({ ...event, sequence: ++sequence }); } catch { /* Observation never grants authority or changes business behavior. */ }
  };
  api.on("before_prompt_build", (event, context) => {
    emit({ source: "host.before_prompt_build", runId: id(context.runId),
      currentUserMessagePresent: typeof event.currentUserMessage === "string",
      currentUserMessageIdPresent: typeof event.currentUserMessageId === "string",
      inputProvenanceKind: id(context.inputProvenance?.kind) });
  });
  api.on("before_tool_call", (event, context) => {
    if (event.toolName !== AUTHOR_INTENT_CANDIDATE_TOOL) return;
    emit({ source: "host.before_tool_call", runId: id(context.runId), toolCallId: id(context.toolCallId), eventRunId: id(event.runId), eventToolCallId: id(event.toolCallId),
      requesterPresent: context.requester !== undefined, signalAborted: aborted(context.abortSignal) });
  });
  api.on("after_tool_call", (event, context) => {
    if (event.toolName !== AUTHOR_INTENT_CANDIDATE_TOOL) return;
    emit({ source: "host.after_tool_call", runId: id(context.runId), toolCallId: id(context.toolCallId), eventRunId: id(event.runId), eventToolCallId: id(event.toolCallId),
      failed: typeof event.error === "string" || event.error !== undefined,
      resultPresent: event.result !== undefined });
  });
  api.on("llm_output", event => {
    emit({ source: "host.llm_output", runId: id(event.runId), provider: id(event.provider), model: id(event.model), harnessId: id(event.harnessId) });
  });
  api.registerTool({ contextVersion: 2, create(context: OpenClawPluginToolContext<2>) {
    counts.factories++;
    emit({ source: "host.factory", contextVersion: 2, requesterPresent: typeof context.requesterSenderId === "string",
      senderIsOwner: bool(context.senderIsOwner), memoryAudiencePresent: context.memoryAudience !== undefined,
      invocationGuardPresent: typeof context.assertInvocationCurrent === "function", sessionPresent: typeof context.sessionKey === "string" });
    return { name: AUTHOR_INTENT_CANDIDATE_TOOL, label: "Author intent candidate", description: "Return an explicitly unconfirmed author-intent candidate. No confirmed publication is available.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(toolCallId, parameters, signal) {
        counts.executions++;
        const guard = () => { counts.guardCalls++; context.assertInvocationCurrent(); signal?.throwIfAborted(); };
        guard();
        emit({ source: "host.execute", toolCallId: id(toolCallId), signalAborted: aborted(signal) });
        if (!isRecord(parameters) || Object.getPrototypeOf(parameters) !== Object.prototype || Object.keys(parameters).length !== 0) {
          counts.argumentRejections++; emit({ source: "core.arguments_rejected", toolCallId: id(toolCallId) });
          return { content: [{ type: "text" as const, text: canonicalJson({ status: "rejected", code: "tool_arguments_invalid" }) }],
            details: { status: "rejected", code: "tool_arguments_invalid" }, isError: true };
        }
        await Promise.resolve(); guard(); counts.candidateReturns++;
        emit({ source: "core.candidate_returned", toolCallId: id(toolCallId), authorSourceAvailable: false, publisherBound: false });
        const result = { status: "candidate", code: "author_source_unavailable", candidate: structuredClone(candidate) };
        return { content: [{ type: "text" as const, text: canonicalJson(result) }], details: result };
      } };
  } }, { name: AUTHOR_INTENT_CANDIDATE_TOOL });
  return { snapshot: () => ({ ...counts }) };
}
