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

export type FrameworkCandidate = { ref: string; purpose: string };
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
  openEpisodeRef?: string;
  situation?: RouteSituation;
};

export type SemanticRouteClassifier = (
  prompt: string,
  frameworkCandidates: FrameworkCandidate[],
) => Promise<CortexRoute>;

export async function routeTurn(
  prompt: string,
  frameworkCandidates: FrameworkCandidate[],
  classifySemantically: SemanticRouteClassifier,
): Promise<CortexRoute> {
  return classifySemantically(prompt, frameworkCandidates);
}
