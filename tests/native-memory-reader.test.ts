import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { clearMemoryPluginState, registerMemoryCapability, registerMemoryCorpusSupplement, type MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { createNativeMemoryReader } from "../src/openclaw/native-memory-reader.js";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "../src/canghai/native-memory-origin.js";
import { inspectDeclaredHostMemory } from "../src/openclaw/host-memory-inventory.js";
import type { OriginalEvidence } from "../src/praxis/episode-evidence.js";
import { bytesVersion } from "../src/canghai/content-version.js";
import { loadPersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { createNativeQueryEmbedding } from "../src/openclaw/native-query-embedding.js";
import { bindProcessingAuthority } from "../src/openclaw/processing-authority.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";

const origin: NativeMemoryOrigin = { schemaVersion: "stella.native-memory-origin/v1", hostVersion: "2026.8.2",
  agentId: "stella", provider: "memory-core", path: "memory/retained.md", fromLine: 1, lineCount: 1 };
const original: OriginalEvidence = { ref: { id: "evidence", version: `sha256:${"a".repeat(64)}` },
  text: "Retained source fragment.\n", role: "owner", kind: "statement", independentOriginId: "source",
  sourceAdapterId: "synthetic", occurredAt: null, authoredAt: null,
  capturedAt: "2026-10-13T00:00:00Z", coverageComplete: true };
function fixture(t: TestContext) {
  const calls: string[] = [];
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-native-reader-test-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  const config: OpenClawConfig = { agents: { entries: { stella: { model: "stella-guarded/model" } } },
    memory: { search: { enabled: true, provider: "none" } },
    hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true } } } },
    plugins: { entries: { "memory-core": { enabled: true }, "memory-wiki": { enabled: true } } } };
  const dbPath = resolveMemorySearchConfig(config, "stella")!.store.databasePath;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; });
  db.exec(`CREATE TABLE memory_index_chunks (id TEXT, path TEXT, source TEXT, start_line INTEGER, end_line INTEGER,
    text TEXT, hash TEXT, model TEXT, embedding TEXT DEFAULT '[]');
    CREATE TABLE memory_index_sources (path TEXT, source TEXT, hash TEXT);
    CREATE TABLE memory_index_chunk_provenance (chunk_id TEXT, origin_class TEXT, session_kind TEXT,
      observed_at INTEGER, supersedes_key TEXT);
    CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(id UNINDEXED, path UNINDEXED, source UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, model UNINDEXED, text);
    INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, text, hash, model) VALUES ('chunk', 'memory/retained.md', 'memory', 1, 1, 'Retained source fragment.', 'chunk-hash', 'fts-only');
    INSERT INTO memory_index_chunks_fts (id, path, source, start_line, end_line, model, text) SELECT id, path, source, start_line, end_line, model, text FROM memory_index_chunks;
    INSERT INTO memory_index_sources VALUES ('memory/retained.md', 'memory', 'source-hash');
    INSERT INTO memory_index_chunk_provenance VALUES ('chunk', 'owner', 'interactive', 1, NULL);`);
  let status: Record<string, unknown> = { backend: "builtin", dbPath, dirty: false, chunks: 1,
    fts: { enabled: true, available: true }, custom: { indexIdentity: { status: "valid" } } };
  let result: unknown = { status: "ok", path: origin.path, from: 1, lines: 1, text: "Retained source fragment." };
  let hits: unknown[] | undefined;
  let live = true;
  let afterAuthorize = () => {};
  // Only public manager/status/authorization/read ports are synthetic. Index
  // reads use a real read-only SQLite connection, including concurrent changes.
  const runtime = { getMemorySearchManager: async (input: { purpose?: string }) => {
    assert.equal(input.purpose, "status"); calls.push("manager"); return { manager: {
      search: async () => { throw new Error("Native search could emit unauthorized embeddings"); },
      sync: async () => { throw new Error("Native consumer must not rebuild an index"); },
      status: () => status, close: async () => { calls.push("close"); },
      readFile: async () => { calls.push("read"); return result; },
    } };
  }, authorizeSearchHits: async (input: { requesterSessionKey: string; hits: unknown[] }) => {
    assert.equal(input.requesterSessionKey, "agent:stella:main");
    assert.deepEqual((input.hits[0] as { provenance: unknown }).provenance, { originClass: "owner", sessionKind: "interactive", observedAt: 1 });
    calls.push("authorize"); afterAuthorize(); return hits ?? input.hits;
  } } as unknown as NonNullable<MemoryPluginCapability["runtime"]>;
  registerMemoryCapability("memory-core", { runtime });
  registerMemoryCorpusSupplement("memory-wiki", {
    search: async input => { assert.equal(input.agentSessionKey, "agent:stella:main"); calls.push("wiki.search");
      return [{ path: origin.path, startLine: 1, endLine: 1, snippet: original.text, score: 0, source: "memory" }]; },
    get: async input => { assert.equal(input.agentSessionKey, "agent:stella:main"); calls.push("wiki.get"); return result; },
  } as Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0]);
  const api = { runtime: { version: "2026.8.2", config: { current: () => config } } } as unknown as OpenClawPluginApi;
  return { root, calls, config, api, db, reader: createNativeMemoryReader(api, "stella", "agent:stella:main"),
    setResult: (value: unknown) => { result = value; }, setHits: (value: unknown[]) => { hits = value; },
    setStatus: (patch: Record<string, unknown>) => { status = { ...status, ...patch }; },
    afterAuthorize: (action: () => void) => { afterAuthorize = action; },
    revoke: () => { live = false; }, current: async () => { if (!live) throw new Error("source_revoked"); } };
}

