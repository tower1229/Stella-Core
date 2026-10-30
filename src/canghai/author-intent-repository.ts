import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { AuthorIntentError, intentCheck as check, intentDocument, intentId, intentProposalHash, intentVersion,
  parseIntentDocument, parseIntentPublication, type AuthorIntentContent, type AuthorIntentDocument, type IntentPublication, type IntentSource } from "./author-intent-asset.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { readRepositoryBytes } from "./catalog-reader.js";
import { readCheckpointCommittedDocument } from "./checkpoint-committed-document.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable, readRecordedMemoryTransaction, MemoryTransactionError,
  type MemoryTransactionPlan } from "./memory-transaction.js";
import { serializeMemoryTransactionJournal } from "./memory-transaction-journal.js";
const run = promisify(execFile);
export type IntentAccess = "read_current" | "read_history" | "publish" | "replay";
export type AuthorSourceProof = { sourceId: string; version: string; authorId: string; locator: string; excerptHash: string };
export type AuthorIntentPorts = {
  /** Trusted caller-owned, request-bound asset qualification. Not model parameters or owner booleans. */
  assertRequest(action: IntentAccess): Promise<void>;
  /** Trusted source-adapter validation of binding and current use permission, including retained excerpts.
   * read_history may admit an available historical version; read_current must not silently adopt a changed version. */
  assertSources(sources: readonly IntentSource[], action: IntentAccess): Promise<void>;
  currentSourceVersion(sourceId: string): Promise<string>;
  /** A trusted source adapter must attest the exact author/location/version, or return null. */
  verifyAuthor(source: IntentSource): Promise<AuthorSourceProof | null>;
  /** Optional bounded diagnostic/fault-injection seam. A rejected observer never makes an operation succeed. */
  onPhase?(phase: "validated" | "replaced" | "committed" | "before_return"): Promise<void>;
};
type StoredResult = { schemaVersion: "stella.author-intent-publication/v1"; assetId: string; operationId: string;
  proposalHash: string; expectedVersion: string | null; publishedVersion: string; baseRevision: string };
export type IntentPublicationResult = Omit<StoredResult, "schemaVersion" | "baseRevision"> & {
  commitRevision: string; currentVersion: string; replayed: boolean; persistenceStatus: "local_committed" };
export type IntentSnapshot = { document: AuthorIntentDocument; version: string; position: "current" | "historical"; commitRevision: string };
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function relative(value: string): string {
  check(typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value) &&
    value.split("/").every(p => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git"), "unsafe_asset_path");
  return value;
}
function claimRows(content: AuthorIntentContent) {
  return [...(["originalIntent", "established", "candidates"] as const).flatMap(group => content[group].map(statement => ({ group, statement }))),
    ...(content.interpretation ? [{ group: "interpretation", statement: content.interpretation }] : [])];
}
function decodeResult(bytes: string, assetId: string, operationId: string): StoredResult {
  let value: StoredResult;
  try { value = JSON.parse(bytes) as StoredResult; } catch { throw new AuthorIntentError("invalid_publication_record"); }
  check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() ===
    ["schemaVersion", "assetId", "operationId", "proposalHash", "expectedVersion", "publishedVersion", "baseRevision"].sort().join() &&
    value.schemaVersion === "stella.author-intent-publication/v1" && value.assetId === assetId && value.operationId === operationId &&
    intentVersion(value.proposalHash) && (value.expectedVersion === null || intentVersion(value.expectedVersion)) &&
    intentVersion(value.publishedVersion) && typeof value.baseRevision === "string" && /^[a-f0-9]{40}$/.test(value.baseRevision) &&
    canonicalJson(value) === bytes, "invalid_publication_record");
  return value;
}
/** Single logical asset, cooperative repository writer. No Host identity, native lease,
 * remote synchronization, USER/MEMORY updates, or semantic decisions are made here. */
