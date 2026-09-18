import { CatalogError, validMemoryRef } from "./catalog-reader.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { isRecord } from "../shared/type-guards.js";
import type { EpisodeEvidenceResolver, EvidencePurpose, EventWindow } from "../praxis/episode-evidence.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import type { SourceAccessDescriptor } from "./source-access.js";
import type { SourceAccessExclusions } from "../praxis/evidence-bundle.js";
import {
  parseSemanticRetrievalConfig,
  retrieveCatalogEvidence,
  type SemanticRetrievalConfig,
  type RetrieveCatalogResult,
} from "./semantic-retrieval.js";
import { assertMemoryTransactionReadable, MemoryTransactionError } from "./memory-transaction.js";

export type TemporalScope = "current" | { knownBy: string; eventWindow?: EventWindow };
export type RetrievalCheckpoint = {
  schemaVersion: "stella.retrieval-checkpoint/v1";
  requestId: string;
  revision: string;
  generationId: string;
  questionDigest: string;
  nextIntents: string[];
  selectedRefs: VersionedRef[];
  deniedRefKeys: string[];
  roundsCompleted: number;
  pagesReviewed: number;
  modelRef: string;
  temporalScope: TemporalScope;
  config: SemanticRetrievalConfig;
  exclusions: SourceAccessExclusions;
};
export type PublicRetrieveReport = {
  schemaVersion: "stella.retrieve-report/v1";
  status: "complete" | "resource_exhausted" | "coverage_gap" | "not_ready" | "fault";
  requestId: string;
  generationId: string;
  category?: string;
  pendingReassessmentCount?: number;
  selectedCount?: number;
  roundsCompleted?: number;
  pagesReviewed?: number;
};
type Coverage = Extract<RetrieveCatalogResult, { status: "complete" }>["coverage"];
type RetrievalOutcome =
  | { status: "complete"; refs: VersionedRef[]; exclusions: SourceAccessExclusions; coverage: Coverage; requestId: string; generationId: string }
  | { status: "resource_exhausted"; checkpoint: RetrievalCheckpoint; refs: VersionedRef[]; exclusions: SourceAccessExclusions; coverage: Coverage; requestId: string; generationId: string }
  | { status: "coverage_gap"; requestId: string; generationId: string; refs: []; exclusions: SourceAccessExclusions }
  | { status: "not_ready"; category: "index_not_ready"; requestId: string; generationId: string }
  | { status: "fault"; category: "source_unavailable" | "generation_mismatch" | "invalid_retrieve_input"; requestId: string; generationId: string };

export type RetrieveResult = RetrievalOutcome & {
  pendingReassessment?: { parentOperationId: string; pendingIds: string[] };
};

const check: (value: unknown, category: string) => asserts value = (value, category) => {
  if (!value) throw new CatalogError(category);
};
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function resolveTemporalPurpose(
  base: Omit<EvidencePurpose, "evidenceCutoff" | "eventWindow">,
  temporalScope: TemporalScope,
  now = new Date().toISOString(),
): EvidencePurpose {
  if (temporalScope === "current") {
    check(timestamp(now), "invalid_temporal_scope");
    return { ...base, evidenceCutoff: now };
  }
  check(isRecord(temporalScope) && timestamp(temporalScope.knownBy), "invalid_temporal_scope");
  const eventWindow = temporalScope.eventWindow;
  if (eventWindow !== undefined) {
    check(isRecord(eventWindow) && timestamp(eventWindow.to), "invalid_temporal_scope");
    check(eventWindow.from == null || timestamp(eventWindow.from), "invalid_temporal_scope");
    check(eventWindow.from == null || Date.parse(eventWindow.from) <= Date.parse(eventWindow.to), "invalid_temporal_scope");
  }
  return {
    ...base,
    evidenceCutoff: temporalScope.knownBy,
    ...(eventWindow ? { eventWindow: { ...(eventWindow.from === undefined ? {} : { from: eventWindow.from }), to: eventWindow.to } } : {}),
  };
}

