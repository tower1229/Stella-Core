import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentWorkspaceDir, resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  CompletionError, coordinateCompletion, captureCompletionOutput, readCompletionOutput, readCompletionPreparation,
  type CompletionDraft, type CompletionPorts, type CompletionResult,
} from "./completion.js";
import { publishCompletionDraft } from "./completion-delivery.js";
import { isRecord } from "../shared/type-guards.js";
import { captureHostInput, type HostInputSnapshot } from "./host-input.js";
import { admitCompletionOnce, openCompletionAdmissionJournal } from "./completion-admission.js";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth";

// Keep terminal run IDs too: a late callback is not a new request. Do not evict a
// known run merely to admit new work, since eviction could authorize a resend.
const claimedRuns = new Set<string>();
const MAX_RECORDED_RUNS = 65_536;
// Host-visible silence is intentional while Core owns the not-yet-published
// draft. Core still requires a complete nonempty private answer below.
export const PRIVATE_DRAFT_HOST_POLICY = {
  silentExpected: true,
  allowEmptyAssistantReplyAsSilent: true,
  terminalReplyExpectation: "optional",
} as const;
function claimRun(agentId: string, runId: string): boolean {
  const key = JSON.stringify([agentId, runId]);
  if (claimedRuns.has(key)) return false;
  if (claimedRuns.size >= MAX_RECORDED_RUNS) throw new CompletionError("run_registry_capacity_exhausted", "admission");
  claimedRuns.add(key);
  return true;
}

export function parsePrivateAssistantDraft(value: unknown): string {
  if (!isRecord(value) || value.role !== "assistant" || value.stopReason !== "stop" ||
      value.phase === "commentary" || !Array.isArray(value.content)) {
    throw new CompletionError("invalid_private_draft", "generate");
  }
  const text: string[] = [];
  for (const part of value.content) {
    if (!isRecord(part)) throw new CompletionError("invalid_private_draft", "generate");
    if (part.type === "thinking") continue;
    if (part.type !== "text" || typeof part.text !== "string") throw new CompletionError("unsupported_final_payload", "generate");
    text.push(part.text);
  }
  const result = text.join("\n");
  if (!result.trim()) throw new CompletionError("empty_private_draft", "generate");
  return result;
}

export type CompletionAdapterPorts = {
  resourceScope(): Promise<string>;
  describeDraft(runId: string, text: string, input: HostInputSnapshot, preparation: unknown): CompletionDraft;
  persist: CompletionPorts["persist"];
  settled(runId: string, result: CompletionResult | undefined): void;
};