test("native memory origin accepts only a closed versioned relative range", () => {
  assert.deepEqual(parseNativeMemoryOrigin(origin), origin);
  for (const patch of [{ path: "../private.md" }, { path: "/absolute.md" }, { path: "memory/.git/private.md" },
    { path: "memory/source.txt" }, { path: "memory/a\\b.md" }, { path: "memory/a\u0000.md" }, { lineCount: 0 }, { lineCount: 121 },
    { fromLine: Number.MAX_SAFE_INTEGER },
    { fromLine: 0 }, { agentId: "" }, { provider: "arbitrary-plugin" }, { claimId: "wrong-provider" }, { grant: true }]) {
    assert.throws(() => parseNativeMemoryOrigin({ ...origin, ...patch }), /invalid_native_memory_origin/);
  }
});

test("native index bytes are consumed only after exact authorized hit and range validation", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t);
  assert.equal(await f.reader(origin, original, f.current), original.text);
  assert.deepEqual(f.calls, ["manager", "authorize", "read", "close"]);
  f.setResult({ status: "ok", path: origin.path, from: 1, lines: 1,
    text: "Retained source fragment.\n\n[More content available. Use from=2 to continue.]", truncated: true, nextFrom: 2 });
  assert.equal(await f.reader(origin, original, f.current), original.text);
  for (const patch of [{ text: "Changed cached content" }, { path: "memory/other.md" }, { from: 2 }, { lines: 2 },
    { status: "not_found" }, { text: "Retained source fragment.\nUNKNOWN" }, { truncated: true, nextFrom: 3 }]) {
    f.setResult({ status: "ok", path: origin.path, from: 1, lines: 1, text: "Retained source fragment.", ...patch });
    await assert.rejects(f.reader(origin, original, f.current), /native_memory_(payload_changed|read_unverifiable)/);
  }
  f.setHits([{ path: "memory/other.md", startLine: 1, endLine: 1 }]);
  const before = f.calls.filter(call => call === "read").length;
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_index_miss/);
  assert.equal(f.calls.filter(call => call === "read").length, before);
});

test("native wiki consumption revalidates between search and get and refuses changed cached bytes", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t), wiki = { ...origin, provider: "memory-wiki" as const };
  f.setResult({ corpus: "wiki", path: origin.path, fromLine: 1, lineCount: 1, content: original.text });
  assert.equal(await f.reader(wiki, original, f.current), original.text);
  assert.deepEqual(f.calls, ["wiki.search", "wiki.get"]);
  f.setResult(null);
  await assert.rejects(f.reader({ ...wiki, claimId: "compiled-claim" }, original, f.current), /native_memory_read_unverifiable/);
  assert.equal(f.calls.filter(call => call === "wiki.get").length, 2, "Missing claim cache never retries by page path");
  f.setResult({ corpus: "wiki", path: origin.path, fromLine: 1, lineCount: 1, content: "Old cache bytes." });
  await assert.rejects(f.reader(wiki, original, f.current), /native_memory_payload_changed/);
  f.calls.length = 0;
  let checks = 0;
  await assert.rejects(f.reader(wiki, original, async () => { if (++checks === 3) f.revoke(); await f.current(); }), /source_revoked/);
  assert.deepEqual(f.calls, ["wiki.search"]);
});

