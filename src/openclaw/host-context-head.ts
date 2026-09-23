import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { CatalogError, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable, readRecordedMemoryTransaction } from "../canghai/memory-transaction.js";
import { blob, git } from "../canghai/synchronization-plan.js";
import type { IngestDurabilityPort } from "../canghai/ingest.js";
import { isRecord } from "../shared/type-guards.js";
import type { BoundTurnRequest } from "./turn-request.js";
import type { HostContextAuthority, ContextConsumption } from "./host-context-authority.js";
import { contextHistoryLocation, contextHistoryVerificationKey, loadContextHistory, readContextHistory, type StoredContextHistory } from "./host-context-history.js";

type Scope = Pick<BoundTurnRequest, "agentId" | "sessionId" | "sessionKey">;
export type ContextHistoryHead = Readonly<{ archive: StoredContextHistory }>;
const heads = new WeakMap<ContextHistoryHead, { root: string; path: string; bytes: string }>();
function check(value: unknown, category: string): asserts value {
  if (!value) throw new CatalogError(category);
}
function location(archiveRoot: string, scope: Scope): string {
  check(archiveRoot && !archiveRoot.includes("\\") && archiveRoot.split("/").every(part =>
    part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !part.includes(":")), "unsafe_archive_locator");
  check(Object.values(scope).every(value => typeof value === "string" && value.trim()), "host_context_session_mismatch");
  return `${archiveRoot}/sessions/${bytesVersion(canonicalJson(scope)).slice(7)}.json`;
}
async function liveText(root: string, file: string): Promise<string | null> {
  try { return (await readRepositoryBytes(root, file)).toString("utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
function scopeOf(request: Scope): Scope {
  return { agentId: request.agentId, sessionId: request.sessionId, sessionKey: request.sessionKey };
}
function parseHead(bytes: string, archiveRoot: string, scope: Scope) {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new CatalogError("host_context_history_head_invalid"); }
  check(isRecord(value) && ["stella.host-context-head/v1", "stella.host-context-head/v2"].includes(String(value.schemaVersion)) &&
    value.archiveRoot === archiveRoot && typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest) &&
    canonicalJson(value.scope) === canonicalJson(scope) &&
    (value.parentDigest === null || typeof value.parentDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.parentDigest)),
  "host_context_history_head_invalid");
  const head = { schemaVersion: value.schemaVersion, archiveRoot, scope, digest: value.digest, parentDigest: value.parentDigest,
    ...(value.schemaVersion === "stella.host-context-head/v2" ? { business: value.business } : {}) };
  check(bytes === canonicalJson(head), "host_context_history_head_invalid");
  return head;
}

type BusinessCommit = {
  body: {
    schemaVersion: "stella.context-business-commit/v1";
    scope: Scope; runId: string; requestHash: string; draftHash: string; archiveDigest: string;
    revision: string; generationId: string; catalogPath: string; businessRequired: boolean;
    journals: Array<{ operationId: string; path: string; sha256: string; revision: string }>;
  };
  signature: string;
};

/** The signing key is held outside the data repository. A retained draft alone,
 * a copied receipt or a journal written before a failed sync cannot sign this
 * statement that the Core business transaction completed. */
