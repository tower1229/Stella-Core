import assert from "node:assert/strict";
import test from "node:test";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent } from "openclaw/plugin-sdk/core";
import { CHECKPOINT_FAILURE_TEXT, replyCheckpointFailure } from "../src/openclaw/checkpoint-failure-reply.js";

const event = (): PluginHookReplyDispatchEvent => ({ runId: "synthetic-failure-run", sessionKey: "agent:synthetic:failure",
  ctx: { Body: "SYNTHETIC_PRIVATE_BODY /private/source API_KEY=not-a-real-secret" }, sendPolicy: "allow", inboundAudio: false,
} as PluginHookReplyDispatchEvent);

test("failure reply uses the stock Host dispatcher once and remains explicitly an error", async () => {
  const delivered: Array<{ text?: string; isError?: boolean }> = []; let idle = 0;
  const dispatcher = createReplyDispatcher({ async deliver(payload, info) { assert.equal(info.kind, "final"); delivered.push(payload); } });
  const ctx = { dispatcher, markIdle() { idle++; } } as unknown as PluginHookReplyDispatchContext;
  const first = event(), pending = replyCheckpointFailure(first, ctx);
  assert.equal(replyCheckpointFailure({ ...first }, ctx), pending);
  const result = await pending;
  assert.deepEqual(result, { handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });
  assert.deepEqual(delivered, [{ text: CHECKPOINT_FAILURE_TEXT, isError: true }]);
  assert.doesNotMatch(JSON.stringify(delivered), /SYNTHETIC_PRIVATE_BODY|private\/source|API_KEY|not-a-real-secret/);
  assert.equal(idle, 1); await replyCheckpointFailure(first, ctx); assert.equal(delivered.length, 1);
});

test("stock Host delivery cancellation is respected without resend or false confirmation", async () => {
  let delivered = 0;
  const dispatcher = createReplyDispatcher({ beforeDeliver: () => null, async deliver() { delivered++; } });
  const ctx = { dispatcher, markIdle() {} } as unknown as PluginHookReplyDispatchContext;
  const result = await replyCheckpointFailure(event(), ctx), receipt = await dispatcher.waitForIdle();
  assert.equal(result.handled, true); assert.equal(result.queuedFinal, true, "reports queue admission only");
  assert.equal(receipt!.counts.final.cancelled, 1); assert.equal(receipt!.anyVisibleDelivered, false); assert.equal(delivered, 0);
});

test("a missing run identity still yields at most one failure for its Host dispatcher", async () => {
  let sends = 0;
  const ctx = { dispatcher: { sendFinalReply() { sends++; return true; }, markComplete() {}, async waitForIdle() {} }, markIdle() {} } as unknown as PluginHookReplyDispatchContext;
  const first = event(); delete first.runId;
  await Promise.all([replyCheckpointFailure(first, ctx), replyCheckpointFailure({ ...first }, ctx)]);
  assert.equal(sends, 1);
});

test("dispatcher rejection and uncertain exceptions never retry or release the default model path", async t => {
  for (const mode of ["reject", "send-throws", "settle-throws"] as const) await t.test(mode, async () => {
    let sends = 0, complete = 0, idle = 0;
    const ctx = { dispatcher: {
      sendFinalReply() { sends++; if (mode === "send-throws") throw new Error("synthetic unknown delivery /private/path"); return mode !== "reject"; },
      markComplete() { complete++; }, async waitForIdle() { if (mode === "settle-throws") throw new Error("synthetic uncertain settlement"); },
    }, markIdle() { idle++; } } as unknown as PluginHookReplyDispatchContext;
    const first = event(), result = await replyCheckpointFailure(first, ctx);
    assert.equal(result.handled, true); assert.equal(result.queuedFinal, mode === "settle-throws");
    await replyCheckpointFailure({ ...first }, ctx);
    assert.equal(sends, 1); assert.equal(complete, 1); assert.equal(idle, 1);
  });
});

test("cancelled, denied, suppressed and tail dispatches do not send failure text", async t => {
  for (const mode of ["cancel", "deny", "suppress", "tail"] as const) await t.test(mode, async () => {
    let sends = 0, idle = 0; const controller = new AbortController(), first = event();
    if (mode === "cancel") controller.abort();
    if (mode === "deny") first.sendPolicy = "deny";
    if (mode === "suppress") first.suppressUserDelivery = true;
    if (mode === "tail") first.isTailDispatch = true;
    const ctx = { abortSignal: controller.signal, dispatcher: { sendFinalReply() { sends++; return true; }, markComplete() {}, async waitForIdle() {} },
      markIdle() { idle++; } } as unknown as PluginHookReplyDispatchContext;
    assert.deepEqual(await replyCheckpointFailure(first, ctx), { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    assert.equal(sends, 0); assert.equal(idle, 1);
  });
});