test("native locators cannot enable absent providers, other agents or other Host versions", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t);
  for (const patch of [{ agentId: "other" }, { hostVersion: "2026.8.3" }]) {
    await assert.rejects(f.reader({ ...origin, ...patch }, original, f.current));
  }
  f.config.plugins!.entries!["memory-core"]!.enabled = false;
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_provider_disabled/);
  f.config.plugins!.entries!["memory-core"]!.enabled = true;
  f.config.hooks!.internal!.entries!["session-memory"]!.enabled = false;
  await assert.rejects(f.reader({ ...origin, provider: "session-memory" }, original, f.current), /native_session_memory_disabled/);
  assert.deepEqual(f.calls, []);
});

test("inventory records the built-in session-memory hook independently of plugins.list", t => {
  const f = fixture(t);
  const inspect = () => inspectDeclaredHostMemory({ config: f.config, agentId: "stella", generationId: "one", plugins: { plugins: [] } });
  const enabled = inspect();
  assert.equal(enabled.entries.find(entry => entry.kind === "session-memory")?.state, "unverifiable");
  assert.equal(enabled.complete, false);
  assert.ok(enabled.blockers.includes("host_memory_consumption_unverifiable"));
  delete f.config.hooks!.internal!.entries!["session-memory"];
  assert.equal(inspect().entries.find(entry => entry.kind === "session-memory")?.state, "unverifiable");
  f.config.hooks!.internal!.enabled = false;
  assert.equal(inspect().entries.find(entry => entry.kind === "session-memory")?.state, "disabled");
  clearMemoryPluginState();
});


test("native exact index lookup refuses incomplete state without search or rebuild", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t);
  for (const patch of [{ dirty: true }, { chunks: 0 }, { custom: { indexIdentity: { status: "missing" } } },
    { custom: { indexIdentity: { status: "mismatched" } } }, { fallback: { from: "openai" } }, { lastSyncError: "index failed" }]) {
    f.setStatus({ dirty: false, chunks: 1, custom: { indexIdentity: { status: "valid" } }, fallback: undefined, lastSyncError: undefined, ...patch });
    await assert.rejects(f.reader(origin, original, f.current), /native_memory_index_unverifiable/);
  }
  assert.equal(f.calls.filter(call => call === "authorize" || call === "read").length, 0);
  assert.equal(f.calls.filter(call => call === "close").length, 6);
});

test("native index authorization preserves indexed provenance and rejects concurrent changes", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t);
  f.afterAuthorize(() => f.db.exec("UPDATE memory_index_chunks SET hash = 'Changed indexed hash'"));
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_index_changed/);
  assert.deepEqual(f.calls, ["manager", "authorize", "close"]);
  f.afterAuthorize(() => {});
  f.db.exec("UPDATE memory_index_sources SET hash = ''");
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_index_unverifiable/);
});


test("native index cannot certify an unrelated indexed body for an authorized locator", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t);
  f.db.exec("UPDATE memory_index_chunks SET text = 'Unrelated indexed content'; UPDATE memory_index_chunks_fts SET text = 'Unrelated indexed content'");
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_index_payload_changed/);
  assert.deepEqual(f.calls, ["manager", "close"]);
});

test("verified native read digests bind index identity and never observe rejected bytes", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t), observations: Array<{ origin: NativeMemoryOrigin; digest: string }> = [];
  const read = createNativeMemoryReader(f.api, "stella", "agent:stella:main", value => observations.push(value));
  await read(origin, original, f.current);
  await read(origin, original, f.current);
  assert.deepEqual(observations[0], observations[1]);
  assert.deepEqual(observations[0]!.origin, origin);
  assert.match(observations[0]!.digest, /^sha256:[a-f0-9]{64}$/);
  f.db.exec("UPDATE memory_index_chunks SET hash = 'second-chunk-hash'");
  await read(origin, original, f.current);
  assert.notEqual(observations[0]!.digest, observations[2]!.digest);
  f.setResult({ status: "ok", path: origin.path, from: 1, lines: 1, text: "Changed bytes" });
  await assert.rejects(read(origin, original, f.current), /native_memory_payload_changed/);
  assert.equal(observations.length, 3);
});

