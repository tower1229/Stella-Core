import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExactHostAgentArguments,
  parseExactHostAgentOutput,
} from "../src/acceptance/exact-host-agent.js";

test("builds a local exact-Host turn for a clean runtime without a Gateway", () => {
  assert.deepEqual(
    buildExactHostAgentArguments({
      agentId: "stella",
      message: "continuity probe",
      sessionKey: "agent:stella:private-recovery-identity",
    }),
    [
      "agent",
      "--local",
      "--agent",
      "stella",
      "--session-key",
      "agent:stella:private-recovery-identity",
      "--message",
      "continuity probe",
      "--json",
      "--timeout",
      "120",
    ],
  );
});

test("accepts the final JSON envelope after Host diagnostics", () => {
  assert.equal(
    parseExactHostAgentOutput(
      '[host] diagnostic\n{"ok":true,"status":"ok","final":"restored"}\n',
      "identity",
    ),
    "restored",
  );
});

test("accepts the OpenClaw agent JSON envelope", () => {
  assert.equal(
    parseExactHostAgentOutput(
      JSON.stringify({
        runId: "run-1",
        status: "ok",
        summary: "completed",
        result: { payloads: [{ text: "identity restored", mediaUrl: null }] },
      }),
      "identity",
    ),
    "identity restored",
  );
});

test("accepts the local OpenClaw agent result envelope", () => {
  assert.equal(
    parseExactHostAgentOutput(
      JSON.stringify({ payloads: [{ text: "Praxis restored", mediaUrl: null }], meta: {} }),
      "praxis",
    ),
    "Praxis restored",
  );
});

test("rejects a failed or empty exact-Host turn", () => {
  assert.throws(
    () => parseExactHostAgentOutput('{"ok":false,"status":"error","final":""}', "identity"),
    /did not complete successfully/,
  );
  for (const status of ["timeout", "failed", "cancelled"]) {
    assert.throws(
      () => parseExactHostAgentOutput(
        JSON.stringify({ status, payloads: [{ text: "partial output" }] }),
        "identity",
      ),
      /did not complete successfully/,
    );
  }
  assert.throws(
    () => parseExactHostAgentOutput(
      JSON.stringify({ ok: "false", payloads: [{ text: "partial output" }] }),
      "identity",
    ),
    /did not complete successfully/,
  );
});
