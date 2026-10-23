import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import fsp, { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { readCheckpointCommittedDocument } from "../src/canghai/checkpoint-committed-document.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { serializeMemoryTransactionJournal } from "../src/canghai/memory-transaction-journal.js";
import type { MemoryTransactionPlan } from "../src/canghai/memory-transaction-plan.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { captureInitializationVerificationBinding } from "../src/openclaw/initialization-verification-binding.js";
import { inspectPublicPackageProvenance } from "../src/openclaw/public-package-provenance.js";
import { admitBusinessCapability, createMemoryCapabilityReceiptStore, issueCapabilityReceipt } from "../src/acceptance/capability-receipt.js";

let plugin: (typeof import("../src/plugin.js"))["default"];
const run = promisify(execFile), sessionKey = "agent:synthetic:main";

test("complete plugin imports through real SDK without identity directory enumeration", async () => {
  let scans = 0;
  const original = fsp.readdir, originalSync = fs.readdirSync;
  fsp.readdir = (() => { scans++; throw new Error("Unexpected directory enumeration during plugin import"); }) as typeof fsp.readdir;
  fs.readdirSync = (() => { scans++; throw new Error("Unexpected sync directory enumeration during plugin import"); }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try { plugin = (await import("../src/plugin.js")).default; assert.equal(typeof plugin.register, "function"); await new Promise(resolve => setImmediate(resolve)); assert.equal(scans, 0); }
  finally { fsp.readdir = original; fs.readdirSync = originalSync; syncBuiltinESMExports(); }
});

function registry(config: unknown, live: any = {}) {
  const hooks = new Map<string, Function>(), methods = new Map<string, Function>(), services: Array<{ stop?(): Promise<void> }> = [], registered: string[] = [];
  let modelCalls = 0, configWrites = 0;
  const observation: { beforeCurrent?: () => void } = {};
  const api = { pluginConfig: config, config: live, source: "synthetic-complete-plugin", logger: { error() {}, warn() {}, info() {}, debug() {} },
    runtime: { version: "2026.8.2", state: { resolveStateDir: () => live.syntheticStateDirectory ?? "/synthetic-unused-host-state" },
      config: { current: () => { observation.beforeCurrent?.(); return live; }, async mutateConfigFile() { configWrites++; throw new Error("Unexpected Host config write"); } },
      llm: { async complete() { modelCalls++; throw new Error("Unexpected provider request"); } },
      agent: { async runEmbeddedAgent() { modelCalls++; throw new Error("Unexpected Host Agent"); } } },
    on(name: string, handler: Function) { hooks.set(name, handler); registered.push(`hook:${name}`); },
    registerGatewayMethod(name: string, handler: Function, options: { scope: string }) { assert.equal(options.scope, "operator.admin"); methods.set(name, handler); registered.push(`gateway:${name}`); },
    registerService(value: { stop?(): Promise<void> }) { services.push(value); registered.push("service"); },
    registerTool() { registered.push("tool"); }, registerCommand() { registered.push("command"); },
    registerProvider() { registered.push("provider"); }, registerContextEngine() { registered.push("context-engine"); },
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  return { hooks, methods, services, registered, api, observation, counts: () => ({ modelCalls, configWrites }) };
}

async function callRpc(registered: ReturnType<typeof registry>, action: string, extra: Record<string, unknown> = {}) {
  let response: any;
  await registered.methods.get("stella.checkpoint")!({ params: { action, ...extra }, respond: (ok: boolean, payload: unknown, error: unknown) => { response = { ok, payload, error }; } });
  return response;
}

async function fixture(t: TestContext) {
  const root = await realpath(await createFixture()), parent = await realpath(await mkdtemp("/tmp/stella-plugin-seam-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const authority = path.join(parent, "authority"), hostState = path.join(parent, "host-state"), storePath = path.join(parent, "sessions.json");
  await mkdir(authority); await mkdir(hostState);
  const live: any = { syntheticStateDirectory: hostState, commands: { ownerAllowFrom: ["synthetic-owner"] }, session: { store: storePath },
    agents: { entries: { synthetic: { model: { primary: "synthetic/model" } } } } };
  await upsertSessionEntry({ agentId: "synthetic", sessionKey, storePath, env: { OPENCLAW_STATE_DIR: hostState }, entry: { sessionId: "synthetic-session", updatedAt: 1 } });
  assert.equal(getSessionEntry({ agentId: "synthetic", sessionKey, storePath, env: { OPENCLAW_STATE_DIR: hostState }, readConsistency: "latest" })?.sessionId, "synthetic-session");
  const revision = await initializeFixtureRepository(root), config = { recoveryAuthority: "core_checkpoint", canghaiRoot: root,
    checkpointStateDirectory: authority, dataMode: "local_write", agentId: "synthetic", requestArchive: "local" };
  live.plugins = { entries: { "stella-core": { enabled: true, config } } };
  const registered = registry(config, live); t.after(async () => { for (const service of registered.services) await service.stop?.(); });
  const rpc = (action: string, extra: Record<string, unknown> = {}) => callRpc(registered, action, extra);
  const reRegister = () => {
    const next = registry(config, live);
    t.after(async () => { for (const service of next.services) await service.stop?.(); });
    return next;
  };
  assert.equal((await rpc("initialize", { revision, operationId: "synthetic-initialize" })).ok, true);
  const event: any = { runId: "synthetic-host-run", sessionKey, sendPolicy: "allow", inboundAudio: false,
    ctx: { SessionKey: sessionKey, Body: "Synthetic authenticated owner request", SenderId: "synthetic-owner", From: "synthetic-owner",
      Provider: "webchat", ChatType: "direct", Timestamp: 1792627200000, CommandAuthorized: true } };
  let processed: { outcome: string; reason: string } | undefined, idle = 0;
  const controller = new AbortController(), context: any = { dispatchKind: "agent", cfg: live, abortSignal: controller.signal,
    recordProcessed(outcome: string, value: { reason: string }) { processed = { outcome, reason: value.reason }; },
    markIdle() { idle++; }, dispatcher: { sendFinalReply() { throw new Error("No generated delivery allowed"); } } };
  const dispatch = () => registered.hooks.get("reply_dispatch")!(event, context);
  const git = async (...args: string[]) => (await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args])).stdout.trim();
  return { root, parent, authority, hostState, storePath, live, config, revision, registered, rpc, reRegister, event, context, controller, dispatch, git, processed: () => processed, idle: () => idle };
}

test("default and explicit legacy register identically through the real plugin entry", () => {
  const config = { canghaiRoot: "/synthetic-unread-canghai", recoveryRevision: "a".repeat(40), dataMode: "read_only", agentId: "synthetic" };
  const implicit = registry(config), explicit = registry({ ...config, recoveryAuthority: "legacy_config" });
  assert.deepEqual(implicit.registered, explicit.registered); assert.ok(implicit.registered.includes("provider")); assert.ok(implicit.hooks.has("reply_dispatch"));
  assert.ok(!implicit.methods.has("stella.checkpoint")); assert.deepEqual(implicit.counts(), { modelCalls: 0, configWrites: 0 });
});

test("complete plugin public reply dispatch archives owner input through existing business writer and resolver", async t => {
  const f = await fixture(t), before = (await f.rpc("status")).payload.authority;
  assert.deepEqual(await f.dispatch(), { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  const status = await f.rpc("reload"); assert.equal(status.ok, true); assert.equal(status.payload.ingress.state, "local_committed", JSON.stringify(status.payload.ingress)); assert.notEqual(status.payload.authority.revision, f.revision);
  assert.equal(status.payload.ingress.state, "local_committed"); assert.equal(status.payload.consumed, false); assert.equal(status.payload.capabilities.agentMemory, false);
  assert.equal(f.processed()?.reason, "stella_owner_ingress_archived_no_agent"); assert.equal(f.idle(), 1);
  assert.deepEqual(f.registered.counts(), { modelCalls: 0, configWrites: 0 });
  const reader = await CatalogReader.load(f.root, "30_PersonalData/memory/catalog.json"); assert.equal(reader.catalog.sources.length, 1);
  const source = await reader.read(reader.catalog.sources[0]!, "sources"); assert.equal((source.origin as any).adapterId, "openclaw-reply-dispatch-2026.8.2");
  const payloadPath = (source.payloads as any[])[0]!.path, payload = JSON.parse(await readFile(path.join(f.root, payloadPath), "utf8"));
  assert.equal(payload.request.prompt, f.event.ctx.Body); assert.equal(payload.capturedAt, new Date(f.event.ctx.Timestamp).toISOString());
  assert.equal(payload.request.sessionId, "synthetic-session"); assert.equal(payload.schemaVersion, "stella.host-request-snapshot/v1");
  const accepted = status.payload.authority; await f.dispatch(); assert.deepEqual((await f.rpc("status")).payload.authority, accepted);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1"); assert.notEqual(accepted.token, before.token);
  for (const service of f.registered.services) await service.stop?.();
  const restarted = f.reRegister();
  assert.equal((await restarted.hooks.get("reply_dispatch")!(f.event, f.context)).handled, true);
  assert.deepEqual((await callRpc(restarted, "reload")).payload.authority, accepted);
  assert.equal((await callRpc(restarted, "status")).payload.ingress.state, "local_committed");
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1");
  f.event.ctx.Body = "Synthetic changed replay"; await restarted.hooks.get("reply_dispatch")!(f.event, f.context);
  assert.equal((await callRpc(restarted, "status")).payload.ingress.category, "checkpoint_ingress_replay_conflict");
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1");
  assert.equal((await f.registered.hooks.get("before_agent_run")!({}, { agentId: "synthetic" })).outcome, "block");
});

test("publication-time opt-in revocation keeps B pending; re-registration replays original A tuple", async t => {
  const f = await fixture(t), before = (await f.rpc("status")).payload.authority;
  let revoked = false;
  f.registered.observation.beforeCurrent = () => {
    if (fs.readFileSync(path.join(f.root, ".git/refs/heads/main"), "utf8").trim() !== f.revision) {
      revoked = true; f.live.plugins.entries["stella-core"].enabled = false;
    }
  };
  assert.equal((await f.dispatch()).handled, true); assert.equal(revoked, true);
  const failed = (await f.rpc("status")).payload;
  assert.equal(failed.ingress.category, "checkpoint_ingress_configuration_changed");
  assert.notEqual(failed.authority.revision, f.revision); assert.notEqual(failed.authority.token, before.token);
  const pending = JSON.parse(await readFile(path.join(f.root, ".stella-memory-transaction.json"), "utf8"));
  assert.deepEqual(pending.recoveryCheckpoint.expected, { revision: before.revision, token: before.token });
  for (const service of f.registered.services) await service.stop?.();
  f.live.plugins.entries["stella-core"].enabled = true;
  const restarted = f.reRegister();
  assert.equal((await restarted.hooks.get("reply_dispatch")!(f.event, f.context)).handled, true);
  const completed = (await callRpc(restarted, "reload")).payload;
  assert.equal(completed.ingress.state, "local_committed", JSON.stringify(completed.ingress));
  assert.deepEqual(completed.authority, failed.authority);
  await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1");
  assert.deepEqual(restarted.counts(), { modelCalls: 0, configWrites: 0 });
});

test("live Host envelope mutation before archive cannot become a successful retained event", async t => {
  const f = await fixture(t);
  f.registered.observation.beforeCurrent = () => { f.event.ctx.Body = "Changed after ingress captured the Host request"; };
  assert.equal((await f.dispatch()).handled, true);
  assert.equal((await f.rpc("status")).payload.ingress.category, "checkpoint_ingress_request_changed");
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
  assert.deepEqual(f.registered.counts(), { modelCalls: 0, configWrites: 0 });
});

test("rehashed pre-journal intents cannot authorize their own owner or extra file writes", async t => {
  for (const attack of ["self-authorized-owner", "extra-file", "host-time"] as const) await t.test(attack, async t => {
    const f = await fixture(t), authority = (await f.rpc("status")).payload.authority;
    const reader = await CatalogReader.load(f.root, "30_PersonalData/memory/catalog.json");
    const binding = JSON.parse(await readFile(path.join(f.root, "50_PersonalAgent/stella/praxis-binding.json"), "utf8"));
    const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-session", sessionKey,
      prompt: f.event.ctx.Body, senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct", hostMessageTimestamp: f.event.ctx.Timestamp }, f.event.runId);
    const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: new Date(f.event.ctx.Timestamp + (attack === "host-time" ? -86_400_000 : 0)).toISOString() },
      { ...binding.archive, ownerId: attack === "self-authorized-owner" ? "attacker-chosen-owner" : "owner-fixture" });
    const operationId = `correction_archive_${bytesVersion(canonicalJson([request.agentId, request.sessionKey, request.runId])).slice(7)}`;
    const after = structuredClone(reader.catalog);
    for (const object of archive.objects) after[object.group].push(object.entry);
    after.parentGenerationId = reader.catalog.generationId;
    after.generationId = `generation_${bytesVersion(canonicalJson([reader.catalogHash, archive, binding.purpose])).slice(7)}`;
    const directory = "30_PersonalData/memory/operations", plan: MemoryTransactionPlan = {
      operationId, journalPath: `${directory}/${operationId}.checkpoint.json`,
      recoveryCheckpoint: { binding: authority.binding, expected: { revision: authority.revision, token: authority.token } }, files: [
        { path: archive.payload.path, before: null, after: archive.payload.bytes },
        ...archive.objects.map(object => ({ path: object.entry.locator.path, before: null, after: object.bytes })),
        { path: `${directory}/${operationId}.archive.json`, before: null, after: canonicalJson({ schemaVersion: "stella.checkpoint-archive/v1", operationId,
          archiveSha256: bytesVersion(canonicalJson(archive)), purpose: binding.purpose, generationId: after.generationId }) },
        { path: reader.catalogPath, before: canonicalJson(reader.catalog), after: canonicalJson(after) },
      ] };
    const protectedPath = "50_PersonalAgent/stella/praxis-binding.json", original = await readFile(path.join(f.root, protectedPath), "utf8");
    if (attack === "extra-file") plan.files.push({ path: protectedPath, before: original, after: "attacker-selected overwrite" });
    const bytes = serializeMemoryTransactionJournal(plan), marker = path.join(f.root, ".stella-memory-transaction.json");
    await writeFile(marker, bytes);
    assert.equal((await f.dispatch()).handled, true);
    assert.equal((await f.rpc("status")).payload.ingress.category, attack === "host-time" ? "checkpoint_ingress_replay_conflict" : "archive_operation_conflict");
    assert.deepEqual((await f.rpc("status")).payload.authority, authority);
    assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
    assert.equal(await readFile(marker, "utf8"), bytes);
    assert.equal(await readFile(path.join(f.root, protectedPath), "utf8"), original);
    await assert.rejects(readFile(path.join(f.root, archive.payload.path)), { code: "ENOENT" });
    assert.deepEqual(f.registered.counts(), { modelCalls: 0, configWrites: 0 });
  });
});

test("original authority blob ignores replacement refs and ambient Git redirection", async t => {
  const f = await fixture(t), file = "50_PersonalAgent/stella/praxis-binding.json", original = await readFile(path.join(f.root, file), "utf8");
  await writeFile(path.join(f.root, file), original.replace("alpha_praxis", "attacker-purpose"));
  await f.git("add", "--", file); await f.git("commit", "--quiet", "-m", "synthetic replacement only");
  const replacement = await f.git("rev-parse", "HEAD"); await f.git("replace", f.revision, replacement);
  assert.notEqual(await f.git("show", `${f.revision}:${file}`), original.trim());
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = "/synthetic-unread-wrong-repository";
    assert.equal(await readCheckpointCommittedDocument(f.root, f.revision, file), original);
  } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});

test("unsupported, denied, cancelled and closed ingress explicitly handles failure without a default Agent path", async t => {
  for (const kind of ["non-owner", "group", "invalid-time", "missing-session", "cancel", "stop"] as const) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === "non-owner") f.live.commands.ownerAllowFrom = ["different-owner"];
    if (kind === "group") f.event.ctx.ChatType = "group";
    if (kind === "invalid-time") f.event.ctx.Timestamp = Number.NaN;
    if (kind === "missing-session") f.event.sessionKey = f.event.ctx.SessionKey = "agent:synthetic:missing";
    if (kind === "cancel") f.controller.abort();
    if (kind === "stop") for (const service of f.registered.services) await service.stop?.();
    const result = await f.dispatch(); assert.equal(result.handled, true); assert.equal(result.queuedFinal, false); assert.equal(f.processed()?.outcome, "error");
    assert.equal(await f.git("rev-parse", "HEAD"), f.revision); assert.deepEqual(f.registered.counts(), { modelCalls: 0, configWrites: 0 });
    assert.equal((await CatalogReader.load(f.root, "30_PersonalData/memory/catalog.json")).catalog.sources.length, 0);
  });
});

