import type {
  PraxisCaseExecutor,
  PraxisEvaluationCase,
  PraxisEvaluationDimensions,
  PraxisEvaluationObservation,
} from "./praxis-evaluation.js";

const DIMENSION_KEYS = [
  "situationUnderstanding",
  "personalContextUse",
  "frameworkApplication",
  "hiddenVariablesSurfaced",
  "concreteNextAction",
  "ownerFit",
  "retrospectiveEndorsement",
] as const satisfies readonly (keyof PraxisEvaluationDimensions)[];

type ModelPraxisEvaluatorOptions = {
  answerCase: (evaluationCase: PraxisEvaluationCase) => Promise<string>;
  judge: (prompt: string) => Promise<{ text: string }>;
};

function unwrapJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
  const lines = trimmed.split(/\r?\n/u);
  const opening = lines.shift();
  const closing = lines.pop();
  if (
    (opening !== "```json" && opening !== "```") ||
    closing !== "```" ||
    lines.some((line) => line.includes("```"))
  ) {
    return trimmed;
  }
  return lines.join("\n");
}

function parseObservation(text: string, expectedCaseId: string): PraxisEvaluationObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(text));
  } catch (error) {
    throw new Error("Praxis model judge returned invalid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Praxis model judge returned an invalid observation");
  }
  const record = parsed as Record<string, unknown>;
  if (record.caseId !== expectedCaseId) {
    throw new Error("Praxis model judge returned the wrong case id");
  }
  if (typeof record.dimensions !== "object" || record.dimensions === null || Array.isArray(record.dimensions)) {
    throw new Error("Praxis model judge omitted rubric dimensions");
  }
  const dimensionRecord = record.dimensions as Record<string, unknown>;
  if (
    DIMENSION_KEYS.some((key) => typeof dimensionRecord[key] !== "boolean") ||
    Object.keys(dimensionRecord).some(
      (key) => !DIMENSION_KEYS.includes(key as keyof PraxisEvaluationDimensions),
    )
  ) {
    throw new Error("Praxis model judge returned invalid rubric dimensions");
  }
  if (
    !Array.isArray(record.evidence) ||
    record.evidence.length === 0 ||
    record.evidence.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error("Praxis model judge must provide non-empty evidence");
  }
  return {
    caseId: expectedCaseId,
    dimensions: Object.fromEntries(
      DIMENSION_KEYS.map((key) => [key, dimensionRecord[key]]),
    ) as PraxisEvaluationDimensions,
    evidence: record.evidence as string[],
  };
}

export function createModelPraxisEvaluator(
  options: ModelPraxisEvaluatorOptions,
): PraxisCaseExecutor {
  return async (evaluationCase) => {
    const answer = await options.answerCase(evaluationCase);
    if (!answer.trim()) throw new Error("Praxis answer Host returned an empty answer");
    const prompt = [
      "Evaluate one Stella Praxis answer semantically across all seven rubric dimensions.",
      "Do not use keyword, regex, string containment, or lexical scoring.",
      "Mark personalContextUse true when the answer appropriately uses available personal context or correctly refuses to invent context that the case does not provide.",
      "Mark retrospectiveEndorsement true when available outcome evidence is used correctly, or when no outcome exists and the answer does not fabricate retrospective endorsement.",
      "Return only strict JSON with caseId, dimensions, and evidence.",
      `Case: ${JSON.stringify(evaluationCase)}`,
      `Answer: ${JSON.stringify(answer)}`,
      `Required seven rubric dimensions: ${DIMENSION_KEYS.join(", ")}`,
    ].join("\n");
    const judged = await options.judge(prompt);
    return parseObservation(judged.text, evaluationCase.id);
  };
}
