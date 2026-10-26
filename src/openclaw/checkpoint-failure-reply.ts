import type { PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent, PluginHookReplyDispatchResult } from "openclaw/plugin-sdk/core";

export const CHECKPOINT_FAILURE_TEXT = "Stella 未能完成本轮请求，请保留当前会话。此次请求未自动重试。";
const replies = new WeakMap<object, Map<string, Promise<PluginHookReplyDispatchResult>>>();

/** One sanitized failure per Host turn/dispatcher. Queue admission is not a delivery receipt.
 * Never throw into the claim hook runner or retry an uncertain send.
 */
export function replyCheckpointFailure(event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext,
  signal: AbortSignal | undefined = ctx.abortSignal): Promise<PluginHookReplyDispatchResult> {
  const key = event.runId ? JSON.stringify([event.sessionKey ?? event.ctx.SessionKey, event.runId]) : "missing-run";
  let turns = replies.get(ctx.dispatcher);
  if (!turns) { turns = new Map(); replies.set(ctx.dispatcher, turns); }
  const existing = turns.get(key);
  if (existing) return existing;
  // Install the promise before any synchronous dispatcher callback can re-enter.
  const pending = Promise.resolve().then(async () => {
    let queued = false;
    try {
      if (!signal?.aborted && event.sendPolicy === "allow" && !event.suppressUserDelivery && !event.isTailDispatch) {
        queued = ctx.dispatcher.sendFinalReply({ text: CHECKPOINT_FAILURE_TEXT, isError: true });
      }
    } catch { /* Keep ownership; a throw cannot prove that no delivery occurred. */ }
    try { ctx.dispatcher.markComplete(); await ctx.dispatcher.waitForIdle(); }
    catch { /* Delivery remains uncertain. Do not resend or start the Agent. */ }
    finally { try { ctx.markIdle("Stella checkpoint request failed"); } catch { /* Host lifecycle is best-effort. */ } }
    return { handled: true, queuedFinal: queued, counts: { tool: 0, block: 0, final: queued ? 1 : 0 } };
  });
  turns.set(key, pending);
  return pending;
}
