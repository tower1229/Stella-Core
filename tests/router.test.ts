import assert from "node:assert/strict";
import test from "node:test";
import { routeTurn } from "../src/routing/router.js";

test("ordinary turn bypasses model routing and Cortex work", async () => {
  let fallbackCalls = 0;
  const route = await routeTurn("TypeScript 的 satisfies 是什么？", async () => {
    fallbackCalls += 1;
    throw new Error("ordinary routing must not call the model");
  });

  assert.deepEqual(route, {
    mode: "ordinary",
    domains: ["general"],
    needsTwin: false,
    needsFramework: false,
    needsReality: false,
    needsExternalResearch: false,
  });
  assert.equal(fallbackCalls, 0);
});

test("relationship decision routes deterministically to Praxis", async () => {
  const route = await routeTurn(
    "她两天没回我消息，我觉得她可能在疏远我。我想知道要不要再发一条，又不想给她压力。",
    async () => {
      throw new Error("clear Praxis turn must not call the model");
    },
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

test("ambiguous personal turn uses the model fallback", async () => {
  let fallbackPrompt = "";
  const route = await routeTurn("这件事让我有点在意。", async (prompt) => {
    fallbackPrompt = prompt;
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
  assert.match(fallbackPrompt, /这件事让我有点在意/);
});

test("current high-stakes personal decision routes to external research", async () => {
  const route = await routeTurn("我想离婚，现在的法律下我该不该先签这份协议？", async () => {
    throw new Error("clear high-stakes turn must not call the model");
  });

  assert.equal(route.mode, "deep_praxis");
  assert.equal(route.stakes, "high");
  assert.equal(route.reversibility, "low");
  assert.equal(route.needsExternalResearch, true);
});
