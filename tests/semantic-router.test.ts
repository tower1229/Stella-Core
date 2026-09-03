import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticRouter } from "../src/routing/semantic-router.js";

test("semantic router preserves structured Praxis meaning and candidate selection", async () => {
  const router = createSemanticRouter(
    async ({ systemPrompt }) => {
      assert.match(systemPrompt, /path:framework.yaml#operator:reversible_test/);
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
          candidateFrameworks: ["path:framework.yaml#operator:reversible_test"],
          candidateTwinRefs: ["path:twin.md"],
          candidatePraxisRefs: ["path:praxis.md"],
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
        }),
      };
    },
    "stella",
  );

  const route = await router("No Chinese decision keywords are present.", {
    frameworks: [
      { ref: "path:framework.yaml#operator:reversible_test", purpose: "Bounded experiment" },
    ],
    twin: [{ ref: "path:twin.md", purpose: "Prefers reversible experiments" }],
    personalPraxis: [{ ref: "path:praxis.md", purpose: "Use a low-pressure message" }],
  });
  assert.equal(route.mode, "praxis");
  assert.deepEqual(route.candidateFrameworks, [
    "path:framework.yaml#operator:reversible_test",
  ]);
  assert.deepEqual(route.situation?.unknowns, ["Other person's reason"]);
  assert.equal(route.twinPrediction?.possibleActions["send-one-message"], 0.7);
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
  }), "stella");

  const route = await router("Which reversible option should I try?", {
    frameworks: [],
    twin: [],
    personalPraxis: [],
  });
  assert.deepEqual(route.candidateFrameworks, []);
});

test("semantic router associates an outcome with exactly one available open Episode", async () => {
  const episodeRef = "path:30_PersonalData/praxis/episodes/praxis-1/episode.json";
  const router = createSemanticRouter(async ({ systemPrompt }) => {
    assert.match(systemPrompt, /praxis-1\/episode\.json/);
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
  }, "stella");

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
  }), "stella");

  await assert.rejects(
    router("Use current schedules to choose transport", {
      frameworks: [], twin: [], personalPraxis: [],
    }),
    (error: unknown) => error instanceof Error && /semantic routing failed/i.test(error.message),
  );
});

test("invalid semantic route fails explicitly instead of degrading to ordinary", async () => {
  const router = createSemanticRouter(async () => ({ text: "not-json" }), "stella");
  await assert.rejects(
    router("这个选择很难判断。", { frameworks: [], twin: [], personalPraxis: [] }),
    (error: unknown) =>
      error instanceof Error &&
      "category" in error &&
      error.category === "stella_semantic_routing_failed" &&
      error.cause instanceof Error &&
      /did not return a JSON route/.test(error.cause.message),
  );
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
  }), "stella");

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
      error.cause instanceof Error &&
      /at most 3 items/.test(error.cause.message),
  );
});
