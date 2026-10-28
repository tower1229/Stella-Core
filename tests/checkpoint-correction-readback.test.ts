import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createCheckpointCorrectionReadback } from "../src/openclaw/checkpoint-correction-readback.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { createCheckpointSourceAccess } from "../src/openclaw/checkpoint-source-access.js";
import type { NativeReadbackOpen, NativeReadbackScope } from "../src/openclaw/checkpoint-native-readback.js";
import { CatalogError, CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { readCheckpointCommittedDocument } from "../src/canghai/checkpoint-committed-document.js";
import { prepareHostRequestArchive, HOST_REQUEST_ARCHIVE_ADAPTER } from "../src/canghai/host-request-archive.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "../src/canghai/host-input-archive.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { snapshotTurnRequest, type BoundTurnRequest } from "../src/openclaw/turn-request.js";
import { createCheckpointWorkSource, WORK_CORRECTION, WORK_GOAL_A, WORK_GOAL_B, WORK_MODEL } from "./checkpoint-work-fixture.js";

type Input = Parameters<typeof createCheckpointCorrectionReadback>[0];
type NativeOpened = Awaited<ReturnType<Input["openNativeReadback"]>>;
type PublicSdk = {
  getActiveMemoryProvider(params: NativeReadbackOpen): Promise<NativeOpened>;
  closeActiveMemorySearchManagers(cfg: NativeReadbackOpen["cfg"]): Promise<void>;
};
type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;
const execute = promisify(execFile), providerId = "stella-c3-correction-readback";
const fixtureSymbol = Symbol.for("stella.test.correction-native-readback");
const requestScopeSymbol = Symbol.for("stella.test.correction-request-scopes");
const globals = globalThis as typeof globalThis & {
  [fixtureSymbol]?: { openReadScope(params: NativeReadbackOpen): Promise<NativeReadbackScope> };
  [requestScopeSymbol]?: Map<string, NativeReadbackScope>;
};
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];

