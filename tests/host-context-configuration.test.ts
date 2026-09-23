import assert from "node:assert/strict";
import test from "node:test";
import { hostContextExecutionHash, hostMemoryConfigurationHash } from "../src/openclaw/host-memory-inventory.js";

const binding = { agentId: "stella", canghaiRoot: "/private/personal-data", recoveryRevision: "a".repeat(40) };
const configuration = () => ({ agents: { entries: { stella: { model: "stella-guarded/model", workspace: "/private/stella" } } },
  plugins: { slots: { contextEngine: "stella-core" }, entries: {
    "stella-core": { enabled: true, config: { ...binding, dataMode: "managed_durable_write", contextHistorySignerId: "pinned-key" } },
    "active-memory": { enabled: true },
  } } });

test("managed context distinguishes a verified recovery-pointer advance from Host policy changes", () => {
  const before = configuration(), copy = structuredClone(before);
  const initial = hostContextExecutionHash(before, binding);
  const advanced = configuration();
  advanced.plugins.entries["stella-core"].config.recoveryRevision = "b".repeat(40);
  assert.throws(() => hostContextExecutionHash(advanced, binding), /host_context_recovery_binding_changed/);
  assert.equal(hostContextExecutionHash(advanced, { ...binding, recoveryRevision: "b".repeat(40) }), initial);
  assert.notEqual(hostMemoryConfigurationHash(before), hostMemoryConfigurationHash(advanced), "Inventory keeps the entire live config binding");
  assert.deepEqual(before, copy);
  for (const mutate of [
    (config: ReturnType<typeof configuration>) => { config.agents.entries.stella.model = "stella-guarded/other"; },
    (config: ReturnType<typeof configuration>) => { config.agents.entries.stella.workspace = "/other/workspace"; },
    (config: ReturnType<typeof configuration>) => { config.plugins.entries["active-memory"].enabled = false; },
    (config: ReturnType<typeof configuration>) => { config.plugins.entries["stella-core"].config.contextHistorySignerId = "changed-key"; },
    (config: ReturnType<typeof configuration>) => { config.plugins.slots.contextEngine = "other"; },
  ]) {
    const changed = configuration();
    mutate(changed);
    assert.notEqual(hostContextExecutionHash(changed, binding), initial);
  }
});

test("managed execution hashing requires the exact configured target and independently held recovery pointer", () => {
  for (const change of [{ agentId: "other" }, { canghaiRoot: "/other/repository" }, { recoveryRevision: "not-a-revision" }]) {
    const config = configuration();
    Object.assign(config.plugins.entries["stella-core"].config, change);
    assert.throws(() => hostContextExecutionHash(config, binding));
  }
  assert.throws(() => hostContextExecutionHash({}, binding));
  const disabled = configuration();
  disabled.plugins.entries["stella-core"].enabled = false;
  assert.throws(() => hostContextExecutionHash(disabled, binding));
});


test("managed wire timestamps use the original Host system-zone default", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const module = new URL("../src/openclaw/host-context-prompt.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { resolveManagedHostTimezone } = await import(${JSON.stringify(module)});
    console.log(JSON.stringify([resolveManagedHostTimezone(), resolveManagedHostTimezone(" invalid/zone "), resolveManagedHostTimezone(" UTC ")]));
  `], { env: { ...process.env, TZ: "Asia/Shanghai" } });
  assert.deepEqual(JSON.parse(stdout), ["Asia/Shanghai", "Asia/Shanghai", "UTC"]);
});


test("current user wire timestamp comes from custody while earlier messages retain their own timestamps", async () => {
  const { projectManagedMessages } = await import("../src/openclaw/host-context-prompt.js");
  const earlier = Date.parse("2026-09-23T04:00:00Z"), custody = earlier + 60_000, runtime = custody + 60_000;
  const messages = [{ role: "user" as const, content: "Prior input", timestamp: earlier },
    { role: "user" as const, content: "Current input", timestamp: runtime }];
  const input = { systemPrompt: "Public rules", tools: [], messages };
  const projected = projectManagedMessages(input, "UTC", { text: "Current input", timestamp: custody });
  assert.match(String(projected.messages[0]!.content), /04:00/);
  assert.match(String(projected.messages[1]!.content), /04:01/);
  assert.equal(input.messages[1]!.content, "Current input");
  const mismatched = projectManagedMessages(input, "UTC", { text: "Other input", timestamp: custody });
  assert.match(String(mismatched.messages[1]!.content), /04:02/);
});
