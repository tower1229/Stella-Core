import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import plugin from "../src/plugin.js";
import {
  createFixture,
  initializeFixtureRepository,
  updateFixtureManifest,
} from "./consciousness-fixture.js";

const execFileAsync = promisify(execFile);

type HookContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  trace?: { traceId: string };
};
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
  dataMode: "read_only" | "local_write" | "managed_durable_write" = "read_only",
): Map<string, HookHandler> {
  const hooks = new Map<string, HookHandler>();
  const api = {
    pluginConfig: {
      canghaiRoot: root,
      recoveryRevision,
      agentId: "stella",
      dataMode,
    },
    runtime: { version: "2026.8.2", llm: { complete } },
    on(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
  };
  plugin.register(api as never);
  return hooks;
}

test("plugin stages prediction before finalization, learns from a tool outcome, and retrieves it", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    await execFileAsync("git", ["-C", root, "switch", "-c", "local/stella-alpha"]);
    let routeNumber = 0;
    let episodeRef = "";
    let learningRef = "";
    const hooks = registerPlugin(root, recoveryRevision, async (params) => {
      routeNumber += 1;
      const systemPrompt = JSON.stringify(params);
      if (routeNumber === 1) return praxisRouteCompletion();
      if (routeNumber === 2) {
        const match = systemPrompt.match(
          /path:30_PersonalData\/praxis\/episodes\/praxis-[a-zA-Z0-9_-]+\/episode\.json/,
        );
        assert.ok(match, "outcome routing should receive an open Episode candidate");
        assert.match(systemPrompt, /send-one-message/);
        episodeRef = match[0];
        return {
          text: JSON.stringify({
            mode: "outcome",
            domains: ["relationship"],
            needsTwin: false,
            needsFramework: false,
            needsReality: false,
            needsExternalResearch: false,
            outcome: {
              openEpisodeRef: episodeRef,
              actualAction: "等待对方主动联系",
              source: "tool_observation",
              observations: ["一周后对方主动恢复联系"],
              result: "等待避免了额外压力",
              predictionAssessment: "countered",
              praxisLearning: "高不确定关系情境中，等待对方主动有时更符合低压目标。",
              observedAt: "2026-09-03T02:00:00.000Z",
            },
          }),
        };
      }
      const match = systemPrompt.match(
        /path:30_PersonalData\/praxis\/episodes\/praxis-[a-zA-Z0-9_-]+\/episode\.json#learning:praxis:0/,
      );
      assert.ok(match, "next Praxis routing should receive the learned item candidate");
      learningRef = match[0];
      const response = await praxisRouteCompletion();
      const parsed = JSON.parse(response.text) as Record<string, unknown>;
      parsed.candidatePraxisRefs = [learningRef];
      return { text: JSON.stringify(parsed) };
    }, "local_write");

    const firstContext = {
      agentId: "stella",
      runId: "praxis-write-run",
      sessionKey: "agent:stella:learning",
      sessionId: "session-learning",
    };
    const firstEvent = {
      prompt: "她两天没回我，我要不要再发一条？",
      messages: [],
    };
    await requireHook(hooks, "before_prompt_build")(firstEvent, firstContext);
    const episodeRoot = path.join(root, "30_PersonalData/praxis/episodes");
    assert.equal((await readdir(episodeRoot)).some((entry) => entry.startsWith("praxis-")), false);
    const createdDirectory = (await readdir(path.join(episodeRoot, ".staging")))[0];
    assert.ok(createdDirectory, "prediction must be durably staged before finalization");
    const stagedPredictionPath = path.join(episodeRoot, ".staging", createdDirectory, "prediction.json");
    const predictionPath = path.join(episodeRoot, createdDirectory, "prediction.json");
    const originalPrediction = await readFile(stagedPredictionPath);

    await requireHook(hooks, "agent_end")(
      {
        runId: firstContext.runId,
        success: true,
        messages: [{ role: "assistant", content: "发一条低压消息，然后等待。" }],
      },
      firstContext,
    );

    const outcomeContext = {
      agentId: "stella",
      runId: "outcome-write-run",
      sessionKey: "agent:stella:learning",
      sessionId: "session-learning",
    };
    const circularResult: { self?: unknown } = {};
    circularResult.self = circularResult;
    await assert.rejects(
      async () => {
        await requireHook(hooks, "after_tool_call")(
          {
            toolName: "relationship-observation",
            params: {},
            result: circularResult,
            runId: outcomeContext.runId,
          },
          outcomeContext,
        );
      },
      /not serializable/,
    );
    await requireHook(hooks, "after_tool_call")(
      {
        toolName: "relationship-observation",
        params: {},
        result: { observation: "后来我没继续发，她一周后主动联系我了。" },
        runId: outcomeContext.runId,
      },
      outcomeContext,
    );
    assert.deepEqual(await readFile(predictionPath), originalPrediction);

    const nextContext = {
      agentId: "stella",
      runId: "next-praxis-run",
      sessionKey: "agent:stella:learning",
      sessionId: "session-learning",
    };
    const nextPrompt = await requireHook(hooks, "before_prompt_build")(
      { prompt: "这次也是类似情况，我该怎么做？", messages: [] },
      nextContext,
    );
    assert.match(JSON.stringify(nextPrompt), /等待对方主动有时更符合低压目标/);
    assert.match(JSON.stringify(nextPrompt), new RegExp(learningRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed agent run discards its staged prediction without exposing an Episode", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    await execFileAsync("git", ["-C", root, "switch", "-c", "local/stella-alpha"]);
    const hooks = registerPlugin(root, recoveryRevision, praxisRouteCompletion, "local_write");
    const context = {
      agentId: "stella",
      runId: "failed-praxis-run",
      sessionKey: "agent:stella:failed",
      sessionId: "session-failed",
    };
    await requireHook(hooks, "before_prompt_build")(
      { prompt: "她没回复，我该怎么办？", messages: [] },
      context,
    );
    await requireHook(hooks, "agent_end")(
      { runId: context.runId, messages: [], success: false, error: "model failed" },
      context,
    );

    const episodeRoot = path.join(root, "30_PersonalData/praxis/episodes");
    assert.deepEqual(
      (await readdir(episodeRoot)).filter((entry) => entry.startsWith("praxis-")),
      [],
    );
    assert.deepEqual(await readdir(path.join(episodeRoot, ".staging")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fixtureOperatorRefs = [
  "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:reversible_test",
  "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:observation_test",
];
const fixtureTwinRefs = ["path:30_PersonalData/twin/hypotheses/twin_fixture.md"];

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
      candidateTwinRefs: fixtureTwinRefs,
      candidatePraxisRefs: [],
      twinPrediction: {
        possibleActions: { "send-one-message": 0.65, wait: 0.35 },
        likelyInterpretations: ["用户会优先选择可逆行动"],
        keyFactors: ["不想给对方压力"],
      },
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

test("plugin requires an explicit supported data mode and rejects managed writes", () => {
  const api = {
    pluginConfig: {
      canghaiRoot: "/tmp/canghai",
      recoveryRevision: "1".repeat(40),
      agentId: "stella",
    },
    runtime: { version: "2026.8.2", llm: { complete: async () => ({ text: "{}" }) } },
    on() {},
  };
  assert.throws(() => plugin.register(api as never), /config\.dataMode/);
  assert.throws(
    () => plugin.register({
      ...api,
      pluginConfig: { ...api.pluginConfig, dataMode: "managed_durable_write" },
    } as never),
    /not enabled/,
  );
});

test("target agent passes the gate and ordinary turn bypasses Cortex context", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision);
    const event = { prompt: "TypeScript 的 satisfies 是什么？", messages: [] };
    const context = { agentId: "stella", runId: "ordinary-run", sessionKey: "agent:stella:test" };
    const prompt = await requireHook(hooks, "before_prompt_build")(
      event,
      context,
    );
    const gate = await requireHook(hooks, "before_agent_run")(event, context);
    assert.deepEqual(gate, { outcome: "pass" });
    const replayedGate = await requireHook(hooks, "before_agent_run")(event, context);
    assert.ok(
      typeof replayedGate === "object" &&
        replayedGate !== null &&
        "outcome" in replayedGate &&
        replayedGate.outcome === "block",
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
    const prompt = await requireHook(hooks, "before_prompt_build")(
      event,
      context,
    );
    assert.deepEqual(await requireHook(hooks, "before_agent_run")(event, context), {
      outcome: "pass",
    });

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
          candidateTwinRefs: fixtureTwinRefs,
        }),
      };
    });
    const event = { prompt: "这件事让我有点在意。", messages: [] };
    const context = { agentId: "stella", runId: "twin-run", sessionKey: "agent:stella:test" };
    const prompt = await requireHook(hooks, "before_prompt_build")(
      event,
      context,
    );
    assert.deepEqual(await requireHook(hooks, "before_agent_run")(event, context), {
      outcome: "pass",
    });

    assert.equal(routingCalls, 1);
    assert.match(JSON.stringify(prompt), /stella_core_consciousness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-session prepared turns are admitted in preparation order", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    let calls = 0;
    const hooks = registerPlugin(root, recoveryRevision, async () => {
      calls += 1;
      if (calls === 1) {
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
      }
      return { text: "not-json" };
    });
    const firstContext = {
      agentId: "stella",
      sessionKey: "agent:stella:shared",
      trace: { traceId: "1".repeat(32) },
    };
    const secondContext = {
      agentId: "stella",
      sessionKey: "agent:stella:shared",
      trace: { traceId: "2".repeat(32) },
    };
    const first = { prompt: "first", messages: [] };
    const second = { prompt: "second", messages: [] };

    await requireHook(hooks, "before_prompt_build")(first, firstContext);
    await requireHook(hooks, "before_prompt_build")(second, secondContext);

    assert.deepEqual(await requireHook(hooks, "before_agent_run")(first, firstContext), {
      outcome: "pass",
    });
    const secondGate = await requireHook(hooks, "before_agent_run")(second, secondContext);
    assert.ok(
      typeof secondGate === "object" && secondGate !== null &&
        "outcome" in secondGate && secondGate.outcome === "block",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-session concurrent preparation is correlated to the exact trace", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const hooks = registerPlugin(root, recoveryRevision, async (params) => {
      const prompt = JSON.stringify(params);
      if (prompt.includes("first concurrent turn")) {
        await firstMayFinish;
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
      }
      return { text: "not-json" };
    });
    const first = { prompt: "first concurrent turn", messages: [] };
    const second = { prompt: "second concurrent turn", messages: [] };
    const firstContext = {
      agentId: "stella",
      sessionKey: "agent:stella:concurrent",
      trace: { traceId: "a".repeat(32) },
    };
    const secondContext = {
      agentId: "stella",
      sessionKey: "agent:stella:concurrent",
      trace: { traceId: "b".repeat(32) },
    };

    const firstPreparation = requireHook(hooks, "before_prompt_build")(first, firstContext);
    await requireHook(hooks, "before_prompt_build")(second, secondContext);
    releaseFirst?.();
    await firstPreparation;

    assert.deepEqual(await requireHook(hooks, "before_agent_run")(first, firstContext), {
      outcome: "pass",
    });
    const secondGate = await requireHook(hooks, "before_agent_run")(second, secondContext);
    assert.ok(
      typeof secondGate === "object" && secondGate !== null &&
        "category" in secondGate && secondGate.category === "stella_semantic_routing_failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic routing failure is explicit and does not masquerade as ordinary", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, recoveryRevision, async () => ({ text: "not-json" }));
    const event = { prompt: "含义需要判断的日常表达", messages: [] };
    const context = {
      agentId: "stella",
      runId: "failed-route-run",
      sessionKey: "agent:stella:test",
    };
    assert.equal(
      await requireHook(hooks, "before_prompt_build")(event, context),
      undefined,
    );
    const gate = await requireHook(hooks, "before_agent_run")(event, context);
    assert.ok(
      typeof gate === "object" && gate !== null && "category" in gate && "outcome" in gate,
    );
    assert.equal(gate.category, "stella_semantic_routing_failed");
    assert.equal(gate.outcome, "block");
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
    const event = { prompt: "migration fixture", messages: [] };
    const context = {
      agentId: "stella",
      runId: "migration-run",
      sessionKey: "agent:stella:test",
    };
    await requireHook(hooks, "before_prompt_build")(event, context);
    const gate = await requireHook(hooks, "before_agent_run")(event, context);
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
    const event = { prompt: "我要不要回复她？", messages: [] };
    const context = {
      agentId: "stella",
      runId: "invalid-record-run",
      sessionKey: "agent:stella:test",
    };
    await requireHook(hooks, "before_prompt_build")(event, context);
    const gate = await requireHook(hooks, "before_agent_run")(event, context);

    assert.ok(typeof gate === "object" && gate !== null && "category" in gate);
    assert.equal(gate.category, "stella_record_invalid");
    assert.doesNotMatch(JSON.stringify(gate), /private-secret-source-line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