/** Real writer/Git/CAS and public native SDK; every semantic response and caller is a fixed fixture. */
async function fixture(t: TestContext, openSdk: (binding: Parameters<Input["openNativeReadback"]>[0]) => Promise<NativeOpened>,
  options: { readOnly?: boolean; read?: boolean; learn?: boolean; disposition?: "update" | "no_change" | "needs_clarification" } = {}) {
  const source = await createCheckpointWorkSource(), root = source.root;
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "stella-c3-writer-"))), state = path.join(parent, "authority");
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  await mkdir(state);
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "-C", root, ...args], { timeout: 15_000 })).stdout.trim();
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-c3-session", sessionKey: "agent:synthetic:c3",
    senderId: "cli", senderIsOwner: true, chatType: "direct", prompt: WORK_CORRECTION }, "synthetic-c3-owner-correction");
  const capturedAt = "2026-10-27T00:00:00Z", purpose = { ...source.binding.purpose, evidenceCutoff: capturedAt,
    trustedAdapters: { user_report: [HOST_REQUEST_ARCHIVE_ADAPTER, HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] } };
  const policy = { schemaVersion: "stella.source-policy/v1", id: "c3-owner-input-policy", ownerId: "owner-fixture",
    readPurposes: options.read === false ? [] : [purpose.readPurpose], derivePurposes: options.learn === false ? [] : [purpose.derivePurpose],
    deliveryScopes: [purpose.deliveryScope], retention: "retain", authorityEvidenceRefs: [] };
  const policyRef = { id: policy.id, version: objectVersion(policy) }, policyPath = "c3-owner-input-policy.json", policyBytes = canonicalJson(policy);
  const catalog = JSON.parse(await readFile(path.join(root, source.catalogPath), "utf8"));
  catalog.policies.push({ ...policyRef, status: "current", dependencies: [], locator: { path: policyPath, sha256: bytesVersion(policyBytes) } });
  await writeFile(path.join(root, policyPath), policyBytes);
  // Fixture setup retains an exact current user input with the existing archive producer.
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt },
    { ...source.binding.archive, ownerId: "owner-fixture", policyRef });
  for (const file of [{ path: archive.payload.path, bytes: archive.payload.bytes }, ...archive.objects.map(object => ({ path: object.entry.locator.path, bytes: object.bytes }))]) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true }); await writeFile(path.join(root, file.path), file.bytes);
  }
  for (const object of archive.objects) catalog[object.group].push(object.entry);
  await writeFile(path.join(root, source.catalogPath), canonicalJson(catalog));
  const grant = JSON.parse(await readFile(path.join(root, source.grantPath), "utf8"));
  grant.descriptors.push({ sourceRef: archive.sourceRef, policyRef, description: "Fixed current owner correction fixture, not a model-supplied input." });
  await writeFile(path.join(root, source.grantPath), canonicalJson(grant));
  await git("add", "--all"); await git("commit", "--quiet", "-m", "[synthetic] C3 admitted owner input");
  assert.equal(await git("remote"), ""); const baseline = await git("rev-parse", "HEAD");
  const config = { recoveryAuthority: "core_checkpoint" as const, canghaiRoot: root, checkpointStateDirectory: state, agentId: "synthetic",
    dataMode: "local_write" as const, agentMemory: "fresh_tools" as const, requestArchive: "local" as const, agentCorrection: "tool" as const };
  let actual = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(config), "2026.10.7");
  await actual.initializeAuthority({ revision: baseline, operationId: "synthetic-c3-init" });
  if (options.readOnly) {
    actual.close(); actual = await createCheckpointPluginRuntime(parseCheckpointPluginConfig({ recoveryAuthority: "core_checkpoint", canghaiRoot: root,
      checkpointStateDirectory: state, agentId: "synthetic", dataMode: "read_only", agentMemory: "fresh_tools" }), "2026.10.7");
  }
  t.after(() => actual.close());
  const counters = { writerCalls: 0, correctionResponses: 0, nativeGets: 0, nativeCloses: 0, nativeOpens: 0,
    sourceRequestHashes: [] as string[] }, control = { denyReadback: false };
  const runtime = { ...actual, async correctLocal(input: Parameters<typeof actual.correctLocal>[0]) { counters.writerCalls++; return actual.correctLocal(input); } };
  const api = { source: "synthetic-c3-plugin", runtime: { config: { current: () => ({ agents: { entries: { synthetic: { model: { primary: WORK_MODEL, fallbacks: [] } } } } }) },
    llm: { async complete(params: LlmParams): Promise<LlmResult> {
      assert.equal(params.reasoning, "low"); const text = params.messages[0]!.content; assert.equal(typeof text, "string");
      const data = JSON.parse((text as string).split("\n").at(-1)!); let value: unknown;
      if (params.purpose === "stella-source-access") {
        counters.sourceRequestHashes.push(data.requestHash);
        value = { requestHash: data.requestHash, sourceRef: data.sourceRef, policyRef: data.policyRef,
          applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
          ruleChecks: (data.accessRules ?? []).map((rule: { id: string }) => ({ id: rule.id, satisfied: true })) };
      }
      else {
        assert.equal(params.purpose, "stella-correction");
        if (data.bindingHash) value = { bindingHash: data.bindingHash, checks: data.data.requirements.map((item: { handle: string }) => ({ handle: item.handle, satisfied: true })) };
        else if (data.proposalHash) value = { requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true };
        else {
          counters.correctionResponses++; assert.equal(data.request, request.prompt);
          const work = data.candidates.find((item: { group: string }) => item.group === "works"); assert.ok(work);
          const disposition = options.disposition ?? "update";
          value = { requestHash: data.requestHash, disposition, clarification: disposition === "needs_clarification" ? "Which argument should remain open?" : null,
            rationale: "Fixed structured response, no semantic inference.", reviewedHandles: data.candidates.map((item: { handle: string }) => item.handle),
            replacements: disposition === "update" ? [{ handle: work.handle, group: "works", record: {
              ...Object.fromEntries(editable.map(key => [key, work.record[key]])), goal: WORK_GOAL_B } }] : [] };
        }
      }
      return { text: JSON.stringify(value), provider: "google", model: "gemini-3.8-flash", agentId: "synthetic", usage: {},
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "google" } }, audit: { caller: { kind: "plugin", id: "stella-core" }, purpose: params.purpose } };
    } } } } as unknown as OpenClawPluginApi;
  const recovery = await runtime.capture(), reader = await CatalogReader.load(root, source.catalogPath), controller = new AbortController();
  const coordinator = createCheckpointCorrectionReadback({ providerId, correction: { api, runtime, recovery, request,
    archive: { recovery, evidenceRefs: archive.evidenceRefs, sourceRefs: [archive.sourceRef], capturedAt, requestHash: request.requestHash, runId: request.runId },
    resolver: new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("C3 must use its bound structured response port"); }),
    bindingPath: source.grantPath, objectRoot: source.binding.archive.objectRoot, signal: controller.signal, assertCurrent: async () => {} },
    async openNativeReadback(binding) {
      counters.nativeOpens++;
      const current = () => runtime.assert(binding.recovery);
      const sourceAccess = await createCheckpointSourceAccess({ api, agentId: "synthetic", root, bindingPath: source.grantPath,
        request: binding.request, purpose: { readPurpose: purpose.readPurpose, derivePurpose: purpose.derivePurpose, deliveryScope: purpose.deliveryScope },
        signal: binding.signal, assertCurrent: current });
      const resolver = new EpisodeEvidenceResolver(binding.reader, { ...purpose, sourceAccess }, async () => { throw new Error("No correction inference during native readback"); });
      globals[fixtureSymbol] = { async openReadScope() { return { reader: binding.reader, resolver, assertCurrent: current,
        async authorizeSources({ sourceRefs }) {
          await current(); if (control.denyReadback) throw new CatalogError("permission_denied");
          for (const ref of sourceRefs) {
            const object = await binding.reader.read(ref, "sources"); await resolver.assertSourceAccess(ref, object.policyRef as typeof ref);
          }
          return { assertCurrent: current };
        } }; } };
      const opened = await openSdk(binding); assert.ok(opened.provider); const lease = opened.provider;
      return { ...opened, provider: { ...lease,
        async get(params) { counters.nativeGets++; return lease.get(params); },
        async close() { counters.nativeCloses++; await lease.close(); },
      } };
    },
  });
  return { coordinator, counters, control, runtime, recovery, baseline, git, source, request, archiveEvidenceRefs: archive.evidenceRefs,
    api, purpose, controller };
}

