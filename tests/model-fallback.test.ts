import assert from "node:assert/strict";
import test from "node:test";
import { createModelRouteFallback } from "../src/routing/model-fallback.js";

test("model Praxis fallback preserves stakes and reversibility", async () => {
  const fallback = createModelRouteFallback(
    async () => ({
      text: JSON.stringify({
        mode: "praxis",
        domains: ["relationship"],
        stakes: "high",
        reversibility: "low",
        needsTwin: true,
        needsFramework: true,
        needsReality: true,
        needsExternalResearch: false,
      }),
    }),
    "stella",
  );

  const route = await fallback("这个选择很难判断。");
  assert.equal(route.mode, "praxis");
  assert.equal(route.stakes, "high");
  assert.equal(route.reversibility, "low");
});

test("invalid model route falls back without exposing personal context", async () => {
  const fallback = createModelRouteFallback(
    async () => ({
      text: JSON.stringify({
        mode: "praxis",
        domains: ["relationship"],
        needsTwin: true,
        needsFramework: true,
        needsReality: true,
        needsExternalResearch: false,
      }),
    }),
    "stella",
  );

  assert.deepEqual(await fallback("这个选择很难判断。"), {
    mode: "ordinary",
    domains: ["general"],
    needsTwin: false,
    needsFramework: false,
    needsReality: false,
    needsExternalResearch: false,
  });
});
