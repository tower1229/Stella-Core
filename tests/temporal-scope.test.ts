import assert from "node:assert/strict";
import test from "node:test";
import { classifyQuestionTemporalScope } from "../src/praxis/temporal-scope.js";
import { CatalogError } from "../src/canghai/catalog-reader.js";

test("classifyQuestionTemporalScope accepts current and historical structured decisions", async () => {
  const current = await classifyQuestionTemporalScope({
    question: "What is the status now?",
    now: "2026-09-16T12:00:00Z",
    complete: async () => ({ text: JSON.stringify({ mode: "current" }) }),
  });
  assert.equal(current, "current");

  const historical = await classifyQuestionTemporalScope({
    question: "What did I know before the trip?",
    now: "2026-09-16T12:00:00Z",
    complete: async () => ({
      text: JSON.stringify({
        mode: "historical",
        knownBy: "2026-07-31T00:00:00Z",
        eventWindow: { from: "2026-07-01T00:00:00Z", to: "2026-07-31T23:59:59Z" },
      }),
    }),
  });
  assert.deepEqual(historical, {
    knownBy: "2026-07-31T00:00:00Z",
    eventWindow: { from: "2026-07-01T00:00:00Z", to: "2026-07-31T23:59:59Z" },
  });
});

test("classifyQuestionTemporalScope rejects invalid model output", async () => {
  await assert.rejects(classifyQuestionTemporalScope({
    question: "Historical?",
    complete: async () => ({ text: "not json" }),
  }), (error: unknown) => error instanceof CatalogError && error.category === "invalid_temporal_scope");
});