test("bound correction commits once, then reads exact versions through the public native lease", { timeout: 120_000 }, async t => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "stella-c3-sdk-"))); t.after(() => rm(parent, { recursive: true, force: true }));
  const envKeys = ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const, before = envKeys.map(key => process.env[key]);
  for (const key of envKeys) process.env[key] = path.join(parent, key === "OPENCLAW_CONFIG_PATH" ? "config.json" : key.toLowerCase());
  const savedFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("C3 forbids real model/network calls"); };
  const cfg: NativeReadbackOpen["cfg"] = { agents: { entries: { synthetic: { workspace: path.join(parent, "workspace") } } }, plugins: {
    enabled: true, allow: [providerId], slots: { memory: providerId }, load: { paths: [path.join(parent, "plugin")] },
    entries: { [providerId]: { enabled: true }, "memory-core": { enabled: false } },
  } };
  let sdk: PublicSdk | undefined;
  try {
    globals[requestScopeSymbol] = new Map();
    await mkdir(path.join(parent, "plugin"));
    await writeFile(path.join(parent, "plugin/package.json"), JSON.stringify({ name: providerId, version: "0.0.0", type: "module", openclaw: { extensions: ["index.mjs"] } }));
    await writeFile(path.join(parent, "plugin/openclaw.plugin.json"), JSON.stringify({ id: providerId, kind: "memory", configSchema: { type: "object", properties: {}, additionalProperties: false } }));
    await writeFile(path.join(parent, "plugin/index.mjs"), `import {registerCheckpointNativeReadback} from ${JSON.stringify(new URL("../src/openclaw/checkpoint-native-readback.js", import.meta.url).href)};
export default {id:${JSON.stringify(providerId)},kind:'memory',register(api){registerCheckpointNativeReadback(api,{providerId:${JSON.stringify(providerId)},openReadScope:async params=>{
const authority=params.context.authority,scopes=globalThis[Symbol.for('stella.test.correction-request-scopes')];
return authority.kind==='operator'&&scopes?.has(authority.connId)?scopes.get(authority.connId):globalThis[Symbol.for('stella.test.correction-native-readback')].openReadScope(params);
}});}};`);
    const require = createRequire(import.meta.url);
    sdk = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/memory-host-search")).href) as PublicSdk;
    const openSdk = () => sdk!.getActiveMemoryProvider({ cfg, agentId: "synthetic", context: {
      authority: { kind: "operator", scopes: ["operator.admin", "operator.read"], connId: "synthetic-c3" }, assertCurrent() {},
    } });
    // A fresh request gets its own permission load, reader, resolver and SDK caller lease.
    // The test router retains each binding by its synthetic connection, including stale ones.
    const bindRead = async (f: Awaited<ReturnType<typeof fixture>>, runtime: Awaited<ReturnType<typeof createCheckpointPluginRuntime>>, request: BoundTurnRequest) => {
      const recovery = await runtime.capture(), reader = await CatalogReader.load(f.source.root, f.source.catalogPath), controller = new AbortController();
      const committedCatalog = await readCheckpointCommittedDocument(reader.root, recovery.expected.revision, reader.catalogPath);
      assert.equal(bytesVersion(committedCatalog), reader.catalogHash, "read binding must use its checkpoint-selected catalog");
      const counts = { targetBodies: 0, payloadReads: 0, documentsReleased: 0 };
      const originalRead = reader.read.bind(reader), originalPayload = reader.readPayload.bind(reader);
      reader.read = async (...args) => { const value = await originalRead(...args); if (args[0].id === f.source.workRef.id) counts.targetBodies++; return value; };
      reader.readPayload = async (...args) => { counts.payloadReads++; return originalPayload(...args); };
      const current = async () => { controller.signal.throwIfAborted(); await runtime.assert(recovery); controller.signal.throwIfAborted(); };
      const sourceAccess = await createCheckpointSourceAccess({ api: f.api, agentId: "synthetic", root: f.source.root, bindingPath: f.source.grantPath,
        request, purpose: { readPurpose: f.purpose.readPurpose, derivePurpose: f.purpose.derivePurpose, deliveryScope: f.purpose.deliveryScope },
        signal: controller.signal, assertCurrent: current });
      assert.ok(sourceAccess);
      const resolver = new EpisodeEvidenceResolver(reader, { ...f.purpose, sourceAccess, signal: controller.signal,
        evidenceCutoff: request.hostMessageTimestamp === undefined ? f.purpose.evidenceCutoff : new Date(request.hostMessageTimestamp).toISOString() },
      async () => { throw new Error("C4 is read-only, with no correction response port"); });
      const connection = `c4:${request.runId}`;
      globals[requestScopeSymbol]!.set(connection, { reader, resolver, assertCurrent: current, async authorizeSources({ sourceRefs }) {
        await current();
        for (const ref of sourceRefs) {
          const source = await reader.read(ref, "sources"); await resolver.assertSourceAccess(ref, source.policyRef as typeof ref);
        }
        return { assertCurrent: current };
      } });
      const opened = await sdk!.getActiveMemoryProvider({ cfg, agentId: "synthetic", context: {
        authority: { kind: "operator", scopes: ["operator.admin", "operator.read"], connId: connection },
        signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); },
      } });
      assert.equal(opened.adapter, "native"); assert.equal(opened.providerId, providerId); assert.ok(opened.provider); const lease = opened.provider;
      const end = async () => { controller.abort(); await lease.close(); globals[requestScopeSymbol]?.delete(connection); };
      t.after(end);
      return { request, recovery, reader, resolver, sourceAccess, counts, end, async readCurrentWork() {
        const ref = reader.currentRef(f.source.workRef.id, "works");
        const result = await lease.get({ reference: { providerId, id: canonicalJson(["works", ref.id]), revision: ref.version } });
        if (result.status === "ok") counts.documentsReleased++;
        return result;
      } };
    };
    await t.test("empty schema rejects all authority overrides, then one bound update commits and reads its Learning Change target", async t => {
      const f = await fixture(t, openSdk);
      const schema = JSON.parse(JSON.stringify(f.coordinator.parameters));
      assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.properties, {});
      await assert.rejects(f.coordinator.execute({ request: "replacement", ownerId: "other", operationId: "other", expected: {} }), /arguments_invalid/);
      assert.equal(f.counters.writerCalls, 0);
      const [a, b] = await Promise.all([f.coordinator.execute({}), f.coordinator.execute({})]); assert.deepEqual(a, b);
      assert.equal(a.status, "readback_verified", JSON.stringify(a.readback)); assert.equal(a.correction.persistenceStatus, "local_committed");
      assert.equal(a.correction.disposition, "update"); assert.equal(f.counters.writerCalls, 1); assert.equal(f.counters.correctionResponses, 1);
      assert.equal(a.readback.documents.length, 1); const document = a.readback.documents[0]!, record = JSON.parse(document.text);
      assert.equal(record.goal, WORK_GOAL_B); assert.equal(document.reference.revision, objectVersion(record));
      const current = await CatalogReader.load(f.source.root, f.source.catalogPath), change = await current.read(a.correction.changeRef, "changes");
      assert.deepEqual(change.inputRefs, f.archiveEvidenceRefs);
      const evidence = await current.read(f.archiveEvidenceRefs[0]!, "evidence"), original = await current.read(evidence.source as typeof f.source.workRef, "sources");
      assert.equal((original.origin as { upstreamId: string }).upstreamId, f.request.runId);
      assert.equal(change.operationId, a.correction.operationId);
      assert.ok((change.targetRefs as Array<{ id: string; version: string }>).some(ref => ref.id === record.id && ref.version === document.reference.revision));
      assert.deepEqual((await f.runtime.capture()).expected, a.correction.authority); assert.equal(await f.git("rev-list", "--count", `${f.baseline}..HEAD`), "1");
      const again = await f.coordinator.execute({}); assert.deepEqual(again, a); assert.equal(f.counters.writerCalls, 1); assert.equal(f.counters.correctionResponses, 1);
      assert.equal(f.counters.nativeOpens, f.counters.nativeCloses); assert.equal(await f.git("status", "--porcelain"), "");
    });
    await t.test("a committed update survives readback denial; retry reads without calling the writer again", async t => {
      const f = await fixture(t, openSdk); f.control.denyReadback = true;
      const failed = await f.coordinator.execute({}); assert.equal(failed.status, "readback_failed");
      assert.equal(failed.correction.persistenceStatus, "local_committed"); assert.equal(failed.readback.status, "failed");
      if (failed.readback.status !== "failed") assert.fail("expected explicit readback failure");
      assert.equal(failed.readback.category, "permission_denied"); assert.deepEqual(failed.readback.documents, []);
      const revision = await f.git("rev-parse", "HEAD"), accepted = (await f.runtime.capture()).expected;
      assert.deepEqual(accepted, failed.correction.authority); assert.equal(f.counters.writerCalls, 1);
      f.control.denyReadback = false; const retried = await f.coordinator.execute({});
      assert.equal(retried.status, "readback_verified", JSON.stringify(retried.readback)); assert.deepEqual(retried.correction, failed.correction);
      assert.equal(f.counters.writerCalls, 1); assert.equal(f.counters.correctionResponses, 1); assert.equal(f.counters.nativeGets, 2);
      assert.equal(await f.git("rev-parse", "HEAD"), revision); assert.deepEqual((await f.runtime.capture()).expected, accepted);
      assert.equal(f.counters.nativeOpens, f.counters.nativeCloses);
    });
    for (const kind of ["read_only", "read", "learn"] as const) await t.test(`${kind} denial cannot commit a correction`, async t => {
      const f = await fixture(t, openSdk, kind === "read_only" ? { readOnly: true } : { [kind]: false });
      await assert.rejects(f.coordinator.execute({}), kind === "read_only" ? /correction_disabled/ : /permission_denied/);
      assert.equal(await f.git("rev-parse", "HEAD"), f.baseline); assert.deepEqual((await f.runtime.capture()).expected, f.recovery.expected);
      assert.equal(f.counters.nativeOpens, 0); assert.equal(f.counters.correctionResponses, 0); assert.equal(await f.git("status", "--porcelain"), "");
    });
    for (const disposition of ["no_change", "needs_clarification"] as const) await t.test(`${disposition} records a receipt without inventing target updates`, async t => {
      const f = await fixture(t, openSdk, { disposition }), result = await f.coordinator.execute({});
      assert.equal(result.status, disposition); assert.equal(result.correction.disposition, disposition);
      assert.equal(result.correction.persistenceStatus, "local_committed"); assert.equal(result.readback.status, "not_required"); assert.deepEqual(result.readback.documents, []);
      assert.equal(result.correction.clarification, disposition === "needs_clarification" ? "Which argument should remain open?" : null);
      const reader = await CatalogReader.load(f.source.root, f.source.catalogPath), work = await reader.read(f.source.workRef, "works"), change = await reader.read(result.correction.changeRef, "changes");
      assert.equal(work.goal, WORK_GOAL_A); assert.deepEqual(change.targetRefs, []); assert.deepEqual(change.changes, []); assert.equal(f.counters.nativeGets, 0);
      assert.equal(await f.git("rev-list", "--count", `${f.baseline}..HEAD`), "1");
    });
    await t.test("C4: next request and reopened disk runtime read the corrected version without old bindings or cached bodies", async t => {
      const f = await fixture(t, openSdk), old = await bindRead(f, f.runtime, f.request);
      const prior = await old.readCurrentWork(); assert.equal(prior.status, "ok");
      if (prior.status !== "ok") assert.fail("expected original work"); assert.equal(JSON.parse(prior.text).goal, WORK_GOAL_A);
      const committed = await f.coordinator.execute({}); assert.equal(committed.status, "readback_verified");
      const accepted = committed.correction.authority, revision = await f.git("rev-parse", "HEAD");
      const oldCounts = { ...old.counts };
      await assert.rejects(old.readCurrentWork(), /checkpoint_runtime_stale/);
      assert.deepEqual(old.counts, oldCounts, "stale binding must not read or release another body");
      assert.deepEqual(old.recovery.expected, f.recovery.expected); assert.notDeepEqual(old.recovery.expected, accepted);
      await old.end(); f.controller.abort(); await assert.rejects(old.readCurrentWork(), /closed|aborted/);
      const nextRequest = snapshotTurnRequest({ ...f.request, prompt: "C4 request two: resume the corrected writing and its open questions.",
        hostMessageTimestamp: Date.parse("2026-10-27T01:00:00Z") }, "synthetic-c4-request-two");
      const next = await bindRead(f, f.runtime, nextRequest);
      assert.notStrictEqual(next.reader, old.reader); assert.notStrictEqual(next.resolver, old.resolver); assert.notStrictEqual(next.sourceAccess, old.sourceAccess);
      assert.deepEqual(next.recovery.expected, accepted);
      const checkWork = (result: Awaited<ReturnType<typeof next.readCurrentWork>>) => {
        assert.equal(result.status, "ok"); if (result.status !== "ok") assert.fail("expected current work");
        const record = JSON.parse(result.text); assert.equal(record.goal, WORK_GOAL_B);
        assert.equal(result.reference.revision, objectVersion(record)); assert.notEqual(result.reference.revision, f.source.workRef.version);
        for (const field of ["kind", "status", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"] as const)
          assert.deepEqual(record[field], f.source.workRecord[field], field);
        return result;
      };
      const currentWork = checkWork(await next.readCurrentWork());
      assert.ok(next.counts.targetBodies > 0 && next.counts.payloadReads > 0); assert.equal(next.counts.documentsReleased, 1);
      assert.ok(f.counters.sourceRequestHashes.includes(nextRequest.requestHash), "request two must obtain its own source judgment");
      await next.end(); f.runtime.close();
      const reopened = await createCheckpointPluginRuntime(f.runtime.config, "2026.10.7"); t.after(() => reopened.close());
      const reopenedRequest = snapshotTurnRequest({ ...nextRequest, prompt: "C4 reopened request: read retained writing from disk.",
        hostMessageTimestamp: Date.parse("2026-10-27T02:00:00Z") }, "synthetic-c4-reopened-request");
      const fresh = await bindRead(f, reopened, reopenedRequest);
      assert.notStrictEqual(fresh.recovery.resolver, next.recovery.resolver); assert.notStrictEqual(fresh.reader, next.reader);
      assert.notStrictEqual(fresh.resolver, next.resolver); assert.notStrictEqual(fresh.sourceAccess, next.sourceAccess);
      assert.deepEqual(fresh.recovery.expected, accepted); assert.deepEqual(checkWork(await fresh.readCurrentWork()), currentWork);
      assert.ok(fresh.counts.targetBodies > 0 && fresh.counts.payloadReads > 0); assert.equal(fresh.counts.documentsReleased, 1);
      assert.ok(f.counters.sourceRequestHashes.includes(reopenedRequest.requestHash), "reopened request cannot reuse the old source decision");
      await fresh.end(); assert.equal(f.counters.writerCalls, 1); assert.equal(f.counters.correctionResponses, 1);
      assert.equal(await f.git("rev-parse", "HEAD"), revision); assert.equal(await f.git("status", "--porcelain"), "");
    });
    await t.test("C4: second request reloads a revoked source grant and releases no body despite unchanged owner/admin and checkpoint", async t => {
      const f = await fixture(t, openSdk), old = await bindRead(f, f.runtime, f.request);
      assert.equal((await old.readCurrentWork()).status, "ok");
      const committed = await f.coordinator.execute({}); assert.equal(committed.status, "readback_verified");
      const accepted = committed.correction.authority, revision = await f.git("rev-parse", "HEAD");
      await old.end(); f.controller.abort();
      const grantPath = path.join(f.source.root, f.source.grantPath), originalGrant = await readFile(grantPath, "utf8"), revoked = JSON.parse(originalGrant);
      revoked.descriptors = []; // Only this temporary fixture's source-context permission changes.
      await writeFile(grantPath, canonicalJson(revoked));
      try {
        const request = snapshotTurnRequest({ ...f.request, prompt: "C4 request two after source access withdrawal.",
          hostMessageTimestamp: Date.parse("2026-10-27T01:00:00Z") }, "synthetic-c4-revoked-request");
        const denied = await bindRead(f, f.runtime, request);
        assert.equal(request.senderIsOwner, true); assert.deepEqual(denied.recovery.expected, accepted);
        assert.ok(revoked.requesterIds.includes(request.senderId)); assert.ok(revoked.modelRefs.includes(WORK_MODEL));
        await assert.rejects(denied.readCurrentWork(), /personal_context_descriptor_required/);
        assert.deepEqual(denied.counts, { targetBodies: 0, payloadReads: 0, documentsReleased: 0 });
        await denied.end(); assert.deepEqual((await f.runtime.capture()).expected, accepted);
        assert.equal(f.counters.writerCalls, 1); assert.equal(f.counters.correctionResponses, 1); assert.equal(await f.git("rev-parse", "HEAD"), revision);
      } finally { await writeFile(grantPath, originalGrant); }
      assert.equal(await f.git("status", "--porcelain"), "");
    });
    assert.equal(fetches, 0);
  } finally {
    await sdk?.closeActiveMemorySearchManagers(cfg); delete globals[fixtureSymbol];
    globals[requestScopeSymbol]?.clear(); delete globals[requestScopeSymbol]; globalThis.fetch = savedFetch;
    for (const [index, key] of envKeys.entries()) { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }
  }
});
