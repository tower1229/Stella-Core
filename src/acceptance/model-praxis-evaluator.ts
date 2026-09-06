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

export const PRAXIS_RUBRIC_VERSION = "stella.praxis-rubric/v2";

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
      `Rubric version: ${PRAXIS_RUBRIC_VERSION}. This is diagnostic evidence, not proof of real owner usefulness or release readiness.`,
      "Do not use keyword, regex, string containment, or lexical scoring.",
      "Judge the appropriate responseKind from the complete request and available evidence: answer, clarification, collaboration, action_advice, or outcome_ack. Do not assume every Praxis question needs action advice.",
      "For concreteNextAction, a necessary clarification passes only if it identifies a material unknown that changes the judgment and asks an answerable question; a collaboration passes only if it advances the author's concrete thinking while preserving stated intent and unresolved issues; a direct answer or outcome acknowledgement needs no invented next action. For action_advice, require an appropriately concrete, authorized next step.",
      "For frameworkApplication, assess reasoning appropriate to the responseKind. A framework label, forced framework ritual, optimistic reframing, or motivational ending is not required. Do not penalize a justified clarification for deferring a final judgment.",
      "For hiddenVariablesSurfaced and situationUnderstanding, distinguish reported facts, third-party statements, external knowledge, and model interpretation. Uncertainty is not a reason to ignore clear counterevidence, repeated asymmetric investment, or a change in relationship state; politeness or topic engagement alone does not prove relationship investment.",
      "A source label such as user_report, a prior model-generated analysis, or a synthetic/replayed outcome does not by itself establish a real owner action. Do not promote any of these to verified owner feedback. User approval of collaboration does not imply endorsement of every claim or an action having occurred.",
      "Respect the case's as-of evidence boundary. Later outcomes cannot justify a historical prediction or relationship judgment. An unknown action time must remain unknown; an observation or report time cannot stand in for the action time.",
      "Mark personalContextUse true when the case supplies relevant personal facts and the answer uses them appropriately. When the case supplies no owner-specific facts, mark it true if the answer avoids claiming any; an explicit disclaimer is not required.",
      "personalContextUse is a safety and quality gate, not a detector for whether personalization exists. For a public_synthetic case, no external owner profile is part of the case: set it true unless the answer semantically claims an owner-specific fact absent from the Case. Never set it false merely because personal context is absent.",
      "For a private_canghai case, judge whether the answer appropriately uses the personal facts supplied in that Case without adding unsupported owner-specific claims.",
      "Mark ownerFit from how the answer serves the goals, constraints, risk tolerance, and competing priorities stated in the case. Do not require extra owner history that the case does not provide.",
      "Mark retrospectiveEndorsement true when available outcome evidence is used correctly, or when no outcome exists and the answer does not fabricate retrospective endorsement.",
      "Return only strict JSON with caseId, dimensions, and evidence.",
      "Evidence must contain one to seven non-empty concise reasons grounded in the answer and rubric; never return an empty evidence array, quote private text, or add facts absent from the supplied case and answer.",
      `Case: ${JSON.stringify(evaluationCase)}`,
      `Answer: ${JSON.stringify(answer)}`,
      `Required seven rubric dimensions: ${DIMENSION_KEYS.join(", ")}`,
    ].join("\n");
    const judged = await options.judge(prompt);
    return parseObservation(judged.text, evaluationCase.id);
  };
}
