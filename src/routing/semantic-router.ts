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
  maxTokens: number;
  temperature: number;
  purpose: string;
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ text: string }>;

export class SemanticRoutingError extends Error {
  readonly category = "stella_semantic_routing_failed";

  constructor(
    message: string,
    readonly diagnostic: "completion_failed" | "invalid_model_route",
  ) {
    super(message);
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

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Model route field ${key} must be a non-empty string`);
  }
  return value;
}

function parseTwinPrediction(record: Record<string, unknown>) {
  const value = record.twinPrediction;
  if (!isRecord(value)) {
    throw new Error(
      `Model Praxis route requires a Twin prediction; route keys: ${Object.keys(record).sort().join(",")}`,
    );
  }
  if (!isRecord(value.possibleActions)) {
    throw new Error(
      `Model Twin prediction requires possibleActions; prediction keys: ${Object.keys(value).sort().join(",")}`,
    );
  }
  const actionEntries = Object.entries(value.possibleActions);
  if (
    actionEntries.length === 0 ||
    actionEntries.length > 4 ||
    actionEntries.some(
      ([action, probability]) =>
        !action || typeof probability !== "number" || probability < 0 || probability > 1,
    )
  ) {
    throw new Error("Model Twin prediction possibleActions is invalid");
  }
  return {
    possibleActions: Object.fromEntries(actionEntries) as Record<string, number>,
    likelyInterpretations: stringList(value, "likelyInterpretations", 4),
    keyFactors: stringList(value, "keyFactors", 4),
  };
}

function parseOutcome(
  record: Record<string, unknown>,
  availableOpenEpisodes: Set<string>,
) {
  const value = record.outcome;
  if (!isRecord(value)) throw new Error("Model outcome route requires outcome details");
  const openEpisodeRef = requiredString(value, "openEpisodeRef");
  if (!availableOpenEpisodes.has(openEpisodeRef)) {
    throw new Error("Model outcome route selected an unavailable open Episode");
  }
  const source = requiredString(value, "source");
  if (
    source !== "user_report" &&
    source !== "tool_observation" &&
    source !== "system_event" &&
    source !== "inferred"
  ) {
    throw new Error("Model outcome source is unsupported");
  }
  const predictionAssessment = requiredString(value, "predictionAssessment");
  if (
    predictionAssessment !== "supported" &&
    predictionAssessment !== "countered" &&
    predictionAssessment !== "unresolved"
  ) {
    throw new Error("Model outcome prediction assessment is unsupported");
  }
  const observedAt = requiredString(value, "observedAt");
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error("Model outcome observedAt must be an ISO date-time");
  }
  return {
    openEpisodeRef,
    actualAction: requiredString(value, "actualAction"),
    source,
    observations: stringList(value, "observations", 4),
    result: requiredString(value, "result"),
    predictionAssessment,
    praxisLearning: requiredString(value, "praxisLearning"),
    observedAt,
  } as const;
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

function optionalSelectedRef(
  record: Record<string, unknown>,
  key: string,
  available: Set<string>,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const ref = requiredString(record, key);
  if (!available.has(ref)) {
    throw new Error(`Model route selected an unavailable ${key} candidate`);
  }
  return ref;
}

function unwrapJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd < 0) return trimmed;
  const language = trimmed.slice(3, firstLineEnd).trim();
  if (language && language !== "json") return trimmed;
  return trimmed.slice(firstLineEnd + 1, -3).trim();
}

async function completeWithOneRetry(
  params: Parameters<RoutingCompletion>[0],
  complete: RoutingCompletion,
): Promise<{ text: string }> {
  try {
    return await complete(params);
  } catch {
    return complete(params);
  }
}

async function selectRelevantOpenEpisode(
  prompt: string,
  candidates: SemanticRoutingCandidates,
  complete: RoutingCompletion,
): Promise<string | undefined> {
  const available = candidates.openEpisodes ?? [];
  if (available.length === 0) return undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: { text: string };
    try {
      result = await complete({
        maxTokens: 500,
        temperature: 0,
        purpose: "stella-core-open-episode-selection",
        systemPrompt: [
          "Judge whether this owner turn asks to recall, inspect, or continue exactly one supplied open Praxis Episode. Do not answer the owner.",
          "A message reporting a new outcome is not an open-state recall and must return null.",
          "Return only strict JSON: {\"openEpisodeRef\":<exact supplied ref or null>}.",
          `Available open Episode candidates: ${JSON.stringify(available)}`,
        ].join(" "),
        messages: [{ role: "user", content: prompt }],
      });
    } catch {
      if (attempt === 1) {
        throw new SemanticRoutingError("Stella semantic routing failed", "completion_failed");
      }
      continue;
    }
    try {
      const parsed = JSON.parse(unwrapJsonFence(result.text)) as unknown;
      if (!isRecord(parsed) || !("openEpisodeRef" in parsed)) {
        throw new Error("Open Episode selector returned an invalid result");
      }
      if (parsed.openEpisodeRef === null) return undefined;
      if (
        typeof parsed.openEpisodeRef !== "string" ||
        !available.some(({ ref }) => ref === parsed.openEpisodeRef)
      ) {
        throw new Error("Open Episode selector returned an unavailable ref");
      }
      return parsed.openEpisodeRef;
    } catch {
      if (attempt === 1) {
        throw new SemanticRoutingError("Stella semantic routing failed", "invalid_model_route");
      }
    }
  }
  throw new SemanticRoutingError("Stella semantic routing failed", "invalid_model_route");
}

function parseModelRoute(text: string, candidates: SemanticRoutingCandidates): CortexRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(text));
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
  const openEpisodeRefs = new Set((candidates.openEpisodes ?? []).map(({ ref }) => ref));
  const candidateFrameworks = isPraxis
    ? selectedRefs(parsed, "candidateFrameworks", 2, frameworkRefs)
    : [];
  const candidateTwinRefs = needsTwin
    ? selectedRefs(parsed, "candidateTwinRefs", 3, twinRefs)
    : [];
  const candidatePraxisRefs = isPraxis
    ? selectedRefs(parsed, "candidatePraxisRefs", 2, praxisRefs)
    : [];
  const openEpisodeRef = isPraxis
    ? optionalSelectedRef(parsed, "openEpisodeRef", openEpisodeRefs)
    : undefined;

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
      ? {
          candidateFrameworks,
          candidatePraxisRefs,
          ...(openEpisodeRef ? { openEpisodeRef } : {}),
          situation: parseSituation(parsed),
          twinPrediction: parseTwinPrediction(parsed),
        }
      : {}),
    ...(parsed.mode === "outcome"
      ? { outcome: parseOutcome(parsed, openEpisodeRefs) }
      : {}),
  };
}

export function createSemanticRouter(
  complete: RoutingCompletion,
): SemanticRouteClassifier {
  return async (prompt, candidates) => {
    let selectedOpenEpisodeRef: string | undefined;
    try {
      selectedOpenEpisodeRef = await selectRelevantOpenEpisode(prompt, candidates, complete);
    } catch (error) {
      if (error instanceof SemanticRoutingError) throw error;
      throw new SemanticRoutingError("Stella semantic routing failed", "completion_failed");
    }
    const systemPrompt = [
      "Semantically classify one user turn for Stella Cortex. Do not answer the user.",
      "Return only strict JSON with mode, domains, stakes, reversibility, needsTwin, needsFramework, needsReality, needsExternalResearch, candidateFrameworks, candidateTwinRefs, candidatePraxisRefs, openEpisodeRef, situation, twinPrediction, and outcome when applicable.",
      "Use praxis for a personal real-world choice or when the owner asks to recall, inspect, or continue one semantically relevant supplied open Episode; use twin for owner-self questions, deep_praxis only when current external facts are required, and ordinary otherwise.",
      "Praxis takes precedence over twin and ordinary whenever a supplied open Episode can answer the owner's request. A direct owner request to inspect current open personal state is Praxis, not machine-authored extraction.",
      "Machine-authored internal planning, extraction, transformation, or structured-output requests are ordinary, even when their source material mentions a personal choice. Use praxis only when the turn itself asks Stella to help the owner make or evaluate that choice.",
      "For praxis, stakes and reversibility must each be exactly low, medium, or high.",
      "Praxis must request Twin, Framework, and Reality, select zero to two exact Framework operator refs, zero to three exact Twin refs, and zero to two exact personal Praxis refs from the supplied candidates, include situation arrays: actors, observations, interpretations, unknowns, userGoals, constraints, and include twinPrediction with one to four possibleActions probabilities plus likelyInterpretations and keyFactors.",
      "For praxis, when exactly one supplied open Episode is semantically relevant to the request, openEpisodeRef is mandatory and must contain its exact ref; otherwise omit openEpisodeRef.",
      ...(selectedOpenEpisodeRef
        ? [`The dedicated semantic selector chose ${JSON.stringify(selectedOpenEpisodeRef)}. The route must be praxis with top-level openEpisodeRef exactly matching it, or outcome with outcome.openEpisodeRef exactly matching it.`]
        : ["The dedicated semantic selector did not choose an open Episode. Omit openEpisodeRef."]),
      "twinPrediction.possibleActions must be a JSON object mapping action strings to numeric probabilities from 0 to 1, never an array.",
      "Use outcome only when the message semantically reports a result for exactly one supplied open Episode. Each open Episode candidate includes its immutable pre-outcome prediction and recommendation. Compare that prediction with the reported actual action and result: predictionAssessment must state supported, countered, or unresolved, and praxisLearning must be derived from that explicit comparison rather than invented independently. Then set all context needs false and include outcome with the exact openEpisodeRef, actualAction, source, observations, result, predictionAssessment, praxisLearning, and observedAt. If no supplied Episode clearly matches, do not use outcome.",
      "For outcome, mode must be exactly outcome; needsTwin, needsFramework, needsReality, and needsExternalResearch must all be false. outcome.source must be exactly user_report for an owner-reported result, tool_observation for tool evidence, system_event for a system event, or inferred only when explicitly marked as inference. outcome.predictionAssessment must be exactly supported, countered, or unresolved, and outcome.observedAt must be an ISO date-time.",
      "Twin mode must select zero to three exact Twin refs. Never invent or alter a candidate ref. deep_praxis is unavailable and must not be selected.",
      "Keep observations separate from interpretations. Do not infer meaning from isolated keywords; judge the complete utterance in context.",
      `Available semantic candidates: ${JSON.stringify(candidates)}`,
    ].join(" ");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: { text: string };
      try {
        result = await completeWithOneRetry({
          maxTokens: 2_000,
          temperature: 0,
          purpose: "stella-core-semantic-routing",
          systemPrompt: attempt === 0
            ? systemPrompt
            : `${systemPrompt} The previous response failed strict route validation. Return one corrected JSON object that satisfies every field and exact-reference constraint.`,
          messages: [{ role: "user", content: prompt }],
        }, complete);
      } catch {
        throw new SemanticRoutingError("Stella semantic routing failed", "completion_failed");
      }
      try {
        const route = parseModelRoute(result.text, candidates);
        const selectedEpisodeMatches = selectedOpenEpisodeRef
          ? (route.mode === "praxis" && route.openEpisodeRef === selectedOpenEpisodeRef) ||
            (route.mode === "outcome" && route.outcome?.openEpisodeRef === selectedOpenEpisodeRef)
          : route.openEpisodeRef === undefined;
        if (!selectedEpisodeMatches) {
          throw new Error("Model route disagreed with the open Episode selector");
        }
        return route;
      } catch {
        if (attempt === 1) {
          throw new SemanticRoutingError("Stella semantic routing failed", "invalid_model_route");
        }
      }
    }
    throw new SemanticRoutingError("Stella semantic routing failed", "invalid_model_route");
  };
}
