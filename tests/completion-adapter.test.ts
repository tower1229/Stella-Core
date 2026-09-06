import assert from "node:assert/strict";
import test from "node:test";
import { parsePrivateAssistantDraft, registerCompletionAdapter } from "../src/openclaw/completion-adapter.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

test("duplicate registrations cannot replace run ownership or finalize another callback's work", async () => {
  const handlers: Array<(event: any, context: any) => Promise<unknown>> = [];
  const api = { on(name: string, handler: any) { if (name === "reply_dispatch") handlers.push(handler); }, logger: { error() {} } } as unknown as OpenClawPluginApi;
  let settled = 0;
  const ports = { resourceScope: async () => "synthetic-scope", describeDraft: () => { throw new Error("Not reached"); },
    persist: async () => { throw new Error("Not reached"); }, settled() { settled++; } };
  registerCompletionAdapter(api, "duplicate-test", ports);
  registerCompletionAdapter(api, "duplicate-test", ports);
  let ownershipCalls = 0;
  let processed = 0;
  let idle = 0;
  let sent = 0;
  const context = { dispatchKind: "agent", dispatcher: { supportsSettledReceipt: true,
      sendFinalReply() { sent++; return true; }, markComplete() {}, async waitForIdle() {} },
    userTurnTranscriptRecorder: {},
    onAgentRunStart() { ownershipCalls++; throw new Error("Synthetic admission failure before model work"); },
    recordProcessed() { processed++; }, markIdle() { idle++; } };
  const event = { runId: "duplicate-registration-run", sessionKey: "agent:duplicate-test:case", ctx: {}, sendPolicy: "allow" };
  await Promise.all(handlers.map((handler) => handler(event, context)));
  // A delayed replay also cannot send a second failure or seize terminal ownership.
  await handlers[1]!(event, context);
  assert.equal(ownershipCalls, 1);
  assert.equal(processed, 1);
  assert.equal(idle, 1);
  assert.equal(sent, 1);
  assert.equal(settled, 0);
});

test("private draft capture extracts only a completed assistant answer", () => {
  assert.equal(parsePrivateAssistantDraft({ role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "synthetic private reasoning" },
    { type: "text", text: "Synthetic committed answer" },
  ] }), "Synthetic committed answer");
});

test("private draft capture rejects incomplete, tool, commentary and missing output", () => {
  for (const value of [undefined, {},
    { role: "assistant", stopReason: "length", content: [{ type: "text", text: "truncated" }] },
    { role: "assistant", stopReason: "stop", phase: "commentary", content: [{ type: "text", text: "progress" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "synthetic" }] },
    { role: "assistant", stopReason: "stop", content: [] },
  ]) assert.throws(() => parsePrivateAssistantDraft(value));
});
