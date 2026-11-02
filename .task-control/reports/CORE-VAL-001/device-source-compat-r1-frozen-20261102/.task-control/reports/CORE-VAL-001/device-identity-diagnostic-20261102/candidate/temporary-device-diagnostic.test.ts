import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTemporaryDeviceDiagnostic } from "./temporary-device-diagnostic.js";
const device = "a".repeat(64);
const digest = createHash("sha256").update(`openclaw-device:${device}`).digest("hex");
function fixture() {
  let reads = 0, keys = 0;
  const abort = new AbortController();
  const identity = { get deviceId() { reads++; return device; }, get key(): string { keys++; throw new Error("key must not be read"); } };
  const scope: any = { signal: abort.signal, hasCurrentClientAuthority: () => true,
    client: { connId: "synthetic-connection", authenticatedUserProfile: { profileId: "synthetic-profile" },
      internal: { authenticatedControlUi: true, authenticatedOperator: true, operatorDeviceTokenIdentity: identity } } };
  return { scope, abort, inspect: () => ({ reads, keys }), run: () => createTemporaryDeviceDiagnostic(digest, () => scope)(true) };
}
test("exact attested device yields only five booleans and reads device scalar once without key", () => {
  const f = fixture(), r = f.run(); assert.deepEqual(Object.values(r), [true, true, true, true, true]);
  assert.equal(Object.keys(r).length, 5); assert.deepEqual(f.inspect(), { reads: 1, keys: 0 });
  assert.equal(JSON.stringify(r).includes(device), false); assert.equal(JSON.stringify(r).includes("synthetic-profile"), false);
});
test("ineligible or delegated callers cannot inspect attestation; CLI does not prove Control UI", () => {
  assert.equal(createTemporaryDeviceDiagnostic(digest, () => { throw new Error("must not inspect"); })(false).matchesOriginalGrant, false);
  for (const name of ["syntheticClient", "agentToolCaller", "agentRuntimeIdentity", "pluginSubagentRequester"]) {
    const f = fixture(); f.scope.client.internal[name] = true; assert.equal(f.run().matchesOriginalGrant, false); assert.equal(f.inspect().reads, 0);
  }
  const f = fixture(); f.scope.client.internal.authenticatedControlUi = false;
  assert.equal(f.run().authenticatedControlUi, false); assert.equal(f.inspect().reads, 0);
});
test("missing, wire-only, wrong and malformed device facts do not match even a device-looking profile", () => {
  for (const value of [undefined, null, { deviceId: "b".repeat(64) }, { deviceId: "wrong" }]) {
    const f = fixture(); f.scope.client.internal.operatorDeviceTokenIdentity = value;
    f.scope.client.connect = { device: { id: device } }; f.scope.client.authenticatedUserProfile.profileId = `openclaw-device:${device}`;
    assert.equal(f.run().matchesOriginalGrant, false);
  }
});
test("expired authority, cancellation or invalidated connection cannot report a match", () => {
  const f = fixture(); f.abort.abort(); assert.equal(f.run().matchesOriginalGrant, false);
  const g = fixture(); g.scope.client.invalidated = true; assert.equal(g.run().matchesOriginalGrant, false);
  const h = fixture(); let calls = 0; h.scope.hasCurrentClientAuthority = () => ++calls === 1;
  assert.equal(h.run().matchesOriginalGrant, false); assert.equal(calls, 2);
});
test("each status call observes its own scope; no prior connection or device result is reused", () => {
  const a = fixture(), b = fixture(); b.scope.client.connId = "another-connection";
  b.scope.client.internal.operatorDeviceTokenIdentity = { deviceId: "b".repeat(64) };
  let scope = a.scope; const inspect = createTemporaryDeviceDiagnostic(digest, () => scope);
  assert.equal(inspect(true).matchesOriginalGrant, true); scope = b.scope; assert.equal(inspect(true).matchesOriginalGrant, false);
});
test("missing prepared seed fails before diagnostic construction", () => {
  for (const seed of ["", "a", "A".repeat(64)]) assert.throws(() => createTemporaryDeviceDiagnostic(seed, () => undefined), /seed_missing/);
});