export function createAuthorIntentRepository(options: { root: string; directory: string; assetId: string; ports: AuthorIntentPorts }) {
  const root = path.resolve(options.root), directory = relative(options.directory), assetId = options.assetId;
  check(intentId(assetId), "invalid_asset_id");
  const ports = { ...options.ports };
  check([ports.assertRequest, ports.assertSources, ports.currentSourceVersion, ports.verifyAuthor].every(f => typeof f === "function") &&
    (ports.onPhase === undefined || typeof ports.onPhase === "function"), "qualification_ports_required");
  const currentPath = `${directory}/current.json`, operationPath = (id: string) => `${directory}/operations/${id}.json`;
  const journalPath = (id: string) => `${directory}/operations/${id}.transaction.json`;
  const historicalPath = (version: string) => `${directory}/history/${version.slice(7)}.json`;
  // No inherited Git routing/configuration, credential prompting, hooks, signing, or lazy network fetch.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
  const git = async (...args: string[]) => (await run("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", root, ...args], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 })).stdout;
  const head = async () => (await git("rev-parse", "--verify", "HEAD^{commit}")).trim();
  const active = async (action: IntentAccess, signal?: AbortSignal) => {
    signal?.throwIfAborted(); await ports.assertRequest(action); signal?.throwIfAborted();
  };
  const qualify = async (sources: IntentSource[], action: IntentAccess, signal?: AbortSignal) => {
    await active(action, signal); await ports.assertSources(structuredClone(sources), action); await active(action, signal);
  };
  const phase = async (value: Parameters<NonNullable<AuthorIntentPorts["onPhase"]>>[0]) => {
    try { await ports.onPhase?.(value); } catch { throw new AuthorIntentError("publication_unconfirmed"); }
  };
  const working = async (file: string): Promise<string | null> => {
    try { return (await readRepositoryBytes(root, file)).toString("utf8"); } catch (error) { if (missing(error)) return null; throw error; }
  };
  const blob = async (revision: string, file: string): Promise<string | null> => {
    check(/^[a-f0-9]{40}$/.test(revision), "publication_commit_invalid");
    const entry = await git("ls-tree", "-z", revision, "--", ":(literal)" + file);
    return entry === "" ? null : readCheckpointCommittedDocument(root, revision, file);
  };
  const repository = async () => {
    check(await realpath(root) === root && (await git("rev-parse", "--show-toplevel")).trim() === root, "unsafe_asset_repository");
  };
  function planFor(input: IntentPublication, before: string | null, baseRevision: string): { plan: MemoryTransactionPlan; result: StoredResult } {
    const bytes = canonicalJson(intentDocument(assetId, input)), version = bytesVersion(bytes);
    const result: StoredResult = { schemaVersion: "stella.author-intent-publication/v1", assetId, operationId: input.operationId,
      proposalHash: intentProposalHash(input), expectedVersion: input.expectedVersion, publishedVersion: version, baseRevision };
    return { result, plan: { operationId: input.operationId, journalPath: journalPath(input.operationId), files: [
      { path: currentPath, before, after: bytes }, { path: historicalPath(version), before: null, after: bytes },
      { path: operationPath(input.operationId), before: null, after: canonicalJson(result) },
    ] } };
  }
  function checkPlan(plan: MemoryTransactionPlan, input?: IntentPublication) {
    check(intentId(plan.operationId) && plan.files.length === 3, "invalid_publication_record");
    const recorded = plan.files.find(f => f.path === operationPath(plan.operationId)); check(recorded, "invalid_publication_record");
    const result = decodeResult(recorded.after, assetId, plan.operationId);
    const file = plan.files.find(f => f.path === currentPath); check(file, "invalid_publication_record");
    const document = parseIntentDocument(file.after, assetId);
    const { previousVersion, ...revision } = document.revision;
    const original = parseIntentPublication({ ...revision, content: document.content, expectedVersion: previousVersion });
    check(result.proposalHash === intentProposalHash(original) && result.publishedVersion === bytesVersion(file.after) &&
      result.expectedVersion === (file.before === null ? null : bytesVersion(file.before)) &&
      canonicalJson(planFor(original, file.before, result.baseRevision).plan) === canonicalJson(plan), "invalid_publication_record");
    if (file.before !== null) parseIntentDocument(file.before, assetId);
    if (input) check(result.proposalHash === intentProposalHash(input), "operation_identity_conflict");
    return { result, document, original };
  }
  async function committed(plan: MemoryTransactionPlan): Promise<string | null> {
    const { result } = checkPlan(plan);
    const revisions = (await git("log", "--format=%H", "HEAD", "--", ":(literal)" + plan.journalPath)).trim().split("\n").filter(Boolean);
    if (revisions.length === 0) return null;
    check(revisions.length === 1, "publication_commit_invalid");
    const revision = revisions[0]!, parents = (await git("rev-list", "--parents", "-n", "1", revision)).trim().split(" ");
    check(parents.length === 2 && parents[1] === result.baseRevision, "publication_commit_invalid");
    const paths = [...plan.files.map(f => f.path), plan.journalPath].sort();
    const changed = (await git("diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", result.baseRevision, revision, "--")).split("\0").filter(Boolean).sort();
    check(canonicalJson(paths) === canonicalJson(changed) && await blob(revision, plan.journalPath) === serializeMemoryTransactionJournal(plan), "publication_commit_invalid");
    for (const file of plan.files) check(await blob(result.baseRevision, file.path) === file.before && await blob(revision, file.path) === file.after,
      "publication_commit_invalid");
    return revision;
  }
  async function recorded(id: string): Promise<MemoryTransactionPlan | null> {
    try { return await readRecordedMemoryTransaction(root, id, journalPath(id)); }
    catch (error) { if (missing(error) || error instanceof MemoryTransactionError && error.category === "pending_transaction_not_found") return null; throw error; }
  }
  async function sourceVersions(input: IntentPublication, signal?: AbortSignal) {
    await qualify(input.content.sources, "publish", signal);
    for (const source of input.content.sources) {
      check(await ports.currentSourceVersion(source.id) === source.version, "source_version_conflict"); await active("publish", signal);
      if (input.confirmation === "author_confirmed" && source.role === "author") {
        const proof = await ports.verifyAuthor(structuredClone(source)); await active("publish", signal);
        check(proof !== null && canonicalJson(proof) === canonicalJson({ sourceId: source.id, version: source.version,
          authorId: source.authorId, locator: source.locator, excerptHash: bytesVersion(source.excerpt) }), "author_source_required");
      }
    }
  }
  async function readCurrentVersion(): Promise<string> {
    const bytes = await working(currentPath); check(bytes !== null, "asset_not_found");
    check(await blob(await head(), currentPath) === bytes, "asset_not_committed"); return bytesVersion(bytes);
  }
  async function read(version: string | null, signal?: AbortSignal): Promise<IntentSnapshot> {
    const action = version === null ? "read_current" : "read_history";
    await active(action, signal); await repository(); await assertMemoryTransactionReadable(root);
    const bytes = await working(version === null ? currentPath : historicalPath(version)); check(bytes !== null, "asset_not_found");
    const document = parseIntentDocument(bytes, assetId), actual = bytesVersion(bytes);
    check(version === null || actual === version, "asset_version_mismatch");
    await qualify(document.content.sources, action, signal);
    if (version === null) for (const source of document.content.sources) {
      check(await ports.currentSourceVersion(source.id) === source.version, "source_version_conflict"); await active(action, signal);
    }
    const plan = await recorded(document.revision.operationId); check(plan, "publication_record_missing");
    const stored = checkPlan(plan); check(stored.result.publishedVersion === actual, "asset_version_mismatch");
    const commitRevision = await committed(plan); check(commitRevision, "asset_not_committed");
    for (const file of plan.files.filter(f => f.path !== currentPath || version === null)) {
      check(await working(file.path) === file.after, "asset_incomplete");
    }
    check(await working(plan.journalPath) === serializeMemoryTransactionJournal(plan), "asset_incomplete");
    if (version === null) check(await readCurrentVersion() === actual, "asset_version_mismatch");
    await assertMemoryTransactionReadable(root); await active(action, signal);
    return { document, version: actual, position: version === null ? "current" : "historical", commitRevision };
  }
  return {
    async publish(value: IntentPublication, signal?: AbortSignal): Promise<IntentPublicationResult> {
      const input = parseIntentPublication(value);
      await qualify(input.content.sources, "publish", signal); await repository();
      let plan = await recorded(input.operationId), replayed = plan !== null;
      if (plan) { checkPlan(plan, input); await qualify(input.content.sources, "replay", signal); }
      else {
        await assertMemoryTransactionReadable(root); await sourceVersions(input, signal);
        const before = await working(currentPath);
        check((before === null ? null : bytesVersion(before)) === input.expectedVersion, "asset_version_conflict");
        if (before !== null) {
          // A revision base is authenticated history, not a claim that its sources remain current.
          // Retain historical read qualification; new proposal sources are independently checked above and under the transaction fence.
          const previous = await read(bytesVersion(before), signal);
          check(previous.version === input.expectedVersion && await readCurrentVersion() === input.expectedVersion, "asset_version_conflict");
          check(input.confirmation !== "candidate" || previous.document.revision.confirmation === "candidate", "author_source_required");
          const previousRows = claimRows(previous.document.content), nextRows = claimRows(input.content);
          check(input.replaces.every(id => previousRows.some(row => row.statement.id === id)) && previousRows.every(row =>
            nextRows.some(next => canonicalJson(next) === canonicalJson(row)) || input.replaces.includes(row.statement.id)), "invalid_revision_relation");
        } else check(input.replaces.length === 0, "invalid_revision_relation");
        const status = await git("status", "--porcelain=v1", "--untracked-files=all"); check(status.trim() === "", "asset_repository_dirty");
        plan = planFor(input, before, await head()).plan;
      }
      const fixed = plan, { result } = checkPlan(fixed, input);
      await applyMemoryTransaction(root, fixed, {
        async validate() { await sourceVersions(input, signal); await phase("validated"); await active("publish", signal); },
        async persist(paths) {
          await active("publish", signal); await phase("replaced");
          if (!await committed(fixed)) {
            await sourceVersions(input, signal);
            check(await head() === result.baseRevision, "publication_base_conflict");
            const allowed = new Set([...paths, ".stella-memory-transaction.json", ".stella-memory-transaction.json.lock"]);
            const dirty = (await git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")).split("\0").filter(Boolean);
            check(dirty.every(row => allowed.has(row.slice(3))), "asset_repository_dirty");
            await git("add", "--", ...paths.map(p => ":(literal)" + p));
            const staged = (await git("diff", "--cached", "--name-only", "-z", "--no-renames")).split("\0").filter(Boolean).sort();
            check(canonicalJson(staged) === canonicalJson([...paths].sort()), "publication_commit_invalid");
            await active("publish", signal);
            await git("commit", "--quiet", "-m", `stella author intent ${input.operationId}`, "--", ...paths.map(p => ":(literal)" + p));
          }
          check(await committed(fixed), "publication_commit_invalid"); await phase("committed");
        },
        async confirmPreviouslyCommitted() { await qualify(input.content.sources, "replay", signal); check(await committed(fixed), "publication_commit_invalid"); },
        async publishView() { await active("publish", signal); },
      }, signal);
      const commitRevision = await committed(fixed); check(commitRevision, "publication_commit_invalid");
      const currentVersion = await readCurrentVersion(); await active(replayed ? "replay" : "publish", signal);
      await phase("before_return"); await active(replayed ? "replay" : "publish", signal);
      const { schemaVersion: _schema, baseRevision: _base, ...receipt } = result;
      return { ...receipt, commitRevision, currentVersion, replayed, persistenceStatus: "local_committed" };
    },
    readCurrent: (signal?: AbortSignal) => read(null, signal),
    async readHistorical(version: string, signal?: AbortSignal) {
      check(intentVersion(version), "invalid_asset_version"); return read(version, signal);
    },
  };
}
