import assert from "node:assert/strict";
import test from "node:test";
import { completionSessionTerminalPatch, parsePrivateAssistantDraft, registerCompletionAdapter } from "../src/openclaw/completion-adapter.js";
import { CatalogError } from "../src/canghai/catalog-reader.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

test("completion status is bound to the native session generation and start, including failure and cancellation", () => {
  const start = { sessionId: "synthetic-session", lifecycleRevision: "native-revision", startedAt: 1000 };
  const entry = { ...start, status: "running" as const, updatedAt: 1100 };
  for (const status of ["done", "failed", "killed"] as const) {
    const patch = completionSessionTerminalPatch(entry, start, { status, endedAt: 1200, error: "synthetic failure" });
    assert.equal(patch.status, status);
    assert.equal(patch.runtimeMs, 200);
    assert.equal(patch.abortedLastRun, status === "killed");
    assert.equal(patch.lastRunError, status === "failed" ? "synthetic failure" : undefined);
    assert.equal(Object.hasOwn(patch, "sessionId"), false);
    assert.equal(Object.hasOwn(patch, "lifecycleRevision"), false);
    assert.equal(Object.hasOwn(patch, "activeWriterRunId"), false);
  }
  for (const changed of [{ ...entry, sessionId: "reset-session" }, { ...entry, lifecycleRevision: "new-revision" },
    { ...entry, startedAt: 1100 }, { ...entry, status: "killed" as const }]) {
    assert.throws(() => completionSessionTerminalPatch(changed, start, { status: "done", endedAt: 1200 }), /host_completion_session_changed/);
  }
  assert.throws(() => completionSessionTerminalPatch(entry, start, { status: "done", endedAt: 999 }), /host_completion_session_changed/);
});

test("Host reset commands retain their native session lifecycle", async () => {
  let dispatch: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
  const api = { on(name: string, handler: unknown) {
    if (name === "reply_dispatch") dispatch = handler as typeof dispatch;
  } } as unknown as OpenClawPluginApi;
  let admitted = 0;
  registerCompletionAdapter(api, "probe", { assertHostResetAllowed: async () => {},
    resourceScope: async () => { admitted++; return "synthetic"; },
    describeDraft: () => { throw new Error("Unexpected draft"); },
    persist: async () => { throw new Error("Unexpected persistence"); }, settled() {} });
  assert.ok(dispatch);
  for (const commandName of ["new", "reset"]) {
    const result = await dispatch({ sessionKey: "agent:probe:main", runId: `host-${commandName}`,
      ctx: { CommandTurn: { kind: "text-slash", source: "text", commandName, authorized: true }, CommandAuthorized: true } }, {});
    assert.equal(result, undefined);
  }
  assert.equal(admitted, 0);
});

test("a blocked Host reset ends before an ordinary model turn", async () => {
  let dispatch: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
  const api = { on(name: string, handler: unknown) {
    if (name === "reply_dispatch") dispatch = handler as typeof dispatch;
  }, logger: { error() {} } } as unknown as OpenClawPluginApi;
  let admitted = 0;
  let settled = 0;
  let processed = "";
  registerCompletionAdapter(api, "blocked-reset", {
    assertHostResetAllowed: async () => { throw new CatalogError("host_memory_consumption_unverifiable"); },
    resourceScope: async () => { admitted++; return "synthetic"; },
    describeDraft: () => { throw new Error("Unexpected draft"); },
    persist: async () => { throw new Error("Unexpected persistence"); },
    settled() { settled++; },
  });
  assert.ok(dispatch);
  const result = await dispatch({ sessionKey: "agent:blocked-reset:main", runId: "blocked-reset-command",
    ctx: { CommandTurn: { kind: "text-slash", source: "text", commandName: "new", authorized: true } },
    sendPolicy: "allow" }, { dispatchKind: "agent", dispatcher: { supportsSettledReceipt: true },
    onAgentRunStart: () => "reply-dispatch", userTurnTranscriptRecorder: {},
    recordProcessed(_status: string, outcome: { reason: string }) { processed = outcome.reason; }, markIdle() {} });
  assert.deepEqual(result, { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  assert.equal(admitted, 0);
  assert.equal(settled, 1);
  assert.equal(processed, "stella_host_memory_consumption_unverifiable");
});

test("Host diagnostic failures still release the completion and mark dispatch idle", async () => {
  let dispatch: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
  const api = { on(name: string, handler: unknown) { if (name === "reply_dispatch") dispatch = handler as typeof dispatch; },
    logger: { error() { throw new Error("synthetic diagnostic failure"); } } } as unknown as OpenClawPluginApi;
  let settled = 0;
  let idle = 0;
  registerCompletionAdapter(api, "cleanup-reset", {
    assertHostResetAllowed: async () => { throw new CatalogError("host_memory_consumption_unverifiable"); },
    resourceScope: async () => { throw new Error("Unexpected admission"); },
    describeDraft: () => { throw new Error("Unexpected draft"); }, persist: async () => { throw new Error("Unexpected persistence"); },
    settled() { settled++; throw new Error("synthetic cleanup failure"); },
  });
  assert.ok(dispatch);
  await assert.rejects(dispatch({ runId: "cleanup-reset-command", sessionKey: "agent:cleanup-reset:main", sendPolicy: "allow",
    ctx: { CommandTurn: { kind: "text-slash", commandName: "new" } } }, {
    dispatchKind: "agent", dispatcher: { supportsSettledReceipt: true }, userTurnTranscriptRecorder: {},
    onAgentRunStart: () => "reply-dispatch", recordProcessed() {}, markIdle() { idle++; },
  }), /synthetic diagnostic failure/);
  assert.equal(settled, 1);
  assert.equal(idle, 1);
});

test("duplicate registrations cannot replace run ownership or finalize another callback's work", async () => {
  const handlers: Array<(event: any, context: any) => Promise<unknown>> = [];
  const api = { on(name: string, handler: any) { if (name === "reply_dispatch") handlers.push(handler); }, logger: { error() {} } } as unknown as OpenClawPluginApi;
  let settled = 0;
  const ports = { assertHostResetAllowed: async () => {}, resourceScope: async () => "synthetic-scope", describeDraft: () => { throw new Error("Not reached"); },
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
