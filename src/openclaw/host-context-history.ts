import { readContextArchiveGraph } from "./host-context-graph.js";
import { CatalogError, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable, readRecordedMemoryTransaction } from "../canghai/memory-transaction.js";
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { IngestDurabilityPort } from "../canghai/ingest.js";
import type { ContextConsumption, HostContextAuthority } from "./host-context-authority.js";
import { parseSourcePolicy } from "../canghai/source-policy.js";
import { isRecord } from "../shared/type-guards.js";

export type StoredContextHistory = Readonly<{ digest: string }>;
const histories = new WeakMap<StoredContextHistory, { root: string; archiveRoot: string; path: string; journalPath: string; operationId: string; verificationKey: KeyObject }>();

export function contextHistorySignerId(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new CatalogError("host_context_archive_key_invalid");
  return bytesVersion(key.export({ type: "spki", format: "der" }));
}

export function contextHistoryVerificationKey(handle: StoredContextHistory): KeyObject {
  const binding = histories.get(handle);
  if (!binding) throw new CatalogError("host_context_archive_unbound");
  return binding.verificationKey;
}

export function contextHistoryLocation(handle: StoredContextHistory): { archiveRoot: string; digest: string; signerId: string } {
  const binding = histories.get(handle);
  if (!binding) throw new CatalogError("host_context_archive_unbound");
  return { archiveRoot: binding.archiveRoot, digest: handle.digest, signerId: contextHistorySignerId(binding.verificationKey) };
}

function archiveRoot(value: string): string {
  if (!value || value.includes("\\") || value.split("/").some(part =>
    !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":"))) {
    throw new CatalogError("unsafe_archive_locator");
  }
  return value;
}

async function assertArchiveReadable(root: string, operationId: string): Promise<void> {
  await assertMemoryTransactionReadable(root);
  // The owning writer may read its unpublished catalog, but must not turn an
  // unfinished archive transaction into a restoration credential.
  try {
    const pending: unknown = JSON.parse((await readRepositoryBytes(root, ".stella-memory-transaction.json")).toString("utf8"));
    if (isRecord(pending) && typeof pending.operationId === "string" && pending.operationId !== operationId) return;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new CatalogError("host_context_archive_pending");
}

/** Only a completed Core archive transaction can supply a restoration handle.
 * Native Host messages and model-provided JSON cannot mint this handle. */
export async function loadContextHistory(root: string, location: { archiveRoot: string; digest: string }, verificationKey: KeyObject): Promise<StoredContextHistory> {
  contextHistorySignerId(verificationKey);
  if (!/^sha256:[a-f0-9]{64}$/.test(location.digest)) throw new CatalogError("host_context_archive_invalid");
  const directory = archiveRoot(location.archiveRoot);
  const operationId = `context_archive_${location.digest.slice(7)}`;
  const handle = Object.freeze({ digest: location.digest });
  histories.set(handle, { root, archiveRoot: directory, operationId, verificationKey, path: `${directory}/contexts/${location.digest.slice(7)}.json`,
    journalPath: `${directory}/operations/${operationId}.json` });
  await readContextHistory(handle, root);
  return handle;
}

export async function readContextHistory(handle: StoredContextHistory, root: string): Promise<Record<string, unknown>> {
  const binding = histories.get(handle);
  if (!binding || binding.root !== root) throw new CatalogError("host_context_archive_unbound");
  await assertArchiveReadable(root, binding.operationId);
  const bytes = await readRepositoryBytes(root, binding.path);
  const signature = await readRepositoryBytes(root, `${binding.path}.sig`);
  if (bytesVersion(bytes) !== handle.digest) throw new CatalogError("host_context_archive_changed");
  if (!verify(null, bytes, binding.verificationKey, Buffer.from(signature.toString("utf8"), "base64"))) {
    throw new CatalogError("host_context_archive_signature_invalid");
  }
  const plan = { operationId: binding.operationId, journalPath: binding.journalPath, files: [
    { path: binding.path, before: null, after: bytes.toString("utf8") },
    { path: `${binding.path}.sig`, before: null, after: signature.toString("utf8") },
  ] };
  const journal = await readRepositoryBytes(root, binding.journalPath);
  if (journal.toString("utf8") !== canonicalJson({ schemaVersion: "stella.memory-transaction/v1", ...plan,
    planHash: bytesVersion(canonicalJson(plan)) })) throw new CatalogError("host_context_archive_changed");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new CatalogError("host_context_archive_invalid"); }
  if (!isRecord(value) || !["stella.host-context-archive/v1", "stella.host-context-archive/v2"].includes(String(value.schemaVersion))) throw new CatalogError("host_context_archive_invalid");
  if (value.schemaVersion === "stella.host-context-archive/v2") readContextArchiveGraph(value);
  await assertArchiveReadable(root, binding.operationId);
  return value;
}

/** Archive an actual verified context through the same fenced, recoverable
 * transaction as other memory writes. This does not make the archive current
 * understanding: a future reader must revalidate its recorded dependencies. */
