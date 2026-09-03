import assert from "node:assert/strict";
import test from "node:test";
import { createModelPraxisEvaluator } from "../src/acceptance/model-praxis-evaluator.js";

const evaluationCase = {
  id: "relationship-01",
  boundary: "public_synthetic" as const,
  category: "relationship_communication",
  prompt: "对方没有回复，我应该如何低压确认？",
};

test("uses an answer Host and structured model judge instead of lexical scoring", async () => {
  let judgePrompt = "";
  const evaluator = createModelPraxisEvaluator({
    answerCase: async () => "先区分事实与解释，再发一次可拒绝的低压确认。",
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
  assert.match(judgePrompt, /does not fabricate retrospective endorsement/i);
  assert.match(judgePrompt, /never return an empty evidence array/i);
  assert.match(judgePrompt, /先区分事实与解释/);
});

test("fails closed when the model judge omits a rubric dimension", async () => {
  const evaluator = createModelPraxisEvaluator({
    answerCase: async () => "answer",
    judge: async () => ({ text: JSON.stringify({
      caseId: "relationship-01",
      dimensions: { situationUnderstanding: true },
      evidence: ["partial"],
    }) }),
  });

  await assert.rejects(evaluator(evaluationCase), /rubric dimensions/);
});
