import { canonicalJson } from "../canghai/content-version.js";
import { EpisodeRepository, type EpisodeSnapshot } from "./episode-repository.js";
import { EpisodeEvidenceResolver } from "./episode-evidence.js";
import { EpisodeV2Error, type EpisodeV2, type VersionedRef } from "./episode-v2.js";
import type { PraxisMemory } from "./episode-store.js";

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EpisodeV2Error("operation_cancelled");
}

/** A routing reference is a locator for an immutable version, not the object's identity. */
export function memoryRoutingRef(ref: VersionedRef, locator: string): string {
  return `path:${locator}#object:${encodeURIComponent(ref.id)}@${ref.version}`;
}

export class PraxisRuntimeMemory {
  readonly #episodeSelections = new Map<string, EpisodeSnapshot>();
  readonly #learningSelections = new Map<string, VersionedRef>();

  constructor(readonly repository: EpisodeRepository, readonly evidence: EpisodeEvidenceResolver) {}

  async listMemory(): Promise<PraxisMemory & { generationId: string }> {
    const reader = this.evidence.reader;
    await reader.assertCurrent();
    this.#episodeSelections.clear();
    this.#learningSelections.clear();
    const openEpisodes: PraxisMemory["openEpisodes"] = [];
    for (const snapshot of await this.repository.listEligible()) {
      const episode = snapshot.episode;
      if (episode.status === "closed" || episode.status === "abandoned" || episode.status === "expired") continue;
      const ref = memoryRoutingRef({ id: episode.id, version: snapshot.version },
        this.repository.historicalPath(episode.id, snapshot.version));
      this.#episodeSelections.set(ref, snapshot);
      openEpisodes.push({ ref, status: episode.status, summary: episode.situation.summary,
        domains: episode.situation.domains, recoveryPriority: episode.recoveryPriority,
        ...(episode.twin?.prediction ? { prediction: episode.twin.prediction } : {}),
        ...(episode.decision ? { recommendation: episode.decision.recommendation } : {}),
      });
    }
    const learningItems: PraxisMemory["learningItems"] = [];
    for (const entry of reader.catalog.understandings) {
      if (entry.status !== "current" || !reader.eligible(entry)) continue;
      const object = await reader.read(entry, "understandings");
      if (object.schemaVersion !== "stella.understanding/v1" ||
          !["owner_statement", "hypothesis", "strategy", "intent"].includes(String(object.kind)) ||
          !["candidate", "active", "contested", "retired"].includes(String(object.status))) {
        throw new EpisodeV2Error("understanding_adapter_unavailable_or_invalid");
      }
      if (object.kind !== "strategy" || object.status === "candidate" || object.status === "retired") continue;
      await this.evidence.resolveLearning(entry);
      const ref = memoryRoutingRef(entry, entry.locator.path);
      const scope = object.scope as { domains: string[] };
      if (!scope.domains.every((domain) => typeof domain === "string" && domain.trim())) {
        throw new EpisodeV2Error("invalid_learning_scope");
      }
      this.#learningSelections.set(ref, { id: entry.id, version: entry.version });
      learningItems.push({ ref, domains: scope.domains, content: canonicalJson({
        statement: object.statement, status: object.status, scope: object.scope,
        supportRefs: object.supportRefs, counterRefs: object.counterRefs,
      }) });
    }
    await reader.assertCurrent();
    return { openEpisodes, learningItems, generationId: reader.catalog.generationId };
  }

  async selectedEpisode(ref: string): Promise<EpisodeSnapshot> {
    await this.evidence.reader.assertCurrent();
    const selected = this.#episodeSelections.get(ref);
    if (!selected) throw new EpisodeV2Error("unavailable_episode_selection");
    const current = await this.repository.read(selected.episode.id);
    if (current.version !== selected.version || !await this.evidence.isCurrentlyEligible(current.episode)) {
      throw new EpisodeV2Error("stale_episode_selection");
    }
    return current;
  }

  async selectedLearning(ref: string): Promise<VersionedRef> {
    await this.evidence.reader.assertCurrent();
    const selected = this.#learningSelections.get(ref);
    if (!selected) throw new EpisodeV2Error("unavailable_learning_selection");
    await this.evidence.resolveLearning(selected);
    return { ...selected };
  }

  async recommend(input: { operationId: string; episode: EpisodeV2;
    decision: NonNullable<EpisodeV2["decision"]>; recordedAt: string; abortSignal?: AbortSignal }): Promise<EpisodeSnapshot> {
    abortIfRequested(input.abortSignal);
    if (input.episode.status !== "open") throw new EpisodeV2Error("initial_advice_requires_open_episode");
    const episode = JSON.parse(canonicalJson(input.episode)) as EpisodeV2;
    const decision = JSON.parse(canonicalJson(input.decision)) as NonNullable<EpisodeV2["decision"]>;
    const opened = await this.repository.apply({ operationId: `${input.operationId}-open`, expectedVersion: null, episode, abortSignal: input.abortSignal });
    abortIfRequested(input.abortSignal);
    const recommended = await this.repository.apply({ operationId: `${input.operationId}-recommend`, expectedVersion: opened.version,
      episode: { ...episode, status: "recommended", updatedAt: input.recordedAt, decision }, abortSignal: input.abortSignal });
    abortIfRequested(input.abortSignal);
    return recommended;
  }

  async applyOutcome(input: { operationId: string; expectedVersion: string; next: EpisodeV2; abortSignal?: AbortSignal }): Promise<EpisodeSnapshot> {
    abortIfRequested(input.abortSignal);
    const result = await this.repository.apply({ operationId: input.operationId, expectedVersion: input.expectedVersion, episode: input.next, abortSignal: input.abortSignal });
    abortIfRequested(input.abortSignal);
    return result;
  }
}
