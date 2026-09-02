import { parse as parseYaml } from "yaml";
import type { LoadedConsciousness } from "../canghai/manifest.js";
import { parseTwinHypothesisRecord } from "../canghai/schema.js";
import type { CortexRoute } from "../routing/router.js";
import { isRecord } from "../shared/type-guards.js";
import { buildSituationFrame, type SituationFrame } from "../situation/frame.js";

export const DEFAULT_MAX_PRAXIS_PACKET_CHARS = 12_000;
const MAX_SITUATION_TEXT_CHARS = 250;
const MAX_TWIN_PATTERN_CHARS = 500;
const MAX_OPERATOR_PURPOSE_CHARS = 300;
const MAX_LIST_ITEMS = 4;
const MAX_FRAMEWORK_OPERATORS = 2;

type RealityMode = "base_model" | "personal_praxis" | "external_research";

export type PraxisContextPacket = {
  mode: "praxis" | "deep_praxis";
  situation: SituationFrame;
  twin?: {
    hypothesisRefs: string[];
    relevantPatterns: string[];
    values?: string[];
    similarEpisodeRefs?: string[];
    prediction?: Record<string, number>;
  };
  framework?: {
    frameworkRefs: string[];
    operatorRefs: string[];
    operators: Array<{ ref: string; purpose: string }>;
    failureModes?: string[];
  };
  reality: {
    modes: RealityMode[];
    norms?: string[];
    hiddenVariables?: string[];
    socialCosts?: string[];
    uncertainties?: string[];
    externalRefs?: string[];
    personalPraxisRefs?: string[];
    personalPractices?: string[];
  };
  openEpisodeRef?: string;
};

type FrameworkOperator = { id: string; purpose: string; selectionText: string };
type FrameworkRecord = {
  id: string;
  cognitiveJobs: string[];
  domainHints: string[];
  positiveSignals: string[];
  operators: FrameworkOperator[];
  failureModes: string[];
};

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundedStrings(values: string[], maxChars = MAX_SITUATION_TEXT_CHARS): string[] {
  return values.slice(0, MAX_LIST_ITEMS).map((value) => boundedText(value, maxChars));
}

function boundSituation(frame: SituationFrame): SituationFrame {
  return {
    actors: boundedStrings(frame.actors, 80),
    observations: boundedStrings(frame.observations),
    interpretations: boundedStrings(frame.interpretations),
    unknowns: boundedStrings(frame.unknowns),
    userGoals: boundedStrings(frame.userGoals),
    constraints: boundedStrings(frame.constraints),
    ...(frame.socialContext ? { socialContext: frame.socialContext } : {}),
    ...(frame.decision ? { decision: frame.decision } : {}),
  };
}

function selectTwinContext(route: CortexRoute, loaded: LoadedConsciousness) {
  const matches = loaded.bootstrapDocuments
    .filter((document) => document.category === "twin")
    .flatMap((document) => {
      const record = parseTwinHypothesisRecord(document.content);
      const scope = isRecord(record.scope) ? record.scope : undefined;
      const domains = Array.isArray(scope?.domains)
        ? scope.domains.filter((value): value is string => typeof value === "string")
        : [];
      const relevant = domains.length === 0 || domains.some((domain) => route.domains.includes(domain));
      return relevant && typeof record.statement === "string"
        ? [{ ref: document.ref, statement: record.statement }]
        : [];
    })
    .slice(0, 3);

  if (matches.length === 0) return undefined;
  return {
    hypothesisRefs: matches.map((match) => match.ref),
    relevantPatterns: matches.map((match) => boundedText(match.statement, MAX_TWIN_PATTERN_CHARS)),
  };
}

function parseFrameworkRecord(content: string): FrameworkRecord | undefined {
  const parsed = parseYaml(content) as unknown;
  if (!isRecord(parsed) || typeof parsed.id !== "string") return undefined;
  const detection = isRecord(parsed.detection) ? parsed.detection : {};
  const cognitiveJobs = Array.isArray(parsed.cognitiveJobs)
    ? parsed.cognitiveJobs.filter((value): value is string => typeof value === "string")
    : [];
  const domainHints = Array.isArray(parsed.domainHints)
    ? parsed.domainHints.filter((value): value is string => typeof value === "string")
    : [];
  const positiveSignals = Array.isArray(detection.positiveSignals)
    ? detection.positiveSignals.filter((value): value is string => typeof value === "string")
    : [];
  const operators = Array.isArray(parsed.operators)
    ? parsed.operators.flatMap((value) =>
        isRecord(value) && typeof value.id === "string" && typeof value.purpose === "string"
          ? [{
              id: value.id,
              purpose: value.purpose,
              selectionText: [
                value.purpose,
                ...(Array.isArray(value.questions) ? value.questions : []),
                ...(Array.isArray(value.transforms) ? value.transforms : []),
                ...(Array.isArray(value.outputHints) ? value.outputHints : []),
              ].filter((item): item is string => typeof item === "string").join(" ").toLowerCase(),
            }]
          : [],
      )
    : [];
  const failureModes = Array.isArray(parsed.failureModes)
    ? parsed.failureModes.flatMap((value) =>
        isRecord(value) && typeof value.description === "string" ? [value.description] : [],
      )
    : [];
  return { id: parsed.id, cognitiveJobs, domainHints, positiveSignals, operators, failureModes };
}