async function verifyBusinessCommit(root: string, value: unknown, snapshot: Record<string, unknown>,
  archive: StoredContextHistory, selectedRevision?: string): Promise<void> {
  const invalid = "host_context_business_commit_invalid";
  check(isRecord(value) && isRecord(value.body) && typeof value.signature === "string", invalid);
  const body = value.body;
  check(verify(null, Buffer.from(canonicalJson(body)), contextHistoryVerificationKey(archive), Buffer.from(value.signature, "base64")), invalid);
  check(body.schemaVersion === "stella.context-business-commit/v1" && isRecord(snapshot.authority) &&
    body.runId === snapshot.authority.runId && body.requestHash === snapshot.authority.requestHash &&
    body.archiveDigest === archive.digest && canonicalJson(body.scope) === canonicalJson({
      agentId: snapshot.agentId, sessionId: snapshot.authority.sessionId, sessionKey: snapshot.authority.sessionKey }), invalid);
  check(typeof body.revision === "string" && /^[a-f0-9]{40}$/.test(body.revision) &&
    typeof body.generationId === "string" && body.generationId && typeof body.catalogPath === "string" && typeof body.businessRequired === "boolean" &&
    Array.isArray(body.journals) && body.journals.length <= 128 && (!body.businessRequired || body.journals.length > 0), invalid);
  const catalogBytes = await blob(root, body.revision, body.catalogPath);
  check(catalogBytes, invalid);
  let catalog: unknown;
  try { catalog = JSON.parse(catalogBytes.toString("utf8")); } catch { throw new CatalogError(invalid); }
  check(isRecord(catalog) && catalog.schemaVersion === "stella.memory-catalog/v1" && catalog.generationId === body.generationId, invalid);
  check(isRecord(snapshot.input) && Array.isArray(snapshot.input.messages), invalid);
  const final = snapshot.input.messages.at(-1);
  check(isRecord(final) && final.role === "assistant" && Array.isArray(final.content), invalid);
  const text: string[] = [];
  for (const part of final.content) {
    check(isRecord(part), invalid);
    if (part.type === "thinking") continue;
    check(part.type === "text" && typeof part.text === "string", invalid);
    text.push(part.text);
  }
  check(text.join("\n").trim() && body.draftHash === bytesVersion(text.join("\n")), invalid);
  const seen = new Set<string>();
  for (const reference of body.journals) {
    check(isRecord(reference) && typeof reference.operationId === "string" &&
      typeof reference.path === "string" && typeof reference.sha256 === "string" && typeof reference.revision === "string" &&
      /^[a-f0-9]{40}$/.test(reference.revision) && !seen.has(reference.operationId), invalid);
    seen.add(reference.operationId);
    const bytes = await blob(root, body.revision, reference.path);
    check(bytes && bytesVersion(bytes) === reference.sha256, invalid);
    check((await git(root, "log", "-1", "--format=%H", body.revision, "--", reference.path)).trim() === reference.revision, invalid);
    check(bytesVersion(await readRepositoryBytes(root, reference.path)) === reference.sha256, invalid);
    if (selectedRevision) {
      const selected = await blob(root, selectedRevision, reference.path);
      check(selected && bytesVersion(selected) === reference.sha256, invalid);
    }
    let journal: unknown;
    try { journal = JSON.parse(bytes.toString("utf8")); } catch { throw new CatalogError(invalid); }
    check(isRecord(journal) && journal.operationId === reference.operationId, invalid);
    if (journal.schemaVersion === "stella.memory-transaction/v1") {
      check(Array.isArray(journal.files) && journal.journalPath === reference.path, invalid);
      const plan = { operationId: journal.operationId, journalPath: journal.journalPath, files: journal.files };
      check(journal.planHash === bytesVersion(canonicalJson(plan)), invalid);
      for (const file of journal.files) {
        check(isRecord(file) && typeof file.path === "string" && typeof file.after === "string" &&
          (file.encoding === undefined || file.encoding === "utf8" || file.encoding === "base64"), invalid);
        const actual = await blob(root, reference.revision, file.path);
        check(actual && actual.equals(Buffer.from(file.after, file.encoding === "base64" ? "base64" : "utf8")), invalid);
      }
    } else {
      check(journal.schemaVersion === "stella.archive-operation/v1" || journal.schemaVersion === "stella.episode-operation/v1", invalid);
    }
  }
}

/** Discover history from the selected durable source revision, never an
 * unsigned runtime cache or whichever archive has the newest timestamp.
 * A handle locates a signed trace; restoreHistory still checks live sources. */
export async function loadContextHistoryHead(input: {
  root: string; archiveRoot: string; revision: string; request: Scope; verificationKey: KeyObject; requireBusinessCommit?: boolean;
}): Promise<ContextHistoryHead | undefined> {
  const scope = scopeOf(input.request);
  const file = location(input.archiveRoot, scope);
  await assertMemoryTransactionReadable(input.root);
  const expected = await blob(input.root, input.revision, file);
  const current = await liveText(input.root, file);
  check(current === (expected?.toString("utf8") ?? null), "host_context_history_head_changed");
  if (current === null) {
    check(await liveText(input.root, file) === null, "host_context_history_head_changed");
    await assertMemoryTransactionReadable(input.root);
    return undefined;
  }
  const value = parseHead(current, input.archiveRoot, scope);
  const archive = await loadContextHistory(input.root, { archiveRoot: input.archiveRoot, digest: value.digest }, input.verificationKey);
  const snapshot = await readContextHistory(archive, input.root);
  check(!input.requireBusinessCommit || value.schemaVersion === "stella.host-context-head/v2", "host_context_business_commit_required");
  if (value.schemaVersion === "stella.host-context-head/v2") await verifyBusinessCommit(input.root, value.business, snapshot, archive, input.revision);
  check(isRecord(snapshot.authority) && snapshot.agentId === scope.agentId &&
    snapshot.authority.sessionId === scope.sessionId && snapshot.authority.sessionKey === scope.sessionKey,
  "host_context_history_scope_mismatch");
  check(value.parentDigest === null || Array.isArray(snapshot.archives) && snapshot.archives.some(parent =>
    isRecord(parent) && parent.archiveRoot === input.archiveRoot && parent.digest === value.parentDigest),
  "host_context_history_parent_missing");
  check(await liveText(input.root, file) === current, "host_context_history_head_changed");
  await assertMemoryTransactionReadable(input.root);
  const head = Object.freeze({ archive });
  heads.set(head, { root: input.root, path: file, bytes: current });
  return head;
}

