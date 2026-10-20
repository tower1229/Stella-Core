import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { CatalogError } from "../canghai/catalog-reader.js";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "../canghai/native-memory-origin.js";
import type { OriginalEvidence } from "../praxis/episode-evidence.js";
import { isRecord } from "../shared/type-guards.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { readNativeQueryEmbedding, type createNativeQueryEmbedding } from "./native-query-embedding.js";

export type NativeMemoryReadObservation = { origin: NativeMemoryOrigin; digest: string };

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

type MemoryRuntime = NonNullable<MemoryPluginCapability["runtime"]>;
type NativeStorage = Pick<typeof import("openclaw/plugin-sdk/memory-core-host-engine-storage"),
  "MEMORY_INDEX_FTS_TABLE" | "MEMORY_INDEX_CHUNKS_TABLE" | "MEMORY_INDEX_SOURCES_TABLE" | "MEMORY_INDEX_CHUNK_PROVENANCE_TABLE" |
  "MEMORY_INDEX_META_TABLE" | "MEMORY_INDEX_VECTOR_TABLE" | "MEMORY_EMBEDDING_CACHE_TABLE">;
type SearchSettings = NonNullable<ReturnType<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation").resolveMemorySearchConfig>>;
type NativeHit = Parameters<NonNullable<MemoryRuntime["authorizeSearchHits"]>>[0]["hits"][number];
const originClasses = ["owner", "agent", "untrusted", "system"] as const;
const sessionKinds = ["interactive", "cron", "heartbeat", "subagent", "unknown"] as const;
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some(item => item === value);
}

// Exact native index lookup executes an already selected locator. The public
// search API can bootstrap/rebuild even with lexicalOnly, so it is not safe at
// this processing boundary. Read the pinned public storage schema read-only.
function readIndexedHit(db: DatabaseSync, origin: NativeMemoryOrigin, originalText: string, schema: NativeStorage, settings: SearchSettings) {
  const { MEMORY_INDEX_FTS_TABLE, MEMORY_INDEX_CHUNKS_TABLE, MEMORY_INDEX_SOURCES_TABLE, MEMORY_INDEX_CHUNK_PROVENANCE_TABLE } = schema;
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(`SELECT chunk.id, chunk.path, chunk.source, chunk.start_line, chunk.end_line,
      chunk.text, chunk.hash, chunk.model, source.hash AS source_hash,
      provenance.origin_class, provenance.session_kind, provenance.observed_at, provenance.supersedes_key
      FROM ${MEMORY_INDEX_FTS_TABLE} AS indexed
      JOIN ${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = indexed.id AND chunk.path = indexed.path
        AND chunk.source = indexed.source AND chunk.start_line = indexed.start_line AND chunk.end_line = indexed.end_line
        AND chunk.model = indexed.model AND chunk.text = indexed.text
      JOIN ${MEMORY_INDEX_SOURCES_TABLE} AS source ON source.path = chunk.path AND source.source = chunk.source
      JOIN ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} AS provenance ON provenance.chunk_id = chunk.id
      WHERE chunk.path = ? AND chunk.source = 'memory' AND chunk.start_line <= ? AND chunk.end_line >= ?
      ORDER BY chunk.id LIMIT 33`).all(origin.path, origin.fromLine, origin.fromLine + origin.lineCount - 1);
  } catch { throw new CatalogError("native_memory_index_unverifiable"); }
  check(rows.length > 0, "native_memory_index_miss");
  check(rows.length <= 32, "native_memory_index_budget_exhausted");
  const hits: NativeHit[] = rows.map(row => {
    check(typeof row.source_hash === "string" && row.source_hash.length > 0 && typeof row.text === "string" &&
      row.text.length <= 64_000 && typeof row.start_line === "number" && Number.isSafeInteger(row.start_line) &&
      typeof row.end_line === "number" && Number.isSafeInteger(row.end_line) &&
      member(row.origin_class, originClasses) && member(row.session_kind, sessionKinds) &&
      typeof row.observed_at === "number" && Number.isSafeInteger(row.observed_at) &&
      (row.supersedes_key === null || typeof row.supersedes_key === "string"), "native_memory_index_unverifiable");
    const body = originalText.endsWith("\n") ? originalText.slice(0, -1) : originalText;
    check(row.text.split("\n").slice(origin.fromLine - row.start_line,
      origin.fromLine - row.start_line + origin.lineCount).join("\n") === body, "native_memory_index_payload_changed");
    return { path: origin.path, startLine: row.start_line, endLine: row.end_line, score: 0,
      snippet: row.text, source: "memory", provenance: { originClass: row.origin_class,
        sessionKind: row.session_kind, observedAt: row.observed_at,
        ...(typeof row.supersedes_key === "string" && row.supersedes_key.trim() ? { supersedesKey: row.supersedes_key } : {}) } };
  });
  const vector = settings.store.vector.enabled && settings.provider !== "none"
    ? readVectorBinding(db, rows, schema, settings) : undefined;
  return { hits, chunkIds: rows.map(row => row.id), vector, fingerprint: JSON.stringify({ rows, vector }) };
}

