import { isRecord } from "../shared/type-guards.js";
import {
  CORTEX_MODES,
  type CortexMode,
  type CortexRoute,
  type RouteSituation,
  type SemanticRouteClassifier,
  type SemanticRoutingCandidates,
} from "./router.js";

export type RoutingCompletion = (params: {
  agentId: string;
  maxTokens: number;
  temperature: number;
  purpose: string;
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ text: string }>;

export class SemanticRoutingError extends Error {
  readonly category = "stella_semantic_routing_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SemanticRoutingError";
  }
}

function isCortexMode(value: string): value is CortexMode {
  return CORTEX_MODES.some((mode) => mode === value);
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Model route field ${key} must be boolean`);
  return value;
}

function stringList(record: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Model route field ${key} must be a string array`);
  }
  if (value.length > maxItems) {
    throw new Error(`Model route field ${key} must contain at most ${maxItems} items`);
  }
  if (value.some((item) => item.length === 0)) {
    throw new Error(`Model route field ${key} must not contain empty strings`);
  }
  return value;
}

function routeRiskFields(record: Record<string, unknown>) {
  const stakes = record.stakes;
  const reversibility = record.reversibility;
  if (stakes !== "low" && stakes !== "medium" && stakes !== "high") {
    throw new Error("Model Praxis route requires low, medium, or high stakes");
  }
  if (reversibility !== "high" && reversibility !== "medium" && reversibility !== "low") {
    throw new Error("Model Praxis route requires high, medium, or low reversibility");
  }
  return { stakes, reversibility } as const;
}

function parseSituation(record: Record<string, unknown>): RouteSituation {
  const value = record.situation;
  if (!isRecord(value)) throw new Error("Model Praxis route requires a Situation Frame");
  return {
    actors: stringList(value, "actors", 4),
    observations: stringList(value, "observations", 4),
    interpretations: stringList(value, "interpretations", 4),
    unknowns: stringList(value, "unknowns", 4),
    userGoals: stringList(value, "userGoals", 4),
    constraints: stringList(value, "constraints", 4),
  };
}

function selectedRefs(
  record: Record<string, unknown>,
  key: string,
  maxItems: number,
  available: Set<string>,
): string[] {
  const refs = stringList(record, key, maxItems);
  if (new Set(refs).size !== refs.length) {
    throw new Error(`Model route field ${key} must not contain duplicate refs`);
  }
  if (refs.some((ref) => !available.has(ref))) {
    throw new Error(`Model route selected an unavailable ${key} candidate`);
  }
  return refs;
}

function parseModelRoute(text: string, candidates: SemanticRoutingCandidates): CortexRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Model router did not return a JSON route", { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed.mode !== "string") {
    throw new Error("Model router did not return a JSON route");
  }
  if (!isCortexMode(parsed.mode)) throw new Error("Model router returned an unsupported mode");

  const domains = stringList(parsed, "domains", 4);
  if (domains.length === 0) throw new Error("Model route requires at least one domain");
  const isPraxis = parsed.mode === "praxis" || parsed.mode === "deep_praxis";
  const needsTwin = booleanField(parsed, "needsTwin");
  const needsFramework = booleanField(parsed, "needsFramework");
  const needsReality = booleanField(parsed, "needsReality");
  const needsExternalResearch = booleanField(parsed, "needsExternalResearch");
  if (isPraxis && (!needsTwin || !needsFramework || !needsReality)) {
    throw new Error("Model Praxis route must request Twin, Framework, and Reality context");
  }
  if (parsed.mode === "praxis" && needsExternalResearch) {
    throw new Error("Model Praxis route requiring external research must use deep_praxis");
  }
  if (parsed.mode === "deep_praxis" && !needsExternalResearch) {
    throw new Error("Model deep_praxis route must require external research");
  }
  if (parsed.mode === "deep_praxis") {
    throw new Error("Deep Praxis is unavailable because external research is not implemented");
  }
  if (
    parsed.mode === "twin" &&
    (!needsTwin || needsFramework || needsReality || needsExternalResearch)
  ) {
    throw new Error("Model Twin route has inconsistent context requirements");
  }
  if (
    (parsed.mode === "ordinary" || parsed.mode === "outcome") &&
    (needsTwin || needsFramework || needsReality || needsExternalResearch)
  ) {
    throw new Error("Model non-Cortex route requested unsupported context");
  }

  const frameworkRefs = new Set(candidates.frameworks.map(({ ref }) => ref));
  const twinRefs = new Set(candidates.twin.map(({ ref }) => ref));
  const praxisRefs = new Set(candidates.personalPraxis.map(({ ref }) => ref));
  const candidateFrameworks = isPraxis
    ? selectedRefs(parsed, "candidateFrameworks", 2, frameworkRefs)
    : [];
  const candidateTwinRefs = needsTwin
    ? selectedRefs(parsed, "candidateTwinRefs", 3, twinRefs)
    : [];
  const candidatePraxisRefs = isPraxis
    ? selectedRefs(parsed, "candidatePraxisRefs", 2, praxisRefs)
    : [];

  return {
    mode: parsed.mode,
    domains,
    ...(isPraxis ? routeRiskFields(parsed) : {}),
    needsTwin,
    needsFramework,
    needsReality,
    needsExternalResearch,
    ...(needsTwin ? { candidateTwinRefs } : {}),
    ...(isPraxis
      ? { candidateFrameworks, candidatePraxisRefs, situation: parseSituation(parsed) }
      : {}),
  };
}

export function createSemanticRouter(
  complete: RoutingCompletion,
  agentId: string,
): SemanticRouteClassifier {
  return async (prompt, candidates) => {
    try {
      const result = await complete({
        agentId,
        maxTokens: 900,
        temperature: 0,
        purpose: "stella-core-semantic-routing",
        systemPrompt: [
          "Semantically classify one user turn for Stella Cortex. Do not answer the user.",
          "Return only strict JSON with mode, domains, stakes, reversibility, needsTwin, needsFramework, needsReality, needsExternalResearch, candidateFrameworks, candidateTwinRefs, candidatePraxisRefs, and situation.",
          "Use praxis for a personal real-world choice, twin for owner-self questions, deep_praxis only when current external facts are required, and ordinary otherwise.",
          "Praxis must request Twin, Framework, and Reality, select zero to two exact Framework operator refs, zero to three exact Twin refs, and zero to two exact personal Praxis refs from the supplied candidates, and include situation arrays: actors, observations, interpretations, unknowns, userGoals, constraints.",
          "Twin mode must select zero to three exact Twin refs. Never invent or alter a candidate ref. deep_praxis is unavailable and must not be selected.",
          "Keep observations separate from interpretations. Do not infer meaning from isolated keywords; judge the complete utterance in context.",
          `Available semantic candidates: ${JSON.stringify(candidates)}`,
        ].join(" "),
        messages: [{ role: "user", content: prompt }],
      });
      return parseModelRoute(result.text, candidates);
    } catch (error) {
      if (error instanceof SemanticRoutingError) throw error;
      throw new SemanticRoutingError("Stella semantic routing failed", { cause: error });
    }
  };
}
