import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listenOnLoopback } from "./loopback-server.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { bytesVersion } from "../src/canghai/content-version.js";
import { loadPersonalContextAccess, parsePersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { createNativeQueryEmbedding, readNativeQueryEmbedding } from "../src/openclaw/native-query-embedding.js";
import { bindProcessingAuthority } from "../src/openclaw/processing-authority.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { hostContextExecutionHash } from "../src/openclaw/host-memory-inventory.js";

async function fixture(t: TestContext, managed = false, signal?: AbortSignal) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-query-embedding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let payload: unknown = { model: "synthetic-embedding", data: [{ index: 0, embedding: [1, 0, 0] }] };
  let status = 200, afterRequest = async () => {}, current = true;
  const calls: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    await afterRequest();
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
  });
  await listenOnLoopback(t, server);
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const config = { memory: { search: { enabled: true, provider: "openai", model: "synthetic-embedding", fallback: "none",
    remote: { baseUrl, apiKey: "synthetic-local-only" }, store: { vector: { enabled: true } } } } } as OpenClawConfig;
  const recovery = { agentId: "stella", canghaiRoot: root, recoveryRevision: "a".repeat(40) };
  if (managed) config.plugins = { entries: { "stella-core": { enabled: true, config: { ...recovery, dataMode: "managed_durable_write" } } } };
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["cli"],
    modelRefs: ["stella-guarded/model"], purpose: { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "private" }, descriptors: [],
    queryEmbedding: { provider: "openai", model: "synthetic-embedding", endpoint: `${baseUrl}/embeddings`, dimensions: 3 } };
  const save = () => writeFile(path.join(root, "grant.json"), JSON.stringify(grant));
  await save();
  const request = snapshotTurnRequest({ agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
    prompt: "我的合成查询，不附加原文或历史。", senderId: "cli", senderIsOwner: true, chatType: "direct" }, "query-run");
  const authority = bindProcessingAuthority({ request, ownerId: "owner", purpose: grant.purpose, modelRef: "stella-guarded/model",
    deployment: bytesVersion("deployment"), generationId: "one" });
  const binding = await loadPersonalContextAccess(root, "grant.json");
  const embedding = createNativeQueryEmbedding({ request, authority, processingGrant: binding, currentConfig: () => config, signal,
    ...(managed ? { configurationHash: () => hostContextExecutionHash(config, recovery) } : {}),
    assertCurrent: async () => { if (!current) throw new Error("source_revoked"); } });
  const settings = resolveMemorySearchConfig(config, "stella")!;
  const index = { model: grant.queryEmbedding.model, dimensions: 3, providerKey: bytesVersion(JSON.stringify({ provider: "openai", baseUrl,
    model: grant.queryEmbedding.model, headers: [["Content-Type", "application/json"]] })).slice(7) };
  return { config, grant, save, request, calls, settings, index, embedding, recovery, revoke: () => { current = false; },
    response: (value: unknown, code = 200) => { payload = value; status = code; }, afterRequest: (fn: () => Promise<void>) => { afterRequest = fn; } };
}

test("query embedding has a closed independent processing grant", () => {
  const base = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["cli"], modelRefs: ["guarded/model"],
    purpose: { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "private" }, descriptors: [] };
  const grant = { provider: "openai", model: "embedding", endpoint: "https://example.invalid/v1/embeddings", dimensions: 384 };
  assert.deepEqual(parsePersonalContextAccess({ ...base, queryEmbedding: grant }).queryEmbedding, grant);
  const consolidation = { ...base, viewProcessingModelRefs: base.modelRefs, operatorMemoryConsolidation: true };
  assert.equal(parsePersonalContextAccess(consolidation).queryEmbedding, undefined);
  const combined = parsePersonalContextAccess({ ...consolidation, queryEmbedding: grant });
  assert.deepEqual(combined.queryEmbedding, grant);
  assert.equal(combined.operatorMemoryConsolidation, true);
  assert.equal(parsePersonalContextAccess({ ...base, queryEmbedding: grant }).operatorMemoryConsolidation, undefined);
  assert.throws(() => parsePersonalContextAccess({ ...combined, operatorMemoryConsolidation: false }), /invalid_operator_memory_consolidation_grant/);
  for (const patch of [{ provider: "arbitrary-plugin" }, { dimensions: 0 }, { dimensions: 8193 }, { model: "" }, { batch: true },
    { endpoint: "https://secret@example.invalid/v1/embeddings" }, { endpoint: "https://example.invalid/v1/embeddings?x=1" }])
    assert.throws(() => parsePersonalContextAccess({ ...base, queryEmbedding: { ...grant, ...patch } }), /invalid_query_embedding_grant/);
  assert.throws(() => readNativeQueryEmbedding({ kind: "native_query_embedding" }), /native_query_embedding_unbound/);
});

