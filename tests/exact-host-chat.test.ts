import assert from "node:assert/strict";
import test from "node:test";
import { runExactHostEvaluationChat, type EvaluationChatPort } from "../src/acceptance/exact-host-chat.js";

function fixture(statuses: unknown[]) {
  let listener: (event: unknown) => void = () => {};
  const calls: string[] = [];
  let unsubscribed = false;
  const port: EvaluationChatPort = {
    subscribe(callback) { listener = callback; return () => { unsubscribed = true; }; },
    async request(method) {
      calls.push(method);
      if (method === "chat.send") return { runId: "run" };
      return statuses.shift();
    },
  };
  const emit = (state = "final", runId = "run") => listener({ event: "chat", payload: {
    sessionKey: "session", runId, state, message: { role: "assistant", content: [{ type: "text", text: "exact answer\n" }] },
  } });
  return { port, calls, emit, unsubscribed: () => unsubscribed };
}
const input = { sessionKey: "session", message: "question", idempotencyKey: "once", timeoutMs: 2000 };

test("evaluation observes the same chat run through queue timeout and binds the delivered final", async () => {
  const f = fixture([{ runId: "run", status: "timeout", timeoutPhase: "queue" }, { runId: "run", status: "ok" }]);
  const result = runExactHostEvaluationChat(f.port, input);
  f.emit("final", "unrelated");
  f.emit();
  assert.deepEqual(await result, { runId: "run", text: "exact answer\n" });
  assert.deepEqual(f.calls, ["chat.send", "agent.wait", "agent.wait"]);
  assert.equal(f.unsubscribed(), true);
});

test("terminal failure and ambiguous delivery never resend or accept transcript drafts", async () => {
  for (const status of [{ runId: "run", status: "error" }, { runId: "run", status: "timeout", endedAt: 123, timeoutPhase: "queue" }]) {
    const f = fixture([status]);
    const result = runExactHostEvaluationChat(f.port, input);
    f.emit();
    await assert.rejects(result, /evaluation_chat_run_failed/);
    assert.equal(f.calls.filter((method) => method === "chat.send").length, 1);
  }
  const f = fixture([{ runId: "run", status: "ok" }]);
  const result = runExactHostEvaluationChat(f.port, input);
  f.emit(); f.emit();
  await assert.rejects(result, /evaluation_chat_delivery_unconfirmed/);
});

test("transport failure is sanitized and cannot trigger a second submission", async () => {
  const f = fixture([]);
  f.port.request = async () => { throw new Error("PRIVATE PROMPT AND LOCAL PATH"); };
  await assert.rejects(runExactHostEvaluationChat(f.port, input), { message: "evaluation_chat_transport_failed" });
  assert.equal(f.unsubscribed(), true);
});