// The Host's "complete" marker does not inspect individual vector/cache bytes.
// Verify only the already selected chunks; never rank candidates or embed text.
function readVectorBinding(db: DatabaseSync, chunks: Record<string, unknown>[], schema: NativeStorage, settings: SearchSettings) {
  const { MEMORY_INDEX_META_TABLE, MEMORY_INDEX_VECTOR_TABLE, MEMORY_INDEX_CHUNKS_TABLE, MEMORY_EMBEDDING_CACHE_TABLE } = schema;
  try {
    const persisted = db.prepare(`SELECT key, value FROM ${MEMORY_INDEX_META_TABLE} WHERE key IN (?, ?) ORDER BY key`)
      .all("memory_index_meta_v1", "memory_vector_rebuild_v1");
    const serialized = persisted.find(row => row.key === "memory_index_meta_v1")?.value;
    check(typeof serialized === "string" && serialized.length <= 16_000, "native_memory_vector_unverifiable");
    const meta: unknown = JSON.parse(serialized);
    check(isRecord(meta) && meta.provider === settings.provider && meta.model === settings.model &&
      typeof meta.providerKey === "string" && /^[a-f0-9]{64}$/.test(meta.providerKey) &&
      Number.isSafeInteger(meta.vectorDims) && Number(meta.vectorDims) > 0 && Number(meta.vectorDims) <= 8192 &&
      persisted.some(row => row.key === "memory_vector_rebuild_v1" && row.value === "clean"), "native_memory_vector_unverifiable");
    const dimensions = Number(meta.vectorDims);
    const bindings = chunks.map(chunk => {
      const row = db.prepare(`SELECT chunk.embedding, vector.embedding AS vector_embedding FROM ${MEMORY_INDEX_CHUNKS_TABLE} AS chunk
        JOIN ${MEMORY_INDEX_VECTOR_TABLE} AS vector ON vector.id = chunk.id WHERE chunk.id = ?`).get(String(chunk.id));
      check(row && chunk.model === meta.model && typeof row.embedding === "string" && row.embedding.length <= 256_000 &&
        row.vector_embedding instanceof Uint8Array, "native_memory_vector_unverifiable");
      const embedding: unknown = JSON.parse(row.embedding);
      check(Array.isArray(embedding) && embedding.length === dimensions && embedding.every(value => typeof value === "number" && Number.isFinite(value)) &&
        embedding.some(value => value !== 0), "native_memory_vector_unverifiable");
      const values = new Float32Array(embedding as number[]), vector = row.vector_embedding;
      check(values.every(Number.isFinite), "native_memory_vector_unverifiable");
      const bytes = Buffer.from(values.buffer);
      check(bytes.every((value, index) => value === vector[index]) && bytes.length === vector.length,
        "native_memory_vector_payload_changed");
      const cache = settings.cache.enabled ? db.prepare(`SELECT provider, model, provider_key, hash, embedding, dims
        FROM ${MEMORY_EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`)
        .get(settings.provider, settings.model, String(meta.providerKey), String(chunk.hash)) : undefined;
      if (settings.cache.enabled) check(cache && cache.dims === dimensions && cache.embedding === row.embedding, "native_memory_embedding_cache_unverifiable");
      return { id: chunk.id, embedding: row.embedding, vector: bytesVersion(bytes), ...(cache ? { cache } : {}) };
    });
    return { persisted, bindings, identity: { model: String(meta.model), providerKey: String(meta.providerKey), dimensions } };
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("native_memory_vector_unverifiable");
  }
}

