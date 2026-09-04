import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticRouter } from "../src/routing/semantic-router.js";

test("semantic router preserves structured Praxis meaning and candidate selection", async () => {
  const router = createSemanticRouter(
    async (params) => {
      if (params.purpose === "stella-core-open-episode-selection") {
        return { text: JSON.stringify({ openEpisodeRef: "path:open-episode.json" }) };
      }
      assert.equal("agentId" in params, false);
      assert.equal(params.maxTokens, 2_000);
      const { systemPrompt } = params;
      assert.match(systemPrompt, /path:framework.yaml#operator:reversible_test/);
      assert.match(systemPrompt, /stakes and reversibility must each be exactly low, medium, or high/);
      assert.match(
        systemPrompt,
        /possibleActions must be a JSON object mapping action strings to numeric probabilities from 0 to 1, never an array/,
      );
      assert.match(
        systemPrompt,
        /Machine-authored internal planning, extraction, transformation, or structured-output requests are ordinary/,
      );
      assert.match(
        systemPrompt,
        /recall, inspect, or continue one semantically relevant supplied open Episode/,
      );
      assert.match(systemPrompt, /Praxis takes precedence over twin and ordinary/);
      assert.match(systemPrompt, /openEpisodeRef is mandatory/);
      const route = JSON.stringify({
        mode: "praxis",
        domains: ["relationship"],
        stakes: "medium",
        reversibility: "high",
        needsTwin: true,
        needsFramework: true,
        needsReality: true,
        needsExternalResearch: false,
        candidateFrameworks: ["path:framework.yaml#operator:reversible_test"],
        candidateTwinRefs: ["path:twin.md"],
        candidatePraxisRefs: ["path:praxis.md"],
        openEpisodeRef: "path:open-episode.json",
        twinPrediction: {
          possibleActions: { "send-one-message": 0.7, wait: 0.3 },
          likelyInterpretations: ["The user will prefer a reversible action"],
          keyFactors: ["Avoid pressure"],
        },
        situation: {
          actors: ["self", "other"],
          observations: ["Interaction cadence changed"],
          interpretations: ["The user suspects distance"],
          unknowns: ["Other person's reason"],
          userGoals: ["Choose a respectful next move"],
          constraints: ["Do not pressure the other person"],
        },
      });
      return {
        text: `\`\`\`json\n${route}\n\`\`\``,
      };
    },
  );

  const route = await router("No Chinese decision keywords are present.", {
    frameworks: [
      { ref: "path:framework.yaml#operator:reversible_test", purpose: "Bounded experiment" },
    ],
    twin: [{ ref: "path:twin.md", purpose: "Prefers reversible experiments" }],
    personalPraxis: [{ ref: "path:praxis.md", purpose: "Use a low-pressure message" }],
    openEpisodes: [{ ref: "path:open-episode.json", purpose: "An acted item awaiting observation" }],
  });
  assert.equal(route.mode, "praxis");
  assert.deepEqual(route.candidateFrameworks, [
    "path:framework.yaml#operator:reversible_test",
  ]);
  assert.deepEqual(route.situation?.unknowns, ["Other person's reason"]);
  assert.equal(route.twinPrediction?.possibleActions["send-one-message"], 0.7);
  assert.equal(route.openEpisodeRef, "path:open-episode.json");
});

test("semantic router accepts a valid Praxis route with zero Framework operators", async () => {
  const router = createSemanticRouter(async () => ({
    text: JSON.stringify({
      mode: "praxis",
      domains: ["decision"],
      stakes: "low",
      reversibility: "high",
      needsTwin: true,
      needsFramework: true,
      needsReality: true,
      needsExternalResearch: false,
      candidateFrameworks: [],
      candidateTwinRefs: [],
      candidatePraxisRefs: [],
      twinPrediction: {
        possibleActions: { "try-option-a": 0.6, "try-option-b": 0.4 },
        likelyInterpretations: [],
        keyFactors: ["Reversibility"],
      },
      situation: {
        actors: ["self"],
        observations: ["Two options are available"],
        interpretations: [],
        unknowns: [],
        userGoals: ["Choose one"],
        constraints: [],
      },
    }),
  }));

  const route = await router("Which reversible option should I try?", {
    frameworks: [],
    twin: [],
    personalPraxis: [],
  });
  assert.deepEqual(route.candidateFrameworks, []);
});

test("semantic router associates an outcome with exactly one available open Episode", async () => {
  const episodeRef = "path:30_PersonalData/praxis/episodes/praxis-1/episode.json";
  const router = createSemanticRouter(async ({ purpose, systemPrompt }) => {
    if (purpose === "stella-core-open-episode-selection") {
      return { text: JSON.stringify({ openEpisodeRef: episodeRef }) };
    }
    assert.match(systemPrompt, /praxis-1\/episode\.json/);
    assert.match(systemPrompt, /source must be exactly user_report/);
    assert.match(systemPrompt, /needsTwin, needsFramework, needsReality, and needsExternalResearch must all be false/);
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
          actualAction: "waited",
          source: "user_report",
          observations: ["the other person replied later"],
          result: "waiting avoided pressure",
          predictionAssessment: "countered",
          praxisLearning: "waiting can better preserve a low-pressure goal",
          observedAt: "2026-09-03T02:00:00.000Z",
        },
      }),
    };
  });

  const route = await router("后来她主动联系我了。", {
    frameworks: [],
    twin: [],
    personalPraxis: [],
    openEpisodes: [{ ref: episodeRef, purpose: "对方未回复后的低压选择" }],
  });

  assert.equal(route.mode, "outcome");
  assert.equal(route.outcome?.openEpisodeRef, episodeRef);
  assert.equal(route.outcome?.predictionAssessment, "countered");
});

