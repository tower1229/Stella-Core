import { isRecord } from "../shared/type-guards.js";

export type EvaluationChatPort = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
};

/** One submission only. Observation timeouts never authorize regeneration or resend. */
export async function runExactHostEvaluationChat(port: EvaluationChatPort, input: {
  sessionKey: string; message: string; idempotencyKey: string; timeoutMs?: number;
}): Promise<{ runId: string; text: string }> {
  const timeoutMs = input.timeoutMs ?? 300_000;
  if (!input.sessionKey || !input.message.trim() || !input.idempotencyKey || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("evaluation_chat_invalid_input");
  }
  const deadline = Date.now() + timeoutMs;
  const terminals: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = port.subscribe((event) => {
    if (!isRecord(event) || event.event !== "chat" || !isRecord(event.payload)) return;
    const payload = event.payload;
    if (payload.sessionKey !== input.sessionKey || !["final", "error", "aborted"].includes(String(payload.state))) return;
    terminals.push(payload);
    wake?.();
  });
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error("evaluation_chat_observation_timeout");
    return value;
  };
  const pause = (milliseconds: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, milliseconds);
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
  });
  try {
    const sent = await port.request("chat.send", {
      sessionKey: input.sessionKey, message: input.message, idempotencyKey: input.idempotencyKey,
    });
    if (!isRecord(sent) || typeof sent.runId !== "string" || !sent.runId) throw new Error("evaluation_chat_missing_run");
    for (;;) {
      const terminal = await port.request("agent.wait", { runId: sent.runId, timeoutMs: Math.min(30_000, remaining()) });
      if (!isRecord(terminal) || terminal.runId !== sent.runId) throw new Error("evaluation_chat_wrong_run");
      if (terminal.status === "ok") break;
      // Exact 2026.8.2 returns these states while queued/draining, without an endedAt.
      if ((terminal.status === "pending" || terminal.status === "timeout") && terminal.endedAt == null &&
        (terminal.timeoutPhase === "queue" || terminal.timeoutPhase === "gateway_draining")) {
        await pause(Math.min(250, remaining()));
        continue;
      }
      throw new Error("evaluation_chat_run_failed");
    }
    while (!terminals.some((event) => event.runId === sent.runId)) await pause(Math.min(250, remaining()));
    const matching = terminals.filter((event) => event.runId === sent.runId);
    if (matching.length !== 1 || matching[0]!.state !== "final") throw new Error("evaluation_chat_delivery_unconfirmed");
    const message = matching[0]!.message;
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content) || !message.content.length ||
      message.content.some((part) => !isRecord(part) || part.type !== "text" || typeof part.text !== "string")) {
      throw new Error("evaluation_chat_unsupported_final");
    }
    const text = message.content.map((part: { text: string }) => part.text).join("\n");
    if (!text.trim()) throw new Error("evaluation_chat_empty_final");
    return { runId: sent.runId, text };
  } catch (error) {
    if (error instanceof Error && /^evaluation_chat_[a-z_]+$/.test(error.message)) throw error;
    // Host errors may include private prompts, model replies or local paths.
    throw new Error("evaluation_chat_transport_failed");
  } finally {
    unsubscribe();
  }
}