export async function persistContextHistory(authority: HostContextAuthority, consumption: ContextConsumption, input: {
  archiveRoot: string;
  signingKey: KeyObject;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  signal?: AbortSignal;
}) {
  const root = archiveRoot(input.archiveRoot);
  const signingKey = input.signingKey;
  if (signingKey.type !== "private") throw new CatalogError("host_context_archive_key_invalid");
  const verificationKey = createPublicKey(signingKey);
  const signerId = contextHistorySignerId(verificationKey);
  const capture = async () => {
    const snapshot = await authority.historySnapshot(consumption);
    if (signerId !== snapshot.signerId) {
      throw new CatalogError("host_context_archive_signer_mismatch");
    }
    for (const { ref } of snapshot.dependencies) {
      const object = await authority.resolver.reader.read(ref);
      if (String(object.schemaVersion).startsWith("stella.source-policy/") && parseSourcePolicy(object).retention !== "retain") {
        throw new CatalogError("host_context_archive_retention_forbidden");
      }
    }
    return canonicalJson(snapshot);
  };
  const bytes = await capture();
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new CatalogError("host_context_archive_budget_exhausted");
  const digest = bytesVersion(bytes);
  const operationId = `context_archive_${digest.slice(7)}`;
  const locator = { path: `${root}/contexts/${digest.slice(7)}.json`, sha256: digest };
  const signature = sign(null, Buffer.from(bytes), signingKey).toString("base64");
  const validate = async () => {
    if (await capture() !== bytes) {
      throw new CatalogError("host_context_archive_changed");
    }
  };
  const receipt = await applyMemoryTransaction(authority.resolver.reader.root, {
    operationId, journalPath: `${root}/operations/${operationId}.json`,
    files: [{ path: locator.path, before: null, after: bytes }, { path: `${locator.path}.sig`, before: null, after: signature }],
  }, {
    validate,
    persist: paths => input.durability.syncCritical(paths, `Archive verified Stella context ${operationId}`).then(() => undefined),
    confirmPreviouslyCommitted: journal => input.durability.confirmPreviouslyCommitted(journal),
    publishView: validate,
  }, input.signal);
  await loadContextHistory(authority.resolver.reader.root, { archiveRoot: root, digest }, verificationKey);
  await validate();
  return { ...receipt, locator };
}

/** Resume only the recorded signed archive plan after a restart. A current
 * authority rechecks all sources and grants inside the owning transaction;
 * completing this retention write neither selects a session head nor releases
 * an old assistant response. */
export async function recoverContextHistory(authority: HostContextAuthority, input: {
  archiveRoot: string; verificationKey: KeyObject;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  signal?: AbortSignal;
}) {
  const directory = archiveRoot(input.archiveRoot), root = authority.resolver.reader.root;
  contextHistorySignerId(input.verificationKey);
  const plan = await readRecordedMemoryTransaction(root);
  const payload = plan.files[0], signature = plan.files[1];
  if (plan.files.length !== 2 || !payload || !signature || payload.before !== null || signature.before !== null ||
      payload.encoding !== undefined || signature.encoding !== undefined) throw new CatalogError("host_context_archive_recovery_plan_invalid");
  const digest = bytesVersion(payload.after), operationId = `context_archive_${digest.slice(7)}`;
  const file = `${directory}/contexts/${digest.slice(7)}.json`;
  if (plan.operationId !== operationId || plan.journalPath !== `${directory}/operations/${operationId}.json` ||
      payload.path !== file || signature.path !== `${file}.sig`) throw new CatalogError("host_context_archive_recovery_plan_invalid");
  const validate = async () => {
    await authority.assertHistoricalArchive({ bytes: payload.after, signature: signature.after,
      archiveRoot: directory, verificationKey: input.verificationKey });
    const snapshot: unknown = JSON.parse(payload.after);
    if (!isRecord(snapshot) || !Array.isArray(snapshot.dependencies)) throw new CatalogError("host_context_archive_invalid");
    for (const dependency of snapshot.dependencies) {
      if (!isRecord(dependency) || !isRecord(dependency.ref) || typeof dependency.ref.id !== "string" || typeof dependency.ref.version !== "string") {
        throw new CatalogError("host_context_archive_invalid");
      }
      const object = await authority.resolver.reader.read({ id: dependency.ref.id, version: dependency.ref.version });
      if (String(object.schemaVersion).startsWith("stella.source-policy/") && parseSourcePolicy(object).retention !== "retain") {
        throw new CatalogError("host_context_archive_retention_forbidden");
      }
    }
  };
  const receipt = await applyMemoryTransaction(root, plan, {
    validate,
    persist: paths => input.durability.syncCritical(paths, `Recover Stella context archive ${operationId}`).then(() => undefined),
    confirmPreviouslyCommitted: journal => input.durability.confirmPreviouslyCommitted(journal),
    publishView: validate,
  }, input.signal);
  await validate();
  await loadContextHistory(root, { archiveRoot: directory, digest }, input.verificationKey);
  return { ...receipt, locator: { path: file, sha256: digest } };
}
