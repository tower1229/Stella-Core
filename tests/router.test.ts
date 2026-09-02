import assert from "node:assert/strict";
import test from "node:test";
import { routeTurn } from "../src/routing/router.js";

test("ordinary turn is classified semantically", async () => {
  let routedPrompt = "";
  const route = await routeTurn("TypeScript 的 satisfies 是什么？", [], async (prompt) => {
    routedPrompt = prompt;
    return {
      mode: "ordinary",
      domains: ["general"],
      needsTwin: false,
      needsFramework: false,
      needsReality: false,
      needsExternalResearch: false,
    };
  });

  assert.deepEqual(route, {
    mode: "ordinary",
    domains: ["general"],
    needsTwin: false,
    needsFramework: false,
    needsReality: false,
    needsExternalResearch: false,
  });
  assert.equal(routedPrompt, "TypeScript 的 satisfies 是什么？");
});

test("relationship decision uses the semantic route result without lexical inference", async () => {
  const route = await routeTurn(
    "The cadence shifted; choose a bounded move that respects both people.",
    [{ ref: "path:framework.yaml#operator:reversible_test", purpose: "Bounded experiment" }],
    async (_prompt, candidates) => ({
      mode: "praxis",
      domains: ["relationship"],
      stakes: "medium",
      reversibility: "high",
      needsTwin: true,
      needsFramework: true,
      needsReality: true,
      needsExternalResearch: false,
      candidateFrameworks: [candidates[0]?.ref ?? ""],
      situation: {
        actors: ["self", "other"],
        observations: ["The cadence shifted"],
        interpretations: [],
        unknowns: ["The reason is unknown"],
        userGoals: ["choose a bounded move"],
        constraints: ["respect both people"],
      },
    }),
  );

  assert.equal(route.mode, "praxis");
  assert.deepEqual(route.domains, ["relationship"]);
  assert.equal(route.stakes, "medium");
  assert.equal(route.reversibility, "high");
  assert.equal(route.needsTwin, true);
  assert.equal(route.needsFramework, true);
  assert.equal(route.needsReality, true);
  assert.equal(route.needsExternalResearch, false);
});

test("ambiguous personal turn uses the same semantic router", async () => {
  const route = await routeTurn("这件事让我有点在意。", [], async () => {
    return {
      mode: "twin",
      domains: ["personal"],
      needsTwin: true,
      needsFramework: false,
      needsReality: false,
      needsExternalResearch: false,
    };
  });

  assert.equal(route.mode, "twin");
});

test("semantic routing errors remain explicit", async () => {
  await assert.rejects(
    routeTurn("任何输入", [], async () => {
      throw new Error("semantic router unavailable");
    }),
    /semantic router unavailable/,
  );
});
