import { canonicalJson, objectVersion } from "../canghai/content-version.js";
import { stableId } from "../canghai/host-input-archive.js";
import { parseEvidenceBundle, type EvidenceBundle } from "./evidence-bundle.js";
import type { PreparedOutcome } from "./outcome-preparation.js";

export function createOutcomeEvidenceBundle(input: {
  operationId: string; requestId: string; revision: string; generationId: string;
  prepared: Extract<PreparedOutcome, { disposition: "ready" }>;
}): EvidenceBundle {
  const { episode, learning } = input.prepared;
  const scope = `Outcome acknowledgement for Episode ${episode.id}; not a full-repository retrieval or a general relationship judgment`;
  const claims: EvidenceBundle["claims"] = [
    { id: "actual", statement: episode.actual!.action, kind: "fact", support: episode.actual!.evidenceRefs, counter: [], unresolved: [], scope },
    ...[episode.outcome!.result, ...episode.outcome!.observations].map((statement, index) => ({
      id: `outcome-${index}`, statement, kind: "fact" as const, support: episode.outcome!.evidenceRefs, counter: [], unresolved: [], scope,
    })),
  ];
  if (learning.strategy) claims.push({ id: "candidate-strategy", statement: learning.strategy.statement, kind: "proposal",
    support: learning.evidenceRefs, counter: [], unresolved: ["Candidate only; owner adoption and later usefulness are not established"],
    scope: canonicalJson(learning.strategy.scope) });
  const bundle = { schemaVersion: "stella.evidence-bundle/v1" as const, id: stableId("bundle", input.operationId),
    requestId: input.requestId, revision: input.revision, generationId: input.generationId, status: "sufficient" as const,
    claims, readEvidenceRefs: input.prepared.readEvidenceRefs, searchedCoverageRefs: input.prepared.searchedCoverageRefs,
    unresolvedLeads: [], stopping: { reason: "Structured model associated the selected Episode outcome; independent original-action and original-outcome verification passed. Scope is outcome acknowledgement only.",
      modelRef: input.prepared.modelRef, promptVersion: input.prepared.promptVersion }, suggestedResponseKind: "outcome_ack" as const };
  return parseEvidenceBundle({ ...bundle, version: objectVersion(bundle) });
}
