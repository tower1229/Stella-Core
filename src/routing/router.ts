export const CORTEX_MODES = [
  "ordinary",
  "twin",
  "praxis",
  "deep_praxis",
  "outcome",
] as const;

export type CortexMode = (typeof CORTEX_MODES)[number];
export type Stakes = "low" | "medium" | "high";
export type Reversibility = "high" | "medium" | "low";

export type SemanticCandidate = { ref: string; purpose: string };
export type SemanticRoutingCandidates = {
  frameworks: SemanticCandidate[];
  twin: SemanticCandidate[];
  personalPraxis: SemanticCandidate[];
};
export type RouteSituation = {
  actors: string[];
  observations: string[];
  interpretations: string[];
  unknowns: string[];
  userGoals: string[];
  constraints: string[];
};

export type CortexRoute = {
  mode: CortexMode;
  domains: string[];
  actors?: string[];
  stakes?: Stakes;
  reversibility?: Reversibility;
  needsTwin: boolean;
  needsFramework: boolean;
  needsReality: boolean;
  needsExternalResearch: boolean;
  candidateFrameworks?: string[];
  candidateTwinRefs?: string[];
  candidatePraxisRefs?: string[];
  openEpisodeRef?: string;
  situation?: RouteSituation;
};

export type SemanticRouteClassifier = (
  prompt: string,
  candidates: SemanticRoutingCandidates,
) => Promise<CortexRoute>;
