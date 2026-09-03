import assert from "node:assert/strict";
import test from "node:test";
import {
  ALPHA_HOST_VERSION,
  assertStellaHostConfig,
  assertStellaPluginRuntime,
  parseExactHostRecoveryReceipt,
  parseExactHostVersion,
} from "../src/acceptance/exact-host-evidence.js";

const receipt = {
  schemaVersion: "stella.exact-host-recovery-receipt/v1",
  coreRevision: "1".repeat(40),
  canghaiRevision: "2".repeat(40),
  hostVersion: ALPHA_HOST_VERSION,
  artifactSha256: "3".repeat(64),
  canghaiFixture: "private",
  cleanRuntimeState: true,
  importedLegacyRuntime: false,
  dataReadable: true,
  cognitiveBootstrapRestored: true,
  derivedRuntimeRebuilt: true,
  continuityAccepted: true,
  identityRestored: true,
  frameworkRestored: true,
  twinRestored: true,
  praxisLearningRestored: true,
  importantOpenStateRestored: true,
  exactHostAgentTurns: 3,
  privateFixtureIncluded: true,
};

test("accepts only the pinned OpenClaw version", () => {
  assert.equal(parseExactHostVersion("OpenClaw 2026.8.2 (build)\n"), ALPHA_HOST_VERSION);
  assert.throws(() => parseExactHostVersion("OpenClaw 2026.8.1\n"), /requires OpenClaw/);
});

test("validates the effective Stella Host source binding", () => {
  const expected = { canghaiRoot: "/private/canghai", canghaiRevision: "2".repeat(40), agentId: "stella" };
  assert.doesNotThrow(() => assertStellaHostConfig({
    canghaiRoot: expected.canghaiRoot,
    recoveryRevision: expected.canghaiRevision,
    agentId: expected.agentId,
    dataMode: "read_only",
  }, expected));
  assert.throws(() => assertStellaHostConfig({
    canghaiRoot: "/other",
    recoveryRevision: expected.canghaiRevision,
    agentId: expected.agentId,
    dataMode: "read_only",
  }, expected), /not bound/);
});

test("requires the packed Stella runtime and admission hooks to be active", () => {
  const runtime = {
    plugin: { id: "stella-core", status: "loaded", activated: true },
    typedHooks: [{ name: "before_prompt_build" }, { name: "before_agent_run" }],
  };
  assert.doesNotThrow(() => assertStellaPluginRuntime(runtime));
  assert.throws(
    () => assertStellaPluginRuntime({ ...runtime, typedHooks: [{ name: "before_prompt_build" }] }),
    /not active/,
  );
});

test("fails closed for incomplete or non-exact recovery receipts", () => {
  assert.deepEqual(parseExactHostRecoveryReceipt(receipt), receipt);
  assert.throws(() => parseExactHostRecoveryReceipt({ ...receipt, hostVersion: "2026.8.1" }), /Invalid/);
  assert.throws(() => parseExactHostRecoveryReceipt({ ...receipt, continuityAccepted: false }), /Invalid/);
  assert.throws(() => parseExactHostRecoveryReceipt({ ...receipt, importedLegacyRuntime: true }), /Invalid/);
  assert.throws(() => parseExactHostRecoveryReceipt({ ...receipt, coreRevision: "short" }), /Invalid/);
});
