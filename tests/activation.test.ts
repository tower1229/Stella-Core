import assert from "node:assert/strict";
import test from "node:test";
import { assessStellaActivation } from "../src/openclaw/activation.js";

const revision = "1".repeat(40);
const request = {
  canghaiRoot: "/private/canghai",
  recoveryRevision: revision,
  agentId: "main",
  dataMode: "managed_durable_write" as const,
  durabilityRemote: "origin",
  durabilityBranch: "local/stella-alpha",
};

test("reports a ready exact managed-write activation", () => {
  const desired = assessStellaActivation(request, {
    coreClean: true,
    canghaiClean: true,
    canghaiBranch: "local/stella-alpha",
    canghaiRevision: revision,
    openclawVersion: "2026.8.2",
    configValid: true,
    manifestValid: true,
    pluginRuntimeValid: true,
    pluginEntry: {},
  }).desiredEntry;
  const result = assessStellaActivation(request, {
    coreClean: true,
    canghaiClean: true,
    canghaiBranch: "local/stella-alpha",
    canghaiRevision: revision,
    openclawVersion: "2026.8.2",
    configValid: true,
    manifestValid: true,
    pluginRuntimeValid: true,
    pluginEntry: desired,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.issues, []);
});

test("includes the manifest default persisted by OpenClaw", () => {
  const desired = assessStellaActivation(request, {
    coreClean: true,
    canghaiClean: true,
    canghaiBranch: "local/stella-alpha",
    canghaiRevision: revision,
    openclawVersion: "2026.8.2",
    configValid: true,
    manifestValid: true,
    pluginRuntimeValid: true,
    pluginEntry: {},
  }).desiredEntry;
  assert.equal(
    desired.config.manifestPath,
    "50_PersonalAgent/stella/manifest.yaml",
  );
});

test("reports source, revision, Host, and policy drift without secrets", () => {
  const result = assessStellaActivation(request, {
    coreClean: false,
    canghaiClean: false,
    canghaiBranch: "dev",
    canghaiRevision: "2".repeat(40),
    openclawVersion: "2026.8.1",
    configValid: false,
    manifestValid: false,
    pluginRuntimeValid: false,
    pluginEntry: { config: { apiKey: "must-not-be-returned" } },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, [
    "core_source_dirty",
    "canghai_source_dirty",
    "canghai_branch_mismatch",
    "canghai_revision_mismatch",
    "openclaw_version_mismatch",
    "openclaw_config_invalid",
    "canghai_manifest_invalid",
    "stella_plugin_runtime_invalid",
    "stella_plugin_config_drift",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-be-returned/);
});

test("managed activation requires an explicit remote and branch", () => {
  assert.throws(
    () => assessStellaActivation(
      { ...request, durabilityRemote: undefined },
      {
        coreClean: true,
        canghaiClean: true,
        canghaiBranch: "local/stella-alpha",
        canghaiRevision: revision,
        openclawVersion: "2026.8.2",
        configValid: true,
        manifestValid: true,
        pluginRuntimeValid: true,
        pluginEntry: {},
      },
    ),
    /explicit durability remote and branch/,
  );
});
