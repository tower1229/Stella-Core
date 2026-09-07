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
    readonly validationCode?: string,
  ) {
    super(message);
    this.name = "SemanticRoutingError";
  }
}

const MAX_STRUCTURED_ROUTE_ATTEMPTS = 3;

function routeValidationCode(error: unknown): string {
  if (error instanceof SyntaxError) return "invalid_json";
  const message = error instanceof Error ? error.message : "";
  const jsonCode = message.match(/did not return a JSON route \((invalid_json_[a-z]+)\)/u)?.[1];
  if (jsonCode) return jsonCode;
  if (message.includes("did not return a JSON route")) return "invalid_json";
  const field = message.match(/^Model route field ([a-zA-Z]+) /u)?.[1];
  if (field) return `field_${field}`;
  if (message.includes("at least one domain")) return "field_domains";
  if (message.includes("disagreed with the open Episode selector")) return "episode_consistency";
  if (message.includes("open Episode selector")) return "episode_selector";
  if (message.includes("outcome source")) return "outcome_source";
  if (message.includes("outcome prediction assessment")) return "outcome_prediction_assessment";
  if (message.includes("outcome observedAt")) return "outcome_observed_at";
  if (message.includes("outcome")) return "outcome_shape";
  if (message.includes("Twin prediction")) return "twin_prediction";
  if (message.includes("Praxis route")) return "praxis_shape";
  if (message.includes("non-Cortex route")) return "context_policy";
  if (message.includes("route mode")) return "mode";
  if (message.includes("unsupported mode")) return "mode";
  return "route_shape";
}