export function parseRetrievalCheckpoint(value: unknown): RetrievalCheckpoint {
  check(isRecord(value) && value.schemaVersion === "stella.retrieval-checkpoint/v1", "invalid_retrieval_checkpoint");
  check(typeof value.requestId === "string" && value.requestId.trim(), "invalid_retrieval_checkpoint");
  check(typeof value.revision === "string" && /^[a-f0-9]{40}$/.test(value.revision), "invalid_retrieval_checkpoint");
  check(typeof value.generationId === "string" && value.generationId.trim(), "invalid_retrieval_checkpoint");
  check(typeof value.questionDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.questionDigest), "invalid_retrieval_checkpoint");
  check(Array.isArray(value.nextIntents) && value.nextIntents.every(item => typeof item === "string" && item.trim() && item.length <= 2000), "invalid_retrieval_checkpoint");
  check(Array.isArray(value.selectedRefs) && value.selectedRefs.every(validMemoryRef), "invalid_retrieval_checkpoint");
  check(Array.isArray(value.deniedRefKeys) && value.deniedRefKeys.every(item => typeof item === "string"), "invalid_retrieval_checkpoint");
  check(Number.isSafeInteger(value.roundsCompleted) && Number(value.roundsCompleted) >= 0, "invalid_retrieval_checkpoint");
  check(Number.isSafeInteger(value.pagesReviewed) && Number(value.pagesReviewed) >= 0, "invalid_retrieval_checkpoint");
  check(typeof value.modelRef === "string" && value.modelRef.includes("/"), "invalid_retrieval_checkpoint");
  check(value.temporalScope === "current" || (isRecord(value.temporalScope) && timestamp(value.temporalScope.knownBy)), "invalid_retrieval_checkpoint");
  parseSemanticRetrievalConfig(value.config);
  check(isRecord(value.exclusions), "invalid_retrieval_checkpoint");
  return structuredClone(value) as RetrievalCheckpoint;
}

function questionDigest(question: string): string {
  return bytesVersion(question);
}

function buildCheckpoint(input: {
  requestId: string; revision: string; generationId: string; question: string; modelRef: string;
  temporalScope: TemporalScope; config: SemanticRetrievalConfig; result: Extract<RetrieveCatalogResult, { status: "resource_exhausted" }>;
}): RetrievalCheckpoint {
  return parseRetrievalCheckpoint({
    schemaVersion: "stella.retrieval-checkpoint/v1",
    requestId: input.requestId,
    revision: input.revision,
    generationId: input.generationId,
    questionDigest: questionDigest(input.question),
    nextIntents: input.result.nextIntents,
    selectedRefs: input.result.refs,
    deniedRefKeys: input.result.deniedRefKeys,
    roundsCompleted: input.result.coverage.rounds,
    pagesReviewed: input.result.coverage.pagesReviewed,
    modelRef: input.modelRef,
    temporalScope: input.temporalScope,
    config: input.config,
    exclusions: input.result.exclusions,
  });
}

export function toPublicRetrieveReport(result: RetrieveResult): PublicRetrieveReport {
  const base = {
    schemaVersion: "stella.retrieve-report/v1" as const,
    status: result.status,
    requestId: result.requestId,
    generationId: result.generationId,
    ...(result.pendingReassessment ? { pendingReassessmentCount: result.pendingReassessment.pendingIds.length } : {}),
  };
  if (result.status === "complete") {
    return { ...base, selectedCount: result.refs.length, roundsCompleted: result.coverage.rounds, pagesReviewed: result.coverage.pagesReviewed };
  }
  if (result.status === "resource_exhausted") {
    return { ...base, selectedCount: result.refs.length, roundsCompleted: result.checkpoint.roundsCompleted, pagesReviewed: result.checkpoint.pagesReviewed };
  }
  if (result.status === "coverage_gap") return { ...base, selectedCount: 0 };
  return { ...base, category: result.category };
}