function operatorSituationScore(operator: FrameworkOperator, situation: SituationFrame): number {
  let score = 0;
  if (
    situation.interpretations.length > 0 &&
    /(?:observation|interpretation|identity|certainty|explanation|evidence)/u.test(operator.selectionText)
  ) {
    score += 3;
  }
  if (
    situation.unknowns.length > 0 &&
    /(?:uncertainty|condition|competing|alternative|evidence|change)/u.test(operator.selectionText)
  ) {
    score += 2;
  }
  if (
    situation.decision?.reversibility === "high" &&
    /(?:reversible|experience|action|test|experiment)/u.test(operator.selectionText)
  ) {
    score += 2;
  }
  return score;
}

function selectFrameworkContext(
  prompt: string,
  route: CortexRoute,
  loaded: LoadedConsciousness,
  situation: SituationFrame,
) {
  const ranked = loaded.bootstrapDocuments
    .filter((document) => document.category === "framework")
    .flatMap((document) => {
      const record = parseFrameworkRecord(document.content);
      if (!record) return [];
      const domainScore = [...record.cognitiveJobs, ...record.domainHints]
        .filter((job) => route.domains.includes(job)).length;
      const signalScore = record.positiveSignals.filter((signal) => prompt.includes(signal)).length;
      return domainScore + signalScore > 0
        ? [{ documentRef: document.ref, record, score: domainScore * 2 + signalScore }]
        : [];
    })
    .sort((left, right) => right.score - left.score);

  const selected = ranked
    .flatMap(({ documentRef, record, score }) =>
      record.operators.flatMap((operator) => {
        const relevance = operatorSituationScore(operator, situation);
        return relevance > 0
          ? [{ documentRef, record, operator, score: score + relevance }]
          : [];
      }),
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_FRAMEWORK_OPERATORS);
  if (selected.length === 0) return undefined;

  return {
    frameworkRefs: [...new Set(selected.map(({ documentRef }) => documentRef))],
    operatorRefs: selected.map(
      ({ documentRef, operator }) => `${documentRef}#operator:${operator.id}`,
    ),
    operators: selected.map(({ documentRef, operator }) => ({
      ref: `${documentRef}#operator:${operator.id}`,
      purpose: boundedText(operator.purpose, MAX_OPERATOR_PURPOSE_CHARS),
    })),
    failureModes: boundedStrings(
      [...new Set(selected.flatMap(({ record }) => record.failureModes))],
    ),
  };
}

function buildRealityContext(
  route: CortexRoute,
  situation: SituationFrame,
  loaded: LoadedConsciousness,
) {
  const modes: RealityMode[] = ["base_model"];
  const personalPraxis = route.needsReality
    ? loaded.praxisPlaybookItems
        .filter(
          (item) =>
            item.domains.length === 0 || item.domains.some((domain) => route.domains.includes(domain)),
        )
        .slice(0, 2)
    : [];
  if (personalPraxis.length > 0) modes.push("personal_praxis");
  if (route.needsExternalResearch) modes.push("external_research");

  const personalFields =
    personalPraxis.length > 0
      ? {
          personalPraxisRefs: personalPraxis.map((item) => item.ref),
          personalPractices: personalPraxis.map((item) =>
            boundedText(item.content.trim(), MAX_TWIN_PATTERN_CHARS),
          ),
        }
      : {};

  if (route.domains.includes("relationship")) {
    return {
      modes,
      ...personalFields,
      norms: ["低压、可退出的单次沟通比连续追问更尊重对方边界。"],
      hiddenVariables: ["未回复也可能受时间、精力、沟通习惯或现实安排影响，不能只归因于关系态度。"],
      socialCosts: ["再次联系的成本取决于频率、语气，以及是否给对方明确的退出空间。"],
      uncertainties: boundedStrings(situation.unknowns),
    };
  }

  return {
    modes,
    ...personalFields,
    hiddenVariables: ["行动成本、其他参与者的约束和执行时机可能改变选项的实际效果。"],
    uncertainties: boundedStrings(situation.unknowns),
  };
}

export function buildPraxisContextPacket(
  prompt: string,
  route: CortexRoute,
  loaded: LoadedConsciousness,
): PraxisContextPacket {
  if (route.mode !== "praxis" && route.mode !== "deep_praxis") {
    throw new Error(`Cannot build a Praxis packet for route mode ${route.mode}`);
  }

  const situation = boundSituation(buildSituationFrame(prompt, route));
  const twin = route.needsTwin ? selectTwinContext(route, loaded) : undefined;
  const framework = route.needsFramework
    ? selectFrameworkContext(prompt, route, loaded, situation)
    : undefined;

  return {
    mode: route.mode,
    situation,
    ...(twin ? { twin } : {}),
    ...(framework ? { framework } : {}),
    reality: buildRealityContext(route, situation, loaded),
    ...(route.openEpisodeRef ? { openEpisodeRef: route.openEpisodeRef } : {}),
  };
}

export function renderPraxisContextPacket(
  packet: PraxisContextPacket,
  maxChars = DEFAULT_MAX_PRAXIS_PACKET_CHARS,
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer");
  }
  const packetJson = JSON.stringify(packet).replaceAll(
    "</stella_core_praxis_context>",
    "<\\/stella_core_praxis_context>",
  );
  const rendered = [
    '<stella_core_praxis_context mode="shadow_read_only">',
    "owner_boundary: advise or prepare only; never send, commit, or act externally",
    "concrete_next_action: required when the owner asks what to do",
    packetJson,
    "</stella_core_praxis_context>",
  ].join("\n");
  if (rendered.length > maxChars) {
    throw new Error(`Praxis Context Packet exceeds the hard limit of ${maxChars} characters`);
  }
  return rendered;
}
