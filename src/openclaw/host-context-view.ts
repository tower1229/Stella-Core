import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { CatalogError, CatalogReader, parseMemoryCatalog, readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable, readRecordedMemoryTransaction, type MemoryTransactionPlan } from "../canghai/memory-transaction.js";
import { parseViewRecipe, viewRecipePath, type MemoryView } from "../canghai/view-recipe.js";
import type { IngestDurabilityPort } from "../canghai/ingest.js";
import { isRecord } from "../shared/type-guards.js";
import { contextHistorySignerId } from "./host-context-history.js";
import type { HostContextAuthority, PreparedHistoryView } from "./host-context-authority.js";

const adapterId = "stella.host-history";
const adapterVersion = "1";
type Snapshot = Awaited<ReturnType<HostContextAuthority["historyViewSnapshot"]>>;
type Ports = {
  reloadAuthority(): Promise<HostContextAuthority>;
  durability: Pick<IngestDurabilityPort, "syncCritical" | "confirmPreviouslyCommitted">;
  signal?: AbortSignal;
};
export type PublishedHistoryView = Readonly<{ viewId: string; digest: string }>;
const published = new WeakMap<PublishedHistoryView, { root: string; catalogPath: string; verificationKey: KeyObject; recipeRef: MemoryView["recipeRef"] }>();
function check(value: unknown, category = "host_context_view_publication_invalid"): asserts value {
  if (!value) throw new CatalogError(category);
}
function directory(value: string): string {
  check(value && !value.includes("\\") && value.split("/").every(part => part && ![".", "..", ".git"].includes(part.toLowerCase()) && !part.includes(":")), "unsafe_archive_locator");
  return value;
}
function decode(bytes: string, signature: string, key: KeyObject): Snapshot {
  check(Buffer.byteLength(bytes) <= 2 * 1024 * 1024 && verify(null, Buffer.from(bytes), key, Buffer.from(signature, "base64")),
    "host_context_view_signature_invalid");
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new CatalogError("host_context_view_invalid"); }
  check(isRecord(value) && value.schemaVersion === "stella.host-history-view/v1" && typeof value.viewId === "string" &&
    typeof value.agentId === "string" && value.signerId === contextHistorySignerId(key) && isRecord(value.authority) &&
    typeof value.authority.generationId === "string" && isRecord(value.sourceArchive) && typeof value.sourceArchive.archiveRoot === "string" &&
    isRecord(value.sources) && Array.isArray(value.sources.dependencies) && typeof value.modelRef === "string" &&
    value.promptVersion === "stella.host-history-rebuild/v1", "host_context_view_invalid");
  check(canonicalJson(value) === bytes, "host_context_view_invalid");
  // Remaining graph and authority fields are validated by HostContextAuthority
  // before a transaction can publish or a caller can consume this signed data.
  return value as Snapshot;
}
function planFor(snapshot: Snapshot, bytes: string, signature: string, catalogPath: string, before: string) {
  const catalog = parseMemoryCatalog(JSON.parse(before));
  check(catalog.generationId === snapshot.authority.generationId, "host_context_generation_mismatch");
  const archiveRoot = directory(snapshot.sourceArchive.archiveRoot), digest = bytesVersion(bytes);
  const operationId = `history_view_${digest.slice(7)}`;
  const artifact = `${archiveRoot}/history-views/${digest.slice(7)}.json`;
  const refs = snapshot.sources.dependencies.map(dependency => {
    check(isRecord(dependency) && isRecord(dependency.ref) && typeof dependency.ref.id === "string" && typeof dependency.ref.version === "string");
    return { id: dependency.ref.id, version: dependency.ref.version };
  });
  const body = { schemaVersion: "stella.view-recipe/v1", id: `history-view:${snapshot.viewId}`, adapterId, adapterVersion,
    hostTarget: snapshot.agentId, inputRefs: refs, parameters: { archiveRoot, digest },
    modelRef: snapshot.modelRef, promptVersion: snapshot.promptVersion };
  const recipe = { ...body, version: objectVersion(body) };
  const view: MemoryView = { id: snapshot.viewId, generationId: snapshot.authority.generationId,
    recipeRef: { id: recipe.id, version: recipe.version }, required: true, sourceRefs: refs };
  parseViewRecipe(recipe, view);
  const after = structuredClone(catalog);
  const index = after.views.findIndex(candidate => candidate.id === view.id);
  if (index < 0) after.views.push(view); else after.views[index] = view;
  parseMemoryCatalog(after);
  const plan: MemoryTransactionPlan = { operationId, journalPath: `${archiveRoot}/operations/${operationId}.json`, files: [
    { path: artifact, before: null, after: bytes }, { path: `${artifact}.sig`, before: null, after: signature },
    { path: viewRecipePath(catalogPath, view.recipeRef), before: null, after: canonicalJson(recipe) },
    { path: catalogPath, before, after: canonicalJson(after) },
  ] };
  return { plan, view, digest };
}

