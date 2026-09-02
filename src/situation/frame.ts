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

const INTERPRETATION_SIGNAL = /(?:我觉得|我认为|我担心|看起来|似乎|可能|大概|意味着)/u;
const UNKNOWN_SIGNAL = /(?:不知道|不确定|是不是|是否|要不要|该不该|\?)/u;
const GOAL_SIGNAL = /(?:我想|我希望|目标是|想要)/u;
const CONSTRAINT_SIGNAL = /(?:不想|不能|必须|只能|同时不|又不|但不)/u;

function clauses(prompt: string): string[] {
  return prompt
    .split(/[。！？!；;\n]+/u)
    .flatMap((sentence) =>
      sentence.split(
        /[，,](?=(?:但|同时|又不|我觉得|我认为|我担心|我想|也不知道|不知道|不想|不能))/u,
      ),
    )
    .map((sentence) => sentence.trim().replace(/^但(?=也?不知道)/u, ""))
    .filter(Boolean);
}

export function buildSituationFrame(prompt: string, route: CortexRoute): SituationFrame {
  const observations: string[] = [];
  const interpretations: string[] = [];
  const unknowns: string[] = [];
  const userGoals: string[] = [];
  const constraints: string[] = [];

  for (const clause of clauses(prompt)) {
    let classified = false;
    if (UNKNOWN_SIGNAL.test(clause)) {
      unknowns.push(clause);
      classified = true;
    }
    if (INTERPRETATION_SIGNAL.test(clause)) {
      interpretations.push(clause);
      classified = true;
    }
    if (CONSTRAINT_SIGNAL.test(clause)) {
      constraints.push(clause);
      classified = true;
    }
    if (GOAL_SIGNAL.test(clause)) {
      userGoals.push(clause);
      classified = true;
    }
    if (!classified) {
      observations.push(clause);
    }
  }

  return {
    actors: route.actors ?? (route.domains.includes("relationship") ? ["self", "other"] : ["self"]),
    observations,
    interpretations,
    unknowns,
    userGoals,
    constraints,
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
