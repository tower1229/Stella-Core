import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Ajv } from "ajv";
import { createFixture, prepareInitializationFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { registerCheckpointPlugin } from "../src/openclaw/checkpoint-plugin-registration.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { prepareHostInputArchive } from "../src/canghai/host-input-archive.js";
import { applyMemoryTransaction, readRecordedMemoryTransaction } from "../src/canghai/memory-transaction.js";
import { openLocalCheckpointRecovery } from "../src/canghai/local-checkpoint-recovery.js";
import { StellaInitializer } from "../src/openclaw/initialization.js";
import { withExclusiveFileLock } from "../src/canghai/exclusive-file-lock.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import type { HostInputSnapshot } from "../src/openclaw/host-input.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { HostIdentity } from "../src/openclaw/initialization-templates.js";

const run = promisify(execFile), catalogPath = "30_PersonalData/memory/catalog.json";
async function fixture(t: TestContext, catalogFormat?: "pretty-lf" | "pretty-crlf") {
  const root = await realpath(await createFixture()), parent = await realpath(await mkdtemp("/tmp/stella-checkpoint-plugin-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const materialization = await prepareInitializationFixture(root, "synthetic");
  if (catalogFormat) {
    const file = path.join(root, catalogPath);
    const pretty = JSON.stringify(JSON.parse(await readFile(file, "utf8")), null, 2) + "\n";
    await writeFile(file, catalogFormat === "pretty-crlf" ? pretty.replace(/\n/g, "\r\n") : pretty);
  }
  const revision = await initializeFixtureRepository(root);
  const stateDirectory = path.join(parent, "authority"), workspace = path.join(parent, "workspace"), stateRoot = path.join(parent, "initialization");
  await mkdir(stateDirectory); await mkdir(workspace); await mkdir(stateRoot);
  const config = parseCheckpointPluginConfig({ recoveryAuthority: "core_checkpoint", canghaiRoot: root,
    checkpointStateDirectory: stateDirectory, dataMode: "local_write", agentId: "synthetic" });
  const runtime = await createCheckpointPluginRuntime(config, "2026.8.2"); t.after(() => runtime.close());
  const git = async (...args: string[]) => (await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args])).stdout.trim();
  let identity: HostIdentity | null = null, verified = 0;
  const initialization = { workspace, stateRoot, source: { recipePath: "50_PersonalAgent/stella/host-materialization.json",
    skillRegistryRef: materialization.skill_bindings[0]!.registry_ref.ref, contractProfile: "alpha_praxis" as const }, ports: {
    async fence() {}, async release() {}, async readIdentity() { return identity; },
    async applyIdentity(before: HostIdentity | null, after: HostIdentity | null, allowAlreadyApplied: boolean) { if (allowAlreadyApplied && canonicalJson(identity) === canonicalJson(after)) return; assert.deepEqual(identity, before); identity = after; },
    async verify(recipe: { files: readonly { target: string; sha256: string }[] }) {
      assert.equal(recipe.files.length, 6); for (const file of recipe.files) assert.ok((await readFile(path.join(workspace, file.target))).length); verified++;
    },
  } };
  const reader = await CatalogReader.load(root, catalogPath), policyRef = reader.catalog.policies[0]!;
  function archive(id = "message-synthetic") {
    const snapshot: HostInputSnapshot = { schemaVersion: "stella.host-input-snapshot/v1", hostVersion: "2026.8.2", agentId: "synthetic", sessionId: "session-synthetic",
      sessionKey: "agent:synthetic:test", entryId: id, logicalTurnId: `turn-${id}`, generation: "generation-synthetic", rawSeq: 1,
      parentId: null, text: "Synthetic retained original only.", event: { type: "message", id, parentId: null, timestamp: "2026-10-22T00:00:00Z",
        message: { role: "user", content: "Synthetic retained original only." } } };
    return prepareHostInputArchive(snapshot, { policyRef, objectRoot: "30_PersonalData/memory/objects", payloadRoot: "30_PersonalData/host-archive", speaker: { id: "owner-fixture", role: "owner" } });
  }
  const purpose = { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat" };
  const initialize = () => runtime.initializeAuthority({ revision, operationId: "initialize-synthetic" });
  return { root, parent, revision, config, runtime, git, reader, archive, purpose, initialization, initialize, verified: () => verified };
}
const fails = (category: string) => (error: unknown) => { assert.ok(error && typeof error === "object" && "category" in error); assert.equal(error.category, category); return true; };

test("checkpoint archive preserves exact formatted catalog bytes through publication failure and restart replay", async t => {
  for (const format of ["pretty-lf", "pretty-crlf"] as const) await t.test(format, async t => {
    const f = await fixture(t, format); await f.initialize();
    const before = await f.runtime.capture(), archive = f.archive();
    const originalBytes = await readFile(path.join(f.root, catalogPath), "utf8");
    assert.notEqual(originalBytes, canonicalJson(JSON.parse(originalBytes)));
    const input = { reader: f.reader, archive, operationId: "formatted-catalog-archive", recovery: before, purpose: f.purpose };
    await assert.rejects(f.runtime.archiveLocal({ ...input, async assertPublication() { throw new Error("Synthetic formatted publication failure"); } }), /Synthetic formatted publication failure/);
    const revisionB = await f.git("rev-parse", "HEAD"), accepted = await f.runtime.capture();
    assert.notEqual(revisionB, f.revision); assert.equal(accepted.expected.revision, revisionB);
    const plan = await readRecordedMemoryTransaction(f.root, input.operationId);
    assert.equal(plan.files.find(file => file.path === catalogPath)!.before, originalBytes);
    assert.equal(plan.recoveryCheckpoint!.expected.revision, f.revision);
    f.runtime.close();
    const reopened = await createCheckpointPluginRuntime(f.config, "2026.8.2"); t.after(() => reopened.close());
    const freshScope = await reopened.capture();
    const replayed = await reopened.archiveLocal({ ...input, recovery: { resolver: freshScope.resolver, expected: before.expected } });
    assert.equal(replayed.replayed, true); assert.equal(await f.git("rev-parse", "HEAD"), revisionB);
    assert.deepEqual((await reopened.capture()).expected, accepted.expected);
    assert.equal(await readFile(path.join(f.root, archive.payload.path), "utf8"), archive.payload.bytes);
    await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
    assert.equal(await f.git("status", "--porcelain"), "");
  });
});

test("uncommitted catalog reformatting still rejects before archive writes", async t => {
  const f = await fixture(t, "pretty-lf"); await f.initialize();
  const before = await f.runtime.capture(), archive = f.archive();
  const file = path.join(f.root, catalogPath), originalBytes = await readFile(file, "utf8");
  await writeFile(file, originalBytes.replace(/\n/g, "\r\n"));
  await assert.rejects(f.runtime.archiveLocal({ reader: f.reader, archive, operationId: "uncommitted-format", recovery: before, purpose: f.purpose }), fails("stale_generation"));
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
  assert.deepEqual((await f.runtime.capture()).expected, before.expected);
  await assert.rejects(readFile(path.join(f.root, archive.payload.path)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
});

test("actual initialization, retained archive Git commit, checkpoint publication, reload and reopen form one local loop", async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.load(), fails("checkpoint_missing"));
  await f.initialize();
  const before = await f.runtime.load(), init = await f.runtime.prepareInitialization(f.initialization);
  const receipt = await init.initialize(); assert.equal(receipt.sourceRevision, f.revision); assert.equal(f.verified(), 1);
  const archive = f.archive(), result = await f.runtime.archiveLocal({ reader: f.reader, archive, operationId: "archive-one", recovery: before.recovery, purpose: f.purpose });
  assert.equal(result.persistenceStatus, "local_committed");
  const after = await f.runtime.load(); assert.equal(after.loaded.recoveryRevision, await f.git("rev-parse", "HEAD"));
  assert.notEqual(after.recovery.expected.revision, f.revision); assert.notEqual(after.recovery.expected.token, before.recovery.expected.token);
  assert.equal(await readFile(path.join(f.root, archive.payload.path), "utf8"), archive.payload.bytes);
  await assert.rejects(f.runtime.assert(before.recovery), fails("checkpoint_runtime_stale"));
  await assert.rejects(init.assertCurrent(), fails("checkpoint_runtime_stale"));
  const fresh = await f.runtime.prepareInitialization(f.initialization); assert.equal((await fresh.assertCurrent()).sourceRevision, f.revision);
  const reopened = await createCheckpointPluginRuntime(f.config, "2026.8.2"); t.after(() => reopened.close());
  assert.deepEqual((await reopened.load()).recovery.expected, after.recovery.expected);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("postcommit publication failure keeps B and pending; restart replays original A without another commit or token advance", async t => {
  const f = await fixture(t); await f.initialize(); const before = await f.runtime.capture(), archive = f.archive();
  const input = { reader: f.reader, archive, operationId: "archive-publish-failure", recovery: before, purpose: f.purpose };
  await assert.rejects(f.runtime.archiveLocal({ ...input, async assertPublication() { throw new Error("Synthetic publication failure"); } }), /Synthetic publication failure/);
  const revisionB = await f.git("rev-parse", "HEAD"), accepted = await f.runtime.capture(); assert.equal(accepted.expected.revision, revisionB);
  await assert.rejects(f.runtime.load(), fails("stella_recovery_revision_invalid"));
  const marker = await readFile(path.join(f.root, ".stella-memory-transaction.json"), "utf8");
  assert.equal(JSON.parse(marker).recoveryCheckpoint.expected.revision, f.revision);
  f.runtime.close();
  const reopened = await createCheckpointPluginRuntime(f.config, "2026.8.2"); t.after(() => reopened.close());
  const newScope = await reopened.capture();
  const original = { resolver: newScope.resolver, expected: before.expected };
  const readerIdentity = { root: f.root, catalogPath, catalogHash: f.reader.catalogHash };
  const retried = await reopened.archiveLocal({ ...input, reader: readerIdentity, recovery: original });
  assert.equal(retried.replayed, true); assert.equal(await f.git("rev-parse", "HEAD"), revisionB);
  assert.deepEqual((await reopened.capture()).expected, accepted.expected);
  await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
  let gates = 0;
  await reopened.archiveLocal({ ...input, reader: readerIdentity, recovery: original, async assertPublication() { gates++; } });
  assert.equal(gates, 1, "completed-journal replay must still verify publication");
  await assert.rejects(reopened.archiveLocal({ ...input, recovery: original, purpose: { ...f.purpose, readPurpose: "other" } }), /archive_operation_conflict/);
});

test("stale expectation rejects a new archive before payload write and cannot replay after a later child", async t => {
  const f = await fixture(t); await f.initialize(); const original = await f.runtime.capture();
  await f.runtime.archiveLocal({ reader: f.reader, archive: f.archive(), operationId: "archive-A", recovery: original, purpose: f.purpose });
  const secondArchive = f.archive("second"), second = { reader: await CatalogReader.load(f.root, catalogPath), archive: secondArchive, operationId: "archive-B", purpose: f.purpose };
  await assert.rejects(f.runtime.archiveLocal({ ...second, recovery: original }), fails("checkpoint_runtime_stale"));
  await assert.rejects(readFile(path.join(f.root, secondArchive.payload.path)), { code: "ENOENT" });
  await f.runtime.archiveLocal({ ...second, recovery: await f.runtime.capture() });
  const current = await f.runtime.capture();
  await assert.rejects(f.runtime.archiveLocal({ reader: f.reader, archive: f.archive(), operationId: "archive-A", recovery: original, purpose: f.purpose }), /checkpoint_runtime_git_mismatch/);
  assert.deepEqual((await f.runtime.capture()).expected, current.expected);
});

test("cancellation and registration shutdown during asynchronous publication retain the fence and never release stale work", async t => {
  for (const kind of ["cancel", "close"] as const) await t.test(kind, async t => {
    const f = await fixture(t); await f.initialize(); const recovery = await f.runtime.capture(), controller = new AbortController();
    await assert.rejects(f.runtime.archiveLocal({ reader: f.reader, archive: f.archive(), operationId: `archive-${kind}`, recovery, purpose: f.purpose, signal: controller.signal,
      async assertPublication() { await Promise.resolve(); if (kind === "cancel") controller.abort(); else f.runtime.close(); } }));
    assert.ok((await readFile(path.join(f.root, ".stella-memory-transaction.json"))).length);
    assert.notEqual(await f.git("rev-parse", "HEAD"), f.revision);
    if (kind === "close") await assert.rejects(recovery.resolver.assertCurrent(recovery.expected), fails("recovery_scope_closed"));
  });
});

test("permission/source mutation during publication is rechecked and not released", async t => {
  const f = await fixture(t); await f.initialize(); const recovery = await f.runtime.capture();
  const policy = path.join(f.root, f.reader.catalog.policies[0]!.locator.path);
  await assert.rejects(f.runtime.archiveLocal({ reader: f.reader, archive: f.archive(), operationId: "archive-revoke", recovery, purpose: f.purpose,
    async assertPublication() { const value = JSON.parse(await readFile(policy, "utf8")); value.readPurposes = []; await writeFile(policy, canonicalJson(value)); } }));
  assert.ok((await readFile(path.join(f.root, ".stella-memory-transaction.json"))).length);
  await assert.rejects(f.runtime.load());
});

test("v2 without an adapter and v1 with a checkpoint adapter reject before journal directories are created", async t => {
  const f = await fixture(t); await f.initialize(); const recovery = await f.runtime.capture();
  const plan = { operationId: "invalid-adapter", journalPath: "never-created/journal.json", files: [{ path: "README.md", before: null, after: "synthetic" }],
    recoveryCheckpoint: { binding: recovery.expected.binding, expected: { revision: recovery.expected.revision, token: recovery.expected.token } } };
  const ports = { async validate() {}, async persist() {}, async confirmPreviouslyCommitted() {} };
  await assert.rejects(applyMemoryTransaction(f.root, plan, ports), fails("transaction_recovery_required"));
  const authority = await openLocalCheckpointRecovery({ stateDirectory: f.config.checkpointStateDirectory, binding: recovery.expected.binding });
  const { recoveryCheckpoint: _, ...legacy } = plan;
  await assert.rejects(applyMemoryTransaction(f.root, legacy, { ...ports, recovery: { authority, expected: recovery.expected, async assertPublication() {} } }), fails("transaction_recovery_required"));
  await assert.rejects(readFile(path.join(f.root, plan.journalPath)), { code: "ENOENT" });
});

test("missing/corrupt state and read-only mode never adopt HEAD or a legacy configuration pointer", async t => {
  const f = await fixture(t);
  assert.throws(() => parseCheckpointPluginConfig({ ...f.config, recoveryRevision: f.revision }), /checkpoint_configuration_invalid/);
  await assert.rejects(f.runtime.capture(), fails("checkpoint_missing"));
  await f.initialize(); await writeFile(path.join(f.config.checkpointStateDirectory, "checkpoint.json"), "corrupt");
  await assert.rejects(f.runtime.load(), fails("checkpoint_corrupt"));
  const readOnly = await createCheckpointPluginRuntime({ ...f.config, dataMode: "read_only" }, "2026.8.2"); t.after(() => readOnly.close());
  await assert.rejects(readOnly.initializeAuthority({ revision: f.revision, operationId: "read-only" }), fails("checkpoint_write_disabled"));
});

test("a changed bootstrap projection remains protected and a stopped initializer cannot become ready again", async t => {
  const f = await fixture(t); await f.initialize(); const operation = await f.runtime.prepareInitialization(f.initialization);
  await operation.initialize(); await writeFile(path.join(f.initialization.workspace, "AGENTS.md"), "Synthetic user modification");
  await assert.rejects(operation.assertCurrent(), /projection_drift/);
  await assert.rejects(operation.initialize(), /projection_drift|host_file_conflict/);
  assert.equal(await readFile(path.join(f.initialization.workspace, "AGENTS.md"), "utf8"), "Synthetic user modification");
  f.runtime.close(); await assert.rejects(operation.assertCurrent(), fails("recovery_scope_closed"));
});

test("plugin manifest requires exactly one authority; legacy pointer remains required by default", async () => {
  const document = JSON.parse(await readFile(path.join(process.cwd(), "openclaw.plugin.json"), "utf8"));
  const validate = new Ajv({ strict: false }).compile(document.configSchema);
  const legacy = { canghaiRoot: "/synthetic", dataMode: "read_only", recoveryRevision: "a".repeat(40) };
  assert.equal(validate(legacy), true); assert.equal(validate({ canghaiRoot: "/synthetic", dataMode: "read_only" }), false);
  const core = { canghaiRoot: "/synthetic", dataMode: "local_write", recoveryAuthority: "core_checkpoint", checkpointStateDirectory: "/synthetic-state" };
  assert.equal(validate(core), true); assert.equal(validate({ ...core, recoveryRevision: legacy.recoveryRevision }), false);
  assert.equal(validate({ ...legacy, checkpointStateDirectory: "/synthetic-state" }), false);
});

test("restricted plugin registration uses one resolver, no config writes or legacy providers, and blocks Agent execution", async t => {
  const f = await fixture(t), hooks = new Map<string, Function>(), methods = new Map<string, Function>(), tools: unknown[] = [], services: { stop(): Promise<void> }[] = [];
  let updates = 0;
  const api = { pluginConfig: f.config, runtime: { version: "2026.8.2", config: { current() { throw new Error("No private Host config reads"); }, async mutateConfigFile() { updates++; } } },
    on(name: string, handler: Function) { hooks.set(name, handler); }, registerTool(tool: unknown) { tools.push(tool); },
    registerGatewayMethod(name: string, handler: Function, options: { scope: string }) { assert.equal(options.scope, "operator.admin"); methods.set(name, handler); },
    registerService(service: { stop(): Promise<void> }) { services.push(service); }, registerProvider() { throw new Error("Legacy provider not allowed"); },
  } as unknown as OpenClawPluginApi;
  const registration = registerCheckpointPlugin(api);
  assert.equal((await hooks.get("before_agent_run")!({}, { agentId: "synthetic" })).outcome, "block");
  assert.equal((await hooks.get("before_agent_run")!({}, { agentId: "other" })).outcome, "pass");
  let response: unknown[] = [];
  await methods.get("stella.checkpoint")!({ params: { action: "initialize", revision: f.revision, operationId: "operator-explicit" }, respond: (...args: unknown[]) => { response = args; } });
  assert.equal(response[0], true);
  const status = await registration.status(true); assert.equal(status.materialized, null); assert.equal(status.consumed, false); assert.equal(status.capabilities.full_memory, false);
  assert.equal(updates, 0); assert.equal(tools.length, 1);
  await services[0]!.stop(); await assert.rejects(registration.status(), fails("recovery_scope_closed"));
});


test("failure before Git commit resumes the original journal after reopen and commits once", async t => {
  const f = await fixture(t); await f.initialize(); const original = await f.runtime.capture();
  const authority = await openLocalCheckpointRecovery({ stateDirectory: f.config.checkpointStateDirectory, binding: original.expected.binding });
  const plan = { operationId: "before-commit-failure", journalPath: "operations/before-commit.json", files: [{ path: "synthetic-note.txt", before: null, after: "Synthetic local note" }],
    recoveryCheckpoint: { binding: original.expected.binding, expected: { revision: original.expected.revision, token: original.expected.token } } };
  const ports = { recovery: { authority, expected: original.expected, async assertPublication() {} }, async validate() {},
    async persist() { throw new Error("Synthetic precommit failure"); }, async confirmPreviouslyCommitted() { throw new Error("No legacy confirmation"); } };
  await assert.rejects(applyMemoryTransaction(f.root, plan, ports), /Synthetic precommit failure/);
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision); assert.deepEqual((await authority.read()), original.expected);
  const recorded = await readRecordedMemoryTransaction(f.root, plan.operationId), reopened = await openLocalCheckpointRecovery({ stateDirectory: f.config.checkpointStateDirectory, binding: original.expected.binding });
  let published = 0;
  await applyMemoryTransaction(f.root, recorded, { ...ports, recovery: { authority: reopened, expected: original.expected, async assertPublication(accepted) { published++; assert.notEqual(accepted.revision, f.revision); } },
    async persist(paths) { await f.git("add", "--", ...paths); await f.git("commit", "--quiet", "-m", "Synthetic commit after failure", "--", ...paths); } });
  assert.equal(published, 1); assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1");
  assert.equal(await f.git("status", "--porcelain"), "");
});


test("Core initialization refuses unowned destinations and preserves previously confirmed modes", async t => {
  const f = await fixture(t); await f.initialize();
  const target = path.join(f.initialization.workspace, "AGENTS.md");
  await writeFile(target, "Synthetic user-owned file");
  const operation = await f.runtime.prepareInitialization(f.initialization);
  await assert.rejects(operation.initialize(), /host_file_unowned/);
  assert.equal(await readFile(target, "utf8"), "Synthetic user-owned file"); await rm(target);
  await operation.initialize(); await chmod(target, 0o644);
  await assert.rejects(operation.initialize(), /projection_mode_drift/);
});

test("publication cannot release a payload changed after CAS or archive into an unselected Git child", async t => {
  await t.test("late payload mutation", async t => {
    const f = await fixture(t); await f.initialize(); const recovery = await f.runtime.capture(), archive = f.archive();
    await assert.rejects(f.runtime.archiveLocal({ reader: f.reader, archive, operationId: "late-payload", recovery, purpose: f.purpose,
      async assertPublication() { await writeFile(path.join(f.root, archive.payload.path), "Synthetic invalid replacement"); } }), /checkpoint_runtime_dirty/);
    assert.ok((await readFile(path.join(f.root, ".stella-memory-transaction.json"))).length);
  });
  await t.test("unselected Git child", async t => {
    const f = await fixture(t); await f.initialize(); const recovery = await f.runtime.capture(), archive = f.archive();
    await writeFile(path.join(f.root, "unrelated.txt"), "Synthetic unrelated child"); await f.git("add", "--", "unrelated.txt"); await f.git("commit", "--quiet", "-m", "Synthetic unselected child");
    const current = await f.git("rev-parse", "HEAD");
    await assert.rejects(f.runtime.archiveLocal({ reader: f.reader, archive, operationId: "unselected-child", recovery, purpose: f.purpose }), /transaction_recovery_revision_mismatch/);
    await assert.rejects(readFile(path.join(f.root, archive.payload.path)), { code: "ENOENT" });
    assert.equal(await f.git("rev-parse", "HEAD"), current); assert.equal(await f.git("status", "--porcelain"), "");
  });
});


test("strict initializer protects new user paths and confirmed modes during a recipe upgrade", async t => {
  for (const kind of ["new-target", "mode-drift"] as const) await t.test(kind, async t => {
    const f = await fixture(t); await f.initialize(); await (await f.runtime.prepareInitialization(f.initialization)).initialize();
    const document = await prepareInitializationFixture(f.root, "synthetic", "Synthetic revised skill instructions.");
    let target: string;
    if (kind === "new-target") {
      const binding = document.skill_bindings[0]!, bytes = "Synthetic new reviewed reference";
      const source = path.join(f.root, binding.source_root.slice(5), "reference.txt"); await writeFile(source, bytes);
      binding.files.push({ path: "reference.txt", sha256: bytesVersion(bytes), executable: false });
      binding.tree_digest = bytesVersion(canonicalJson(binding.files));
      await writeFile(path.join(f.root, f.initialization.source.recipePath), JSON.stringify(document));
      target = path.join(f.initialization.workspace, "skills/stella-initialization-probe/reference.txt");
      await writeFile(target, "Synthetic unowned user content");
    } else {
      target = path.join(f.initialization.workspace, "AGENTS.md"); await chmod(target, 0o644);
    }
    await f.git("add", "--", "50_PersonalAgent/stella"); await f.git("commit", "--quiet", "-m", "Synthetic recipe upgrade");
    // Unit-level source upgrade: the public initializer is supplied an explicit B. This does not migrate the Core checkpoint.
    const initializer = new StellaInitializer(f.initialization.workspace, f.initialization.stateRoot,
      { ...f.initialization.source, root: f.root, revision: await f.git("rev-parse", "HEAD"), agentId: "synthetic", hostVersion: "2026.8.2" },
      { ...f.initialization.ports, strictOwnership: true, withLock: withExclusiveFileLock, recoveryAuthority: { ...(await f.runtime.capture()).expected, revision: await f.git("rev-parse", "HEAD"), token: "synthetic-unit-upgrade" } });
    await assert.rejects(initializer.initialize(), kind === "new-target" ? /host_file_unowned/ : /projection_mode_drift/);
    if (kind === "new-target") assert.equal(await readFile(target, "utf8"), "Synthetic unowned user content");
    assert.equal((await f.runtime.capture()).expected.revision, f.revision);
  });
});


test("Core initialization rejects legacy pending and replays only its persisted original checkpoint tuple", async t => {
  await t.test("legacy pending cannot adopt unowned existing files", async t => {
    const f = await fixture(t); await f.initialize();
    const target = path.join(f.initialization.workspace, "AGENTS.md"); await writeFile(target, "Synthetic user file before legacy intent");
    const legacy = new StellaInitializer(f.initialization.workspace, f.initialization.stateRoot,
      { ...f.initialization.source, root: f.root, revision: f.revision, agentId: "synthetic", hostVersion: "2026.8.2" }, f.initialization.ports);
    const plan = await legacy.plan(); assert.equal(plan.recoveryAuthority, undefined);
    const bytes = canonicalJson(plan); await writeFile(path.join(f.initialization.stateRoot, "pending.json"), bytes);
    await assert.rejects((await f.runtime.prepareInitialization(f.initialization)).initialize(), /initialization_checkpoint_pending_unverified/);
    assert.equal(await readFile(target, "utf8"), "Synthetic user file before legacy intent");
    assert.equal(await readFile(path.join(f.initialization.stateRoot, "pending.json"), "utf8"), bytes);
  });
  await t.test("same Core pending resumes after reopen; changed token cannot be filled from current", async t => {
    const f = await fixture(t); await f.initialize(); const original = await f.runtime.capture();
    const operation = await f.runtime.prepareInitialization({ ...f.initialization, ports: { ...f.initialization.ports,
      async verify() { throw new Error("Synthetic initialization verify failure"); } } });
    await assert.rejects(operation.initialize(), /Synthetic initialization verify failure/);
    const pending = path.join(f.initialization.stateRoot, "pending.json"), bytes = await readFile(pending, "utf8"), plan = JSON.parse(bytes);
    assert.deepEqual(plan.recoveryAuthority, original.expected); f.runtime.close();
    const reopened = await createCheckpointPluginRuntime(f.config, "2026.8.2"); t.after(() => reopened.close());
    const changed = { ...plan, recoveryAuthority: { ...plan.recoveryAuthority, token: "stale-original-token" } };
    const { planHash: _, ...body } = changed; changed.planHash = bytesVersion(canonicalJson(body)); await writeFile(pending, canonicalJson(changed));
    await assert.rejects((await reopened.prepareInitialization(f.initialization)).initialize(), /initialization_checkpoint_pending_unverified/);
    await writeFile(pending, bytes);
    assert.equal((await (await reopened.prepareInitialization(f.initialization)).initialize()).sourceRevision, f.revision);
    await assert.rejects(readFile(pending), { code: "ENOENT" });
    assert.deepEqual((await reopened.capture()).expected, original.expected);
  });
});


test("snapshot import is explicit operator maintenance, blocks new runs and never repairs invalid inputs", async t => {
  const f = await fixture(t); await f.initialize(); const before = await f.runtime.capture();
  const hooks = new Map<string, Function>(), methods = new Map<string, Function>(), services: { stop(): Promise<void> }[] = [];
  let configurationWrites = 0;
  const api = { pluginConfig: f.config, runtime: { version: "2026.8.2", config: {
    current() { throw new Error("No Host config needed for rejected import"); }, async mutateConfigFile() { configurationWrites++; } } },
    on(name: string, handler: Function) { hooks.set(name, handler); }, registerTool() {},
    registerGatewayMethod(name: string, handler: Function, options: { scope: string }) { assert.equal(options.scope, "operator.admin"); methods.set(name, handler); },
    registerService(service: { stop(): Promise<void> }) { services.push(service); },
  } as unknown as OpenClawPluginApi;
  registerCheckpointPlugin(api); t.after(async () => { await services[0]!.stop(); });
  const invoke = async (params: unknown) => {
    let response: unknown[] = [];
    await methods.get("stella.checkpoint")!({ params, respond: (...args: unknown[]) => { response = args; } }); return response;
  };
  const input = { action: "import", expectedRevision: before.expected.revision, expectedToken: before.expected.token,
    candidateRoot: path.join(f.parent, "not-opened"), producerBaseRevision: f.revision, candidateRevision: "invalid-revision", operationId: "invalid-import" };
  assert.equal((await invoke({ ...input, unexpected: true }))[0], false);
  const pending = invoke(input);
  const blocked = await hooks.get("before_agent_run")!({}, { agentId: "synthetic" });
  assert.equal(blocked.category, "checkpoint_import_in_progress");
  assert.equal((await pending)[0], false);
  assert.notEqual((await hooks.get("before_agent_run")!({}, { agentId: "synthetic" })).category, "checkpoint_import_in_progress");
  assert.deepEqual((await f.runtime.capture()).expected, before.expected);
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
  assert.equal(await f.git("status", "--porcelain"), ""); assert.equal(configurationWrites, 0);
});
