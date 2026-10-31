/** Correlates only public tool lifecycle metadata. It does not read prompts,
 * messages, recorder state, requester identity, source permissions or proposals. */
type Identity = { agentId?: string; sessionKey?: string; sessionId?: string };
type Event = { toolName: string; toolCallId?: string; runId?: string };
type Context = Identity & Event & { abortSignal?: AbortSignal };
type Pending = Identity & { runId?: string; conflict: boolean; release(): void };
const value = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

export function createToolRequestBinding(agentId: string, toolName: string) {
  const pending = new Map<string, Pending>();
  return {
    observe(event: Event, context: Context): string | undefined {
      if (event.toolName !== toolName || context.toolName !== toolName || context.agentId !== agentId) return;
      const call = context.toolCallId;
      if (!value(call) || event.toolCallId !== call || !value(context.sessionKey) ||
          (context.sessionId !== undefined && !value(context.sessionId)) ||
          (event.runId !== context.runId) || (context.runId !== undefined && !value(context.runId))) {
        return "stella_request_binding_invalid";
      }
      const previous = pending.get(call);
      if (previous) {
        previous.conflict = true;
        return "stella_request_binding_ambiguous";
      }
      if (context.abortSignal?.aborted) return "stella_request_binding_cancelled";
      if (pending.size >= 128) return "stella_request_binding_capacity";
      const signal = context.abortSignal;
      const entry: Pending = { agentId, sessionKey: context.sessionKey, sessionId: context.sessionId,
        runId: context.runId, conflict: false, release: () => signal?.removeEventListener("abort", discard) };
      function discard() {
        if (pending.get(call!) === entry) pending.delete(call!);
        entry.release();
      }
      pending.set(call, entry);
      signal?.addEventListener("abort", discard, { once: true });
    },
    consume(callId: string, factory: Identity) {
      const entry = pending.get(callId);
      if (!entry) return { status: "unavailable" as const, code: "host_tool_hook_not_observed" };
      pending.delete(callId); entry.release();
      if (entry.conflict || factory.agentId !== entry.agentId || factory.sessionKey !== entry.sessionKey ||
          (factory.sessionId !== undefined && !value(factory.sessionId)) ||
          (entry.sessionId !== undefined && factory.sessionId !== undefined && entry.sessionId !== factory.sessionId)) {
        return { status: "rejected" as const, code: "stella_request_binding_mismatch" };
      }
      return { status: "bound" as const, scope: entry.runId === undefined ? "tool_call" as const : "run_and_tool_call" as const,
        code: entry.runId === undefined ? "host_run_not_provided" : "host_run_and_call_observed",
        agentId: entry.agentId, toolCallId: callId, runId: entry.runId ?? null,
        sessionBound: true, sessionIncarnationBound: value(entry.sessionId) && value(factory.sessionId),
        authorConfirmation: false as const, inputAdmission: "not_connected" as const };
    },
  };
}
