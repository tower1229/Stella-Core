import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { bytesVersion } from "../src/canghai/content-version.js";
import { inspectDeclaredHostMemory } from "../src/openclaw/host-memory-inventory.js";
import { hostMemoryRuntimeBlockers } from "../src/openclaw/host-memory.js";

function inspect(config: OpenClawConfig, plugins: unknown[] = []) {
  const result = inspectDeclaredHostMemory({ config, agentId: "probe", plugins: { plugins }, generationId: "generation" });
  assert.equal(result.complete, false);
  assert.deepEqual(result.blockers, ["host_memory_consumption_unverifiable"]);
  assert.deepEqual(hostMemoryRuntimeBlockers("full_memory"), result.blockers);
  return result;
}
const core = { id: "memory-core", installed: true, enabled: true };
const row = (result: ReturnType<typeof inspect>, identity: string) => result.entries.find(entry => entry.identityHash === bytesVersion(identity))!;

test("bundled Dreaming is inventoried independently of a standalone plugin", () => {
  for (const enabled of [undefined, true, false]) {
    const result = inspect({ plugins: { entries: { "memory-core": { enabled: true,
      config: enabled === undefined ? {} : { dreaming: { enabled } } } } } }, [core]);
    const dreaming = row(result, "memory-core:dreaming");
    assert.equal(dreaming.kind, "dreaming");
    assert.equal(dreaming.state, enabled === false ? "disabled" : "unverifiable");
    assert.equal(dreaming.reason, enabled === false ? "host_reports_disabled" : "native_dreaming_generation_binding_unavailable");
    assert.equal(result.entries.filter(entry => entry.kind === "dreaming").length, 1);
  }
});

test("a standalone Dreaming plugin cannot inherit the bundled feature's disable", () => {
  const result = inspect({ plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } } },
    [core, { id: "dreaming", installed: true, enabled: true }]);
  assert.equal(row(result, "memory-core:dreaming").state, "disabled");
  assert.equal(row(result, "plugin:dreaming").state, "unverifiable");
});

test("configured missing plugins stay visible and private identities stay hashed", () => {
  for (const installed of [[], [{ id: "private-configured-plugin", installed: false, enabled: false }]]) {
    const result = inspect({ plugins: { entries: { "private-configured-plugin": { enabled: true } } } }, installed);
    assert.equal(row(result, "plugin:private-configured-plugin").state, "unverifiable");
    assert.equal(row(result, "plugin:private-configured-plugin").reason, "declared_plugin_inventory_missing");
    assert.ok(!JSON.stringify(result).includes("private-configured-plugin"));
  }
});

test("allowlisted missing plugins and configured code loaders cannot disappear from the inventory", () => {
  const result = inspect({ plugins: { allow: ["private-allowlisted-plugin"], load: { paths: ["/private/plugin-path"] } },
    hooks: { internal: { load: { extraDirs: ["/private/hook-path"] } } } });
  assert.equal(row(result, "plugin:private-allowlisted-plugin").reason, "declared_plugin_inventory_missing");
  for (const identity of ["additional_plugin_loader:/private/plugin-path", "additional_internal_hook_loader:/private/hook-path"]) {
    assert.equal(row(result, identity).state, "unverifiable");
    assert.equal(row(result, identity).reason, "declared_loader_inventory_unavailable");
  }
  assert.ok(!JSON.stringify(result).includes("/private/"));
});

test("contradictory enabled states cannot certify a disabled producer", () => {
  for (const [configured, observed] of [[false, true], [true, false]]) {
    const result = inspect({ plugins: { entries: { "memory-core": { enabled: configured } } } }, [{ ...core, enabled: observed }]);
    assert.equal(row(result, "plugin:memory-core").state, "unverifiable");
    assert.equal(row(result, "plugin:memory-core").reason, "host_plugin_state_conflict");
    assert.equal(row(result, "memory-core:dreaming").state, "unverifiable");
  }
});

test("explicit disables remain diagnostic and never clear the complete profile", () => {
  const result = inspect({ plugins: { entries: { "memory-core": { enabled: false }, "private-disabled-plugin": { enabled: false } } } });
  for (const identity of ["plugin:memory-core", "plugin:private-disabled-plugin", "memory-core:dreaming"]) {
    assert.equal(row(result, identity).state, "disabled");
  }
});

test("configured internal hooks are inventoried while absent bundled hooks remain unknown", () => {
  const config: OpenClawConfig = { hooks: { internal: { entries: {
    "private-custom-hook": { enabled: true }, "private-disabled-hook": { enabled: false },
  } } } };
  const result = inspect(config);
  assert.equal(row(result, "hook:session-memory").state, "unverifiable");
  assert.equal(row(result, "hook:private-custom-hook").kind, "additional_internal_hook");
  assert.equal(row(result, "hook:private-custom-hook").state, "unverifiable");
  assert.equal(row(result, "hook:private-disabled-hook").state, "disabled");
  assert.ok(!JSON.stringify(result).includes("private-custom-hook"));
  config.hooks!.internal!.enabled = false;
  assert.equal(row(inspect(config), "hook:private-custom-hook").state, "disabled");
});

test("malformed, duplicate and excessive inventories fail explicitly", () => {
  assert.throws(() => inspect({}, [core, core]), /invalid_host_memory_inventory/);
  assert.throws(() => inspect({}, [{ ...core, installed: undefined }]), /invalid_host_memory_inventory/);
  const entries = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`configured-${index}`, { enabled: true }]));
  assert.throws(() => inspect({ plugins: { entries } }), /invalid_host_memory_inventory/);
  assert.throws(() => inspect({ hooks: { internal: { entries } } }), /invalid_host_memory_inventory/);
});
