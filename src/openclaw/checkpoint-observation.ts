import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-flags";

export const CHECKPOINT_OBSERVATION_FLAG = "stella.core.observe";
export const CHECKPOINT_OBSERVATION_PREFIX = "Stella checkpoint observation: ";
type Identity = { agentId?: unknown; sessionId?: unknown; sessionKey?: unknown; senderIsOwner?: unknown; requesterSenderId?: unknown };
type Hook = { agentId?: unknown; sessionId?: unknown; sessionKey?: unknown; runId?: unknown; toolCallId?: unknown;
  requester?: { senderId?: unknown; senderIsOwner?: unknown }; abortSignal?: AbortSignal };
type Counts = { grants: number; activeGrants: number; preparations: number; toolPermits: number };

/** Public audit correlation only. The observer nonce and already-observed Host
 * run/call ID suffice to recompute this tag; it authenticates or authorizes nothing. */
export function checkpointHostObservationTag(observerId: string, domain: "run" | "call", value: unknown) {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(JSON.stringify(["stella.host-observation/v1", observerId, domain, value])).digest("hex") : null;
}

/** Diagnostics only. No permissions, object-identity registry, file writer or
 * returned capability. A missing/failed observation cannot alter execution.
 * Identity tags are private-salted; run/call tags permit external audit matching.
 * Neither kind of tag is used by the business path. */
export function createCheckpointObservation(api: Pick<OpenClawPluginApi, "config" | "logger">) {
  let salt: Buffer | undefined, observerId: string | undefined, sequence = 0, factorySequence = 0;
  try {
    if (isDiagnosticFlagEnabled(CHECKPOINT_OBSERVATION_FLAG, api.config)) { salt = randomBytes(32); observerId = randomUUID(); }
  } catch { /* A diagnostic configuration failure only disables observations. */ }
  const tag = (domain: string, value: unknown) => typeof value === "string" && value.length > 0
    ? createHmac("sha256", salt!).update(domain).update("\0").update(value).digest("hex") : null;
  const owner = (value: unknown) => typeof value === "boolean" ? value : null;
  const identity = (context: Identity) => ({ agentTag: tag("agent", context.agentId), sessionTag: tag("session", context.sessionId),
    sessionKeyTag: tag("session-key", context.sessionKey), requesterTag: tag("requester", context.requesterSenderId),
    senderIsOwner: owner(context.senderIsOwner) });
  const signal = (value?: AbortSignal) => {
    const aborted: unknown = value?.aborted;
    return { abortSignalPresent: value !== undefined, aborted: typeof aborted === "boolean" ? aborted : null };
  };
  const emit = (source: string, fields: () => Record<string, unknown>) => {
    if (!salt) return;
    try {
      const row = { schemaVersion: "stella.checkpoint-observation/v1", observerId, sequence: ++sequence, source, ...fields() };
      const result: unknown = api.logger.debug?.(CHECKPOINT_OBSERVATION_PREFIX + JSON.stringify(row));
      // The SDK logger is synchronous; also contain a misbehaving async sink.
      if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
    } catch { /* Drop only this observation; collectors must reject missing evidence. */ }
  };
  return {
    factory(tool: "stella_memory_correct" | "stella_memory_data", context: Identity) {
      if (!salt) return undefined;
      const factoryLabel = ++factorySequence;
      emit("factory", () => ({ tool, factoryLabel, ...identity(context) }));
      return factoryLabel;
    },
    hook(tool: "stella_memory_correct" | "stella_memory_data", context: Hook) {
      emit("before_tool_call", () => ({ tool, ...identity({ agentId: context.agentId, sessionId: context.sessionId,
        sessionKey: context.sessionKey, requesterSenderId: context.requester?.senderId,
        senderIsOwner: context.requester?.senderIsOwner }), runTag: checkpointHostObservationTag(observerId!, "run", context.runId),
        callTag: checkpointHostObservationTag(observerId!, "call", context.toolCallId),
      ...signal(context.abortSignal) }));
    },
    execute(tool: "stella_memory_correct" | "stella_memory_data", factoryLabel: number | undefined, callId: unknown, abortSignal?: AbortSignal) {
      emit("execute", () => ({ tool, factoryLabel, callTag: checkpointHostObservationTag(observerId!, "call", callId), ...signal(abortSignal) }));
    },
    retired(runId: string, before: { grants: number; toolPermits: number; wasActive: boolean; grantRemoved: boolean }, counts: () => Counts) {
      emit("retirement", () => ({ runTag: checkpointHostObservationTag(observerId!, "run", runId), countScope: "config-and-host-state-supply-scope",
        before, after: counts() }));
    },
  };
}
