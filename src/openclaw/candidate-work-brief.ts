import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { AuthorIntentError, intentId, intentVersion, type AuthorIntentContent, type IntentSource } from "../canghai/author-intent-asset.js";
import { createAuthorIntentRepository, type IntentSnapshot } from "../canghai/author-intent-repository.js";
import { readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { CANDIDATE_PARAMETERS, parseProposal, type Proposal } from "./work-brief-proposal.js";

export const WORK_BRIEF_TOOL = "stella_work_brief";
export const DRAFT_MARKER = ".stella-candidate-drafts.json";
export const DRAFT_MARKER_BYTES = canonicalJson({ schemaVersion: "stella.candidate-drafts/v1", scope: "synthetic_debug" });
const id = () => Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,99}$" });
export const WORK_BRIEF_PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("read"), Type.Literal("save")]), briefId: id(),
  operationId: Type.Optional(id()),
  expectedVersion: Type.Optional(Type.Union([Type.Null(), Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })])),
  proposal: Type.Optional(CANDIDATE_PARAMETERS),
}, { additionalProperties: false });
type Input = { action: "read"; briefId: string } | {
  action: "save"; briefId: string; operationId: string; expectedVersion: string | null; proposal: Proposal;
};
export class WorkBriefError extends Error {
  constructor(readonly category: string) { super(category); }
}
function check(value: unknown, code: string): asserts value { if (!value) throw new WorkBriefError(code); }
export function validDraftsRoot(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) &&
    path.resolve(value) === value && !/[\\\x00-\x1f\x7f]/.test(value);
}
function parseInput(value: unknown): Input {
  check(isRecord(value) && Object.getPrototypeOf(value) === Object.prototype && intentId(value.briefId), "work_brief_arguments_invalid");
  const keys = value.action === "read" ? ["action", "briefId"] : ["action", "briefId", "operationId", "expectedVersion", "proposal"];
  check(Object.keys(value).sort().join() === keys.sort().join(), "work_brief_arguments_invalid");
  if (value.action === "read") return { action: "read", briefId: value.briefId };
  check(value.action === "save" && intentId(value.operationId) &&
    (value.expectedVersion === null || intentVersion(value.expectedVersion)), "work_brief_arguments_invalid");
  return { action: "save", briefId: value.briefId, operationId: value.operationId,
    expectedVersion: value.expectedVersion, proposal: parseProposal(value.proposal) };
}
function content(briefId: string, proposal: Proposal): AuthorIntentContent {
  const excerpt = canonicalJson(proposal);
  check(excerpt.length <= 16_384, "work_brief_too_large");
  return {
    topic: proposal.topic, scope: "Unconfirmed synthetic work brief; no author authority or long-term memory",
    nonGoals: ["Author confirmation", "Formal publication", "Long-term personal memory"],
    sources: [{ id: "proposal", version: bytesVersion(excerpt), authorId: "unverified-proposal", role: "assistant",
      locator: `candidate:${briefId}`, purpose: "support", excerpt }],
    originalIntent: [], established: [], interpretation: null, authorityConflicts: [],
    candidates: [{ id: "interpretation_candidate", text: proposal.interpretation, sourceIds: ["proposal"] },
      ...proposal.proposedPremises.map((text, index) => ({ id: `premise_${index}`, text, sourceIds: ["proposal"] }))],
    unresolved: proposal.openQuestions,
  };
}
const labels = { status: "candidate", authorConfirmation: false, publisher: false,
  evidenceStatus: "model_supplied_unverified", storageScope: "synthetic_debug", longTermMemory: false } as const;

/** A request-scoped adapter for a separately configured, synthetic-only Git store.
 * Its source is ONLY the enclosed assistant proposal, never an external author.
 * References are opaque strings: no source, URL, transcript or user-file lookup.
 * The operator selects this store; the caller guard restricts its use, not author qualification. */
export async function executeWorkBrief(root: string, value: unknown, assertCurrent: () => void, signal?: AbortSignal) {
  const input = parseInput(value);
  check(validDraftsRoot(root), "work_brief_store_invalid");
  const guard = () => { assertCurrent(); signal?.throwIfAborted(); };
  const assertStore = async () => {
    guard();
    check(await realpath(root) === root, "work_brief_store_invalid");
    const git = await lstat(path.join(root, ".git"));
    check(git.isDirectory() && !git.isSymbolicLink(), "work_brief_store_invalid");
    check((await readRepositoryBytes(root, DRAFT_MARKER)).toString("utf8") === DRAFT_MARKER_BYTES, "work_brief_store_invalid");
    guard();
  };
  // New map for every invocation; no session/latest permission or cross-request grant cache.
  let validatedProposalVersion: string | undefined;
  const qualify = (sources: readonly IntentSource[]) => {
    guard(); check(sources.length === 1, "work_brief_source_invalid");
    const source = sources[0]!;
    let proposal: Proposal;
    try { proposal = parseProposal(JSON.parse(source.excerpt)); } catch { throw new WorkBriefError("work_brief_source_invalid"); }
    check(canonicalJson(content(input.briefId, proposal).sources) === canonicalJson(sources), "work_brief_source_invalid");
    validatedProposalVersion = source.version;
  };
  const repository = createAuthorIntentRepository({ root, directory: `drafts/${input.briefId}`, assetId: input.briefId, ports: {
    assertRequest: assertStore,
    async assertSources(sources) { qualify(sources); },
    async currentSourceVersion(sourceId) {
      guard(); check(sourceId === "proposal" && validatedProposalVersion, "work_brief_source_invalid");
      return validatedProposalVersion;
    },
    async verifyAuthor() { return null; },
  } });
  const decode = (snapshot: IntentSnapshot) => {
    check(snapshot.document.revision.confirmation === "candidate", "work_brief_not_candidate");
    const proposal = parseProposal(JSON.parse(snapshot.document.content.sources[0]!.excerpt));
    check(canonicalJson(snapshot.document.content) === canonicalJson(content(input.briefId, proposal)), "work_brief_source_invalid");
    return proposal;
  };
  if (input.action === "read") {
    const snapshot = await repository.readCurrent(signal), proposal = decode(snapshot); guard();
    return { ...labels, briefId: input.briefId, saved: true, version: snapshot.version,
      commitRevision: snapshot.commitRevision, proposal, persistenceStatus: "local_committed" };
  }
  const previous = input.expectedVersion === null ? null : await repository.readHistorical(input.expectedVersion, signal);
  if (previous) decode(previous);
  const receipt = await repository.publish({ operationId: input.operationId, expectedVersion: input.expectedVersion,
    confirmation: "candidate", triggerSourceId: null, content: content(input.briefId, input.proposal),
    replaces: previous?.document.content.candidates.map(row => row.id) ?? [], reason: "Explicit save of an unconfirmed work brief" }, signal);
  guard();
  return { ...labels, briefId: input.briefId, saved: true, ...receipt,
    isCurrent: receipt.publishedVersion === receipt.currentVersion };
}
export function workBriefFailure(error: unknown): string {
  if (error instanceof WorkBriefError || error instanceof AuthorIntentError) return error.category;
  if (error instanceof Error && "category" in error && typeof error.category === "string") return error.category;
  return "work_brief_operation_failed";
}
