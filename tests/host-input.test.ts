import assert from "node:assert/strict";
import test from "node:test";
import { captureHostInput } from "../src/openclaw/host-input.js";

function fixture() {
  const message = { role: "user", content: [{ type: "text", text: "Synthetic original owner report" }], timestamp: 1 };
  const event = { type: "message", id: "message-original", parentId: "parent-original", timestamp: "2026-09-06T00:00:00Z", message };
  const admission = { role: "user", agentId: "synthetic", sessionId: "session-original", sessionKey: "agent:synthetic:test",
    storePath: "runtime-only-location", entryId: event.id, logicalTurnId: "logical-original", generation: "generation-original",
    rawSeq: 3, effectiveParentId: event.parentId };
  const input = { hostVersion: "2026.8.2", agentId: admission.agentId, sessionId: admission.sessionId, sessionKey: admission.sessionKey,
    recorder: { hasPersisted: () => true, getAdmissionReceipt: () => admission, getPersistedMessage: () => message } };
  return { message, event, admission, input };
}
test("Host capture binds the committed user event, recorder and logical turn without exporting local store paths", () => {
  const { input, event } = fixture();
  const snapshot = captureHostInput(input, (params) => {
    assert.equal(params.storePath, "runtime-only-location");
    return [{ type: "session" }, event];
  });
  assert.equal(snapshot.entryId, event.id);
  assert.equal(snapshot.logicalTurnId, "logical-original");
  assert.equal(snapshot.text, "Synthetic original owner report");
  assert.doesNotMatch(JSON.stringify(snapshot), /runtime-only-location/);
  event.message.content[0]!.text = "Changed after capture";
  assert.equal(snapshot.text, "Synthetic original owner report");
});
test("Host capture rejects missing, ambiguous, mismatched and unpersisted messages", () => {
  const { input, event } = fixture();
  for (const events of [[], [event, event], [{ ...event, parentId: "wrong" }], [{ ...event, message: { ...event.message, content: "fabricated" } }]]) {
    assert.throws(() => captureHostInput(input, () => events), /host_input_unavailable/);
  }
  assert.throws(() => captureHostInput({ ...input, recorder: { ...input.recorder, hasPersisted: () => false } }, () => [event]), /host_input_unavailable/);
  assert.throws(() => captureHostInput({ ...input, sessionId: "other-session" }, () => [event]), /host_input_unavailable/);
  assert.throws(() => captureHostInput({ ...input, hostVersion: "unverified-host" }, () => [event]), /host_input_unavailable/);
});