function invalidJsonEnvelopeCode(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "invalid_json_missing";
  if (trimmed.includes("```")) return "invalid_json_fenced";
  if (trimmed.startsWith("{") && !trimmed.endsWith("}")) return "invalid_json_truncated";
  if (trimmed.startsWith("{")) return "invalid_json_syntax";
  if (trimmed.includes("{") && trimmed.includes("}")) return "invalid_json_wrapped";
  return "invalid_json_missing";
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
  if (Math.abs(actionEntries.reduce((sum, [, probability]) => sum + (probability as number), 0) - 1) > 1e-6) {
    throw new Error("Model Twin prediction probabilities must sum to one");
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
  if (Object.keys(value).some((key) => key !== "openEpisodeRef")) {
    throw new Error("Model outcome routing cannot supply unverified action or learning details");
  }
  return { openEpisodeRef };
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
  const systemPrompt = [
    "Judge whether this owner turn asks to recall, inspect, or continue exactly one supplied open Praxis Episode. Do not answer the owner.",
    "A message reporting a new outcome is not an open-state recall and must return null.",
    "Return only strict JSON: {\"openEpisodeRef\":<exact supplied ref or null>}.",
    `Available open Episode candidates: ${JSON.stringify(available)}`,
  ].join(" ");
  let repairInstruction = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: { text: string };
    try {
      result = await complete({
        maxTokens: 4_096,
        temperature: 0,
        purpose: "stella-core-open-episode-selection",
        systemPrompt: attempt === 0 ? systemPrompt : `${systemPrompt} ${repairInstruction}`,
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
    } catch (error) {
      if (attempt === 1) {
        throw new SemanticRoutingError(
          "Stella semantic routing failed",
          "invalid_model_route",
          "episode_selector",
        );
      }
      const validationReason = error instanceof Error
        ? error.message.slice(0, 200)
        : "unknown validation failure";
      repairInstruction = [
        "The previous selector response failed strict validation.",
        `Validation error: ${validationReason}`,
        `Previous response: ${result.text.slice(0, 1_000)}`,
        "Return only the corrected JSON object with the required openEpisodeRef field.",
      ].join(" ");
    }
  }
  throw new SemanticRoutingError(
    "Stella semantic routing failed",
    "invalid_model_route",
    "episode_selector",
  );
}

function parseModelRoute(text: string, candidates: SemanticRoutingCandidates): CortexRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(text));
  } catch (error) {
    throw new Error(
      `Model router did not return a JSON route (${invalidJsonEnvelopeCode(text)})`,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || typeof parsed.mode !== "string") {
    throw new Error("Model router did not return a JSON route");
  }
  if (!isCortexMode(parsed.mode)) throw new Error("Model router returned an unsupported mode");

  const responseKind = parsed.responseKind;
  if (responseKind !== "answer" && responseKind !== "clarification" && responseKind !== "collaboration" &&
      responseKind !== "action_advice" && responseKind !== "outcome_ack") {
    throw new Error("Model route field responseKind is invalid");
  }
  const evidenceStatus = parsed.evidenceStatus;
  if (evidenceStatus !== "sufficient" && evidenceStatus !== "material_unknown" && evidenceStatus !== "conflicting") {
    throw new Error("Model route field evidenceStatus is invalid");
  }
  const materialUnknowns = stringList(parsed, "materialUnknowns", 4);
  if (evidenceStatus === "material_unknown" && materialUnknowns.length === 0) {
    throw new Error("Model route field materialUnknowns must identify the missing evidence");
  }
  if (evidenceStatus === "material_unknown" && responseKind === "action_advice") {
    throw new Error("Model route field responseKind cannot force action advice across material unknowns");
  }
  if (parsed.mode === "outcome" ? !["outcome_ack", "clarification"].includes(responseKind) : responseKind === "outcome_ack") {
    throw new Error("Model route field responseKind disagrees with outcome mode");
  }
  if (parsed.twinPrediction !== undefined && responseKind !== "action_advice") {
    throw new Error("Model route field responseKind does not support a new choice prediction");
  }

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
    responseKind,
    evidenceStatus,
    materialUnknowns,
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
          ...(parsed.twinPrediction !== undefined ? { twinPrediction: parseTwinPrediction(parsed) } : {}),
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
      "Return only strict JSON with mode, responseKind, evidenceStatus, materialUnknowns, domains, stakes, reversibility, needsTwin, needsFramework, needsReality, needsExternalResearch, candidateFrameworks, candidateTwinRefs, candidatePraxisRefs, openEpisodeRef, situation, twinPrediction, and outcome when applicable.",
      "Choose responseKind semantically: answer, clarification, collaboration, action_advice, outcome_ack. Outcome mode permits outcome_ack or clarification; outcome_ack is provisional until original evidence and persistence are verified. evidenceStatus must be sufficient, material_unknown, or conflicting; materialUnknowns is an array of zero to four concrete missing facts. Operational faults are errors, not evidence states.",
      "When missing facts would change the decision, identify them in materialUnknowns and choose an answerable clarification or useful collaboration, never force action_advice. Writing collaboration preserves the author's intent and unresolved thinking, without invented action, outcome, optimistic meaning, or motivational ending.",
      "Use praxis for a personal real-world choice or when the owner asks to recall, inspect, or continue one semantically relevant supplied open Episode; use twin for owner-self questions, deep_praxis only when current external facts are required, and ordinary otherwise.",
      "Praxis takes precedence over twin and ordinary whenever a supplied open Episode can answer the owner's request. A direct owner request to inspect current open personal state is Praxis, not machine-authored extraction.",
      "Machine-authored internal planning, extraction, transformation, or structured-output requests are ordinary, even when their source material mentions a personal choice. Use praxis only when the turn itself asks Stella to help the owner make or evaluate that choice.",
      "For praxis, stakes and reversibility must each be exactly low, medium, or high.",
      "Praxis must request Twin, Framework, and Reality, select zero to two exact Framework operator refs, zero to three exact Twin refs, and zero to two exact personal Praxis refs from the supplied candidates, and include situation arrays: actors, observations, interpretations, unknowns, userGoals, constraints. Only include twinPrediction for a meaningful choice before its outcome is known, when responseKind is action_advice; it is optional, never required to fill a format. If present, supply one to four possibleActions probabilities summing to one, plus likelyInterpretations and keyFactors.",
      "Select Twin and personal Praxis refs only when their supplied purpose is semantically relevant to this exact situation. Empty selections are correct when no candidate applies; never transfer a memory across relationship, family, workplace, or other domains merely because both situations are social.",
      "For praxis, the Host will attach the already selected openEpisodeRef. Omit this redundant field; if you return it, it must match the dedicated selector exactly.",
      ...(selectedOpenEpisodeRef
        ? [`The dedicated semantic selector chose ${JSON.stringify(selectedOpenEpisodeRef)}. The route must be praxis, or outcome with outcome.openEpisodeRef exactly matching it.`]
        : ["The dedicated semantic selector did not choose an open Episode. Omit openEpisodeRef."]),
      "twinPrediction.possibleActions must be a JSON object mapping action strings to numeric probabilities from 0 to 1, never an array.",
      "Use outcome only when the message semantically reports a result for exactly one supplied open Episode. Set all context needs false and supply outcome:{openEpisodeRef:<exact supplied ref>} only. This routing decision selects a candidate, not proof that an action or result occurred. Actual action, result, time and learning belong exclusively to the subsequent original-evidence verification phase; never supply them in routing output. If no supplied Episode clearly matches, do not use outcome.",
      "Twin mode must select zero to three exact Twin refs. Never invent or alter a candidate ref. deep_praxis is unavailable and must not be selected.",
      "Keep observations separate from interpretations. Do not infer meaning from isolated keywords; judge the complete utterance in context.",
      `Available semantic candidates: ${JSON.stringify(candidates)}`,
    ].join(" ");
    let repairInstruction = "";
    let validationCode = "route_shape";
    for (let attempt = 0; attempt < MAX_STRUCTURED_ROUTE_ATTEMPTS; attempt += 1) {
      let result: { text: string };
      try {
        result = await completeWithOneRetry({
          // The Host output budget also covers reasoning; 2,000 truncated valid
          // Gemini route responses before the JSON object was complete.
          maxTokens: 8_192,
          temperature: 0,
          purpose: "stella-core-semantic-routing",
          systemPrompt: attempt === 0
            ? systemPrompt
            : `${systemPrompt} ${repairInstruction}`,
          messages: [{ role: "user", content: prompt }],
        }, complete);
      } catch {
        throw new SemanticRoutingError("Stella semantic routing failed", "completion_failed");
      }
      try {
        const parsedRoute = parseModelRoute(result.text, candidates);
        const route = parsedRoute.mode === "praxis" && parsedRoute.openEpisodeRef === undefined && selectedOpenEpisodeRef
          ? { ...parsedRoute, openEpisodeRef: selectedOpenEpisodeRef }
          : parsedRoute;
        const selectedEpisodeMatches = selectedOpenEpisodeRef
          ? (route.mode === "praxis" && route.openEpisodeRef === selectedOpenEpisodeRef) ||
            (route.mode === "outcome" && route.outcome?.openEpisodeRef === selectedOpenEpisodeRef)
          : route.openEpisodeRef === undefined;
        if (!selectedEpisodeMatches) {
          throw new Error("Model route disagreed with the open Episode selector");
        }
        return route;
      } catch (error) {
        validationCode = routeValidationCode(error);
        if (attempt === MAX_STRUCTURED_ROUTE_ATTEMPTS - 1) {
          throw new SemanticRoutingError(
            "Stella semantic routing failed",
            "invalid_model_route",
            validationCode,
          );
        }
        const validationReason = error instanceof Error
          ? error.message.slice(0, 300)
          : "unknown validation failure";
        repairInstruction = [
          "The previous response failed strict route validation.",
          `Validation error: ${validationReason}`,
          `Previous response: ${result.text.slice(0, 4_000)}`,
          "Return one corrected JSON object that satisfies every field and exact-reference constraint. Do not repeat the explanation.",
        ].join(" ");
      }
    }
    throw new SemanticRoutingError(
      "Stella semantic routing failed",
      "invalid_model_route",
      validationCode,
    );
  };
}
