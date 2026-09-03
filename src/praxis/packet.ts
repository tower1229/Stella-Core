import { parse as parseYaml } from "yaml";
import type { LoadedConsciousness } from "../canghai/manifest.js";
import { parseTwinHypothesisRecord } from "../canghai/schema.js";
import type {
  CortexRoute,
  SemanticCandidate,
  SemanticRoutingCandidates,
} from "../routing/router.js";
import { isRecord } from "../shared/type-guards.js";
import { buildSituationFrame, type SituationFrame } from "../situation/frame.js";
import type { OpenEpisodeCandidate, StellaDataMode } from "./episode-store.js";

export const DEFAULT_MAX_PRAXIS_PACKET_CHARS = 12_000;
const MAX_SITUATION_TEXT_CHARS = 250;
const MAX_TWIN_PATTERN_CHARS = 500;
const MAX_OPERATOR_PURPOSE_CHARS = 300;
const MAX_LIST_ITEMS = 4;
const MAX_FRAMEWORK_OPERATORS = 2;
const MAX_ROUTING_CANDIDATES_PER_KIND = 24;

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

type FrameworkOperator = { id: string; purpose: string };
type FrameworkRecord = {
  id: string;
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
  const selectedRefs = new Set(route.candidateTwinRefs ?? []);
  const matches = loaded.bootstrapDocuments
    .filter((document) => document.category === "twin")
    .flatMap((document) => {
      const record = parseTwinHypothesisRecord(document.content);
      return selectedRefs.has(document.ref) && typeof record.statement === "string"
        ? [{ ref: document.ref, statement: record.statement }]
        : [];
    })
    .slice(0, 3);

  if (matches.length !== selectedRefs.size) {
    throw new Error("Praxis route did not resolve its selected Twin hypotheses");
  }

  if (matches.length === 0) return undefined;
  return {
    hypothesisRefs: matches.map((match) => match.ref),
    relevantPatterns: matches.map((match) => boundedText(match.statement, MAX_TWIN_PATTERN_CHARS)),
  };
}

function parseFrameworkRecord(content: string): FrameworkRecord | undefined {
  const parsed = parseYaml(content) as unknown;
  if (!isRecord(parsed) || typeof parsed.id !== "string") return undefined;
  const operators = Array.isArray(parsed.operators)
    ? parsed.operators.flatMap((value) =>
        isRecord(value) && typeof value.id === "string" && typeof value.purpose === "string"
          ? [{ id: value.id, purpose: value.purpose }]
          : [],
      )
    : [];
  const failureModes = Array.isArray(parsed.failureModes)
    ? parsed.failureModes.flatMap((value) =>
        isRecord(value) && typeof value.description === "string" ? [value.description] : [],
      )
    : [];
  return { id: parsed.id, operators, failureModes };
}

function withinCandidateCapacity(kind: string, candidates: SemanticCandidate[]): SemanticCandidate[] {
  if (candidates.length > MAX_ROUTING_CANDIDATES_PER_KIND) {
    throw new Error(
      `${kind} candidate count exceeds the hard limit of ${MAX_ROUTING_CANDIDATES_PER_KIND}`,
    );
  }
  return candidates;
}

export function listSemanticRoutingCandidates(
  loaded: LoadedConsciousness,
  openEpisodes: OpenEpisodeCandidate[] = [],
): SemanticRoutingCandidates {
  const frameworks = loaded.bootstrapDocuments
    .filter((document) => document.category === "framework")
    .flatMap((document) => {
      const record = parseFrameworkRecord(document.content);
      if (!record) return [];
      return record.operators.map((operator) => ({
        ref: `${document.ref}#operator:${operator.id}`,
        purpose: boundedText(operator.purpose, 160),
      }));
    });
  const twin = loaded.bootstrapDocuments
    .filter((document) => document.category === "twin")
    .flatMap((document) => {
      const record = parseTwinHypothesisRecord(document.content);
      return typeof record.statement === "string"
        ? [{ ref: document.ref, purpose: boundedText(record.statement, 160) }]
        : [];
    });
  const personalPraxis = loaded.praxisPlaybookItems.map((item) => ({
    ref: item.ref,
    purpose: boundedText(item.content.trim(), 160),
  }));
  return {
    frameworks: withinCandidateCapacity("Framework", frameworks),
    twin: withinCandidateCapacity("Twin", twin),
    personalPraxis: withinCandidateCapacity("personal Praxis", personalPraxis),
    openEpisodes: withinCandidateCapacity(
      "open Praxis Episode",
      openEpisodes.map((episode) => ({
        ref: episode.ref,
        purpose: boundedText(JSON.stringify({
          domains: episode.domains,
          summary: episode.summary,
          prediction: episode.prediction,
          recommendation: episode.recommendation,
        }), 1_000),
      })),
    ),
  };
}

function selectFrameworkContext(
  route: CortexRoute,
  loaded: LoadedConsciousness,
) {
  const selectedRefs = new Set(route.candidateFrameworks ?? []);
  const selected = loaded.bootstrapDocuments
    .filter((document) => document.category === "framework")
    .flatMap((document) => {
      const record = parseFrameworkRecord(document.content);
      if (!record) return [];
      return record.operators.flatMap((operator) => {
        const ref = `${document.ref}#operator:${operator.id}`;
        return selectedRefs.has(ref) ? [{ documentRef: document.ref, record, operator }] : [];
      });
    })
    .slice(0, MAX_FRAMEWORK_OPERATORS);
  if (selected.length !== selectedRefs.size) {
    throw new Error("Praxis route did not resolve its selected Framework operators");
  }

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
  const selectedPraxisRefs = new Set(route.candidatePraxisRefs ?? []);
  const personalPraxis = route.needsReality
    ? loaded.praxisPlaybookItems.filter((item) => selectedPraxisRefs.has(item.ref))
    : [];
  if (personalPraxis.length !== selectedPraxisRefs.size) {
    throw new Error("Praxis route did not resolve its selected personal Praxis records");
  }
  if (personalPraxis.length > 0) modes.push("personal_praxis");
  if (route.needsExternalResearch) {
    throw new Error("External research is unavailable for Praxis packet construction");
  }

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
    ? selectFrameworkContext(route, loaded)
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
  dataMode: StellaDataMode = "read_only",
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer");
  }
  const packetJson = JSON.stringify(packet).replaceAll(
    "</stella_core_praxis_context>",
    "<\\/stella_core_praxis_context>",
  );
  const rendered = [
    `<stella_core_praxis_context mode="${dataMode}">`,
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