/** Host search ranks candidates, but cannot choose or authorize personal evidence.
 * This reader looks up only a fragment already selected by Core's semantic path.
 * Actual native bytes must equal its independently retained, admitted original.
 * The current callback must only check structure/authority: consumption replays it
 * before semantic processing is permitted. */
export function createNativeMemoryReader(api: OpenClawPluginApi, agentId: string, sessionKey: string,
  observeVerifiedRead?: (observation: NativeMemoryReadObservation) => void,
  queryEmbedding?: ReturnType<typeof createNativeQueryEmbedding>) {
  const verifiedReads = new Map<string, () => Promise<void>>();
  const retainRead = (origin: NativeMemoryOrigin, original: OriginalEvidence, assertCurrent: () => Promise<void>, expected: string) => {
    const key = canonicalJson([origin, original.ref]);
    if (verifiedReads.has(key)) return;
    const retainedOrigin = structuredClone(origin), retainedOriginal = structuredClone(original);
    // Recheck the first successfully consumed generation, including exact reads
    // that never embed a query. Caller mutation or another read cannot replace it.
    verifiedReads.set(key, async () => {
      let observed: string | undefined;
      const verifier = createNativeMemoryReader(api, agentId, sessionKey, value => { observed = value.digest; }, queryEmbedding);
      await verifier(retainedOrigin, retainedOriginal, assertCurrent);
      check(observed === expected, queryEmbedding ? "native_query_embedding_consumption_changed" : "native_memory_consumption_changed");
    });
  };
  let revalidation: Promise<void> | undefined;
  const read = async (value: NativeMemoryOrigin, original: OriginalEvidence, assertCurrent: () => Promise<void>): Promise<string> => {
    await assertCurrent();
    const origin = parseNativeMemoryOrigin(value);
    check(api.runtime.version === "2026.8.2" && origin.hostVersion === api.runtime.version, "native_memory_host_version_unsupported");
    check(origin.agentId === agentId, "native_memory_agent_mismatch");
    const config = structuredClone(api.runtime.config.current()) as OpenClawConfig;
    check(config.plugins?.entries?.[origin.provider === "session-memory" ? "memory-core" : origin.provider]?.enabled === true,
      "native_memory_provider_disabled");
    check(original.text.trim().length > 0 && original.text.length <= 12_000, "native_memory_excerpt_budget_exhausted");
    let result: unknown;
    if (origin.provider === "memory-wiki") {
      check(!queryEmbedding, "native_query_embedding_provider_unsupported");
      const { listMemoryCorpusSupplements } = await import("openclaw/plugin-sdk/memory-core-host-runtime-core");
      await assertCurrent();
      const supplements = listMemoryCorpusSupplements().filter(entry => entry.pluginId === "memory-wiki");
      check(supplements.length === 1, "native_memory_provider_unbound");
      const supplement = supplements[0]!.supplement;
      // Wiki ranks compiled page metadata; use the already selected exact page
      // locator rather than treating a long Markdown body as a semantic query.
      const hits = await supplement.search({ agentId, agentSessionKey: sessionKey, sandboxed: false, query: origin.path, maxResults: 32 });
      await assertCurrent();
      check(Array.isArray(hits) && hits.some(hit => isRecord(hit) && hit.path === origin.path), "native_memory_index_miss");
      // A declared claim alias requires the native compiled cache. An absent or
      // invalidated publication must return failure, never retry by page path.
      result = await supplement.get({ agentId, agentSessionKey: sessionKey, sandboxed: false,
        lookup: origin.claimId === undefined ? origin.path : `claim:${origin.claimId}`,
        fromLine: origin.fromLine, lineCount: origin.lineCount });
      await assertCurrent();
      check(isRecord(result) && result.corpus === "wiki" && result.path === origin.path && result.fromLine === origin.fromLine &&
        result.lineCount === origin.lineCount && typeof result.content === "string", "native_memory_read_unverifiable");
      check(result.content === original.text, "native_memory_payload_changed");
      const digest = bytesVersion(canonicalJson({ origin, hits, result }));
      retainRead(origin, original, assertCurrent, digest);
      observeVerifiedRead?.({ origin, digest });
      return result.content;
    }
    check(origin.path.startsWith("memory/"), "native_memory_path_forbidden");
    if (origin.provider === "session-memory") check(config.hooks?.internal?.enabled === true &&
      config.hooks.internal.entries?.["session-memory"]?.enabled === true, "native_session_memory_disabled");
    const [{ getMemoryCapabilityRegistration }, { resolveMemorySearchConfig }, storage] = await Promise.all([
      import("openclaw/plugin-sdk/memory-host-core"), import("openclaw/plugin-sdk/memory-core-host-engine-foundation"),
      import("openclaw/plugin-sdk/memory-core-host-engine-storage"),
    ]);
    await assertCurrent();
    const registration = getMemoryCapabilityRegistration();
    check(registration?.pluginId === "memory-core" && registration.capability.runtime, "native_memory_provider_unbound");
    const runtime = registration.capability.runtime;
    const settings = resolveMemorySearchConfig(config, agentId);
    check(settings?.enabled && settings.store.driver === "sqlite", "native_memory_index_unavailable");
    let db: DatabaseSync;
    const vectorEnabled = settings.store.vector.enabled && settings.provider !== "none";
    try { db = new DatabaseSync(settings.store.databasePath, { readOnly: true, allowExtension: vectorEnabled }); }
    catch { throw new CatalogError("native_memory_index_unavailable"); }
    let manager: Awaited<ReturnType<MemoryRuntime["getMemorySearchManager"]>>["manager"] = null;
    let text: string;
    let nativeDigest: string;
    try {
      if (vectorEnabled) {
        const loaded = await storage.loadSqliteVecExtension({ db, extensionPath: settings.store.vector.extensionPath });
        db.enableLoadExtension(false);
        await assertCurrent();
        check(loaded.ok, "native_memory_vector_unavailable");
      }
      const loaded = await runtime.getMemorySearchManager({ cfg: config, agentId, purpose: "status" });
      manager = loaded.manager;
      await assertCurrent();
      check(loaded.manager && !loaded.error && loaded.manager.close, "native_memory_index_unavailable");
      check(runtime.authorizeSearchHits, "native_memory_search_authority_unavailable");
      const assertIndex = () => {
        const status = loaded.manager!.status();
        check(status.backend === "builtin" && status.dbPath === settings.store.databasePath &&
          status.dirty === false && (status.chunks ?? 0) > 0 && status.fts?.enabled === true && status.fts.available === true && !status.lastSyncError && !status.fallback &&
          isRecord(status.custom?.indexIdentity) && status.custom.indexIdentity.status === "valid",
          "native_memory_index_unverifiable");
        if (vectorEnabled) check(status.vector?.enabled === true && status.vector.index?.state === "complete" &&
          !status.vector.loadError, "native_memory_vector_unverifiable");
      };
      assertIndex();
      const indexed = readIndexedHit(db, origin, original.text, storage, settings);
      const hits = await runtime.authorizeSearchHits({ cfg: config, agentId,
        requesterSessionKey: sessionKey, sandboxed: false, hits: indexed.hits });
      await assertCurrent();
      assertIndex();
      check(readIndexedHit(db, origin, original.text, storage, settings).fingerprint === indexed.fingerprint, "native_memory_index_changed");
      check(hits.some(hit => hit.path === origin.path && hit.startLine <= origin.fromLine &&
        hit.endLine >= origin.fromLine + origin.lineCount - 1), "native_memory_index_miss");
      let queryDigest: string | undefined;
      if (queryEmbedding) {
        check(indexed.vector, "native_query_embedding_vector_required");
        const bound = readNativeQueryEmbedding(await queryEmbedding(settings, indexed.vector.identity));
        await assertCurrent(); await bound.assertCurrent();
        assertIndex();
        check(readIndexedHit(db, origin, original.text, storage, settings).fingerprint === indexed.fingerprint, "native_memory_index_changed");
        // Native sqlite-vec ranking only. No document bytes, index writes,
        // fallback scan or unadmitted candidate snippets leave this boundary.
        const vector = Buffer.from(new Float32Array(bound.vector).buffer);
        let candidates: Record<string, unknown>[];
        try {
          const count = db.prepare(`SELECT COUNT(*) AS count FROM ${storage.MEMORY_INDEX_VECTOR_TABLE}`).get()?.count;
          check(typeof count === "number" && count > 0 && count <= 4096, "native_query_embedding_index_budget_exhausted");
          candidates = db.prepare(`SELECT chunk.id, chunk.path, chunk.start_line, chunk.end_line, vec_distance_cosine(vector.embedding, ?) AS distance
            FROM ${storage.MEMORY_INDEX_VECTOR_TABLE} AS vector JOIN ${storage.MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = vector.id
            WHERE vector.embedding MATCH ? AND k = ? AND chunk.source = 'memory' AND chunk.model = ?
            ORDER BY distance, chunk.id LIMIT 32`).all(vector, vector, count, indexed.vector.identity.model);
        } catch (error) {
          if (error instanceof CatalogError) throw error;
          throw new CatalogError("native_query_embedding_search_failed");
        }
        check(candidates.every(row => typeof row.distance === "number" && Number.isFinite(row.distance)), "native_query_embedding_search_failed");
        check(candidates.some(row => typeof row.distance === "number" && 1 - row.distance >= settings.query.minScore &&
          indexed.chunkIds.includes(row.id) && row.path === origin.path &&
          typeof row.start_line === "number" && row.start_line <= origin.fromLine && typeof row.end_line === "number" &&
          row.end_line >= origin.fromLine + origin.lineCount - 1), "native_query_embedding_index_miss");
        queryDigest = bytesVersion(canonicalJson({ receipt: bound.digest, candidates: candidates.map(row => ({ ...row })) }));
      }
      result = await loaded.manager.readFile({ relPath: origin.path, from: origin.fromLine, lines: origin.lineCount });
      await assertCurrent();
      assertIndex();
      check(readIndexedHit(db, origin, original.text, storage, settings).fingerprint === indexed.fingerprint, "native_memory_index_changed");
      check(isRecord(result) && result.status === "ok" && result.path === origin.path && result.from === origin.fromLine &&
        result.lines === origin.lineCount && typeof result.text === "string", "native_memory_read_unverifiable");
      // The pinned public read codec removes the last empty file line and may
      // append this exact range continuation notice. No unknown rewrite is accepted.
      const body = original.text.endsWith("\n") ? original.text.slice(0, -1) : original.text;
      const notice = result.truncated === true && result.nextFrom === origin.fromLine + origin.lineCount
        ? `\n\n[More content available. Use from=${result.nextFrom} to continue.]` : "";
      check(result.text === body + notice && (result.truncated !== true || notice.length > 0), "native_memory_payload_changed");
      text = result.text.slice(0, body.length) + (original.text.endsWith("\n") ? "\n" : "");
      nativeDigest = bytesVersion(canonicalJson({ origin, indexed: indexed.fingerprint, result, ...(queryDigest ? { queryDigest } : {}) }));
    } finally {
      db.close();
      await manager?.close?.();
    }
    await assertCurrent();
    observeVerifiedRead?.({ origin, digest: nativeDigest });
    retainRead(origin, original, assertCurrent, nativeDigest);
    return text;
  };
  return Object.assign(read, { assertCurrent() {
    return revalidation ??= (async () => {
      for (const current of verifiedReads.values()) await current();
    })().finally(() => { revalidation = undefined; });
  } });
}
