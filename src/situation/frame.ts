import type { CortexRoute, Reversibility, Stakes } from "../routing/router.js";

export type SituationFrame = {
  actors: string[];
  observations: string[];
  interpretations: string[];
  unknowns: string[];
  userGoals: string[];
  constraints: string[];
  socialContext?: {
    relationshipStage?: string;
    powerRelation?: string;
    reciprocity?: string;
    intimacy?: string;
    ambiguity?: string;
  };
  decision?: {
    options?: string[];
    stakes: Stakes;
    reversibility: Reversibility;
  };
};

export function buildSituationFrame(_prompt: string, route: CortexRoute): SituationFrame {
  if (!route.situation) {
    throw new Error("Praxis route requires a semantically extracted Situation Frame");
  }
  return {
    ...route.situation,
    ...(route.stakes && route.reversibility
      ? {
          decision: {
            stakes: route.stakes,
            reversibility: route.reversibility,
          },
        }
      : {}),
  };
}
