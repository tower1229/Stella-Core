import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import plugin from "../src/plugin.js";
import {
  createFixture,
  initializeFixtureRepository,
  updateFixtureManifest,
} from "./consciousness-fixture.js";

type HookContext = { agentId?: string };
type HookHandler = (event: unknown, context: HookContext) => unknown | Promise<unknown>;

function registerPlugin(root: string, recoveryRevision: string): Map<string, HookHandler> {
  const hooks = new Map<string, HookHandler>();
  const api = {
    pluginConfig: {
      canghaiRoot: root,
      recoveryRevision,
      agentId: "stella",
    },
    runtime: { version: "2026.8.2" },
    on(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
  };
  plugin.register(api as never);
  return hooks;
}

function requireHook(hooks: Map<string, HookHandler>, name: string): HookHandler {
  const hook = hooks.get(name);
  assert.ok(hook, `expected ${name} hook`);
  return hook;
}

test("target agent passes the gate and receives bounded consciousness context", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision);
    const gate = await requireHook(hooks, "before_agent_run")({}, { agentId: "stella" });
    assert.deepEqual(gate, { outcome: "pass" });

    const prompt = await requireHook(hooks, "before_prompt_build")({}, { agentId: "stella" });
    assert.ok(typeof prompt === "object" && prompt !== null);
    assert.match(JSON.stringify(prompt), new RegExp(recoveryRevision));
    assert.ok(JSON.stringify(prompt).length <= 33_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-target agent bypasses consciousness loading and injection", async () => {
  const root = await createFixture();
  try {
    const hooks = registerPlugin(root, "1".repeat(40));
    const gate = await requireHook(hooks, "before_agent_run")({}, { agentId: "ordinary" });
    const prompt = await requireHook(hooks, "before_prompt_build")({}, { agentId: "ordinary" });
    assert.deepEqual(gate, { outcome: "pass" });
    assert.equal(prompt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target agent receives the stable migration failure category", async () => {
  const root = await createFixture();
  try {
    await updateFixtureManifest(root, (manifest) =>
      manifest.replace("activationStatus: active", "activationStatus: migration_required"),
    );
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision);
    const gate = await requireHook(hooks, "before_agent_run")({}, { agentId: "stella" });
    assert.ok(typeof gate === "object" && gate !== null && "category" in gate);
    assert.equal(gate.category, "stella_migration_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