/** Publish only the exact currently verified archive, after its own durable
 * transaction. A failed head update keeps the normal memory fence and prevents
 * completion publication; an orphan archive is never selected automatically. */
export async function publishContextHistoryHead(authority: HostContextAuthority, consumption: ContextConsumption, input: {
  request: Scope; archive: StoredContextHistory; previous?: ContextHistoryHead;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  signal?: AbortSignal;
}) {
  return publishHead(authority, input, () => authority.historySnapshot(consumption));
}

/** After a business transaction advances generation, reauthorize the signed
 * archive as history. The old model consumption is never reissued. The caller
 * must have completed the business write for this exact request before invoking
 * this function; failed business writes must leave the session head unchanged. */
export async function publishCompletedContextHistoryHead(authority: HostContextAuthority, input: {
  request: BoundTurnRequest; archive: StoredContextHistory; previous?: ContextHistoryHead;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  assertCompletionCurrent(): Promise<void>;
  business: { revision: string; generationId: string; catalogPath: string; draftHash: string; businessRequired: boolean;
    journals: Array<{ operationId: string; path: string }>; signingKey: KeyObject };
  signal?: AbortSignal;
}) {
  await input.assertCompletionCurrent();
  const root = authority.resolver.reader.root;
  check(/^[a-f0-9]{40}$/.test(input.business.revision), "host_context_business_commit_invalid");
  const body: BusinessCommit["body"] = {
    schemaVersion: "stella.context-business-commit/v1", scope: scopeOf(input.request), runId: input.request.runId,
    requestHash: input.request.requestHash, draftHash: input.business.draftHash, archiveDigest: input.archive.digest,
    revision: input.business.revision, generationId: input.business.generationId, catalogPath: input.business.catalogPath, businessRequired: input.business.businessRequired,
    journals: await Promise.all(input.business.journals.map(async entry => ({ ...entry,
      sha256: bytesVersion(await readRepositoryBytes(root, entry.path)),
      revision: (await git(root, "log", "-1", "--format=%H", input.business.revision, "--", entry.path)).trim() }))),
  };
  check(createPublicKey(input.business.signingKey).export({ type: "spki", format: "der" }).equals(
    contextHistoryVerificationKey(input.archive).export({ type: "spki", format: "der" })), "host_context_archive_signer_mismatch");
  const business: BusinessCommit = { body, signature: sign(null, Buffer.from(canonicalJson(body)), input.business.signingKey).toString("base64") };
  return publishHead(authority, { ...input, business }, async () => {
    await input.assertCompletionCurrent();
    await authority.restoreHistory(input.archive);
    const snapshot = await readContextHistory(input.archive, authority.resolver.reader.root);
    check(isRecord(snapshot.authority) && snapshot.authority.runId === input.request.runId &&
      snapshot.authority.requestHash === input.request.requestHash, "host_context_completion_mismatch");
    return snapshot;
  });
}