/** The Alpha text-only adapter uses the Host loop and the original Host session. */
export function registerCompletionAdapter(
  api: OpenClawPluginApi,
  agentId: string,
  ports: CompletionAdapterPorts,
): void {
  api.on("llm_output", (event, ctx) => {
    if (ctx.agentId === agentId) captureCompletionOutput(event.runId, event.lastAssistant);
  }, { priority: 1_000 });
  api.on("reply_dispatch", async (event, ctx) => {
    const sessionKey = event.sessionKey ?? event.ctx.SessionKey;
    if (!sessionKey?.startsWith(`agent:${agentId}:`)) return;
    const runId = event.runId;
    let result: CompletionResult | undefined;
    let terminalOutcome: "completed" | "failed" = "failed";
    let terminalError: string | undefined;
    let queued = false;
    let claimed = false;
    let duplicate = false;
    try {
      // This must precede Host ownership and any awaited work. Otherwise a second
      // registration can replace the first owner's terminal callback, then fail at
      // resource admission and clear the first registration's prepared draft.
      if (runId && !claimRun(agentId, runId)) {
        duplicate = true;
        return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      if (!runId || ctx.dispatchKind !== "agent" || !ctx.dispatcher.supportsSettledReceipt ||
          !ctx.onAgentRunStart || !ctx.userTurnTranscriptRecorder ||
          event.images?.length || event.inboundAudio || event.isTailDispatch ||
          event.suppressUserDelivery || event.sendPolicy !== "allow") {
        throw new CompletionError("capability_unavailable", "admission");
      }
      if (ctx.abortSignal?.aborted) throw new CompletionError("cancelled", "admission");
      const ownership = ctx.onAgentRunStart(runId, undefined, {
        completionSource: "reply-dispatch", getResult: () => ({ terminalOutcome: {
          reason: terminalOutcome, status: terminalOutcome === "completed" ? "ok" : "error", error: terminalError,
        } }),
      });
      if (ownership !== "reply-dispatch") throw new CompletionError("capability_unavailable", "admission");
      claimed = true;
      const entry = getSessionEntry({ agentId, sessionKey });
      if (entry?.modelOverride || entry?.providerOverride) {
        throw new CompletionError("session_model_override_unavailable", "admission");
      }
      const sessionId = entry?.sessionId ?? randomUUID();
      const model = resolveDefaultModelForAgent({ cfg: ctx.cfg, agentId });
      const sender = resolveCommandAuthorization({ ctx: event.ctx, cfg: ctx.cfg, commandAuthorized: event.ctx.CommandAuthorized });
      const chatType = event.ctx.ChatType;
      if (chatType !== undefined && chatType !== "direct" && chatType !== "group" && chatType !== "channel") {
        throw new CompletionError("unsupported_chat_type", "admission");
      }
      const prompt = event.ctx.Body;
      if (typeof prompt !== "string" || !prompt.trim()) throw new CompletionError("invalid_input", "admission");
      const resourceScope = await ports.resourceScope();
      result = await coordinateCompletion({ operationId: runId, runId, resourceScope, timeoutMs: 600_000, abortSignal: ctx.abortSignal,
        request: { agentId, sessionId, sessionKey, prompt, senderId: sender.senderId || undefined,
          senderIsOwner: sender.senderIsOwner, chatType },
      }, {
        async generateDraft({ abortSignal }) {
          let admissionStore;
          try { admissionStore = await openCompletionAdmissionJournal(api.runtime.state.resolveStateDir()); }
          catch { throw new CompletionError("admission_store_unavailable", "admission"); }
          await admitCompletionOnce(admissionStore, { agentId, runId, sessionKey, resourceScope, prompt });
          if (abortSignal.aborted) throw new CompletionError("cancelled", "admission");
          const generated = await api.runtime.agent.runEmbeddedAgent({
            agentId, sessionId, sessionKey, runId,
            senderId: sender.senderId, senderIsOwner: sender.senderIsOwner,
            messageChannel: event.ctx.Provider, chatType,
            workspaceDir: resolveAgentWorkspaceDir(ctx.cfg, agentId), config: ctx.cfg,
            prompt, transcriptPrompt: prompt, ...model, modelFallbacksOverride: [],
            timeoutMs: 540_000, abortSignal,
            // Preserve Host prompt/skill construction and the caller's policy.
            // Only these tools may execute before the private draft is committed.
            toolsAllow: event.toolsAllow,
            toolExecutionAllow: ["read", "stella_initialize"],
            suppressLiveStreamOutput: true,
            ...PRIVATE_DRAFT_HOST_POLICY, deferTerminalLifecycle: true,
            userTurnTranscriptRecorder: ctx.userTurnTranscriptRecorder,
            prepareAssistantTranscriptMessage: ctx.prepareAssistantTranscriptMessage,
          });
          const preparation = readCompletionPreparation(runId);
          if (isRecord(preparation) && preparation.outcome === "blocked" && typeof preparation.category === "string") {
            throw new CompletionError(preparation.category, "prepare");
          }
          if (generated.meta.error || generated.meta.aborted || generated.didSendViaMessagingTool ||
              generated.payloads?.some((payload) => payload.isError || payload.mediaUrl || payload.mediaUrls?.length)) {
            throw new CompletionError("generation_failed", "generate");
          }
          const originalInput = captureHostInput({ hostVersion: api.runtime.version, agentId, sessionId, sessionKey,
            recorder: ctx.userTurnTranscriptRecorder! });
          return ports.describeDraft(runId, parsePrivateAssistantDraft(readCompletionOutput(runId)), originalInput, readCompletionPreparation(runId));
        },
        persist: ports.persist,
        async publishFinal(input) {
          // Admission is the irreversible send boundary; never re-send on unknown delivery.
          queued = true;
          return publishCompletionDraft({ ...input, dispatcher: ctx.dispatcher });
        },
      });
      terminalOutcome = result.delivery.status === "confirmed" ? "completed" : "failed";
      if (terminalOutcome === "failed") terminalError = `Stella 未完成本轮请求（delivery_${result.delivery.status}，阶段：publish）。交付未确认，不自动重发。`;
      ctx.recordProcessed(terminalOutcome === "completed" ? "completed" : "error", {
        reason: `stella_delivery_${result.delivery.status}`,
      });
    } catch (error) {
      const failure = error instanceof CompletionError ? error : new CompletionError("completion_failed", "admission");
      api.logger.error(`Stella completion: ${failure.category}:${failure.stage}`);
      terminalError = `Stella 未完成本轮请求（${failure.category}，阶段：${failure.stage}）。${queued ? "交付未确认，不自动重发。" : "未确认的业务回复没有发布。"}`;
      // Claimed chat runs deliver failures through the Host's native chat/error terminal.
      if (!claimed && !queued && !ctx.abortSignal?.aborted && event.sendPolicy === "allow" && !event.suppressUserDelivery) {
        queued = ctx.dispatcher.sendFinalReply({
          text: terminalError,
        });
        ctx.dispatcher.markComplete();
        await ctx.dispatcher.waitForIdle();
      }
      ctx.recordProcessed("error", { reason: `stella_${failure.category}` });
    } finally {
      if (claimed && runId) {
        try { ports.settled(runId, result); } catch {
          api.logger.error("Stella completion: cleanup_failed:settled");
        }
      }
      if (!duplicate) ctx.markIdle("Stella completion settled");
    }
    return { handled: true, queuedFinal: queued, counts: { tool: 0, block: 0, final: queued ? 1 : 0 } };
  }, { priority: 1_000, timeoutMs: 660_000, eligibleDispatchKinds: ["agent"] });
}
