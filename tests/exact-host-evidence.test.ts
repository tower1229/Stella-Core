import assert from "node:assert/strict";
import test from "node:test";
import {
  ALPHA_HOST_VERSION,
  assertStellaHostConfig,
  assertStellaHostHooks,
  assertStellaPluginManifest,
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

test("requires the packed plugin to activate when the OpenClaw Gateway starts", () => {
  assert.doesNotThrow(() => assertStellaPluginManifest({
    id: "stella-core",
    activation: { onStartup: true, onAgentHarnesses: ["openclaw"] },
  }));
  assert.throws(() => assertStellaPluginManifest({
    id: "stella-core",
    activation: { onAgentHarnesses: ["openclaw"] },
  }), /not activated/);
  assert.throws(() => assertStellaPluginManifest({
    id: "stella-core",
    activation: { onStartup: true },
  }), /not activated/);
  assert.throws(() => assertStellaPluginManifest({
    id: "stella-core",
    activation: { onStartup: true, onAgentHarnesses: ["other"] },
  }), /not activated/);
});

test("requires explicit prompt injection permission and a sufficient semantic hook budget", () => {
  assert.doesNotThrow(() => assertStellaHostHooks({
    allowConversationAccess: true,
    allowPromptInjection: true,
    timeouts: {
      before_prompt_build: 90_000,
      before_agent_finalize: 90_000,
      agent_end: 90_000,
    },
  }));
  assert.throws(() => assertStellaHostHooks({
    allowConversationAccess: true,
    allowPromptInjection: false,
    timeouts: {
      before_prompt_build: 90_000,
      before_agent_finalize: 90_000,
      agent_end: 90_000,
    },
  }), /insufficient/);
  assert.throws(() => assertStellaHostHooks({
    allowConversationAccess: true,
    allowPromptInjection: true,
    timeouts: {
      before_prompt_build: 15_000,
      before_agent_finalize: 15_000,
      agent_end: 15_000,
    },
  }), /insufficient/);
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
    typedHooks: [
      { name: "before_prompt_build" },
      { name: "before_agent_finalize" },
      { name: "before_agent_run" },
    ],
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