test("actual query transport is single-flight, exact and bound to immutable returned vector", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.embedding(f.settings, f.index), f.embedding(f.settings, f.index)]);
  assert.equal(first, second);
  assert.deepEqual(f.calls, [{ model: "synthetic-embedding", input: [f.request.prompt] }]);
  const binding = readNativeQueryEmbedding(first); assert.deepEqual(binding.vector, [1, 0, 0]);
  binding.vector[0] = 0; assert.deepEqual(readNativeQueryEmbedding(first).vector, [1, 0, 0]);
  await binding.assertCurrent();
  f.config.memory!.search!.model = "other";
  await assert.rejects(binding.assertCurrent(), /native_query_embedding_configuration_changed/);
  assert.throws(() => f.embedding(f.settings, { ...f.index, dimensions: 4 }), /native_query_embedding_identity_mismatch/);
});

test("query model, dimensions, fallback, endpoint and index identity fail before network", async t => {
  for (const patch of [{ model: "other" }, { dimensions: 4 }, { providerKey: "wrong" }]) {
    const f = await fixture(t);
    await assert.rejects(f.embedding(f.settings, { ...f.index, ...patch }), /native_query_embedding_identity_mismatch/);
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t); f.settings.fallback = "other";
  await assert.rejects(f.embedding(f.settings, f.index), /native_query_embedding_identity_mismatch/); assert.equal(f.calls.length, 0);
});

test("query grant or source revoked during transport cannot mint a consumption receipt", async t => {
  const f = await fixture(t); f.afterRequest(async () => { f.revoke(); });
  await assert.rejects(f.embedding(f.settings, f.index), /source_revoked/); assert.equal(f.calls.length, 1);
  const other = await fixture(t); other.afterRequest(async () => { other.grant.queryEmbedding.model = "revoked"; await other.save(); });
  await assert.rejects(other.embedding(other.settings, other.index), /personal_context_access_changed/);
});

test("query response model, count, index, dimensions, zero and nonfinite vectors fail closed", async t => {
  for (const payload of [ { model: "other", data: [{ index: 0, embedding: [1, 0, 0] }] },
    { model: "synthetic-embedding", data: [] }, { model: "synthetic-embedding", data: [{ index: 1, embedding: [1, 0, 0] }] },
    { model: "synthetic-embedding", data: [{ index: 0, embedding: [1] }] },
    { model: "synthetic-embedding", data: [{ index: 0, embedding: [0, 0, 0] }] },
    { model: "synthetic-embedding", data: [{ index: 0, embedding: [null, 0, 0] }] } ]) {
    const f = await fixture(t); f.response(payload);
    await assert.rejects(f.embedding(f.settings, f.index), /native_query_embedding_response_invalid/); assert.equal(f.calls.length, 1);
  }
});

test("transport failure is explicit and never retries or falls back", async t => {
  const f = await fixture(t); f.response({}, 503);
  await assert.rejects(f.embedding(f.settings, f.index), /native_query_embedding_transport_failed/);
  await assert.rejects(f.embedding(f.settings, f.index), /native_query_embedding_transport_failed/);
  assert.equal(f.calls.length, 1);
});

test("managed query revalidation permits only the Core-held recovery CAS and keeps execution settings pinned", async t => {
  const f = await fixture(t, true), receipt = await f.embedding(f.settings, f.index);
  const binding = readNativeQueryEmbedding(receipt), entry = f.config.plugins!.entries!["stella-core"]!.config!;
  entry.recoveryRevision = "b".repeat(40);
  await assert.rejects(binding.assertCurrent(), /host_context_recovery_binding_changed/);
  f.recovery.recoveryRevision = String(entry.recoveryRevision);
  await binding.assertCurrent();
  f.config.memory!.search!.remote!.baseUrl = "https://other.invalid/v1";
  await assert.rejects(binding.assertCurrent(), /native_query_embedding_configuration_changed/);
  assert.equal(f.calls.length, 1);
});

test("Core cancellation prevents query dispatch and invalidates an in-flight response", async t => {
  const cancelled = new AbortController(); cancelled.abort();
  const before = await fixture(t, false, cancelled.signal);
  await assert.rejects(before.embedding(before.settings, before.index), /native_query_embedding_cancelled/);
  assert.equal(before.calls.length, 0);
  const controller = new AbortController(), during = await fixture(t, false, controller.signal);
  during.afterRequest(async () => { controller.abort(); });
  await assert.rejects(during.embedding(during.settings, during.index), /native_query_embedding_cancelled/);
  assert.equal(during.calls.length, 1);
});


test("configured Gemini native query cannot acquire an unsupported Core processing grant", () => {
  const base = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["cli"], modelRefs: ["guarded/model"],
    purpose: { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "private" }, descriptors: [] };
  assert.throws(() => parsePersonalContextAccess({ ...base, queryEmbedding: { provider: "gemini", model: "gemini-embedding-001",
    dimensions: 3072, endpoint: "https://example.invalid/v1beta/models/gemini-embedding-001:embedContent" } }), /invalid_query_embedding_grant/);
});
