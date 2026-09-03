export const PRAXIS_EVALUATION_CATEGORIES = [
  "relationship_communication",
  "gratitude_reciprocity",
  "asking_for_help",
  "refusing_requests",
  "family_privacy",
  "social_etiquette",
  "informal_workplace",
  "uncertainty_conflict",
] as const;

export type PraxisEvaluationBoundary = "public_synthetic" | "private_canghai";

export type PraxisEvaluationCase = {
  id: string;
  boundary: PraxisEvaluationBoundary;
  category: string;
  prompt: string;
};

export type PraxisEvaluationSuite = {
  schemaVersion: "stella.alpha-praxis-suite/v1";
  boundary: PraxisEvaluationBoundary;
  cases: PraxisEvaluationCase[];
};

export type PraxisEvaluationDimensions = {
  situationUnderstanding: boolean;
  personalContextUse: boolean;
  frameworkApplication: boolean;
  hiddenVariablesSurfaced: boolean;
  concreteNextAction: boolean;
  ownerFit: boolean;
  retrospectiveEndorsement: boolean;
};

export type PraxisEvaluationObservation = {
  caseId: string;
  dimensions: PraxisEvaluationDimensions;
  evidence: string[];
};

export type PraxisEvaluationReport = {
  schemaVersion: "stella.alpha-praxis-evaluation/v1";
  boundary: PraxisEvaluationBoundary | "mixed";
  boundaryCounts: Record<PraxisEvaluationBoundary, number>;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  failedCaseIds: string[];
  categoryCounts: Record<string, number>;
  execution?: PraxisEvaluationExecution;
};

export type PraxisEvaluationExecution = {
  coreRevision: string;
  canghaiRevision: string;
  hostVersion: string;
  artifactSha256: string;
};

export type PraxisCaseExecutor = (
  evaluationCase: PraxisEvaluationCase,
) => Promise<PraxisEvaluationObservation>;

function parseSuite(input: string, complete: boolean): PraxisEvaluationSuite {
  const parsed = JSON.parse(input) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Praxis evaluation suite must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== "stella.alpha-praxis-suite/v1") {
    throw new Error("Praxis evaluation suite schema is unsupported");
  }
  if (record.boundary !== "public_synthetic" && record.boundary !== "private_canghai") {
    throw new Error("Praxis evaluation suite boundary is invalid");
  }
  if (!Array.isArray(record.cases)) {
    throw new Error("Praxis evaluation suite cases must be an array");
  }
  const cases = record.cases.map((value, index): PraxisEvaluationCase => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Praxis evaluation case ${index} must be an object`);
    }
    const evaluationCase = value as Record<string, unknown>;
    if (
      typeof evaluationCase.id !== "string" ||
      typeof evaluationCase.category !== "string" ||
      typeof evaluationCase.prompt !== "string"
    ) {
      throw new Error(`Praxis evaluation case ${index} is invalid`);
    }
    return {
      id: evaluationCase.id,
      boundary: record.boundary as PraxisEvaluationBoundary,
      category: evaluationCase.category,
      prompt: evaluationCase.prompt,
    };
  });
  if (complete) validateSuite(cases);
  return {
    schemaVersion: "stella.alpha-praxis-suite/v1",
    boundary: record.boundary,
    cases,
  };
}

export function parsePraxisEvaluationSuite(input: string): PraxisEvaluationSuite {
  return parseSuite(input, true);
}

export function parsePraxisEvaluationSuiteFragment(input: string): PraxisEvaluationSuite {
  const suite = parseSuite(input, false);
  if (suite.cases.length === 0) {
    throw new Error("Praxis evaluation suite fragment must contain at least one case");
  }
  const ids = new Set(suite.cases.map(({ id }) => id));
  if (ids.size !== suite.cases.length) {
    throw new Error("Praxis evaluation case ids must be unique");
  }
  return suite;
}

function validateSuite(cases: PraxisEvaluationCase[]): PraxisEvaluationBoundary | "mixed" {
  if (cases.length < 30 || cases.length > 50) {
    throw new Error("Praxis evaluation suite must contain 30 to 50 cases");
  }
  const ids = new Set(cases.map(({ id }) => id));
  if (ids.size !== cases.length) throw new Error("Praxis evaluation case ids must be unique");

  const boundaries = new Set(cases.map(({ boundary }) => boundary));
  const categories = new Set(cases.map(({ category }) => category));
  if (PRAXIS_EVALUATION_CATEGORIES.some((category) => !categories.has(category))) {
    throw new Error("Praxis evaluation suite must cover all required categories");
  }
  for (const evaluationCase of cases) {
    if (!evaluationCase.id.trim() || !evaluationCase.prompt.trim()) {
      throw new Error("Praxis evaluation cases require non-empty ids and prompts");
    }
  }
  return boundaries.size === 1 ? cases[0]!.boundary : "mixed";
}

function observationPassed(observation: PraxisEvaluationObservation): boolean {
  return Object.values(observation.dimensions).every((value) => value === true) &&
    observation.evidence.length > 0 &&
    observation.evidence.every((entry) => entry.trim().length > 0);
}

export async function runPraxisEvaluation(
  cases: PraxisEvaluationCase[],
  execute: PraxisCaseExecutor,
  execution?: PraxisEvaluationExecution,
): Promise<PraxisEvaluationReport> {
  const boundary = validateSuite(cases);
  const categoryCounts: Record<string, number> = {};
  const boundaryCounts: Record<PraxisEvaluationBoundary, number> = {
    public_synthetic: 0,
    private_canghai: 0,
  };
  const failedCaseIds: string[] = [];

  for (const evaluationCase of cases) {
    categoryCounts[evaluationCase.category] = (categoryCounts[evaluationCase.category] ?? 0) + 1;
    boundaryCounts[evaluationCase.boundary] += 1;
    const observation = await execute(evaluationCase);
    if (observation.caseId !== evaluationCase.id) {
      throw new Error(`Praxis evaluation observation mismatched case ${evaluationCase.id}`);
    }
    if (!observationPassed(observation)) failedCaseIds.push(evaluationCase.id);
  }

  const sortedCategoryCounts = Object.fromEntries(
    Object.entries(categoryCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    schemaVersion: "stella.alpha-praxis-evaluation/v1",
    boundary,
    boundaryCounts,
    caseCount: cases.length,
    passedCount: cases.length - failedCaseIds.length,
    failedCount: failedCaseIds.length,
    failedCaseIds,
    categoryCounts: sortedCategoryCounts,
    ...(execution ? { execution } : {}),
  };
}
