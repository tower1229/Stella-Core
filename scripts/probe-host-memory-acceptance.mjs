import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { createFixture, initializeFixtureRepository, prepareInitializationFixture } from "../.test-dist/tests/consciousness-fixture.js";
import { startExactHostGateway, inspectExactHostSourceTransition } from "./lib/exact-host-gateway.mjs";
import { HOST_MEMORY_ACCEPTANCE_MATRIX, assertHostMemoryAcceptanceReport } from "./lib/host-memory-evidence.mjs";

const scenario = process.argv[2] ?? "success";
const nativeProvider = process.argv[3] ?? "memory-core";
const indexMode = process.argv[4] ?? "fts";
const googleWire = process.argv.includes("--google-wire");
if (googleWire) {
  const allowed = indexMode === "fts" ? ["success", "grant-denied", "native-stale-before-model"]
    : indexMode === "vector" ? ["source-deleted-before-model"] : [];
  assert.ok(nativeProvider === "memory-core" && allowed.includes(scenario), "Google wire smoke has an explicit bounded scenario set");
}
const probeModelId = googleWire ? "gemini-3.8-flash" : "probe";
const probeModelRef = `stella-guarded/${probeModelId}`;
const queryIndex = indexMode === "query";
const vectorIndex = indexMode === "vector" || queryIndex;
const queryRequest = "Read the configured synthetic native observation for constrained verification.";
assert.ok(HOST_MEMORY_ACCEPTANCE_MATRIX.some(entry => entry.provider === nativeProvider && entry.scenario === scenario && (entry.indexMode ?? "fts") === indexMode));
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const moduleUrl = relative => pathToFileURL(path.join(packageRoot, "dist", relative)).href;
const sdkUrl = relative => pathToFileURL(path.join(hostRoot, "dist/plugin-sdk", relative)).href;
assert.equal(JSON.parse(await readFile(path.join(hostRoot, "package.json"))).version, "2026.8.2");
const { GatewayClient } = await import(sdkUrl("gateway-runtime.js"));
const { bytesVersion, canonicalJson, objectVersion } = await import(moduleUrl("src/canghai/content-version.js"));
const { prepareRepositorySource } = await import(moduleUrl("src/canghai/repository-source.js"));
const run = promisify(execFile);
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-host-memory-acceptance-"));
process.stderr.write(`Constrained memory evidence: ${temp}\n`);
const state = path.join(temp, "state"), workspace = path.join(temp, "workspace"), plugin = path.join(temp, "plugin");
await Promise.all([state, workspace, plugin].map(dir => mkdir(dir)));
const vault = path.join(temp, "vault");
let producerReport, nativeSource;
if (nativeProvider !== "memory-core") {
  assert.ok(process.env.STELLA_NATIVE_PRODUCERS_REPORT, "Native certification requires actual Host producer evidence");
  producerReport = JSON.parse(await readFile(process.env.STELLA_NATIVE_PRODUCERS_REPORT));
  assert.equal(producerReport.schemaVersion, "stella.native-memory-producers/v1");
  assert.equal(producerReport.hostVersion, "2026.8.2"); assert.equal(producerReport.dreamingEnabled, false);
  assert.equal(producerReport.nativeSessionNewExecuted, true); assert.equal(producerReport.nativeWikiCompileExecuted, true);
  assert.equal(producerReport.nativeCompiledClaimRead, true);
  nativeSource = producerReport.artifacts.find(entry => entry.provider === nativeProvider); assert.ok(nativeSource);
  assert.equal(createHash("sha256").update(await readFile(nativeSource.rawPath)).digest("hex"), nativeSource.rawSha256);
  await cp(producerReport.workspace, workspace, { recursive: true });
  await cp(producerReport.vault, vault, { recursive: true });
}
await mkdir(path.join(workspace, "memory"), { recursive: true });
const original = nativeSource?.text ?? "SYNTHETIC_CONSTRAINED_NATIVE_ORIGINAL\n";
const changedNativeText = original.replace("SYNTHETIC_", "SYNTHETIC_CHANGED_");
assert.notEqual(changedNativeText, original);
const nativePath = nativeSource?.nativePath ?? "memory/verified.md";
const nativeFile = path.join(nativeProvider === "memory-wiki" ? vault : workspace, nativePath);
if (!nativeSource) await writeFile(nativeFile, original);
const canghaiRoot = await createFixture();
await prepareInitializationFixture(canghaiRoot, "probe");
const base = "50_PersonalAgent/stella";
const catalogPath = path.join(canghaiRoot, "30_PersonalData/memory/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath));
const policy = { schemaVersion: "stella.source-policy/v1", id: "constrained-native", ownerId: "owner-fixture",
  readPurposes: scenario === "source-denied" ? [] : ["alpha_praxis"], derivePurposes: ["alpha_praxis"], deliveryScopes: ["host-chat"],
  retention: "retain", authorityEvidenceRefs: [] };
const policyRef = { id: policy.id, version: objectVersion(policy) };
const policyPath = "30_PersonalData/memory/constrained-policy.json", body = canonicalJson(policy);
await writeFile(path.join(canghaiRoot, policyPath), body);
catalog.policies.push({ ...policyRef, status: "current", dependencies: [], locator: { path: policyPath, sha256: bytesVersion(body) } });
const retained = "30_PersonalData/memory/native-retained.md";
await writeFile(path.join(canghaiRoot, retained), original);
const imported = await prepareRepositorySource({ root: canghaiRoot, collectionId: "constrained-native", sourceId: "constrained-native",
  relativePath: retained, expectedSha256: bytesVersion(original), capturedAt: "2026-09-01T00:00:00Z", policyRef,
  nativeMemory: { schemaVersion: "stella.native-memory-origin/v1", hostVersion: "2026.8.2", agentId: "probe", provider: nativeProvider,
    path: nativePath, fromLine: 1, lineCount: nativeSource?.lineCount ?? 1, ...(nativeSource?.claimId ? { claimId: nativeSource.claimId } : {}) },
  objectRoot: "30_PersonalData/memory/objects", reviewedSegments: [{ start: 0, end: Buffer.byteLength(original), policyRef }] });
for (const object of imported.objects) {
  await mkdir(path.dirname(path.join(canghaiRoot, object.entry.locator.path)), { recursive: true });
  await writeFile(path.join(canghaiRoot, object.entry.locator.path), object.bytes); catalog[object.group].push(object.entry);
}
await writeFile(catalogPath, canonicalJson(catalog));
const evidenceRef = imported.objects.find(object => object.group === "evidence").entry;
const profilePath = path.join(canghaiRoot, base, "runtime-profile.yaml");
const profile = parse(await readFile(profilePath, "utf8"));
profile.agent_id = "probe"; profile.contract_profile = "full_memory";
profile.memory.semantic_provider = "stella-structured-llm"; profile.memory.required_views = ["current_understanding", "ongoing_work"];
for (const role of Object.values(profile.models)) { role.provider = "stella-guarded"; role.model = probeModelId; role.required_capabilities = []; }
const lifecycle = profile.capabilities.find(capability => capability.id === "transcript_archive");
lifecycle.id = "memory_lifecycle"; lifecycle.adapter_id = "stella.memory-lifecycle";
const bindingPath = path.join(canghaiRoot, base, "praxis-binding.json");
const binding = JSON.parse(await readFile(bindingPath)); binding.schemaVersion = "stella.memory-runtime-binding/v1";
await writeFile(bindingPath, canonicalJson(binding));
profile.capabilities.push(...[
  ["source_access_context", "stella.personal-context-access", "personal-access.json"],
  ["memory_access", "stella.memory-access", "memory-acceptance.json"],
].map(([id, adapter_id, file]) => ({ id, adapter_id, adapter_version: "1", required: true, config_ref: `path:${base}/${file}`,
  acceptance_ref: `path:${base}/capability-acceptance.json`, required_secret_refs: [] })));
await writeFile(profilePath, stringify(profile));
await writeFile(path.join(canghaiRoot, base, "personal-access.json"), canonicalJson({
  schemaVersion: "stella.personal-context-access/v1", ownerId: "owner-fixture", requesterIds: ["cli"], modelRefs: [probeModelRef],
  viewProcessingModelRefs: [probeModelRef], purpose: binding.purpose,
  ...(scenario === "grant-denied" ? {} : { operatorMemoryAcceptance: true }),
  descriptors: [{ sourceRef: imported.sourceRef, policyRef, description: "The explicitly requested synthetic native observation",
    segment: { payloadSha256: bytesVersion(original), start: 0, end: Buffer.byteLength(original) } }],
}));
await writeFile(path.join(canghaiRoot, base, "memory-acceptance.json"), canonicalJson({ schemaVersion: "stella.host-memory-acceptance/v1",
  request: queryRequest, ...(queryIndex ? { queryEmbedding: true } : {}), evidenceRef: { id: evidenceRef.id, version: evidenceRef.version } }));
if (producerReport) {
  const retained = path.join(canghaiRoot, "30_PersonalData/native-producer"); await mkdir(retained, { recursive: true });
  await cp(producerReport.workspace, path.join(retained, "workspace"), { recursive: true });
  await cp(producerReport.vault, path.join(retained, "vault"), { recursive: true });
  await cp(path.join(producerReport.evidenceDirectory, "wiki-input.md"), path.join(retained, "wiki-input.md"));
  await writeFile(path.join(retained, "producer.json"), JSON.stringify(producerReport, null, 2));
}
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "constrained-memory-probe", type: "module", version: "0.0.0", openclaw: { extensions: ["./index.mjs"] } }));
await cp(path.join(packageRoot, "openclaw.plugin.json"), path.join(plugin, "openclaw.plugin.json"));
await writeFile(path.join(plugin, "index.mjs"), `
import main from ${JSON.stringify(moduleUrl("src/plugin.js"))};
import { getMemoryCapabilityRegistration } from ${JSON.stringify(sdkUrl("memory-host-core.js"))};
import { listMemoryCorpusSupplements } from ${JSON.stringify(sdkUrl("memory-core-host-runtime-core.js"))};
import { resolveCommandAuthorization } from ${JSON.stringify(sdkUrl("command-auth.js"))};
import { resolveTurnAudience } from ${JSON.stringify(moduleUrl("src/openclaw/turn-audience.js"))};
import { appendFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadSqliteVecExtension } from ${JSON.stringify(sdkUrl("memory-core-host-engine-storage.js"))};
let indexedDbPath;
const mutateVector = async scenario => {
  const db = new DatabaseSync(indexedDbPath, { allowExtension: true });
  try {
    if (!(await loadSqliteVecExtension({ db })).ok) throw new Error('vector_extension_missing');
    const selected = db.prepare('SELECT id FROM memory_index_chunks WHERE path = ?').all(${JSON.stringify(nativePath)});
    const embedding = Array.from({ length: 384 }, (_, index) => index === 1 ? 1 : 0);
    for (const row of selected) {
      if (scenario === 'vector-row-missing') db.prepare('DELETE FROM memory_index_chunks_vec WHERE id = ?').run(row.id);
      if (['vector-row-mismatch', 'vector-invalidated-before-model', 'vector-generation-changed-before-model'].includes(scenario))
        db.prepare('UPDATE memory_index_chunks_vec SET embedding = ? WHERE id = ?').run(new Float32Array(embedding), row.id);
      if (scenario === 'vector-generation-changed-before-model') db.prepare('UPDATE memory_index_chunks SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), row.id);
    }
    if (scenario === 'embedding-cache-missing') db.exec('DELETE FROM memory_embedding_cache');
    if (['embedding-cache-mismatch', 'cache-invalidated-before-model', 'vector-generation-changed-before-model'].includes(scenario))
      db.prepare('UPDATE memory_embedding_cache SET embedding = ?').run(JSON.stringify(embedding));
  } finally { db.close(); }
};
const afterRead = async actual => {
  appendFileSync(${JSON.stringify(path.join(temp, "native-read.jsonl"))}, JSON.stringify(actual) + '\\n');
  if (!${JSON.stringify(["native-stale-before-model", "source-deleted-before-model", "grant-revoked-before-model", "native-cache-invalidated", "vector-invalidated-before-model", "cache-invalidated-before-model", "vector-generation-changed-before-model"].includes(scenario))} ||
      existsSync(${JSON.stringify(path.join(temp, "invalidation.json"))})) return;
  const modelCalls = readdirSync(${JSON.stringify(temp)}).filter(name => /^model-[0-9]+[.]json$/.test(name)).length;
  if (${scenario === "native-stale-before-model"}) writeFileSync(${JSON.stringify(nativeFile)}, ${JSON.stringify(changedNativeText)});
  if (${scenario === "source-deleted-before-model"}) unlinkSync(${JSON.stringify(path.join(canghaiRoot, retained))});
  if (${scenario === "grant-revoked-before-model"}) {
    const file = ${JSON.stringify(path.join(canghaiRoot, base, "personal-access.json"))};
    const config = JSON.parse(readFileSync(file, 'utf8')); config.operatorMemoryAcceptance = false;
    writeFileSync(file, JSON.stringify(config));
  }
  if (${scenario === "native-cache-invalidated"}) {
    if (${nativeProvider === "memory-wiki"}) unlinkSync(${JSON.stringify(path.join(vault, ".openclaw-wiki/log.jsonl"))});
    else { const db = new DatabaseSync(indexedDbPath); try { db.exec('UPDATE memory_index_chunk_provenance SET observed_at = observed_at + 1'); } finally { db.close(); } }
  }
  if (${JSON.stringify(vectorIndex)}) await mutateVector(${JSON.stringify(scenario)});
  writeFileSync(${JSON.stringify(path.join(temp, "invalidation.json"))}, JSON.stringify({ scenario: ${JSON.stringify(scenario)}, modelCalls, nativeBodyRetained: existsSync(${JSON.stringify(nativeFile)}) }));
};
export default { ...main, register(api) {
  api.registerGatewayMethod('stella.syntheticSourceRevision', ({ respond }) => {
    respond(true, { revision: api.runtime.config.current().plugins.entries['stella-core'].config.recoveryRevision });
  }, { scope: 'operator.admin' });
  api.registerGatewayMethod('stella.syntheticAdvanceSource', async ({ params, respond }) => {
    await api.runtime.config.mutateConfigFile({ afterWrite: { mode: 'auto' }, mutate(draft) {
      draft.plugins.entries['stella-core'].config.recoveryRevision = params.revision;
    } });
    respond(true, { advanced: true });
  }, { scope: 'operator.admin' });
  api.registerGatewayMethod('stella.syntheticPrepareIndex', async ({ respond }) => {
    if (${nativeProvider === "memory-wiki"}) {
      const entry = listMemoryCorpusSupplements().find(entry => entry.pluginId === 'memory-wiki');
      if (!entry) throw new Error('native_wiki_registration_missing');
      const get = entry.supplement.get.bind(entry.supplement);
      entry.supplement.get = async input => {
        if (${scenario === "native-mismatch"}) writeFileSync(${JSON.stringify(nativeFile)}, ${JSON.stringify(changedNativeText)});
        const actual = await get(input); await afterRead(actual); return actual;
      };
      respond(true, { wiki: true }); return;
    }
    const runtime = getMemoryCapabilityRegistration()?.capability.runtime;
    if (!runtime) throw new Error('native_registration_missing');
    const { manager } = await runtime.getMemorySearchManager({ cfg: api.runtime.config.current(), agentId: 'probe' });
    if (!manager) throw new Error('native_manager_missing');
    if (${scenario !== "index-missing"}) await manager.sync({ force: true });
    let vectorSearch;
    if (${vectorIndex && scenario !== "index-missing"}) {
      const query = 'Which earlier observation is authorized for this verification?';
      const hits = await manager.search(query, { maxResults: 32, minScore: 0.1, sources: ['memory'], sessionKey: 'agent:probe:main' });
      vectorSearch = { query, hits, status: manager.status() };
      writeFileSync(${JSON.stringify(path.join(temp, "native-vector-search.json"))}, JSON.stringify(vectorSearch));
    }
    const status = manager.status(); indexedDbPath = status.dbPath; await manager.close();
    if (${JSON.stringify(vectorIndex && ["vector-row-missing", "vector-row-mismatch", "embedding-cache-missing", "embedding-cache-mismatch"].includes(scenario))}) await mutateVector(${JSON.stringify(scenario)});
    const get = runtime.getMemorySearchManager.bind(runtime);
    runtime.getMemorySearchManager = async (...args) => {
      const result = await get(...args);
      if (result.manager) {
        const read = result.manager.readFile.bind(result.manager);
        result.manager.search = async () => { throw new Error('consumer_search_forbidden'); };
        result.manager.sync = async () => { throw new Error('consumer_sync_forbidden'); };
        result.manager.readFile = async (...input) => {
          if (${scenario === "native-mismatch"}) writeFileSync(${JSON.stringify(nativeFile)}, ${JSON.stringify(changedNativeText)});
          const actual = await read(...input);
          await afterRead(actual);
          return actual;
        };
      }
      return result;
    };
    respond(true, { ...status, ...(vectorSearch ? { vectorSearch } : {}) });
  }, { scope: 'operator.admin' });
  main.register({ ...api, logger: { ...api.logger, error(message) {
    appendFileSync(${JSON.stringify(path.join(temp, "diagnostics.jsonl"))}, JSON.stringify({ message }) + '\\n'); api.logger.error(message);
  } }, registerProvider(provider) {
    if (${googleWire} && provider.id === 'stella-guarded') {
      const wrap = provider.wrapSimpleCompletionStreamFn;
      provider = { ...provider, wrapSimpleCompletionStreamFn(context) {
        const original = context.streamFn;
        const bound = wrap({ ...context, streamFn: original ? async (model, input, options) => {
          const rawStream = await original(model, input, {
          ...options, async onPayload(payload, payloadModel) {
            const describeControl = value => ({ keys: Object.keys(value ?? {}), configKeys: Object.keys(value?.config ?? {}),
              signalType: typeof value?.config?.abortSignal?.addEventListener, signalSame: value?.config?.abortSignal === options?.signal });
            const before = describeControl(payload);
            const result = await options?.onPayload?.(payload, payloadModel);
            writeFileSync(${JSON.stringify(path.join(temp, "transport-control.json"))}, JSON.stringify({ api: model.api, sourceApi: context.sourceApi,
              optionSignalType: typeof options?.signal?.addEventListener, before, after: describeControl(result ?? payload) }));
            return result;
          },
          });
          return { async *[Symbol.asyncIterator]() {
            for await (const event of rawStream) {
              if (event.type === 'done') {
                const undefinedPaths = [];
                const walk = (value, key) => {
                  if (value === undefined) undefinedPaths.push(key);
                  else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) walk(child, key + '.' + name);
                };
                walk(event.message, 'message');
                writeFileSync(${JSON.stringify(path.join(temp, "sdk-message-shape.json"))}, JSON.stringify({ undefinedPaths }));
              }
              appendFileSync(${JSON.stringify(path.join(temp, "sdk-events.jsonl"))}, JSON.stringify(event) + String.fromCharCode(10));
              yield event;
            }
          }, async result() {
            const message = await rawStream.result();
            appendFileSync(${JSON.stringify(path.join(temp, "sdk-output.jsonl"))}, JSON.stringify(message) + '\\n');
            return message;
          } };
        } : undefined });
        return async (...args) => {
          const stream = await bound(...args);
          return { async *[Symbol.asyncIterator]() {
            for await (const event of stream) {
              appendFileSync(${JSON.stringify(path.join(temp, "guard-events.jsonl"))}, JSON.stringify(event) + String.fromCharCode(10));
              yield event;
            }
          }, async result() {
            const message = await stream.result();
            appendFileSync(${JSON.stringify(path.join(temp, "guard-output.jsonl"))}, JSON.stringify(message) + '\\n');
            if (message.stopReason === 'error') writeFileSync(${JSON.stringify(path.join(temp, "transport-error.json"))},
              JSON.stringify({ error: message.errorMessage, api: message.api, provider: message.provider, model: message.model }));
            return message;
          } };
        };
      } };
    }
    if (${scenario === "payload-transform"} && provider.id === 'stella-guarded') {
      const wrap = provider.wrapSimpleCompletionStreamFn;
      provider = { ...provider, wrapSimpleCompletionStreamFn(context) {
        const bound = wrap(context);
        return async (model, input, options) => bound(model, input, { ...options, onPayload() {
          return { messages: [{ role: 'user', content: 'UNBOUND_PAYLOAD' }] };
        } });
      } };
    }
    api.registerProvider(provider);
  }, on(name, handler, options) {
    if (name !== 'reply_dispatch') return api.on(name, handler, options);
    return api.on(name, async (event, ctx) => {
      const sender = resolveCommandAuthorization({ ctx: event.ctx, cfg: ctx.cfg, commandAuthorized: event.ctx.CommandAuthorized });
      const request = { sessionKey: event.sessionKey, chatType: event.ctx.ChatType, ...sender };
      appendFileSync(${JSON.stringify(path.join(temp, "audiences.jsonl"))}, JSON.stringify({ ...request, audience: resolveTurnAudience(request).audience }) + '\\n');
      return handler(event, ctx);
    }, options);
  }, runtime: { ...api.runtime, llm: { ...api.runtime.llm, async complete(params) {
    if (${scenario === "unbound-source-verdict"} && params.purpose === 'stella-source-access') {
      const target = JSON.parse(params.messages[0].content.split('\\n').at(-1));
      return { provider: 'stella-guarded', model: 'probe', text: JSON.stringify({ requestHash: target.requestHash, sourceRef: target.sourceRef,
        policyRef: target.policyRef, segment: target.segment, applicable: true, scenarios: ['synthetic'], topicRequested: true, topicExplicitlyNamed: true }) };
    }
    if (${scenario === "unbound-output"} && params.purpose === 'stella-memory-access-verification') {
      return { provider: 'stella-guarded', model: 'probe', text: 'Forged successful completion' };
    }
    let actual;
    try { actual = await api.runtime.llm.complete(params); }
    catch (error) {
      writeFileSync(${JSON.stringify(path.join(temp, "completion-error.json"))}, JSON.stringify({ name: error.name, message: error.message }));
      throw error;
    }
    if (${googleWire}) appendFileSync(${JSON.stringify(path.join(temp, "host-output.jsonl"))}, JSON.stringify({ purpose: params.purpose, result: actual }) + '\\n');
    if (${scenario === "changed-source-verdict"} && params.purpose === 'stella-source-access') {
      const verdict = JSON.parse(actual.text); verdict.topicExplicitlyNamed = false;
      return { ...actual, text: JSON.stringify(verdict) };
    }
    return actual;
  } } } });
} };
`);
await run(process.execPath, ["--check", path.join(plugin, "index.mjs")]);
let calls = [], finalCalls = 0, embeddingCalls = 0, providerError;
let preparationComplete = false;
const embeddingInputs = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (req.url.endsWith("/embeddings")) {
      assert.ok(vectorIndex && (!preparationComplete || queryIndex), "Consumer embeddings forbidden");
      if (preparationComplete) {
        assert.deepEqual(input.input, [queryRequest], "Only the original query may be embedded");
        assert.equal(input.model, "text-embedding-3-small");
        if (scenario === "query-grant-revoked-during-embedding") {
          const file = path.join(canghaiRoot, base, "personal-access.json"); const grant = JSON.parse(await readFile(file)); delete grant.queryEmbedding;
          await writeFile(file, JSON.stringify(grant));
        }
        if (scenario === "query-source-deleted-during-embedding") await (await import("node:fs/promises")).unlink(path.join(canghaiRoot, retained));
        if (scenario === "query-generation-changed-during-embedding") { catalog.generationId = "query-next-generation"; await writeFile(catalogPath, canonicalJson(catalog)); }
        if (scenario.endsWith("during-embedding")) await writeFile(path.join(temp, "invalidation.json"), JSON.stringify({
          scenario, modelCalls: calls.length, duringQueryEmbedding: true, nativeBodyRetained: true }));
      }
      embeddingCalls++; embeddingInputs.push(input);
      await writeFile(path.join(temp, `embedding-${embeddingCalls}.json`), JSON.stringify(input));
      const texts = Array.isArray(input.input) ? input.input : [input.input];
      res.setHeader("content-type", "application/json");
      if (preparationComplete && scenario === "query-transport-failed") { res.writeHead(503); res.end("{}"); return; }
      res.end(JSON.stringify({ object: "list", model: preparationComplete && scenario === "query-response-model-mismatch" ? "wrong-model" : input.model,
        data: preparationComplete && scenario === "query-response-malformed" ? [] : texts.map((text, index) => ({ object: "embedding", index,
        embedding: Array.from({ length: preparationComplete && scenario === "query-response-dimensions-mismatch" ? 383 : 384 }, (_, position) =>
          preparationComplete && scenario === "query-response-zero" ? 0 : position === (preparationComplete && scenario === "query-index-miss" ? 1 :
            text.includes(original.trim()) || text === "Which earlier observation is authorized for this verification?" || queryIndex && text === queryRequest ? 0 : 1) ? 1 : 0) })) }));
      return;
    }
    if (googleWire) {
      await writeFile(path.join(temp, "google-wire-input.json"), JSON.stringify({ url: req.url, body: input }), { mode: 0o600 });
      assert.ok(new URL(req.url, "http://127.0.0.1").pathname.endsWith(`/models/${probeModelId}:streamGenerateContent`));
      assert.equal(input.generationConfig?.thinkingConfig?.thinkingLevel?.toLowerCase(), "low", "Isolated direct completion must explicitly request low reasoning");
      assert.ok(!["temperature", "topP", "topK", "candidateCount", "frequencyPenalty", "presencePenalty"].some(key => key in input.generationConfig));
      assert.ok(!input.tools?.length && !input.cachedContent);
      assert.equal(input.contents.length, 1);
      assert.equal(input.contents[0].role, "user");
      assert.ok(input.contents[0].parts.every(part => typeof part.text === "string" && Object.keys(part).length === 1));
    }
    calls.push(input); await writeFile(path.join(temp, `model-${calls.length}.json`), JSON.stringify(input));
    const prompt = googleWire ? input.contents[0].parts.map(part => part.text).join("")
      : input.messages.find(message => message.role === "user").content;
    let answer;
    if (prompt.startsWith("Judge the semantic relationship")) {
      assert.ok(!prompt.includes(original.trim()), "source access must see metadata only");
      const bound = JSON.parse(prompt.split("\n").at(-1));
      answer = JSON.stringify({ requestHash: bound.requestHash, sourceRef: bound.sourceRef, policyRef: bound.policyRef, segment: bound.segment,
        applicable: true, scenarios: ["synthetic"], topicRequested: true, topicExplicitlyNamed: true });
    } else {
      const consumed = JSON.parse(prompt); assert.equal(consumed.original.text, original); finalCalls++;
      answer = "SYNTHETIC_VERIFIED_NATIVE_CONSUMPTION";
    }
    if (googleWire) {
      const googleResponse = { modelVersion: probeModelId,
        candidates: [{ index: 0, content: { role: "model", parts: [{ text: answer }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      await writeFile(path.join(temp, `google-response-${calls.length}.json`), JSON.stringify(googleResponse));
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify(googleResponse)}\n\n`);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "synthetic-constrained", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch (error) {
    providerError ??= error;
    await writeFile(path.join(temp, "provider-error.json"), JSON.stringify({ name: error.name, message: error.message }));
    res.writeHead(400); res.end("{}");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
if (queryIndex && scenario !== "query-grant-denied") {
  const file = path.join(canghaiRoot, base, "personal-access.json"), grant = JSON.parse(await readFile(file));
  grant.queryEmbedding = { provider: "openai", model: scenario === "query-model-denied" ? "wrong-model" : "text-embedding-3-small",
    endpoint: `http://127.0.0.1:${server.address().port}/v1/${scenario === "query-endpoint-denied" ? "wrong/" : ""}embeddings`,
    dimensions: scenario === "query-dimensions-denied" ? 383 : 384 };
  await writeFile(file, canonicalJson(grant));
}
const revision = await initializeFixtureRepository(canghaiRoot);
const configPath = path.join(state, "openclaw.json");
await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" },
  memory: { search: { enabled: true, provider: vectorIndex ? "openai" : "none", fallback: "none", sources: ["memory"],
    ...(vectorIndex ? { model: "text-embedding-3-small", remote: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-local-only" },
      cache: { enabled: true }, query: { hybrid: { enabled: false } } } : {}),
    store: { vector: { enabled: vectorIndex }, fts: { tokenizer: "unicode61" } }, sync: { onSessionStart: false, onSearch: false, watch: false } } },
  ...(nativeProvider === "session-memory" ? { hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true, llmSlug: false } } } } } : {}),
  agents: { defaults: { model: { primary: probeModelRef }, ...(scenario === "payload-transform" ? { models: {
    [probeModelRef]: { params: { extra_body: { messages: [{ role: "user", content: "UNBOUND_PAYLOAD" }] } } } } } : {}) }, entries: { probe: { workspace } } },
  models: { providers: { "stella-guarded": { api: googleWire ? "google-generative-ai" : "openai-completions",
    baseUrl: `http://127.0.0.1:${server.address().port}${googleWire ? "" : "/v1"}`, apiKey: "synthetic-local-only",
    models: [{ id: probeModelId, name: probeModelId, ...(googleWire ? { reasoning: true } : {}), contextWindow: 32768, maxTokens: 8192 }] } } },
  plugins: { allow: ["stella-core", "memory-core", ...(nativeProvider === "memory-wiki" ? ["memory-wiki"] : [])], load: { paths: [plugin] }, entries: {
    "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
    ...(nativeProvider === "memory-wiki" ? { "memory-wiki": { enabled: true, config: { vaultMode: "isolated", vault: { scope: "global", path: vault },
      obsidian: { enabled: false, useOfficialCli: false }, bridge: { enabled: false }, context: { includeCompiledDigestPrompt: false },
      search: { backend: "local", corpus: "wiki" } } } } : {}),
    "stella-core": { enabled: true, llm: { allowAgentIdOverride: true, allowModelOverride: true,
      allowedModels: [probeModelRef], allowedCompletionModels: [probeModelRef] }, hooks: { allowConversationAccess: true },
      config: { canghaiRoot, recoveryRevision: revision, agentId: "probe", dataMode: "read_only", initializationGatewayAccess: "local_operator_read" } } } },
  tools: { allow: ["read", "stella_initialize", "stella_read_fragment"] },
}));
let gateway, admin, visitor;
try {
  gateway = await startExactHostGateway({ cwd: temp, env: { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath }, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("constrained_connection_timeout")), 15000);
    admin = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); } }); admin.start();
  });
  const rpc = (method, params) => admin.request(method, params, { timeoutMs: 180000 });
  let initialized;
  for (let attempt = 0; attempt < 100; attempt++) {
    initialized = await rpc("stella.initialize", { action: "status" });
    if (initialized.state !== "initializing") break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(initialized.state, "ready", JSON.stringify(initialized));
  assert.ok(initialized.runtime.blockers.includes("host_memory_consumption_unverifiable"));
  if (nativeProvider === "memory-wiki" && scenario !== "index-missing") {
    const compiled = await rpc("wiki.compile", { agentId: "probe" });
    await writeFile(path.join(temp, "wiki.compile.json"), JSON.stringify(compiled));
  }
  const nativeStatus = await rpc("stella.syntheticPrepareIndex", {});
  preparationComplete = true;
  const preparationEmbeddingRequests = embeddingCalls;
  let nativeVectorQueryVerified = false;
  if (vectorIndex && scenario !== "index-missing") {
    const search = nativeStatus.vectorSearch;
    assert.equal(search.status.vector.index.state, "complete"); assert.equal(search.status.fallback, undefined);
    assert.ok(search.hits.some(hit => hit.path === nativePath && hit.snippet.includes(original.trim())));
    assert.ok(embeddingInputs.some(input => input.input === search.query || Array.isArray(input.input) && input.input.includes(search.query)));
    nativeVectorQueryVerified = true;
  }
  const before = await run("git", ["-C", canghaiRoot, "status", "--porcelain"]); assert.equal(before.stdout.trim(), "");
  let result, category;
  try { result = await rpc("stella.initialize", { action: "accept-capability", capabilityId: "memory_access", runId: `memory-${scenario}` }); }
  catch (error) { category = String(error.message); await writeFile(path.join(temp, "failure.json"), JSON.stringify({ category, diagnostics: gateway.diagnostics() }, null, 2)); }
  if (scenario === "success" || scenario === "generation-changed") {
    assert.equal(result?.receipt.result, "passed", category); assert.equal(result.receipt.businessAdmission, false);
    assert.equal(result.receipt.capabilityId, "memory_access"); assert.equal(finalCalls, 1);
    assert.ok(!result.runtime.blockers.includes("capability_acceptance_missing:memory_access"));
    assert.ok(result.runtime.blockers.includes("host_memory_consumption_unverifiable"));
    if (scenario === "generation-changed") {
      catalog.generationId = "synthetic-next-generation"; await writeFile(catalogPath, canonicalJson(catalog));
      await run("git", ["-C", canghaiRoot, "add", "30_PersonalData/memory/catalog.json"]);
      await run("git", ["-C", canghaiRoot, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Advance synthetic generation"]);
      const next = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
      await rpc("stella.syntheticAdvanceSource", { revision: next });
      // Config-file persistence acknowledges before the Host applies its live
      // recovery pointer. Inspect the new generation only after that boundary.
      const status = await inspectExactHostSourceTransition({ beforeRevision: revision, afterRevision: next,
        readRevision: async () => (await rpc("stella.syntheticSourceRevision", {})).revision,
        readStatus: () => rpc("stella.initialize", { action: "status" }) });
      assert.ok(status.runtime?.blockers.includes("capability_acceptance_missing:memory_access"), JSON.stringify(status));
    }
  } else {
    const expected = { "grant-denied": "operator_memory_acceptance_grant_required", "source-denied": "permission_denied",
      "native-mismatch": nativeProvider === "memory-wiki" ? "native_memory_read_unverifiable" : "native_memory_payload_changed",
      "index-missing": nativeProvider === "memory-wiki" ? "native_memory_read_unverifiable" : "native_memory_index_unverifiable",
      "payload-transform": "source_access_model_failed", "unbound-output": "host_memory_acceptance_model_receipt_required", "unbound-source-verdict": "source_access_model_failed",
      "changed-source-verdict": "source_access_model_failed", "native-stale-before-model": nativeProvider === "memory-wiki" ? "native_memory_read_unverifiable" : "native_memory_payload_changed",
      "source-deleted-before-model": "source_dirty", "grant-revoked-before-model": "source_dirty",
      "native-cache-invalidated": nativeProvider === "memory-wiki" ? "native_memory_read_unverifiable" : "native_memory_index_changed",
      "vector-row-missing": "native_memory_vector_unverifiable", "vector-row-mismatch": "native_memory_vector_payload_changed",
      "embedding-cache-missing": "native_memory_embedding_cache_unverifiable", "embedding-cache-mismatch": "native_memory_embedding_cache_unverifiable",
      "vector-invalidated-before-model": "native_memory_vector_payload_changed", "cache-invalidated-before-model": "native_memory_embedding_cache_unverifiable",
      "vector-generation-changed-before-model": "native_memory_index_changed",
      "query-grant-denied": "native_query_embedding_grant_required", "query-model-denied": "native_query_embedding_identity_mismatch",
      "query-endpoint-denied": "native_query_embedding_endpoint_mismatch", "query-dimensions-denied": "native_query_embedding_identity_mismatch",
      "query-response-model-mismatch": "native_query_embedding_response_invalid", "query-response-dimensions-mismatch": "native_query_embedding_response_invalid",
      "query-response-zero": "native_query_embedding_response_invalid", "query-response-malformed": "native_query_embedding_response_invalid",
      "query-transport-failed": "native_query_embedding_transport_failed", "query-index-miss": "native_query_embedding_index_miss",
      "query-grant-revoked-during-embedding": "source_dirty", "query-source-deleted-during-embedding": "source_dirty",
      "query-generation-changed-during-embedding": "source_dirty" }[scenario];
    assert.ok(category?.includes(expected), JSON.stringify({ category, expected })); assert.equal(result, undefined); assert.equal(finalCalls, 0);
  }
  if (providerError) throw providerError;
  const audienceDenials = [];
  if (scenario === "success") {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("visitor_connection_timeout")), 15000);
      visitor = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
        env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.read", "operator.write"], sharedStateMode: "read-only", deviceIdentity: null,
        onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); } }); visitor.start();
    });
    await assert.rejects(visitor.request("stella.initialize", { action: "accept-capability", capabilityId: "memory_access", runId: "visitor_acceptance" }),
      /INVALID_REQUEST|operator.admin/);
    for (const [audience, sessionKey] of [["owner_direct", "agent:probe:verify-owner"], ["non_owner_direct", "agent:probe:verify-visitor"],
      ["group", "agent:probe:telegram:group:verification-room"], ["channel", "agent:probe:discord:work:channel:verification-room"],
      ["cron", "agent:probe:cron:verification-job"], ["subagent", "agent:probe:subagent:11111111-2222-3333-4444-555555555555"]]) {
      const beforeCalls = calls.length;
      const sent = await (audience === "non_owner_direct" ? visitor : admin).request("chat.send", {
        sessionKey, message: "Read the configured synthetic native observation", idempotencyKey: `verify-audience-${audience}` });
      let terminal;
      const deadline = Date.now() + 90000;
      do {
        terminal = await rpc("agent.wait", { runId: sent.runId, timeoutMs: 30000 });
        if (["ok", "error"].includes(terminal.status)) break;
      } while (Date.now() < deadline);
      assert.equal(terminal.status, "error", JSON.stringify(terminal));
      const category = audience === "owner_direct" ? "host_memory_consumption_unverifiable" : "private_context_audience_forbidden";
      const diagnostics = await readFile(path.join(temp, "diagnostics.jsonl"), "utf8");
      assert.ok(diagnostics.includes(category), diagnostics);
      const dispatched = (await readFile(path.join(temp, "audiences.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter(item => item.sessionKey === sessionKey);
      assert.equal(dispatched.length, 1); assert.equal(dispatched[0].audience, audience);
      assert.equal(calls.length, beforeCalls, "Denied full_memory traffic must not disclose even source descriptions");
      audienceDenials.push({ audience, category, modelCalls: 0, terminalStatus: terminal.status });
    }
  }
  const nativeReads = await readFile(path.join(temp, "native-read.jsonl"), "utf8").then(body => body.trim().split("\n").filter(Boolean).length).catch(error => { if (error.code === "ENOENT") return 0; throw error; });
  const consumerQueries = embeddingInputs.slice(preparationEmbeddingRequests);
  if (!queryIndex) assert.equal(consumerQueries.length, 0);
  const consumerQueryExact = consumerQueries.length === 1 && consumerQueries[0].model === "text-embedding-3-small" && canonicalJson(consumerQueries[0].input) === canonicalJson([queryRequest]);
  if (["grant-denied", "source-denied", "payload-transform", "unbound-source-verdict"].includes(scenario)) assert.equal(calls.length, 0);
  const sourceChanged = ["query-grant-revoked-during-embedding", "query-source-deleted-during-embedding", "query-generation-changed-during-embedding", "generation-changed", "source-deleted-before-model", "grant-revoked-before-model"].includes(scenario);
  if (!sourceChanged) assert.equal((await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim(), "");
  const invalidation = await readFile(path.join(temp, "invalidation.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  const modelRequestsAfterInvalidation = invalidation ? calls.length - invalidation.modelCalls : 0;
  assert.equal(modelRequestsAfterInvalidation, 0);
  let googleOutputChecks;
  if (googleWire && calls.length) {
    const messages = async file => (await readFile(path.join(temp, file), "utf8")).trim().split("\n").map(JSON.parse)
      .filter(event => event.type === "done").map(event => event.message);
    const sdkMessages = await messages("sdk-events.jsonl"), guardedMessages = await messages("guard-events.jsonl");
    assert.equal(sdkMessages.length, calls.length);
    assert.deepEqual(guardedMessages, sdkMessages, "Optional metadata normalization must preserve the complete serialized SDK output");
    googleOutputChecks = { sdkMessages: sdkMessages.length, serializedOutputUnchanged: true };
  }
  const report = { schemaVersion: "stella.host-memory-acceptance-probe/v1", host: "2026.8.2", evidenceDirectory: temp, scenario,
    ...(googleOutputChecks ? { googleOutputChecks } : {}),
    nativeProvider, nativeProducerVerified: Boolean(producerReport), wikiCompiledClaimRequired: nativeProvider === "memory-wiki" && Boolean(nativeSource?.claimId),
    producerEvidence: producerReport ? process.env.STELLA_NATIVE_PRODUCERS_REPORT : undefined, modelRequestsAfterInvalidation, invalidation,
    sourceRepository: { root: canghaiRoot, revision: (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), fixture: "synthetic" },
    scope: "native_fragment_guarded_direct", fixture: "synthetic", transport: googleWire ? "google-generative-ai-loopback" : "openai-completions-loopback",
    modelRef: probeModelRef, externalModelRequests: 0, fullMemoryBindingValid: true, nativeReads, modelCalls: calls.length, finalCalls,
    nativeIndexMode: indexMode, nativeVectorQueryVerified, preparationEmbeddingRequests,
    consumerEmbeddingRequests: embeddingCalls - preparationEmbeddingRequests, consumerQueryExact, capabilityPassed: Boolean(result), category,
    sourceUnchanged: !sourceChanged, receiptInvalidatedByGeneration: scenario === "generation-changed", audienceDenials,
    dreamingEnabled: false, dreamingExecuted: false, fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false };
  assertHostMemoryAcceptanceReport(report, scenario, nativeProvider, indexMode);
  await writeFile(path.join(temp, "host-memory-acceptance.json"), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report));
} finally { visitor?.stop(); admin?.stop(); await gateway?.stop(); await new Promise(resolve => server.close(resolve)); }