test("deep Praxis fails explicitly while external research is unavailable", async () => {
  const router = createSemanticRouter(async () => ({
    text: JSON.stringify({
      mode: "deep_praxis",
      domains: ["travel"],
      stakes: "medium",
      reversibility: "medium",
      needsTwin: true,
      needsFramework: true,
      needsReality: true,
      needsExternalResearch: true,
      candidateFrameworks: [],
      candidateTwinRefs: [],
      candidatePraxisRefs: [],
      situation: {
        actors: ["self"], observations: [], interpretations: [], unknowns: [],
        userGoals: ["Choose current transport"], constraints: [],
      },
    }),
  }));

  await assert.rejects(
    router("Use current schedules to choose transport", {
      frameworks: [], twin: [], personalPraxis: [],
    }),
    (error: unknown) => error instanceof Error && /semantic routing failed/i.test(error.message),
  );
});

test("invalid semantic route fails explicitly instead of degrading to ordinary", async () => {
  const router = createSemanticRouter(async () => ({ text: "not-json" }));
  await assert.rejects(
    router("这个选择很难判断。", { frameworks: [], twin: [], personalPraxis: [] }),
    (error: unknown) =>
      error instanceof Error &&
      "category" in error &&
      error.category === "stella_semantic_routing_failed" &&
      "diagnostic" in error &&
      error.diagnostic === "invalid_model_route" &&
      error.cause === undefined,
  );
});

test("open Episode selector repairs one invalid structured response with feedback", async () => {
  let attempts = 0;
  const router = createSemanticRouter(async ({ purpose, systemPrompt }) => {
    if (purpose === "stella-core-open-episode-selection") {
      attempts += 1;
      if (attempts === 1) return { text: "not-json" };
      assert.match(systemPrompt, /previous selector response failed strict validation/i);
      assert.match(systemPrompt, /Previous response: not-json/);
      return { text: JSON.stringify({ openEpisodeRef: null }) };
    }
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
  });

  const route = await router("这是一个与未完成事项无关的新问题", {
    frameworks: [],
    twin: [],
    personalPraxis: [],
    openEpisodes: [{ ref: "path:open-episode.json", purpose: "待继续的选择" }],
  });
  assert.equal(route.mode, "ordinary");
  assert.equal(attempts, 2);
});

test("semantic routing completion failures do not expose provider error details", async () => {
  const router = createSemanticRouter(async () => {
    throw new Error("provider echoed private prompt: never-log-this");
  });

  await assert.rejects(
    router("never-log-this", { frameworks: [], twin: [], personalPraxis: [] }),
    (error: unknown) =>
      error instanceof Error &&
      "diagnostic" in error &&
      error.diagnostic === "completion_failed" &&
      error.cause === undefined &&
      !error.message.includes("never-log-this"),
  );
});

test("open Episode selector reports invalid model output separately from provider failure", async () => {
  const router = createSemanticRouter(async () => ({ text: "not-json" }));

  await assert.rejects(
    router("继续之前那件还没收尾的事", {
      frameworks: [],
      twin: [],
      personalPraxis: [],
      openEpisodes: [{ ref: "path:open-episode.json", purpose: "待继续的选择" }],
    }),
    (error: unknown) =>
      error instanceof Error &&
      "diagnostic" in error &&
      error.diagnostic === "invalid_model_route" &&
      "validationCode" in error &&
      error.validationCode === "episode_selector" &&
      error.cause === undefined,
  );
});

test("semantic routing retries one transient completion failure without degrading", async () => {
  let attempts = 0;
  const router = createSemanticRouter(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient provider failure");
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
  });

  const route = await router("Explain a TypeScript operator", {
    frameworks: [], twin: [], personalPraxis: [],
  });

  assert.equal(attempts, 2);
  assert.equal(route.mode, "ordinary");
});

test("semantic routing retries one invalid structured route without degrading", async () => {
  let attempts = 0;
  const router = createSemanticRouter(async ({ systemPrompt }) => {
    attempts += 1;
    if (attempts === 1) return { text: "not-json" };
    assert.match(systemPrompt, /Previous response: not-json/);
    assert.match(systemPrompt, /Validation error:/);
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
  });

  const route = await router("Explain a TypeScript operator", {
    frameworks: [], twin: [], personalPraxis: [],
  });

  assert.equal(attempts, 2);
  assert.equal(route.mode, "ordinary");
});

test("semantic route fails instead of silently truncating over-capacity selections", async () => {
  const router = createSemanticRouter(async () => ({
    text: JSON.stringify({
      mode: "twin",
      domains: ["personal"],
      needsTwin: true,
      needsFramework: false,
      needsReality: false,
      needsExternalResearch: false,
      candidateTwinRefs: ["path:one", "path:two", "path:three", "path:four"],
    }),
  }));

  await assert.rejects(
    router("Reflect on my patterns", {
      frameworks: [],
      twin: ["one", "two", "three", "four"].map((id) => ({
        ref: `path:${id}`,
        purpose: id,
      })),
      personalPraxis: [],
    }),
    (error: unknown) =>
      error instanceof Error &&
      "diagnostic" in error &&
      error.diagnostic === "invalid_model_route" &&
      error.cause === undefined,
  );
});
