import { canonicalJson } from "../canghai/content-version.js";
import type { PreparedOutcome } from "./outcome-preparation.js";
import type { EpisodeSnapshot } from "./episode-repository.js";
import type { VersionedRef } from "./episode-v2.js";
import { CatalogError } from "../canghai/catalog-reader.js";
import { renderConsciousnessContext } from "../canghai/context.js";
import type { LoadedConsciousness } from "../canghai/manifest.js";
import type { CortexRoute } from "../routing/router.js";
import type { EvidenceBundle } from "./evidence-bundle.js";
import type { OpenEpisodeCandidate, StellaDataMode } from "./episode-store.js";
import { buildPraxisContextPacket, DEFAULT_MAX_PRAXIS_PACKET_CHARS, renderPraxisContextPacket } from "./packet.js";

export const STELLA_CORE_SYSTEM_CONTEXT =
  "Stella Core is the cognitive runtime for this agent. CangHai is the sole authority for durable personal consciousness and long-term identity facts. Machine-local OpenClaw sessions, SQLite, derived indexes, and prompt caches are not authoritative.";

/** The same fixed compiler is used by preparation and the final-input authority. */
export function renderSelectedCortexContext(input: {
  question: string; loaded: LoadedConsciousness; route: CortexRoute; openEpisodes: OpenEpisodeCandidate[]; dataMode: StellaDataMode;
}): string {
  const { route, loaded } = input;
  if (route.mode === "ordinary") return STELLA_CORE_SYSTEM_CONTEXT;
  if (route.mode === "outcome") return "";
  if (route.mode === "praxis" || route.mode === "deep_praxis") {
    return renderPraxisContextPacket(buildPraxisContextPacket(input.question, route, loaded, input.openEpisodes),
      DEFAULT_MAX_PRAXIS_PACKET_CHARS, input.dataMode);
  }
  const selected = new Set(route.candidateTwinRefs ?? []);
  return renderConsciousnessContext({ ...loaded, bootstrapDocuments: loaded.bootstrapDocuments.filter(document =>
    document.category === "identity" || document.category === "twin" && selected.has(document.ref)) });
}

/** Only these response semantics may be refined by the evidence assessment. */
export function applyQuestionResponse(route: CortexRoute, bundle: EvidenceBundle): CortexRoute {
  if (bundle.suggestedResponseKind === "action_advice" && route.mode !== "praxis" && route.mode !== "deep_praxis") {
    throw new CatalogError("question_response_mode_mismatch");
  }
  return { ...structuredClone(route), responseKind: bundle.suggestedResponseKind, evidenceStatus: bundle.status,
    materialUnknowns: bundle.unresolvedLeads.filter(lead => lead.material).map(lead => lead.question) };
}

export function renderResponseContract(route: CortexRoute): string {
  return `response_contract: ${JSON.stringify({ responseKind: route.responseKind, evidenceStatus: route.evidenceStatus,
    materialUnknowns: route.materialUnknowns })}`;
}


export function applyOutcomeResponse(route: CortexRoute, outcome: PreparedOutcome): CortexRoute {
  if (route.mode !== "outcome") throw new CatalogError("outcome_response_mode_mismatch");
  return { ...structuredClone(route), responseKind: outcome.disposition === "ready" ? "outcome_ack" : "clarification",
    evidenceStatus: outcome.disposition === "ready" ? "sufficient" : "material_unknown",
    materialUnknowns: outcome.disposition === "ready" ? [] : [outcome.question] };
}

export function renderOutcomeContext(selected: EpisodeSnapshot, outcome: PreparedOutcome,
  projection?: { episode: EpisodeSnapshot["episode"]; changeRef: VersionedRef; strategyRef?: VersionedRef }): string {
  if (outcome.disposition === "ready") {
    if (!projection) throw new CatalogError("outcome_transaction_required");
    return canonicalJson({ mode: "outcome", episode: projection.episode, changeRef: projection.changeRef,
      learning: outcome.learning, strategyStatus: projection.strategyRef ? "candidate" : null,
      persistence: "Draft only; completion coordinates atomic persistence before delivery. A candidate strategy is not an adopted owner belief or proven reusable learning." });
  }
  if (projection) throw new CatalogError("outcome_transaction_unexpected");
  return canonicalJson({ mode: "outcome", episode: { id: selected.episode.id, version: selected.version,
    summary: selected.episode.situation.summary }, clarification: outcome.question,
    persistence: "No outcome or learning was written. Do not claim completion or infer any actual action from the request." });
}