test("verified Wiki read digests bind compiled claim lookup and reject absent cache", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(t), observations: Array<{ origin: NativeMemoryOrigin; digest: string }> = [];
  const read = createNativeMemoryReader(f.api, "stella", "agent:stella:main", value => observations.push(value));
  const wiki = { ...origin, provider: "memory-wiki" as const, claimId: "compiled-claim" };
  f.setResult({ corpus: "wiki", path: origin.path, fromLine: 1, lineCount: 1, content: original.text });
  await read(wiki, original, f.current);
  await read(wiki, original, f.current);
  assert.deepEqual(observations[0], observations[1]);
  assert.deepEqual(observations[0]!.origin, wiki);
  f.setResult(null);
  await assert.rejects(read(wiki, original, f.current), /native_memory_read_unverifiable/);
  assert.equal(observations.length, 2);
});

async function vectorFixture(t: TestContext) {
  const f = fixture(t);
  assert.equal((await loadSqliteVecExtension({ db: f.db })).ok, true);
  f.config.memory!.search = { ...f.config.memory!.search, provider: "openai", model: "synthetic-embedding",
    store: { vector: { enabled: true } }, cache: { enabled: true } };
  f.setStatus({ vector: { enabled: true, index: { state: "complete" } } });
  f.db.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]);
    CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE memory_embedding_cache (provider TEXT, model TEXT, provider_key TEXT, hash TEXT, embedding TEXT, dims INTEGER);
    UPDATE memory_index_chunks SET model = 'synthetic-embedding', embedding = '[1,0,0]';
    UPDATE memory_index_chunks_fts SET model = 'synthetic-embedding';
    INSERT INTO memory_index_meta VALUES ('memory_vector_rebuild_v1', 'clean');`);
  f.db.prepare("INSERT INTO memory_index_meta VALUES ('memory_index_meta_v1', ?)").run(JSON.stringify({
    provider: "openai", model: "synthetic-embedding", providerKey: "a".repeat(64), vectorDims: 3 }));
  f.db.prepare("INSERT INTO memory_embedding_cache VALUES ('openai', 'synthetic-embedding', ?, 'chunk-hash', '[1,0,0]', 3)").run("a".repeat(64));
  f.db.prepare("INSERT INTO memory_index_chunks_vec VALUES ('chunk', ?)").run(new Float32Array([1, 0, 0]));
  return f;
}

test("native vector-backed reads bind the actual vector and embedding cache without search", async t => {
  t.after(clearMemoryPluginState);
  const f = await vectorFixture(t), observations: string[] = [];
  const read = createNativeMemoryReader(f.api, "stella", "agent:stella:main", value => observations.push(value.digest));
  assert.equal(await read(origin, original, f.current), original.text);
  assert.deepEqual(f.calls, ["manager", "authorize", "read", "close"]);
  f.db.exec("UPDATE memory_index_chunks SET embedding = '[0,1,0]'; UPDATE memory_embedding_cache SET embedding = '[0,1,0]'");
  f.db.prepare("UPDATE memory_index_chunks_vec SET embedding = ? WHERE id = 'chunk'").run(new Float32Array([0, 1, 0]));
  assert.equal(await read(origin, original, f.current), original.text);
  assert.notEqual(observations[0], observations[1], "Vector/cache changes must change the consumption digest");
});

test("a complete vector marker cannot certify missing or changed selected vector bytes", async t => {
  t.after(clearMemoryPluginState);
  const f = await vectorFixture(t);
  f.db.prepare("UPDATE memory_index_chunks_vec SET embedding = ? WHERE id = 'chunk'").run(new Float32Array([0, 1, 0]));
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_vector_payload_changed/);
  f.db.exec("DELETE FROM memory_index_chunks_vec WHERE id = 'chunk'");
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_vector_unverifiable/);
  assert.equal(f.calls.filter(call => call === "read" || call === "authorize").length, 0);
});

test("vector consumption rejects absent or mismatched cache and explicit rebuild state", async t => {
  t.after(clearMemoryPluginState);
  const f = await vectorFixture(t);
  for (const sql of ["UPDATE memory_embedding_cache SET embedding = '[0,1,0]'", "DELETE FROM memory_embedding_cache"]) {
    f.db.exec(sql);
    await assert.rejects(f.reader(origin, original, f.current), /native_memory_embedding_cache_unverifiable/);
  }
  f.db.exec("UPDATE memory_index_meta SET value = '1' WHERE key = 'memory_vector_rebuild_v1'");
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_vector_unverifiable/);
  assert.equal(f.calls.filter(call => call === "read" || call === "authorize").length, 0);
});

test("concurrent vector invalidation wins before native file read", async t => {
  t.after(clearMemoryPluginState);
  const f = await vectorFixture(t);
  f.afterAuthorize(() => f.db.prepare("UPDATE memory_index_chunks_vec SET embedding = ? WHERE id = 'chunk'").run(new Float32Array([0, 1, 0])));
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_vector_payload_changed/);
  assert.deepEqual(f.calls, ["manager", "authorize", "close"]);
});

test("original query transport binds actual native KNN and rejects changed candidates before later consumption", async t => {
  t.after(clearMemoryPluginState);
  const f = await vectorFixture(t), calls: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "synthetic-embedding", data: [{ index: 0, embedding: [1, 0, 0] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  f.config.memory!.search!.fallback = "none";
  f.config.memory!.search!.remote = { baseUrl, apiKey: "synthetic-local-only" };
  const providerKey = bytesVersion(JSON.stringify({ provider: "openai", baseUrl, model: "synthetic-embedding",
    headers: [["Content-Type", "application/json"]] })).slice(7);
  f.db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(JSON.stringify({
    provider: "openai", model: "synthetic-embedding", providerKey, vectorDims: 3 }));
  f.db.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(providerKey);
  // Same direction but different magnitude: the pinned Host scores cosine,
  // while sqlite-vec's default table distance is Euclidean.
  f.db.exec("UPDATE memory_index_chunks SET embedding = '[2,0,0]'; UPDATE memory_embedding_cache SET embedding = '[2,0,0]'");
  f.db.prepare("UPDATE memory_index_chunks_vec SET embedding = ? WHERE id = 'chunk'").run(new Float32Array([2, 0, 0]));
  const purpose = { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "private" };
  await writeFile(path.join(f.root, "grant.json"), JSON.stringify({ schemaVersion: "stella.personal-context-access/v1", ownerId: "owner",
    requesterIds: ["cli"], modelRefs: ["stella-guarded/model"], purpose, descriptors: [],
    queryEmbedding: { provider: "openai", model: "synthetic-embedding", endpoint: `${baseUrl}/embeddings`, dimensions: 3 } }));
  const request = snapshotTurnRequest({ agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
    prompt: "Original synthetic query", senderIsOwner: true, senderId: "cli", chatType: "direct" }, "run-query");
  const authority = bindProcessingAuthority({ request, ownerId: "owner", purpose, modelRef: "stella-guarded/model",
    deployment: bytesVersion("deployment"), generationId: "one" });
  const query = createNativeQueryEmbedding({ request, authority, processingGrant: await loadPersonalContextAccess(f.root, "grant.json"),
    currentConfig: () => f.config, assertCurrent: f.current });
  const read = createNativeMemoryReader(f.api, "stella", request.sessionKey, undefined, query);
  await read.assertQueryCurrent();
  assert.equal(await read(origin, original, f.current), original.text);
  await read.assertQueryCurrent(); await read.assertQueryCurrent();
  assert.deepEqual(calls, [{ model: "synthetic-embedding", input: [request.prompt] }]);
  f.db.exec("INSERT INTO memory_index_chunks SELECT 'other', 'memory/other.md', source, start_line, end_line, text, hash, model, embedding FROM memory_index_chunks WHERE id = 'chunk'");
  f.db.prepare("INSERT INTO memory_index_chunks_vec VALUES ('other', ?)").run(new Float32Array([1, 0, 0]));
  await assert.rejects(read.assertQueryCurrent(), /native_query_embedding_consumption_changed/);
  assert.equal(calls.length, 1, "Revalidation never resends a query or embeds a document");
});
