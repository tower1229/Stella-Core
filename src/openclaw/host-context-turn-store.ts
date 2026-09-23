import type { HarnessContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { IngestDurabilityPort } from "../canghai/ingest.js";
import { CatalogError, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable } from "../canghai/memory-transaction.js";

export type HostContextTurn = Parameters<NonNullable<HarnessContextEngine["commitTurn"]>>[0];
export type CommitHostContextTurn = NonNullable<HarnessContextEngine["commitTurn"]>;

function check(value: unknown, category: string): asserts value {
  if (!value) throw new CatalogError(category);
}

/** Retain the Host's accepted raw transcript range, never a model-consumption
 * credential. The existing memory transaction atomically publishes the range
 * and its advancement key. A restarted Host may retry older turns in this same
 * session before processing the new request; this store does not require the
 * older request's expired model authority. */
export function createHostContextTurnStore(options: {
  root: string;
  archiveRoot: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  validate(): Promise<void>;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
}): CommitHostContextTurn {
  const { root, archiveRoot, agentId, sessionId, sessionKey, validate, durability } = options;
  check(archiveRoot && !archiveRoot.includes("\\") && archiveRoot.split("/").every(part =>
    part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !part.includes(":")), "unsafe_archive_locator");
  return async params => {
    // Runtime contexts contain callbacks and are deliberately not archive data.
    const snapshot = structuredClone({ advancementKey: params.advancementKey, admission: params.admission,
      terminal: params.terminal, messages: params.messages, isHeartbeat: params.isHeartbeat ?? false });
    check(params.sessionId === sessionId && params.sessionKey === sessionKey, "host_context_session_mismatch");
    const { admission, terminal } = snapshot;
    check(typeof snapshot.advancementKey === "string" && snapshot.advancementKey.length > 0 &&
      snapshot.advancementKey.length <= 4096, "host_context_advancement_invalid");
    for (const anchor of [admission, terminal]) {
      check(anchor.agentId === agentId && anchor.sessionId === sessionId && anchor.sessionKey === sessionKey &&
        typeof anchor.entryId === "string" && anchor.entryId.length > 0 &&
        typeof anchor.storePath === "string" && anchor.storePath.length > 0 &&
        typeof anchor.generation === "string" && anchor.generation.length > 0 &&
        Number.isSafeInteger(anchor.rawSeq) && anchor.rawSeq >= 0 &&
        Number.isSafeInteger(anchor.activeMessagePosition) && anchor.activeMessagePosition >= 0,
      "host_context_transcript_anchor_invalid");
    }
    check(admission.role === "user" && typeof admission.logicalTurnId === "string" && admission.logicalTurnId.length > 0 &&
      admission.storePath === terminal.storePath && admission.generation === terminal.generation &&
      admission.rawSeq <= terminal.rawSeq && admission.activeMessagePosition <= terminal.activeMessagePosition &&
      snapshot.messages.length > 0 && snapshot.messages[0]?.role === "user", "host_context_transcript_range_invalid");
    const bytes = canonicalJson({ schemaVersion: "stella.host-context-turn/v1", ...snapshot });
    check(Buffer.byteLength(bytes) <= 2 * 1024 * 1024, "host_context_archive_budget_exhausted");
    const key = bytesVersion(canonicalJson({ agentId, sessionId, sessionKey, advancementKey: snapshot.advancementKey })).slice(7);
    const operationId = `context_turn_${key}`;
    const file = `${archiveRoot}/turns/${key}.json`;
    const journalPath = `${archiveRoot}/operations/${operationId}.json`;
    // Validate inside the transaction's ownership scope so a retry can inspect
    // its own unfinished write. Revalidate completed-key replay below as well.
    const receipt = await applyMemoryTransaction(root, { operationId, journalPath,
      files: [{ path: file, before: null, after: bytes }] }, {
      validate,
      persist: paths => durability.syncCritical(paths, `Archive accepted Host turn ${operationId}`).then(() => undefined),
      confirmPreviouslyCommitted: journal => durability.confirmPreviouslyCommitted(journal),
      publishView: validate,
    });
    await assertMemoryTransactionReadable(root);
    let retained: Buffer;
    try { retained = await readRepositoryBytes(root, file); }
    catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("host_context_archive_unavailable");
    }
    check(retained.toString("utf8") === bytes, "host_context_archive_changed");
    await validate();
    return { status: receipt.replayed ? "duplicate" : "committed" };
  };
}