async function publishHead(authority: HostContextAuthority, input: {
  request: Scope; archive: StoredContextHistory; previous?: ContextHistoryHead;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  signal?: AbortSignal;
  business?: BusinessCommit;
}, captureSnapshot: () => Promise<Record<string, unknown>>) {
  const root = authority.resolver.reader.root;
  const archive = contextHistoryLocation(input.archive);
  // This scope locates the transaction, not its authority. Validate it against
  // the actual consumption inside the owning transaction so an interrupted
  // write can be resumed without bypassing its pending fence.
  const scope = scopeOf(input.request);
  const file = location(archive.archiveRoot, scope);
  const previous = input.previous ? heads.get(input.previous) : undefined;
  check(!input.previous || previous && previous.root === root && previous.path === file, "host_context_history_head_unbound");
  const parentDigest = input.previous?.archive.digest ?? null;
  const before = previous?.bytes ?? null;
  const after = canonicalJson({ schemaVersion: input.business ? "stella.host-context-head/v2" : "stella.host-context-head/v1", archiveRoot: archive.archiveRoot,
    scope, digest: archive.digest, parentDigest, ...(input.business ? { business: input.business } : {}) });
  const operationId = `context_head_${bytesVersion(after).slice(7)}`;
  const validate = async () => {
    const snapshot = await captureSnapshot();
    if (input.business) await verifyBusinessCommit(root, input.business, snapshot, input.archive);
    check(isRecord(snapshot.authority) && snapshot.agentId === scope.agentId &&
      snapshot.authority.sessionId === scope.sessionId && snapshot.authority.sessionKey === scope.sessionKey,
    "host_context_session_mismatch");
    check(bytesVersion(canonicalJson(snapshot)) === archive.digest, "host_context_archive_changed");
    check(parentDigest === null || Array.isArray(snapshot.archives) && snapshot.archives.some(parent =>
      isRecord(parent) && parent.archiveRoot === archive.archiveRoot && parent.digest === parentDigest), "host_context_history_parent_missing");
    await readContextHistory(input.archive, root);
    const current = await liveText(root, file);
    check(current === before || current === after, "host_context_history_head_changed");
  };
  const receipt = await applyMemoryTransaction(root, {
    operationId, journalPath: `${archive.archiveRoot}/operations/${operationId}.json`, files: [{ path: file, before, after }],
  }, {
    validate,
    persist: paths => input.durability.syncCritical(paths, `Publish Stella history ${operationId}`).then(() => undefined),
    confirmPreviouslyCommitted: journal => input.durability.confirmPreviouslyCommitted(journal),
    publishView: validate,
  }, input.signal);
  check(await liveText(root, file) === after, "host_context_history_head_changed");
  await validate();
  return { ...receipt, headPath: file, archiveDigest: archive.digest };
}

/** Resume a recorded head transaction after a process restart. The new run
 * reauthorizes historical data, never reconstructs an expired consumption
 * credential or publishes the old assistant reply. Only this exact pending
 * one-file plan can enter the transaction's owner scope. */
export async function recoverContextHistoryHead(authority: HostContextAuthority, input: {
  request: Scope; revision: string; archiveRoot: string; verificationKey: KeyObject;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  signal?: AbortSignal;
}) {
  const root = authority.resolver.reader.root;
  const scope = scopeOf(input.request), file = location(input.archiveRoot, scope);
  const plan = await readRecordedMemoryTransaction(root);
  check(plan.files.length === 1 && plan.files[0]!.path === file && plan.files[0]!.encoding === undefined,
    "host_context_history_recovery_plan_invalid");
  const change = plan.files[0]!;
  const head = parseHead(change.after, input.archiveRoot, scope);
  const parent = change.before === null ? null : parseHead(change.before, input.archiveRoot, scope);
  check(head.parentDigest === (parent?.digest ?? null), "host_context_history_parent_missing");
  check(plan.operationId === `context_head_${bytesVersion(change.after).slice(7)}` &&
    plan.journalPath === `${input.archiveRoot}/operations/${plan.operationId}.json`, "host_context_history_recovery_plan_invalid");
  // A commit may have succeeded just before the process stopped. Both the
  // selected before and selected after revision are valid recovery anchors.
  const validate = async () => {
    const committed = (await blob(root, input.revision, file))?.toString("utf8") ?? null;
    check(committed === change.before || committed === change.after, "host_context_history_head_changed");
    const archive = await loadContextHistory(root, { archiveRoot: input.archiveRoot, digest: head.digest }, input.verificationKey);
    const snapshot = await readContextHistory(archive, root);
    if (head.schemaVersion === "stella.host-context-head/v2") await verifyBusinessCommit(root, head.business, snapshot, archive, input.revision);
    check(isRecord(snapshot.authority) && snapshot.agentId === scope.agentId &&
      snapshot.authority.sessionId === scope.sessionId && snapshot.authority.sessionKey === scope.sessionKey,
    "host_context_history_scope_mismatch");
    check(head.parentDigest === null || Array.isArray(snapshot.archives) && snapshot.archives.some(ancestor =>
      isRecord(ancestor) && ancestor.archiveRoot === input.archiveRoot && ancestor.digest === head.parentDigest),
    "host_context_history_parent_missing");
    await authority.restoreHistory(archive);
    const current = await liveText(root, file);
    check(current === change.before || current === change.after, "host_context_history_head_changed");
  };
  const receipt = await applyMemoryTransaction(root, plan, {
    validate,
    persist: paths => input.durability.syncCritical(paths, `Recover Stella history ${plan.operationId}`).then(() => undefined),
    confirmPreviouslyCommitted: journal => input.durability.confirmPreviouslyCommitted(journal),
    publishView: validate,
  }, input.signal);
  await validate();
  check(await liveText(root, file) === change.after, "host_context_history_head_changed");
  return { ...receipt, headPath: file, archiveDigest: head.digest };
}
