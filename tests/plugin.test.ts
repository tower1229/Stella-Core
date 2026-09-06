import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import plugin from "../src/plugin.js";
import { coordinateCompletion, completionDraftHash, readCompletionPreparation } from "../src/openclaw/completion.js";
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
        mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [],
        domains: ["general"],
        needsTwin: false,
        needsFramework: false,
        needsReality: false,
        needsExternalResearch: false,
      }),
    };
  },
  dataMode: "read_only" | "local_write" | "managed_durable_write" = "read_only",
  errors: string[] = [],
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
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(message: string) {
        errors.push(message);
      },
    },
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
const fixtureTwinRefs = ["path:30_PersonalData/twin/hypotheses/twin_fixture.md"];

async function praxisRouteCompletion(): Promise<{ text: string }> {
  return {
    text: JSON.stringify({
      mode: "praxis", responseKind: "action_advice", evidenceStatus: "sufficient", materialUnknowns: [],
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

test("plugin requires explicit data mode and managed durability transport", () => {
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
    /durabilityRemote/,
  );
  assert.doesNotThrow(() => plugin.register({
    ...api,
    pluginConfig: {
      ...api.pluginConfig,
      dataMode: "managed_durable_write",
      durabilityRemote: "origin",
      durabilityBranch: "stella-alpha",
    },
  } as never));
});


type PromptResult = { prependSystemContext?: string; appendContext?: string };
async function preparedRun(hooks: Map<string, HookHandler>, runId: string, prompt: string,
  verify: (value: PromptResult | undefined, gate: unknown, context: HookContext) => void | Promise<void>,
  admissionHooks = hooks): Promise<void> {
  await coordinateCompletion({ operationId: runId, runId, timeoutMs: 10_000 }, {
    async generateDraft() {
      const context = { agentId: "stella", runId, sessionKey: "agent:stella:test" };
      const event = { prompt, messages: [] };
      const result = await requireHook(hooks, "before_prompt_build")(event, context) as PromptResult | undefined;
      const gate = await requireHook(admissionHooks, "before_agent_run")(event, context);
      await verify(result, gate, context);
      return { draftId: runId, text: "synthetic", evidenceRef: "synthetic", responseKind: "answer", requiresCriticalPersistence: false };
    },
    async persist({ operationId, draft }) {
      return { schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
        draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind, evidenceRef: draft.evidenceRef,
        writeOperationIds: [], observedRevision: "a".repeat(40), generationId: "synthetic", persistenceStatus: "not_required",
        checkedAt: new Date().toISOString() };
    },
    async publishFinal() { return { deliveryId: "synthetic", status: "confirmed" }; },
  });
}

test("main plugin registers coordinated completion and removes soft critical writers", async () => {
  const root = await createFixture();
  try {
    const hooks = registerPlugin(root, await initializeFixtureRepository(root));
    assert.ok(hooks.has("reply_dispatch"));
    assert.ok(hooks.has("llm_output"));
    for (const name of ["after_tool_call", "before_agent_finalize", "agent_end"]) assert.equal(hooks.has(name), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncoordinated target execution is blocked before semantic calls or writes", async () => {
  const root = await createFixture();
  try {
    let calls = 0;
    const hooks = registerPlugin(root, await initializeFixtureRepository(root), async () => { calls++; return praxisRouteCompletion(); }, "local_write");
    const context = { agentId: "stella", runId: "direct", sessionKey: "agent:stella:test" };
    assert.equal(await requireHook(hooks, "before_prompt_build")({ prompt: "synthetic", messages: [] }, context), undefined);
    assert.equal((await requireHook(hooks, "before_agent_run")({}, context) as { category: string }).category, "capability_unavailable");
    assert.equal(calls, 0);
    assert.equal((await readdir(path.join(root, "30_PersonalData/praxis/episodes"))).some((name) => name.startsWith("praxis-") || name === ".staging"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared context crosses independent main hook registrations and is admitted once", async () => {
  const root = await createFixture();
  try {
    const revision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, revision);
    const otherRegistration = registerPlugin(root, revision);
    await preparedRun(hooks, "cross-registration", "synthetic ordinary question", async (prompt, gate, context) => {
      assert.deepEqual(gate, { outcome: "pass" });
      assert.match(prompt!.appendContext!, /CangHai is the sole authority/);
      assert.match(prompt!.appendContext!, /response_contract/);
      assert.doesNotMatch(prompt!.appendContext!, /stella_core_praxis_context/);
      assert.equal((readCompletionPreparation("cross-registration") as { admitted: boolean }).admitted, true);
      assert.equal((await requireHook(otherRegistration, "before_agent_run")({}, context) as { outcome: string }).outcome, "block");
    }, otherRegistration);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only decision prepares a traceable packet without staging an Episode", async () => {
  const root = await createFixture();
  try {
    const hooks = registerPlugin(root, await initializeFixtureRepository(root), praxisRouteCompletion);
    await preparedRun(hooks, "readonly-praxis", "她两天没回我，我要不要再发一条？", (prompt, gate) => {
      assert.deepEqual(gate, { outcome: "pass" });
      assert.match(prompt!.appendContext!, /stella_core_praxis_context/);
      assert.match(prompt!.appendContext!, /action_advice/);
      assert.equal((readCompletionPreparation("readonly-praxis") as { persistRecommendation?: unknown }).persistRecommendation, undefined);
    });
    assert.equal((await readdir(path.join(root, "30_PersonalData/praxis/episodes"))).some((name) => name.startsWith("praxis-") || name === ".staging"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local-only advice cannot claim critical durable completion or stage a record", async () => {
  const root = await createFixture();
  try {
    const revision = await initializeFixtureRepository(root);
    await execFileAsync("git", ["-C", root, "switch", "-c", "local/stella-alpha"]);
    const hooks = registerPlugin(root, revision, praxisRouteCompletion, "local_write");
    await preparedRun(hooks, "local-praxis", "她两天没回我，我要不要再发一条？", (prompt, gate) => {
      assert.equal(prompt, undefined);
      assert.equal((gate as { category: string }).category, "critical_durability_required");
    });
    assert.equal((await readdir(path.join(root, "30_PersonalData/praxis/episodes"))).some((name) => name.startsWith("praxis-") || name === ".staging"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("semantic failures remain explicit and exclude raw provider content", async () => {
  const root = await createFixture();
  try {
    const errors: string[] = [];
    const hooks = registerPlugin(root, await initializeFixtureRepository(root), async () => {
      throw new Error("SYNTHETIC_PRIVATE_PROVIDER_TEXT");
    }, "read_only", errors);
    await preparedRun(hooks, "routing-failure", "SYNTHETIC_PRIVATE_PROMPT", (prompt, gate) => {
      assert.equal(prompt, undefined);
      assert.equal((gate as { outcome: string }).outcome, "block");
      assert.doesNotMatch(JSON.stringify(gate), /SYNTHETIC_PRIVATE/);
    });
    assert.ok(errors.length);
    assert.doesNotMatch(errors.join("\n"), /SYNTHETIC_PRIVATE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration-required consciousness blocks coordinated admission", async () => {
  const root = await createFixture();
  try {
    await updateFixtureManifest(root, (manifest) => { manifest.runtimeState.activationStatus = "migration_required"; });
    const hooks = registerPlugin(root, await initializeFixtureRepository(root));
    await preparedRun(hooks, "migration", "synthetic", (prompt, gate) => {
      assert.equal(prompt, undefined);
      assert.equal((gate as { category: string }).category, "stella_migration_required");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-target execution remains outside Stella admission and context injection", async () => {
  const root = await createFixture();
  try {
    const hooks = registerPlugin(root, "a".repeat(40));
    const context = { agentId: "ordinary" };
    assert.deepEqual(await requireHook(hooks, "before_agent_run")({}, context), { outcome: "pass" });
    assert.equal(await requireHook(hooks, "before_prompt_build")({ prompt: "synthetic" }, context), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
