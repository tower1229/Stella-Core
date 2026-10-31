import { definePluginEntry, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import path from "node:path";
import { isRecord } from "./shared/type-guards.js";
import { createToolRequestBinding } from "./openclaw/tool-request-binding.js";
import { CANDIDATE_PARAMETERS, parseProposal, type Proposal } from "./openclaw/work-brief-proposal.js";
import { WORK_BRIEF_TOOL, WORK_BRIEF_PARAMETERS, executeWorkBrief, validDraftsRoot, workBriefFailure } from "./openclaw/candidate-work-brief.js";
export { WORK_BRIEF_TOOL } from "./openclaw/candidate-work-brief.js";

export const CANDIDATE_TOOL = "stella_author_intent_candidate";
export const STATUS_TOOL = "stella_status";
export { CANDIDATE_PARAMETERS, parseProposal } from "./openclaw/work-brief-proposal.js";

export function parseOrdinaryConfig(value: unknown): { agentId: string; publisher: false; candidateDraftsRoot?: string } {
  const config = value ?? {};
  if (!isRecord(config) || Object.keys(config).some(key => key !== "agentId" && key !== "publisher" && key !== "candidateDraftsRoot") ||
      (config.publisher !== undefined && config.publisher !== false) ||
      (config.candidateDraftsRoot !== undefined && !validDraftsRoot(config.candidateDraftsRoot)) ||
      (config.agentId !== undefined && (typeof config.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.agentId)))) {
    throw new Error("stella_ordinary_configuration_invalid: use agentId, publisher:false and optional dedicated candidateDraftsRoot; legacy configuration is not migrated implicitly");
  }
  return { agentId: typeof config.agentId === "string" ? config.agentId : "main", publisher: false,
    ...(typeof config.candidateDraftsRoot === "string" ? { candidateDraftsRoot: config.candidateDraftsRoot } : {}) };
}

function result(details: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(isError ? { isError: true } : {}) };
}

/** Ordinary entry. No legacy loader, provider, context engine, model client or
 * automatic background task is bound. Draft storage is explicit and synthetic-only.
 * The Host's model supplies semantics; this tool only validates and labels its
 * proposal. References remain unverified and cannot become author admission. */
export default definePluginEntry({
  id: "stella-core",
  name: "Stella Core",
  description: "Source-aware work-brief candidates alongside native OpenClaw memory and context",
  register(api) {
    const config = parseOrdinaryConfig(api.pluginConfig);
    const requestBinding = createToolRequestBinding(config.agentId, CANDIDATE_TOOL);
    api.on("before_tool_call", (event, context) => {
      const error = requestBinding.observe(event, context);
      if (error) return { block: true, blockReason: error };
    });
    const status = () => ({
      architecture: "ordinary-plugin", stage: "candidate-only", agentId: config.agentId,
      publisher: false, sourceAdapter: "not_connected", authorConfirmation: false,
      persistence: config.candidateDraftsRoot ? "candidate_drafts_only" : "none",
      candidateDraftsConfigured: Boolean(config.candidateDraftsRoot), draftScope: "synthetic_debug",
      modelCalls: false, legacyRuntime: "inactive",
      requestBinding: "public-tool-hook-metadata", currentInputAdmission: "not_connected",
      memory: "host-owned", context: "host-owned", agentLoop: "host-owned",
    });
    api.registerTool({ contextVersion: 2, create(context: OpenClawPluginToolContext<2>) {
      if (context.agentId !== config.agentId) return null;
      // Capture the Host guard once. The mutable factory object cannot replace it.
      const invocationGuard = context.assertInvocationCurrent.bind(context);
      const identity = { agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId };
      const owner = context.senderIsOwner;
      const fsPolicy = context.fsPolicy ? { workspaceOnly: context.fsPolicy.workspaceOnly, root: context.fsPolicy.root } : undefined;
      const sandboxed = context.sandboxed;
      const check = (signal?: AbortSignal) => {
        invocationGuard(); signal?.throwIfAborted();
        if (context.agentId !== identity.agentId || context.sessionKey !== identity.sessionKey || context.sessionId !== identity.sessionId) {
          throw new Error("stella_request_factory_identity_changed");
        }
      };
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
            const binding = requestBinding.consume(callId, identity);
            if (binding.status === "rejected") return result({ status: "rejected", code: binding.code }, true);
            let proposal: Proposal;
            try { proposal = parseProposal(parameters); }
            catch { return result({ status: "rejected", code: "stella_candidate_arguments_invalid" }, true); }
            check(signal);
            return result({ status: "candidate", code: "author_source_unavailable", toolCallId: callId,
              proposal, evidenceStatus: "model_supplied_unverified", authorConfirmation: false,
              publisher: false, saved: false, requestBinding: binding });
          } },
        { name: WORK_BRIEF_TOOL, label: "Unconfirmed work brief",
          description: "Explicitly save or read a synthetic, unconfirmed work brief in the configured debug draft store. Read by briefId in each new request. Save requires a new operationId and the exact last-read expectedVersion (null only to create); stale versions fail. No author confirmation, source-file access, formal publication or long-term memory. Evidence references stay unverified. This debug store is owner-only.",
          parameters: WORK_BRIEF_PARAMETERS,
          async execute(_callId, parameters, signal) {
            const draftGuard = () => {
              check(signal);
              if (owner !== true || context.senderIsOwner !== owner) throw new Error("work_brief_owner_required");
              // No host-filesystem bridge for sandboxed callers. A workspace-only
              // caller cannot use configuration to escape its Host-owned root.
              if (sandboxed === true) throw new Error("work_brief_sandbox_unsupported");
              if (fsPolicy?.workspaceOnly && config.candidateDraftsRoot) {
                const relative = fsPolicy.root ? path.relative(fsPolicy.root, config.candidateDraftsRoot) : "..";
                if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
                  throw new Error("work_brief_workspace_denied");
                }
              }
            };
            draftGuard();
            if (!config.candidateDraftsRoot) return result({ status: "rejected", code: "work_brief_not_configured" }, true);
            try { return result(await executeWorkBrief(config.candidateDraftsRoot, parameters, draftGuard, signal)); }
            catch (error) {
              draftGuard();
              return result({ status: "failed", code: workBriefFailure(error), publisher: false, authorConfirmation: false }, true);
            }
          } },
      ];
    } }, { names: [STATUS_TOOL, CANDIDATE_TOOL, WORK_BRIEF_TOOL] });
    api.registerCommand({ name: "stella-status", description: "Show Stella architecture and candidate-only limits without a model call", requireAuth: true,
      handler: () => ({ text: JSON.stringify(status(), null, 2) }) });
  },
});
