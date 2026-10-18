import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { CatalogError } from "../canghai/catalog-reader.js";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "../canghai/native-memory-origin.js";
import type { OriginalEvidence } from "../praxis/episode-evidence.js";
import { isRecord } from "../shared/type-guards.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";

export type NativeMemoryReadObservation = { origin: NativeMemoryOrigin; digest: string };

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

type MemoryRuntime = NonNullable<MemoryPluginCapability["runtime"]>;
type NativeStorage = Pick<typeof import("openclaw/plugin-sdk/memory-core-host-engine-storage"),
  "MEMORY_INDEX_FTS_TABLE" | "MEMORY_INDEX_CHUNKS_TABLE" | "MEMORY_INDEX_SOURCES_TABLE" | "MEMORY_INDEX_CHUNK_PROVENANCE_TABLE">;
type NativeHit = Parameters<NonNullable<MemoryRuntime["authorizeSearchHits"]>>[0]["hits"][number];
const originClasses = ["owner", "agent", "untrusted", "system"] as const;
const sessionKinds = ["interactive", "cron", "heartbeat", "subagent", "unknown"] as const;
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some(item => item === value);
}

// Exact native index lookup executes an already selected locator. The public
// search API can bootstrap/rebuild even with lexicalOnly, so it is not safe at
// this processing boundary. Read the pinned public storage schema read-only.
function readIndexedHit(db: DatabaseSync, origin: NativeMemoryOrigin, originalText: string, schema: NativeStorage) {
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
  return { hits, fingerprint: JSON.stringify(rows) };
}

/** Host search ranks candidates, but cannot choose or authorize personal evidence.
 * This reader looks up only a fragment already selected by Core's semantic path.
 * Actual native bytes must equal its independently retained, admitted original. */
export function createNativeMemoryReader(api: OpenClawPluginApi, agentId: string, sessionKey: string,
  observeVerifiedRead?: (observation: NativeMemoryReadObservation) => void) {
  return async (value: NativeMemoryOrigin, original: OriginalEvidence, assertCurrent: () => Promise<void>): Promise<string> => {
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
      observeVerifiedRead?.({ origin, digest: bytesVersion(canonicalJson({ origin, hits, result })) });
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
    try { db = new DatabaseSync(settings.store.databasePath, { readOnly: true }); }
    catch { throw new CatalogError("native_memory_index_unavailable"); }
    let manager: Awaited<ReturnType<MemoryRuntime["getMemorySearchManager"]>>["manager"] = null;
    let text: string;
    let nativeDigest: string;
    try {
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
      };
      assertIndex();
      const indexed = readIndexedHit(db, origin, original.text, storage);
      const hits = await runtime.authorizeSearchHits({ cfg: config, agentId,
        requesterSessionKey: sessionKey, sandboxed: false, hits: indexed.hits });
      await assertCurrent();
      assertIndex();
      check(readIndexedHit(db, origin, original.text, storage).fingerprint === indexed.fingerprint, "native_memory_index_changed");
      check(hits.some(hit => hit.path === origin.path && hit.startLine <= origin.fromLine &&
        hit.endLine >= origin.fromLine + origin.lineCount - 1), "native_memory_index_miss");
      result = await loaded.manager.readFile({ relPath: origin.path, from: origin.fromLine, lines: origin.lineCount });
      await assertCurrent();
      assertIndex();
      check(readIndexedHit(db, origin, original.text, storage).fingerprint === indexed.fingerprint, "native_memory_index_changed");
      check(isRecord(result) && result.status === "ok" && result.path === origin.path && result.from === origin.fromLine &&
        result.lines === origin.lineCount && typeof result.text === "string", "native_memory_read_unverifiable");
      // The pinned public read codec removes the last empty file line and may
      // append this exact range continuation notice. No unknown rewrite is accepted.
      const body = original.text.endsWith("\n") ? original.text.slice(0, -1) : original.text;
      const notice = result.truncated === true && result.nextFrom === origin.fromLine + origin.lineCount
        ? `\n\n[More content available. Use from=${result.nextFrom} to continue.]` : "";
      check(result.text === body + notice && (result.truncated !== true || notice.length > 0), "native_memory_payload_changed");
      text = result.text.slice(0, body.length) + (original.text.endsWith("\n") ? "\n" : "");
      nativeDigest = bytesVersion(canonicalJson({ origin, indexed: indexed.fingerprint, result }));
    } finally {
      db.close();
      await manager?.close?.();
    }
    await assertCurrent();
    observeVerifiedRead?.({ origin, digest: nativeDigest });
    return text;
  };
}