async function apply(root: string, catalogPath: string, plan: MemoryTransactionPlan, key: KeyObject, ports: Ports) {
  const artifact = plan.files[0], signature = plan.files[1], catalog = plan.files[3];
  check(plan.files.length === 4 && artifact && signature && catalog && catalog.path === catalogPath && typeof catalog.before === "string" &&
    plan.files.every(file => file.encoding === undefined));
  const snapshot = decode(artifact.after, signature.after, key);
  const expected = planFor(snapshot, artifact.after, signature.after, catalogPath, catalog.before);
  check(canonicalJson(expected.plan) === canonicalJson(plan));
  const validate = async () => {
    ports.signal?.throwIfAborted();
    const authority = await ports.reloadAuthority();
    check(authority.resolver.reader.root === root && authority.resolver.reader.catalogPath === catalogPath);
    const current = (await readRepositoryBytes(root, catalogPath)).toString("utf8");
    check(current === catalog.before || current === catalog.after, "host_context_view_catalog_changed");
    await authority.assertHistoryViewSnapshot(snapshot, key);
  };
  await applyMemoryTransaction(root, plan, {
    validate,
    persist: paths => ports.durability.syncCritical(paths, `Publish Stella history view ${plan.operationId}`).then(() => undefined),
    confirmPreviouslyCommitted: async file => { await validate(); await ports.durability.confirmPreviouslyCommitted(file); },
    publishView: validate,
  }, ports.signal);
  return loadPublishedHistoryView(await CatalogReader.load(root, catalogPath), snapshot.viewId, key);
}

/** Publish a signed reconstruction and its recipe/selection atomically. This
 * records a historical reconstruction, not a committed search-index database.
 * Generation writers must migrate these required views before advancing state. */
export async function publishPreparedHistoryView(authority: HostContextAuthority, view: PreparedHistoryView,
  input: Ports & { signingKey: KeyObject }): Promise<PublishedHistoryView> {
  check(input.signingKey.type === "private", "host_context_archive_key_invalid");
  const key = createPublicKey(input.signingKey), snapshot = await authority.historyViewSnapshot(view);
  check(snapshot.signerId === contextHistorySignerId(key), "host_context_archive_signer_mismatch");
  const bytes = canonicalJson(snapshot), signature = sign(null, Buffer.from(bytes), input.signingKey).toString("base64");
  const reader = authority.resolver.reader;
  const before = (await readRepositoryBytes(reader.root, reader.catalogPath)).toString("utf8");
  await reader.assertCurrent();
  const { plan } = planFor(snapshot, bytes, signature, reader.catalogPath, before);
  return apply(reader.root, reader.catalogPath, plan, key, input);
}

