import assert from "node:assert/strict";
import test from "node:test";

const { observeExactHostRunTerminal } = await import(new URL("../../scripts/lib/exact-host-gateway.mjs", import.meta.url).href);

test("terminal observation keeps one run through unfinished Host waits and preserves its actual failure", async () => {
  const failed = { runId: "once", status: "error", endedAt: 123, error: "persist_failed" };
  const responses = [{ runId: "once", status: "pending", timeoutPhase: "queue" },
    { runId: "once", status: "timeout", timeoutPhase: "gateway_draining" }, failed];
  const observed: string[] = [];
  const result = await observeExactHostRunTerminal({ runId: "once", timeoutMs: 200, intervalMs: 1,
    async readTerminal(params: { runId: string; timeoutMs: number }) {
      observed.push(params.runId);
      assert.ok(params.timeoutMs > 0 && params.timeoutMs <= 200);
      return responses.shift();
    },
  });
  assert.equal(result, failed);
  assert.deepEqual(observed, ["once", "once", "once"]);
});

test("terminal observation does not hide ended timeouts or unrelated Host failures", async () => {
  for (const terminal of [{ runId: "once", status: "timeout", timeoutPhase: "queue", endedAt: 123 },
    { runId: "once", status: "error", error: "source_changed" },
    { runId: "once", status: "timeout", timeoutPhase: "provider" }]) {
    let calls = 0;
    assert.equal(await observeExactHostRunTerminal({ runId: "once", async readTerminal() { calls++; return terminal; } }), terminal);
    assert.equal(calls, 1);
  }
});

test("terminal observation rejects another run or malformed responses", async () => {
  for (const response of [undefined, { runId: "different", status: "ok" }, { runId: "once" }]) {
    await assert.rejects(observeExactHostRunTerminal({ runId: "once", async readTerminal() { return response; } }), /exact_host_terminal_invalid/);
  }
});

test("terminal observation fails explicitly when the same run never ends", async () => {
  await assert.rejects(observeExactHostRunTerminal({ runId: "once", timeoutMs: 10, intervalMs: 1,
    async readTerminal() { return { runId: "once", status: "timeout", timeoutPhase: "gateway_draining" }; },
  }), /exact_host_terminal_observation_timeout/);
});
