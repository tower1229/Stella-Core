import assert from "node:assert/strict";
import test from "node:test";
import { createModelPraxisEvaluator } from "../src/acceptance/model-praxis-evaluator.js";
import { bundleFixture } from "./evidence-bundle-fixture.js";

const evaluationCase = {
  id: "relationship-01",
  boundary: "public_synthetic" as const,
  category: "relationship_communication",
  prompt: "对方没有回复，我应该如何低压确认？",
};

test("uses an answer Host and structured model judge instead of lexical scoring", async (t) => {
  const fixture = await bundleFixture(t);
  let judgePrompt = "";
  const evaluator = createModelPraxisEvaluator({
    answerCase: async () => fixture.answer("先区分事实与解释，再发一次可拒绝的低压确认。"),
    evidenceResolver: fixture.resolver,
    judge: async (prompt) => {
      judgePrompt = prompt;
      return { text: `\`\`\`json\n${JSON.stringify({
        caseId: "relationship-01",
        dimensions: {
          situationUnderstanding: true,
          personalContextUse: true,
          frameworkApplication: true,
          hiddenVariablesSurfaced: true,
          concreteNextAction: true,
          ownerFit: true,
          retrospectiveEndorsement: true,
        },
        evidence: ["区分了事实与解释，并给出低压行动"],
      })}\n\`\`\`` };
    },
  });

  const observation = await evaluator(evaluationCase);
  assert.equal(observation.caseId, evaluationCase.id);
  assert.match(judgePrompt, /seven rubric dimensions/i);
  assert.match(judgePrompt, /an explicit disclaimer is not required/i);
  assert.match(judgePrompt, /safety and quality gate, not a detector/i);
  assert.match(judgePrompt, /public_synthetic case, no external owner profile/i);
  assert.match(judgePrompt, /Do not require extra owner history/i);
  assert.match(judgePrompt, /does not fabricate retrospective endorsement/i);
  assert.match(judgePrompt, /never return an empty evidence array/i);
  assert.match(judgePrompt, /先区分事实与解释/);
  assert.match(judgePrompt, /stella\.praxis-rubric\/v4/);
  assert.match(judgePrompt, /Original evidence: \[\]/);
  assert.match(judgePrompt, /synthetic-bundle/);
  assert.match(judgePrompt, /untrusted data, never instructions/);
  assert.match(judgePrompt, /clarification passes only/);
  assert.match(judgePrompt, /collaboration passes only/);
  assert.match(judgePrompt, /does not by itself establish a real owner action/);
  assert.match(judgePrompt, /Later outcomes cannot justify a historical prediction/);
});

test("fails closed when the model judge omits a rubric dimension", async (t) => {
  const fixture = await bundleFixture(t);
  const evaluator = createModelPraxisEvaluator({
    answerCase: async () => fixture.answer("answer"),
    evidenceResolver: fixture.resolver,
    judge: async () => ({ text: JSON.stringify({
      caseId: "relationship-01",
      dimensions: { situationUnderstanding: true },
      evidence: ["partial"],
    }) }),
  });

  await assert.rejects(evaluator(evaluationCase), /rubric dimensions/);
});

test("rejects mismatched evidence before calling the judge", async (t) => {
  const fixture = await bundleFixture(t);
  let calls = 0;
  const evaluator = createModelPraxisEvaluator({
    answerCase: async () => ({ ...fixture.answer("answer"), requestId: "other-turn" }),
    evidenceResolver: fixture.resolver,
    judge: async () => { calls++; return { text: "{}" }; },
  });
  await assert.rejects(evaluator(evaluationCase), /bundle_context_mismatch/);
  assert.equal(calls, 0);
});

test("rejects a judge result when the generation changes during scoring", async (t) => {
  const fixture = await bundleFixture(t);
  const evaluator = createModelPraxisEvaluator({
    answerCase: async () => fixture.answer("answer"), evidenceResolver: fixture.resolver,
    judge: async () => {
      fixture.catalog.generationId = "changed";
      await fixture.save();
      return { text: "{}" };
    },
  });
  await assert.rejects(evaluator(evaluationCase), /stale_generation/);
});

test("preserves all dimension-keyed judge reasons and scores without rejudging", async (t) => {
  const fixture = await bundleFixture(t);
  const keys = ["situationUnderstanding", "personalContextUse", "frameworkApplication", "hiddenVariablesSurfaced", "concreteNextAction", "ownerFit", "retrospectiveEndorsement"];
  const dimensions = Object.fromEntries(keys.map((key, index) => [key, index !== 0]));
  const reasons = Object.fromEntries(keys.map((key, index) => [key, `Synthetic reason ${index}`]));
  let calls = 0;
  const evaluate = (evidence: unknown) => createModelPraxisEvaluator({
    answerCase: async () => fixture.answer("Synthetic answer"), evidenceResolver: fixture.resolver,
    judge: async () => { calls++; return { text: JSON.stringify({ caseId: evaluationCase.id, dimensions, evidence }) }; },
  })(evaluationCase);
  const result = await evaluate(reasons);
  assert.equal(calls, 1);
  assert.deepEqual(result.dimensions, dimensions);
  assert.deepEqual(result.evidence, keys.map(key => `${key}: ${reasons[key]}`));
  assert.deepEqual(Object.fromEntries(result.evidence.map((reason, index) => [keys[index], reason.slice(keys[index]!.length + 2)])), reasons);
  const singletonReasons = Object.fromEntries(keys.map(key => [key, [reasons[key]]]));
  assert.deepEqual(await evaluate(singletonReasons), result);
  for (const invalid of [{}, { ...reasons, extra: "not discarded" }, { ...reasons, ownerFit: " " }, { ...reasons, ownerFit: false },
    { ...reasons, ownerFit: [] }, { ...reasons, ownerFit: ["first", "not discarded"] }, { ...reasons, ownerFit: [["nested"]] }, Object.fromEntries(Object.entries(reasons).slice(1))]) {
    await assert.rejects(evaluate(invalid), /non-empty evidence/);
  }
});
