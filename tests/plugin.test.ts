import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import plugin from "../src/plugin.js";
import { EpisodeRepository } from "../src/praxis/episode-repository.js";
import { memoryRoutingRef } from "../src/praxis/runtime-memory.js";
import type { EpisodeV2 } from "../src/praxis/episode-v2.js";
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
  assessEvidence?: (params: unknown) => Promise<{ text: string; provider?: string; model?: string }>,
): Map<string, HookHandler> {
  const hooks = new Map<string, HookHandler>();
  const api = {
    pluginConfig: {
      canghaiRoot: root,
      recoveryRevision,
      agentId: "stella",
      dataMode,
      ...(dataMode === "managed_durable_write" ? { durabilityRemote: "origin", durabilityBranch: "local/stella-alpha" } : {}),
    },
    runtime: { version: "2026.8.2", llm: { complete: async (params: { purpose?: string; messages?: Array<{ content: string }> }) => {
      if (params.purpose === "stella-question-evidence") {
        if (assessEvidence) return assessEvidence(params);
        const input = JSON.parse(params.messages![0]!.content.split("\n").at(-1)!) as { provisionalRoute: { responseKind: string; evidenceStatus: string; materialUnknowns: string[] } };
        return { provider: "synthetic", model: "injected", text: JSON.stringify({ status: input.provisionalRoute.evidenceStatus,
          claims: [], unresolvedLeads: input.provisionalRoute.materialUnknowns.map((question) => ({ question, material: true, reason: "Synthetic unknown" })),
          stoppingReason: "Synthetic configured empty source scope", suggestedResponseKind: input.provisionalRoute.responseKind }) };
      }
      return complete(params);
    } } },
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
    registerGatewayMethod(name: string, handler: HookHandler, options: { scope: string }) {
      assert.equal(options.scope, "operator.admin");
      hooks.set(`gateway:${name}`, handler);
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
    registerGatewayMethod() {},
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

test("recovery Gateway method rejects missing admin authority and caller-supplied destinations before model access", async () => {
  const root = await createFixture();
  try {
    let modelCalls = 0;
    const hooks = registerPlugin(root, await initializeFixtureRepository(root), async () => { modelCalls++; throw new Error("Must not call model"); }, "managed_durable_write");
    for (const [method, prefix] of [["stella.recoverOutcome", "outcome"], ["stella.recoverQuestionEvidence", "question"]]) {
    const recover = requireHook(hooks, `gateway:${method}`);
    const operationId = `${prefix}_${"a".repeat(64)}`;
    for (const request of [
      { client: null, params: { operationId }, category: "recovery_admin_required" },
      { client: { connect: { role: "operator", scopes: ["operator.read"] } }, params: { operationId }, category: "recovery_admin_required" },
      { client: { connect: { role: "operator", scopes: ["operator.admin"] } }, params: { operationId, root: "untrusted" }, category: "invalid_recovery_request" },
    ]) {
      let responses = 0;
      await recover({ ...request, respond(ok: boolean, _payload: unknown, error: { message: string }) {
        responses++; assert.equal(ok, false); assert.match(error.message, new RegExp(request.category));
      } }, {});
      assert.equal(responses, 1);
    }
    }
    assert.equal(modelCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("main outcome route requests evidence clarification without closing an unauthenticated report", async () => {
  const root = await createFixture();
  try {
    const repository = new EpisodeRepository(root, "30_PersonalData/praxis/episodes", {
      async resolveHistorical() {}, async resolveEvidence() { assert.fail("No action evidence exists"); },
      async resolveLearning() { assert.fail("No learning exists"); }, async verifyActionEvidence() { return false; },
      async verifyOutcomeEvidence() { return false; }, async isCurrentlyEligible() { return true; }, async persist() {},
    });
    const now = "2026-09-05T00:00:00Z";
    const open: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "praxis-main-clarification", status: "open",
      createdAt: now, updatedAt: now, recoveryPriority: "important", historicalInputRefs: [], provenance: {},
      situation: { summary: "Synthetic weekend invitation", domains: ["social"], observations: [] } };
    const opened = await repository.apply({ operationId: "synthetic-open", expectedVersion: null, episode: open });
    const advised = await repository.apply({ operationId: "synthetic-advice", expectedVersion: opened.version,
      episode: { ...open, status: "recommended", decision: { recommendation: "Confirm a suitable time", rationale: [] } } });
    const episodeRef = memoryRoutingRef({ id: open.id, version: advised.version }, repository.historicalPath(open.id, advised.version));
    const revision = await initializeFixtureRepository(root);
    let calls = 0;
    const hooks = registerPlugin(root, revision, async (params) => {
      calls++;
      const purpose = (params as { purpose: string }).purpose;
      if (purpose !== "stella-core-semantic-routing") return { text: JSON.stringify({ openEpisodeRef: null }) };
      return { text: JSON.stringify({ mode: "outcome", responseKind: "outcome_ack", evidenceStatus: "sufficient", materialUnknowns: [],
        domains: ["social"], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false,
        outcome: { openEpisodeRef: episodeRef } }) };
    });
    await preparedRun(hooks, "outcome-clarification", "后来约成了", (result, gate) => {
      assert.deepEqual(gate, { outcome: "pass" });
      assert.match(result?.appendContext ?? "", /"responseKind":"clarification"/);
      const prepared = readCompletionPreparation("outcome-clarification") as { persistRecommendation?: unknown };
      assert.equal(prepared.persistRecommendation, undefined);
    });
    assert.equal(calls, 2);
    assert.equal((await repository.read(open.id)).version, advised.version);
    assert.equal((await execFileAsync("git", ["-C", root, "status", "--porcelain"])).stdout.trim(), "");
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

test("managed advice preparation defers all business writes until coordinated persistence", async () => {
  const root = await createFixture();
  try {
    const revision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, revision, praxisRouteCompletion, "managed_durable_write");
    await preparedRun(hooks, "managed-prepare", "她两天没回我，我要不要再发一条？", (_prompt, gate) => {
      assert.deepEqual(gate, { outcome: "pass" });
      assert.equal(typeof (readCompletionPreparation("managed-prepare") as { persistRecommendation?: unknown }).persistRecommendation, "function");
    });
    assert.equal((await readdir(path.join(root, "30_PersonalData/praxis/episodes"))).some((name) => name.startsWith("praxis-") || name === ".staging"), false);
    const status = await execFileAsync("git", ["-C", root, "status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("original-evidence judgment can replace provisional advice with clarification without staging an Episode", async () => {
  const root = await createFixture();
  try {
    const revision = await initializeFixtureRepository(root);
    const hooks = registerPlugin(root, revision, praxisRouteCompletion, "managed_durable_write", [], async () => ({
      provider: "synthetic", model: "injected", text: JSON.stringify({ status: "material_unknown", claims: [],
        unresolvedLeads: [{ question: "此前明确约定了什么时候回复？", material: true, reason: "This changes whether the delay contradicts an actual commitment" }],
        stoppingReason: "No original commitment available in the configured scope", suggestedResponseKind: "clarification" }),
    }));
    await preparedRun(hooks, "evidence-clarification", "她两天没回我，我要不要再发一条？", (prompt, gate) => {
      assert.deepEqual(gate, { outcome: "pass" });
      const prepared = readCompletionPreparation("evidence-clarification") as { route: { responseKind: string }; persistRecommendation?: unknown };
      assert.equal(prepared.route.responseKind, "clarification");
      assert.equal(typeof prepared.persistRecommendation, "function");
      assert.match(prompt!.appendContext!, /此前明确约定/);
      assert.doesNotMatch(prompt!.appendContext!, /"responseKind":"action_advice"/);
    });
    assert.equal((await execFileAsync("git", ["-C", root, "status", "--porcelain"])).stdout.trim(), "");
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
    await updateFixtureManifest(root, (manifest) => manifest.replace("activationStatus: active", "activationStatus: migration_required"));
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
