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

  const route = await router("No Chinese decision keywords are present.", [
    { ref: "path:framework.yaml#operator:reversible_test", purpose: "Bounded experiment" },
  ]);
  assert.equal(route.mode, "praxis");
  assert.deepEqual(route.candidateFrameworks, [
    "path:framework.yaml#operator:reversible_test",
  ]);
  assert.deepEqual(route.situation?.unknowns, ["Other person's reason"]);
});

test("invalid semantic route fails explicitly instead of degrading to ordinary", async () => {
  const router = createSemanticRouter(async () => ({ text: "not-json" }), "stella");
  await assert.rejects(
    router("这个选择很难判断。", []),
    (error: unknown) =>
      error instanceof Error &&
      "category" in error &&
      error.category === "stella_semantic_routing_failed" &&
      error.cause instanceof Error &&
      /did not return a JSON route/.test(error.cause.message),
  );
});
