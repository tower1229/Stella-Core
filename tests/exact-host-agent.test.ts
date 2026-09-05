import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExactHostAgentArguments,
  buildExactHostAgentCommand,
  extractSafeExactHostAgentError,
  parseExactHostAgentOutput,
  parseExactHostAgentTurn,
} from "../src/acceptance/exact-host-agent.js";

const runtimeMeta = {
  systemPromptReport: { currentTurn: { runtimeContextChars: 321 } },
};

test("builds an exact-Host turn through the Gateway", () => {
  assert.deepEqual(
    buildExactHostAgentArguments({
      agentId: "stella",
      message: "continuity probe",
      sessionKey: "agent:stella:private-recovery-identity",
    }),
    [
      "agent",
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

test("launches the OpenClaw module through the current Node executable", () => {
  assert.deepEqual(
    buildExactHostAgentCommand("C:/consumer/node_modules/openclaw/openclaw.mjs", {
      agentId: "stella",
      message: "continuity probe",
      sessionKey: "agent:stella:private-recovery-identity",
    }),
    {
      executable: process.execPath,
      args: [
        "C:/consumer/node_modules/openclaw/openclaw.mjs",
        ...buildExactHostAgentArguments({
          agentId: "stella",
          message: "continuity probe",
          sessionKey: "agent:stella:private-recovery-identity",
        }),
      ],
    },
  );
});

test("accepts the final JSON envelope after Host diagnostics", () => {
  assert.equal(
    parseExactHostAgentOutput(
      `[host] diagnostic\n${JSON.stringify({
        ok: true,
        status: "ok",
        final: "restored",
        meta: runtimeMeta,
      })}\n`,
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
        result: {
          payloads: [{ text: "identity restored", mediaUrl: null }],
          meta: runtimeMeta,
        },
      }),
      "identity",
    ),
    "identity restored",
  );
});

test("accepts the local OpenClaw agent result envelope", () => {
  assert.equal(
    parseExactHostAgentOutput(
      JSON.stringify({ payloads: [{ text: "Praxis restored", mediaUrl: null }], meta: runtimeMeta }),
      "praxis",
    ),
    "Praxis restored",
  );
});

test("reports the Host-observed runtime context and rejects omitted evidence", () => {
  assert.deepEqual(
    parseExactHostAgentTurn(JSON.stringify({
      status: "ok",
      payloads: [{ text: "restored" }],
      meta: runtimeMeta,
    }), "identity"),
    { text: "restored", runtimeContextChars: 321 },
  );
  assert.throws(
    () => parseExactHostAgentOutput(JSON.stringify({
      status: "ok",
      payloads: [{ text: "restored" }],
      meta: {},
    }), "identity"),
    /omitted runtime-context evidence/,
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

test("extracts and redacts nested OpenClaw agent errors", () => {
  const privateMessage = "private relationship details";
  const stdout = JSON.stringify({
    runId: "run-1",
    status: "error",
    result: {
      error: {
        kind: "hook_block",
        message: `Stella could not prepare this turn: ${privateMessage} at C:\\private\\state token_abcdefghijklmnopqrstuvwxyz0123456789`,
      },
    },
  });
  const diagnostic = extractSafeExactHostAgentError(stdout, privateMessage);
  assert.equal(
    diagnostic,
    "Stella could not prepare this turn: <private-message> at <path> <token>",
  );
});
