import { validateSchema } from "../canghai/schema.js";

export type VersionedRef = { id: string; version: string };
export type ActualSource = "user_report" | "tool_observation" | "system_event";
export type EpisodeStatus = "open" | "recommended" | "acted" | "observing" | "closed" | "abandoned" | "expired";
export type EpisodeV2 = {
  schemaVersion: "stella.praxis-episode/v2";
  id: string;
  status: EpisodeStatus;
  createdAt: string;
  updatedAt: string;
  recoveryPriority: "normal" | "important";
  historicalInputRefs: VersionedRef[];
  provenance: { agentId?: string; sessionId?: string; runId?: string; messageRefs?: string[] };
  situation: {
    summary: string; domains: string[]; observations: string[];
    actors?: string[]; interpretations?: string[]; unknowns?: string[]; goals?: string[];
    stakes?: "low" | "medium" | "high"; reversibility?: "low" | "medium" | "high";
  };
  twin?: { hypothesisRefs?: VersionedRef[]; prediction?: {
    possibleActions: Record<string, number>; likelyInterpretations: string[]; keyFactors: string[];
  } };
  framework?: { frameworkRefs?: VersionedRef[]; operatorRefs?: string[] };
  reality?: {
    modes?: Array<"base_model" | "personal_praxis" | "external_research">;
    norms?: string[]; hiddenVariables?: string[]; likelyInterpretations?: string[];
    socialCosts?: string[]; uncertainties?: string[]; externalRefs?: VersionedRef[]; similarEpisodeRefs?: VersionedRef[];
  };
  decision?: { recommendation: string; rationale: string[]; options?: string[]; actionGate?: "A" | "B" | "C" | "D" };
  actual?: { action: string; occurredAt: string | null; recordedAt: string; source: ActualSource; evidenceRefs: VersionedRef[] };
  outcome?: { observations: string[]; result: string; observedAt: string; evidenceRefs: VersionedRef[] };
  learning?: { algorithmVersion: string; predictionAssessment: "supported" | "countered" | "unresolved";
    evidenceRefs: VersionedRef[]; twin: VersionedRef[]; praxis: VersionedRef[]; reality?: string[]; frameworkPractice?: string[] };
  retrospective?: { endorsement?: number; regret?: number; comment?: string; recordedAt?: string; evidenceRefs?: VersionedRef[] };
};

export class EpisodeV2Error extends Error {
  constructor(readonly category: string) { super(`Praxis v2 validation failed: ${category}`); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export async function parseEpisodeV2(value: unknown): Promise<EpisodeV2> {
  await validateSchema("praxis-episode-v2", value);
  const episode = value as EpisodeV2;
  const prediction = episode.twin?.prediction;
  if (prediction) {
    const probabilities = Object.values(prediction.possibleActions);
    if (probabilities.length === 0 || Math.abs(probabilities.reduce((sum, probability) => sum + probability, 0) - 1) > 1e-6) {
      throw new EpisodeV2Error("prediction_not_normalized");
    }
  }
  if (Date.parse(episode.updatedAt) < Date.parse(episode.createdAt)) throw new EpisodeV2Error("invalid_record_time");
  return episode;
}

export async function validateEpisodeV2References(episode: EpisodeV2, ports: {
  resolveHistorical(ref: VersionedRef): Promise<void>;
  verifyActionEvidence(actual: NonNullable<EpisodeV2["actual"]>): Promise<boolean>;
  verifyOutcomeEvidence(actual: NonNullable<EpisodeV2["actual"]>, outcome: NonNullable<EpisodeV2["outcome"]>): Promise<boolean>;
  resolveEvidence(ref: VersionedRef): Promise<void>;
  resolveLearning(ref: VersionedRef): Promise<void>;
}): Promise<void> {
  await parseEpisodeV2(episode);
  for (const ref of [
    ...episode.historicalInputRefs, ...(episode.twin?.hypothesisRefs ?? []),
    ...(episode.framework?.frameworkRefs ?? []), ...(episode.reality?.externalRefs ?? []),
    ...(episode.reality?.similarEpisodeRefs ?? []),
  ]) await ports.resolveHistorical(ref);
  for (const ref of [...(episode.actual?.evidenceRefs ?? []), ...(episode.outcome?.evidenceRefs ?? []),
    ...(episode.learning?.evidenceRefs ?? []), ...(episode.retrospective?.evidenceRefs ?? [])]) await ports.resolveEvidence(ref);
  if (episode.actual && !await ports.verifyActionEvidence(episode.actual)) throw new EpisodeV2Error("unsupported_actual_action");
  if (episode.outcome && (!episode.actual || !await ports.verifyOutcomeEvidence(episode.actual, episode.outcome))) {
    throw new EpisodeV2Error("unsupported_reported_outcome");
  }
  for (const ref of [...(episode.learning?.twin ?? []), ...(episode.learning?.praxis ?? [])]) await ports.resolveLearning(ref);
}

const transitions: Record<EpisodeStatus, readonly EpisodeStatus[]> = {
  open: ["recommended", "abandoned", "expired"],
  recommended: ["recommended", "acted", "closed", "abandoned", "expired"],
  acted: ["observing", "closed"], observing: ["closed"],
  closed: [], abandoned: [], expired: [],
};

export async function validateEpisodeV2Transition(previous: EpisodeV2, next: EpisodeV2): Promise<void> {
  await parseEpisodeV2(previous);
  await parseEpisodeV2(next);
  if (canonical(previous) === canonical(next)) return;
  if (previous.id !== next.id || previous.createdAt !== next.createdAt || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new EpisodeV2Error("identity_or_time_changed");
  }
  if (!transitions[previous.status].includes(next.status)) throw new EpisodeV2Error("illegal_transition");
  if (previous.twin?.prediction && canonical(previous.twin.prediction) !== canonical(next.twin?.prediction)) {
    throw new EpisodeV2Error("sealed_prediction_changed");
  }
  if (canonical(previous.historicalInputRefs) !== canonical(next.historicalInputRefs)) {
    throw new EpisodeV2Error("historical_inputs_changed");
  }
}