/** Replay only the exact recorded plan; reconstruction never reruns on recovery. */
export async function recoverHistoryView(root: string, catalogPath: string, key: KeyObject, ports: Ports): Promise<PublishedHistoryView> {
  contextHistorySignerId(key);
  return apply(root, catalogPath, await readRecordedMemoryTransaction(root), key, ports);
}

export async function loadPublishedHistoryView(reader: CatalogReader, viewId: string, key: KeyObject): Promise<PublishedHistoryView> {
  const recipe = await reader.readViewRecipe(viewId);
  check(recipe.adapterId === adapterId && recipe.adapterVersion === adapterVersion &&
    Object.keys(recipe.parameters).sort().join() === "archiveRoot,digest" && typeof recipe.parameters.archiveRoot === "string" &&
    typeof recipe.parameters.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(recipe.parameters.digest), "host_context_view_recipe_invalid");
  const digest = recipe.parameters.digest, archiveRoot = directory(recipe.parameters.archiveRoot);
  const artifact = `${archiveRoot}/history-views/${digest.slice(7)}.json`;
  const bytes = (await readRepositoryBytes(reader.root, artifact)).toString("utf8");
  const signature = (await readRepositoryBytes(reader.root, `${artifact}.sig`)).toString("utf8");
  check(bytesVersion(bytes) === digest, "host_context_view_changed");
  const snapshot = decode(bytes, signature, key);
  const journal = (await readRepositoryBytes(reader.root, `${archiveRoot}/operations/history_view_${digest.slice(7)}.json`)).toString("utf8");
  let transaction: unknown;
  try { transaction = JSON.parse(journal); } catch { throw new CatalogError("host_context_view_publication_invalid"); }
  check(isRecord(transaction) && Array.isArray(transaction.files) && isRecord(transaction.files[3]) && typeof transaction.files[3].before === "string");
  const expected = planFor(snapshot, bytes, signature, reader.catalogPath, transaction.files[3].before);
  check(journal === canonicalJson({ schemaVersion: "stella.memory-transaction/v1", ...expected.plan, planHash: bytesVersion(canonicalJson(expected.plan)) }));
  const selected = reader.catalog.views.find(view => view.id === viewId);
  check(snapshot.viewId === viewId && recipe.hostTarget === snapshot.agentId && canonicalJson(selected) === canonicalJson(expected.view), "host_context_view_catalog_changed");
  await assertMemoryTransactionReadable(reader.root);
  // The owning publication transaction must not expose an unfinished view.
  try { await readRepositoryBytes(reader.root, ".stella-memory-transaction.json"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await reader.assertCurrent();
      const handle = Object.freeze({ viewId, digest });
      published.set(handle, { root: reader.root, catalogPath: reader.catalogPath, verificationKey: key, recipeRef: expected.view.recipeRef });
      return handle;
    }
    throw error;
  }
  throw new CatalogError("host_context_view_pending");
}

export async function readPublishedHistoryView(handle: PublishedHistoryView, reader: CatalogReader) {
  const binding = published.get(handle);
  check(binding && binding.root === reader.root && binding.catalogPath === reader.catalogPath, "host_context_view_unbound");
  const current = await loadPublishedHistoryView(reader, handle.viewId, binding.verificationKey);
  check(current.digest === handle.digest && canonicalJson(published.get(current)!.recipeRef) === canonicalJson(binding.recipeRef), "host_context_view_changed");
  const recipe = await reader.readViewRecipe(handle.viewId);
  const file = `${directory(String(recipe.parameters.archiveRoot))}/history-views/${handle.digest.slice(7)}.json`;
  const bytes = (await readRepositoryBytes(reader.root, file)).toString("utf8");
  const signature = (await readRepositoryBytes(reader.root, `${file}.sig`)).toString("utf8");
  check(bytesVersion(bytes) === handle.digest, "host_context_view_changed");
  const snapshot = decode(bytes, signature, binding.verificationKey);
  await reader.assertCurrent();
  return { snapshot, verificationKey: binding.verificationKey };
}