test("package metadata stays diagnostic and cannot issue or revalidate an old strong receipt", async t => {
  const parent = await realpath(await mkdtemp("/tmp/stella-public-provenance-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const core = path.join(parent, "core"), host = path.join(parent, "host"); await mkdir(core); await mkdir(host);
  const coreFile = path.join(core, "package.json"), hostFile = path.join(host, "package.json"), lockFile = path.join(parent, "package-lock.json");
  await writeFile(coreFile, JSON.stringify({ name: "@tower1229/stella-core", version: "0.1.0-alpha.0" }));
  await writeFile(hostFile, JSON.stringify({ name: "openclaw", version: "2026.8.2" }));
  await writeFile(lockFile, JSON.stringify({ packages: { "node_modules/openclaw": { version: "2026.8.2", integrity: "sha512-c3ludGhldGlj" } } }));
  const provenance = await inspectPublicPackageProvenance({ corePackageJson: coreFile, hostPackageJson: hostFile, projectLockfile: lockFile });
  assert.equal(provenance.loadedCodeIdentity, "unverified"); assert.equal(provenance.installedTreeIdentity, "unverified");
  assert.equal(provenance.archiveIntegrityVerified, false); assert.equal(provenance.capabilityReceipt, null); assert.equal(provenance.functionalAcceptance, false);
  const noRead = { runtime: { config: { current() { assert.fail("Unknown identity read private configuration"); } } } } as unknown as OpenClawPluginApi;
  const capture = () => captureInitializationVerificationBinding(noRead, { canghaiRoot: "/synthetic-unread", manifestPath: "unread.yaml", agentId: "synthetic" });
  await assert.rejects(capture(), /verification_code_identity_unavailable/);
  await writeFile(hostFile, JSON.stringify({ name: "openclaw", version: "2026.8.3" }));
  assert.equal((await inspectPublicPackageProvenance({ corePackageJson: coreFile, hostPackageJson: hostFile, projectLockfile: lockFile })).lockedHost?.matchesDeclaredVersion, false);
  const digest = "sha256:" + "a".repeat(64), binding = { core: digest, artifact: digest, host: digest, harness: digest, source: digest, profile: digest, policy: digest, configuration: digest, model: digest, cases: digest };
  const store = createMemoryCapabilityReceiptStore(), receipt = await issueCapabilityReceipt({ capabilityId: "host_initialization", adapterId: "synthetic-old-strong", adapterVersion: "1",
    host: { actorHash: digest, runId: "synthetic-old", purpose: { kind: "adapter_verification", capabilityId: "host_initialization" }, resourceScope: digest },
    binding, result: "passed", executionDigest: digest, store });
  await assert.rejects(admitBusinessCapability({ capabilityId: "host_initialization", receipt, captureBinding: capture, store }), /verification_code_identity_unavailable/);
  assert.ok(await store.read(receipt.id));
});


test("missing Host timestamp uses the original Core receive clock across completed operation restart", async t => {
  const f = await fixture(t); delete f.event.ctx.Timestamp;
  const earliest = Date.now(); assert.equal((await f.dispatch()).handled, true);
  const first = (await f.rpc("status")).payload; assert.equal(first.ingress.state, "local_committed"); assert.equal(first.ingress.capturedAtSource, "core_receive_clock");
  const reader = await CatalogReader.load(f.root, "30_PersonalData/memory/catalog.json"), source = await reader.read(reader.catalog.sources[0]!, "sources");
  const snapshot = JSON.parse(await readFile(path.join(f.root, (source.payloads as any[])[0].path), "utf8"));
  assert.equal(snapshot.request.hostMessageTimestamp, undefined); assert.ok(Date.parse(snapshot.capturedAt) >= earliest);
  for (const service of f.registered.services) await service.stop?.();
  const restarted = f.reRegister(); assert.equal((await restarted.hooks.get("reply_dispatch")!(f.event, f.context)).handled, true);
  const second = (await callRpc(restarted, "status")).payload; assert.equal(second.ingress.state, "local_committed", JSON.stringify(second.ingress));
  assert.deepEqual(second.authority, first.authority); assert.equal(await f.git("rev-parse", "HEAD"), first.authority.revision);
  assert.equal((await CatalogReader.load(f.root, "30_PersonalData/memory/catalog.json")).catalog.sources.length, 1);
});
