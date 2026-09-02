import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import plugin from "../src/plugin.js";
import {
  createFixture,
  initializeFixtureRepository,
  updateFixtureManifest,
} from "./consciousness-fixture.js";

type HookContext = { agentId?: string; runId?: string; sessionKey?: string };
type HookHandler = (event: unknown, context: HookContext) => unknown | Promise<unknown>;

function registerPlugin(
  root: string,
  recoveryRevision: string,
  complete: (params: unknown) => Promise<{ text: string }> = async () => {
    return {
      text: JSON.stringify({
        mode: "ordinary",
        domains: ["general"],
        needsTwin: false,
        needsFramework: false,
        needsReality: false,
        needsExternalResearch: false,
      }),
    };
  },
): Map<string, HookHandler> {
  const hooks = new Map<string, HookHandler>();
  const api = {
    pluginConfig: {
      canghaiRoot: root,
      recoveryRevision,
      agentId: "stella",
    },
    runtime: { version: "2026.8.2", llm: { complete } },
    on(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
  };
  plugin.register(api as never);
  return hooks;
}

const fixtureOperatorRefs = [
  "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:reversible_test",
  "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:observation_test",
];

async function praxisRouteCompletion(): Promise<{ text: string }> {
  return {
    text: JSON.stringify({
      mode: "praxis",
      domains: ["relationship"],
      stakes: "medium",
      reversibility: "high",
      needsTwin: true,
      needsFramework: true,
      needsReality: true,
      needsExternalResearch: false,
      candidateFrameworks: fixtureOperatorRefs,
      situation: {
        actors: ["self", "other"],
        observations: ["她两天没回我消息"],
        interpretations: ["我觉得她可能在疏远我"],
        unknowns: ["她没有回复的原因"],
        userGoals: ["判断是否再发一条消息"],
        constraints: ["不想给她压力"],
      },
    }),
  };
}

function requireHook(hooks: Map<string, HookHandler>, name: string): HookHandler {
  const hook = hooks.get(name);
  assert.ok(hook, `expected ${name} hook`);
  return hook;
}

test("target agent passes the gate and ordinary turn bypasses Cortex context", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision);
    const event = { prompt: "TypeScript 的 satisfies 是什么？", messages: [] };
    const context = { agentId: "stella", runId: "ordinary-run", sessionKey: "agent:stella:test" };
    const gate = await requireHook(hooks, "before_agent_run")(event, context);
    assert.deepEqual(gate, { outcome: "pass" });

    const prompt = await requireHook(hooks, "before_prompt_build")(
      event,
      context,
    );
    assert.ok(typeof prompt === "object" && prompt !== null);
    assert.doesNotMatch(JSON.stringify(prompt), /stella_core_(?:consciousness|praxis_context)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-target agent bypasses consciousness loading and injection", async () => {
  const root = await createFixture();
  try {
    const hooks = registerPlugin(root, "1".repeat(40));
    const gate = await requireHook(hooks, "before_agent_run")({}, { agentId: "ordinary" });
    const prompt = await requireHook(hooks, "before_prompt_build")(
      { prompt: "她没回我，我要不要再发一条？", messages: [] },
      { agentId: "ordinary" },
    );
    assert.deepEqual(gate, { outcome: "pass" });
    assert.equal(prompt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relationship decision receives a bounded traceable Praxis packet", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision, praxisRouteCompletion);
    const event = {
      prompt: "她两天没回我消息，我觉得她可能在疏远我。我想知道要不要再发一条，又不想给她压力。",
      messages: [],
    };
    const context = { agentId: "stella", runId: "praxis-run", sessionKey: "agent:stella:test" };
    assert.deepEqual(await requireHook(hooks, "before_agent_run")(event, context), {
      outcome: "pass",
    });
    const prompt = await requireHook(hooks, "before_prompt_build")(
      event,
      context,
    );

    const rendered = JSON.stringify(prompt);
    assert.match(rendered, /stella_core_praxis_context/);
    assert.match(rendered, /#operator:reversible_test/);
    assert.match(rendered, /path:30_PersonalData\/twin\/hypotheses\/twin_fixture\.md/);
    assert.doesNotMatch(rendered, /stella_core_consciousness/);
    assert.ok(rendered.length <= 13_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous target turn uses the public semantic router", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    let routingCalls = 0;
    const hooks = registerPlugin(root, recoveryRevision, async () => {
      routingCalls += 1;
      return {
        text: JSON.stringify({
          mode: "twin",
          domains: ["personal"],
          needsTwin: true,
          needsFramework: false,
          needsReality: false,
          needsExternalResearch: false,
        }),
      };
    });
    const event = { prompt: "这件事让我有点在意。", messages: [] };
    const context = { agentId: "stella", runId: "twin-run", sessionKey: "agent:stella:test" };
    assert.deepEqual(await requireHook(hooks, "before_agent_run")(event, context), {
      outcome: "pass",
    });
    const prompt = await requireHook(hooks, "before_prompt_build")(
      event,
      context,
    );

    assert.equal(routingCalls, 1);
    assert.match(JSON.stringify(prompt), /stella_core_consciousness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic routing failure is explicit and does not masquerade as ordinary", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision, async () => ({ text: "not-json" }));
    await assert.rejects(
      async () =>
        requireHook(hooks, "before_agent_run")(
          { prompt: "含义需要判断的日常表达", messages: [] },
          {
            agentId: "stella",
            runId: "failed-route-run",
            sessionKey: "agent:stella:test",
          },
        ),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_semantic_routing_failed",
    );
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
    const gate = await requireHook(hooks, "before_agent_run")(
      { prompt: "migration fixture", messages: [] },
      { agentId: "stella", runId: "migration-run", sessionKey: "agent:stella:test" },
    );
    assert.ok(typeof gate === "object" && gate !== null && "category" in gate);
    assert.equal(gate.category, "stella_migration_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consciousness failure output does not expose private source lines", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "30_PersonalData/praxis/playbook/registry.yaml"),
      "items:\n private-secret-source-line",
      "utf8",
    );
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision);
    const gate = await requireHook(hooks, "before_agent_run")(
      { prompt: "我要不要回复她？", messages: [] },
      { agentId: "stella", runId: "invalid-record-run", sessionKey: "agent:stella:test" },
    );

    assert.ok(typeof gate === "object" && gate !== null && "category" in gate);
    assert.equal(gate.category, "stella_record_invalid");
    assert.doesNotMatch(JSON.stringify(gate), /private-secret-source-line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