type RetrieveWiring = {
  requestId: string;
  question: string;
  revision: string;
  generationId: string;
  temporalScope: TemporalScope;
  purpose: EvidencePurpose;
  requiredCapabilities: string[];
  resourceBudget: { config: SemanticRetrievalConfig; abortSignal?: AbortSignal };
  resolver: EpisodeEvidenceResolver;
  descriptors: SourceAccessDescriptor[];
  ownerId: string;
  modelRef: string;
  assertProcessingCurrent(): Promise<void>;
  complete(input: { prompt: string; maxTokens: number }): Promise<{ text: string; provider?: string; model?: string }>;
  readiness?: () => Promise<{ status: "ready" } | { status: "not_ready"; category: "index_not_ready" } | { status: "fault"; category: "source_unavailable" }>;
  checkpoint?: RetrievalCheckpoint;
};

/** Public retrieve seam: temporal scope, failure classes, and continuable budget exhaustion. */
export async function retrieve(input: RetrieveWiring): Promise<RetrieveResult> {
  const result = await retrieveCurrentEvidence(input);
  const pendingReassessment = input.resolver.reader.reassessmentProgress;
  return pendingReassessment ? { ...result, pendingReassessment } : result;
}

async function retrieveCurrentEvidence(input: RetrieveWiring): Promise<RetrievalOutcome> {
  check(input.requestId.trim() && input.question.trim() && /^[a-f0-9]{40}$/.test(input.revision), "invalid_retrieve_input");
  check(input.generationId === input.resolver.reader.catalog.generationId, "generation_mismatch");
  check(input.requiredCapabilities.includes("semantic_retrieval"), "invalid_retrieve_input");
  const expected = resolveTemporalPurpose({
    readPurpose: input.purpose.readPurpose,
    derivePurpose: input.purpose.derivePurpose,
    deliveryScope: input.purpose.deliveryScope,
    trustedAdapters: input.purpose.trustedAdapters,
    ...(input.purpose.sourceAccess ? { sourceAccess: input.purpose.sourceAccess } : {}),
  }, input.temporalScope, input.purpose.evidenceCutoff);
  check(expected.evidenceCutoff === input.purpose.evidenceCutoff, "invalid_temporal_scope");
  check(canonicalJson(expected.eventWindow ?? null) === canonicalJson(input.purpose.eventWindow ?? null), "invalid_temporal_scope");
  check(input.resolver.purpose.evidenceCutoff === input.purpose.evidenceCutoff, "invalid_temporal_scope");
  check(canonicalJson(input.resolver.purpose.eventWindow ?? null) === canonicalJson(input.purpose.eventWindow ?? null), "invalid_temporal_scope");

  if (input.readiness) {
    const ready = await input.readiness();
    if (ready.status === "not_ready") return { status: "not_ready", category: ready.category, requestId: input.requestId, generationId: input.generationId };
    if (ready.status === "fault") return { status: "fault", category: ready.category, requestId: input.requestId, generationId: input.generationId };
  } else {
    try {
      await assertMemoryTransactionReadable(input.resolver.reader.root);
      await input.resolver.reader.assertCurrent();
    } catch (error) {
      if (error instanceof MemoryTransactionError && ["memory_transaction_pending", "source_synchronization_pending"].includes(error.category)) {
        return { status: "not_ready", category: "index_not_ready", requestId: input.requestId, generationId: input.generationId };
      }
      if (error instanceof CatalogError && error.category === "source_unavailable") {
        return { status: "fault", category: "source_unavailable", requestId: input.requestId, generationId: input.generationId };
      }
      if (error instanceof CatalogError && error.category === "stale_generation") {
        return { status: "fault", category: "generation_mismatch", requestId: input.requestId, generationId: input.generationId };
      }
      throw error;
    }
  }

  const eligible = input.resolver.reader.catalog.evidence.filter(entry => entry.status === "current" && input.resolver.reader.eligible(entry));
  if (eligible.length === 0) {
    return { status: "coverage_gap", requestId: input.requestId, generationId: input.generationId, refs: [], exclusions: {} };
  }

  const config = parseSemanticRetrievalConfig(input.resourceBudget.config);
  const checkpoint = input.checkpoint ? parseRetrievalCheckpoint(input.checkpoint) : undefined;
  if (checkpoint) {
    check(checkpoint.requestId === input.requestId && checkpoint.revision === input.revision, "invalid_retrieval_checkpoint");
    check(checkpoint.generationId === input.generationId && checkpoint.modelRef === input.modelRef, "invalid_retrieval_checkpoint");
    check(checkpoint.questionDigest === questionDigest(input.question), "invalid_retrieval_checkpoint");
    check(canonicalJson(checkpoint.temporalScope) === canonicalJson(input.temporalScope), "invalid_retrieval_checkpoint");
    check(checkpoint.config.pageSize === config.pageSize && checkpoint.config.maxSelected === config.maxSelected &&
      checkpoint.config.maxOriginalChars === config.maxOriginalChars, "invalid_retrieval_checkpoint");
    check(config.maxRounds > checkpoint.roundsCompleted, "invalid_retrieval_checkpoint");
  }

  await input.assertProcessingCurrent();
  let result: RetrieveCatalogResult;
  try {
    result = await retrieveCatalogEvidence({
      question: input.question,
      resolver: input.resolver,
      descriptors: input.descriptors,
      modelRef: input.modelRef,
      ownerId: input.ownerId,
      config,
      assertProcessingCurrent: input.assertProcessingCurrent,
      complete: input.complete,
      abortSignal: input.resourceBudget.abortSignal,
      ...(checkpoint ? {
        resume: {
          intents: checkpoint.nextIntents,
          selectedRefs: checkpoint.selectedRefs,
          deniedRefKeys: checkpoint.deniedRefKeys,
          roundsCompleted: checkpoint.roundsCompleted,
          pagesReviewed: checkpoint.pagesReviewed,
          exclusions: checkpoint.exclusions,
        },
      } : {}),
    });
  } catch (error) {
    if (error instanceof MemoryTransactionError && ["memory_transaction_pending", "source_synchronization_pending"].includes(error.category)) {
      return { status: "not_ready", category: "index_not_ready", requestId: input.requestId, generationId: input.generationId };
    }
    if (error instanceof CatalogError && error.category === "stale_generation") {
      return { status: "fault", category: "generation_mismatch", requestId: input.requestId, generationId: input.generationId };
    }
    if (error instanceof CatalogError && error.category === "source_unavailable") {
      return { status: "fault", category: "source_unavailable", requestId: input.requestId, generationId: input.generationId };
    }
    throw error;
  }

  if (result.status === "resource_exhausted") {
    return {
      status: "resource_exhausted",
      requestId: input.requestId,
      generationId: input.generationId,
      refs: result.refs,
      exclusions: result.exclusions,
      coverage: result.coverage,
      checkpoint: buildCheckpoint({
        requestId: input.requestId, revision: input.revision, generationId: input.generationId,
        question: input.question, modelRef: input.modelRef, temporalScope: input.temporalScope, config, result,
      }),
    };
  }
  if (result.coverage.descriptorCount === 0) {
    return { status: "coverage_gap", requestId: input.requestId, generationId: input.generationId, refs: [], exclusions: result.exclusions };
  }
  return {
    status: "complete",
    requestId: input.requestId,
    generationId: input.generationId,
    refs: result.refs,
    exclusions: result.exclusions,
    coverage: result.coverage,
  };
}

export async function resumeRetrieve(input: Omit<RetrieveWiring, "requestId" | "revision" | "generationId" | "temporalScope" | "requiredCapabilities" | "resourceBudget" | "checkpoint" | "readiness"> & {
  checkpoint: RetrievalCheckpoint;
  /** Continuation budget; maxRounds must exceed checkpoint.roundsCompleted. */
  resourceBudget: { config: SemanticRetrievalConfig; abortSignal?: AbortSignal };
}): Promise<RetrieveResult> {
  const checkpoint = parseRetrievalCheckpoint(input.checkpoint);
  await input.assertProcessingCurrent();
  await input.resolver.reader.assertCurrent();
  check(checkpoint.generationId === input.resolver.reader.catalog.generationId, "generation_mismatch");
  for (const ref of checkpoint.selectedRefs) await input.resolver.readEvidence(ref);
  return retrieve({
    ...input,
    requestId: checkpoint.requestId,
    revision: checkpoint.revision,
    generationId: checkpoint.generationId,
    temporalScope: checkpoint.temporalScope,
    requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: input.resourceBudget,
    checkpoint,
  });
}
