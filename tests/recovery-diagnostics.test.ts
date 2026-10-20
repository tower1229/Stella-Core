import assert from "node:assert/strict";
import test from "node:test";
import { recoveryFailureDiagnostic } from "../src/openclaw/recovery-diagnostics.js";

test("recovery diagnostics preserve operational causes while excluding private error text", () => {
  const cause = Object.assign(new Error("private-source-path and model output"), { code: "ENOENT" });
  const error = new Error("private request", { cause });
  error.name = "RecoveryPointerSyncError";
  assert.deepEqual(recoveryFailureDiagnostic("recover", error), {
    stage: "recover", causes: [{ name: "RecoveryPointerSyncError" }, { name: "Error", code: "ENOENT" }],
  });
  cause.name = "private-source-name";
  cause.code = "private-token";
  assert.deepEqual(recoveryFailureDiagnostic("recover", error).causes[1], { name: "Error" });
});

test("recovery diagnostics bound cyclic causes and do not serialize arbitrary thrown values", () => {
  const error = new Error("private");
  error.cause = error;
  assert.deepEqual(recoveryFailureDiagnostic("binding", error), { stage: "binding", causes: [{ name: "Error" }] });
  assert.deepEqual(recoveryFailureDiagnostic("binding", { toJSON() { throw new Error("Must not serialize"); } }), { stage: "binding", causes: [] });
});

test("recovery diagnostics preserve subprocess exit status without exposing its command", () => {
  const error = Object.assign(new Error("private git command and repository path"), { code: 128, cmd: "private", stderr: "private" });
  assert.deepEqual(recoveryFailureDiagnostic("recover", error), { stage: "recover", causes: [{ name: "Error", exitCode: 128 }] });
});
