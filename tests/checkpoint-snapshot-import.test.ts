import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { importCheckpointSnapshot } from "../src/canghai/checkpoint-snapshot-import.js";
import { openLocalCheckpointRecovery } from "../src/canghai/local-checkpoint-recovery.js";
import { createAgentSupplySource } from "./checkpoint-agent-supply-fixture.js";
import { prepareSnapshotImportFixture } from "./checkpoint-snapshot-fixture.js";

const execute = promisify(execFile), manifestPath = "50_PersonalAgent/stella/manifest.yaml";
const grantPath = "50_PersonalAgent/stella/checkpoint-access.json";
async function git(root: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" });
  return (await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Synthetic Snapshot Test", "-c", "user.email=snapshot@example.invalid", "-C", root, ...args], { env, timeout: 15_000 })).stdout.trim();
}
async function fixture(t: TestContext, options: { missingDescriptor?: boolean; catalogConflict?: boolean } = {}) {
  const parent = await realpath(await mkdtemp("/tmp/stella-checkpoint-snapshot-"));
  const source = await createAgentSupplySource({ policyContext: "allow" }), candidateRoot = path.join(parent, "candidate");
  t.after(async () => { await rm(source.root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const projection = await prepareSnapshotImportFixture(source, candidateRoot);
  if (options.missingDescriptor) {
    const file = path.join(source.root, grantPath), grant = JSON.parse(await readFile(file, "utf8"));
    grant.descriptors = grant.descriptors.filter((item: { sourceRef: { version: string } }) => item.sourceRef.version !== projection.sourceRef.version);
    await writeFile(file, canonicalJson(grant)); await git(source.root, "add", "--", grantPath); await git(source.root, "commit", "--quiet", "-m", "Synthetic consumer without new descriptor");
  }
  if (options.catalogConflict) {
    const file = path.join(source.root, source.catalogPath), catalog = JSON.parse(await readFile(file, "utf8"));
    catalog.generationId = "synthetic-local-independent-generation";
    await writeFile(file, canonicalJson(catalog)); await git(source.root, "add", "--", source.catalogPath); await git(source.root, "commit", "--quiet", "-m", "Synthetic independent catalog change");
  }
  const stateDirectory = path.join(parent, "authority"); await mkdir(stateDirectory, { mode: 0o700 });
  const binding = { agentId: "synthetic", repositoryRoot: source.root, manifestPath };
  const authority = await openLocalCheckpointRecovery({ stateDirectory, binding });
  const revision = await git(source.root, "rev-parse", "HEAD");
  await authority.initialize({ revision, operationId: "synthetic-snapshot-initialize" });
  const expected = await authority.read();
  const input = { root: source.root, manifestPath, hostVersion: "2026.8.2", candidateRoot,
    producerBaseRevision: projection.producerBaseRevision, candidateRevision: projection.candidateRevision, operationId: "snapshot-import-one", expected };
  const commit = async (paths: string[], operationId: string) => {
    await git(source.root, "add", "--", ...paths);
    await git(source.root, "commit", "--quiet", "-m", `[synthetic] ${operationId}`, "--", ...paths);
  };
  const unchanged = async () => {
    assert.equal(await git(source.root, "rev-parse", "HEAD"), revision);
    assert.equal(await git(source.root, "status", "--porcelain"), "");
    assert.deepEqual(await authority.read(), expected);
    await assert.rejects(readFile(path.join(source.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(source.root, ".stella-memory-transaction.json.lock")), { code: "ENOENT" });
    await assert.rejects(git(source.root, "show-ref", "--verify", `refs/stella/imports/${input.candidateRevision}`));
  };
  return { source, projection, input, authority, stateDirectory, commit, unchanged };
}
function category(expected: string) { return (error: unknown): boolean => {
  assert.ok(error && typeof error === "object" && "category" in error); assert.equal(error.category, expected); return true;
}; }

test("explicit data snapshot creates a Core child/journal/CAS under the owned repository lock and exact replay is idempotent", async t => {
  const f = await fixture(t), grant = await readFile(path.join(f.source.root, grantPath), "utf8");
  const before = await CatalogReader.load(f.source.root, f.source.catalogPath);
  const result = await importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit });
  assert.ok(result.authority); assert.equal(result.replayed, false); assert.equal(result.candidateRevision, f.input.candidateRevision);
  assert.notEqual(result.authority.revision, f.input.candidateRevision);
  assert.equal(await git(f.source.root, "rev-parse", "HEAD^"), f.input.expected.revision);
  assert.equal(await git(f.source.root, "rev-parse", "HEAD"), result.authority.revision);
  assert.equal(await git(f.source.root, "show-ref", "--verify", "--hash", `refs/stella/imports/${f.input.candidateRevision}`), f.input.candidateRevision);
  assert.equal(await readFile(path.join(f.source.root, grantPath), "utf8"), grant);
  const current = await CatalogReader.load(f.source.root, f.source.catalogPath);
  const entry = current.entry(f.projection.sourceRef, "sources"), source = await current.read(entry, "sources");
  const payload = (source.payloads as Array<{ sha256: string }>)[0]!;
  assert.ok((await current.readPayload(entry, payload.sha256)).bytes.toString("utf8").includes(f.projection.marker));
  for (const group of ["sources", "evidence", "coverage"] as const) for (const old of before.catalog[group]) {
    const retained = current.entry(old, group); assert.equal(retained.status, "superseded");
    assert.equal(bytesVersion(await readFile(path.join(f.source.root, old.locator.path))), old.locator.sha256);
  }
  assert.equal(await git(f.source.root, "status", "--porcelain"), "");
  const replay = await importCheckpointSnapshot(f.input, { authority: f.authority, commit: async () => assert.fail("Replay must not commit again") });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.authority, result.authority);
  await assert.rejects(importCheckpointSnapshot({ ...f.input, candidateRevision: f.input.producerBaseRevision }, { authority: f.authority, commit: f.commit }));
});

test("stale caller expectation is refused without fetch, files or authority change", async t => {
  const f = await fixture(t);
  await assert.rejects(importCheckpointSnapshot({ ...f.input, expected: { ...f.input.expected, token: "stale-token" } }, { authority: f.authority, commit: f.commit }), category("checkpoint_runtime_stale"));
  await f.unchanged();
});

test("a consumer catalog divergence conflicts instead of merging", async t => {
  const f = await fixture(t, { catalogConflict: true });
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit }), category("snapshot_import_catalog_conflict"));
  await f.unchanged();
});

test("a new v3 Source version needs its exact descriptor already reviewed in the consumer grant", async t => {
  const f = await fixture(t, { missingDescriptor: true });
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit }), category("snapshot_import_descriptor_required"));
  await f.unchanged();
});

test("invalid candidate catalog schema never changes the consumer", async t => {
  const f = await fixture(t), file = path.join(f.input.candidateRoot, f.source.catalogPath);
  const catalog = JSON.parse(await readFile(file, "utf8")); catalog.schemaVersion = "invalid.synthetic.catalog";
  await writeFile(file, canonicalJson(catalog)); await git(f.input.candidateRoot, "add", "--", f.source.catalogPath);
  await git(f.input.candidateRoot, "commit", "--quiet", "-m", "Synthetic invalid candidate schema"); f.input.candidateRevision = await git(f.input.candidateRoot, "rev-parse", "HEAD");
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit }), category("invalid_catalog")); await f.unchanged();
});

test("a self-consistent new policy version is explicitly rejected rather than imported", async t => {
  const f = await fixture(t), catalog = JSON.parse(await readFile(path.join(f.input.candidateRoot, f.source.catalogPath), "utf8"));
  const entry = catalog.policies[0], file = path.join(f.input.candidateRoot, entry.locator.path);
  const policy = JSON.parse(await readFile(file, "utf8")); policy.readPurposes = ["synthetic-widened-purpose"];
  policy.version = objectVersion(policy);
  const bytes = canonicalJson(policy); entry.version = policy.version; entry.locator.sha256 = bytesVersion(bytes);
  await writeFile(file, bytes); await writeFile(path.join(f.input.candidateRoot, f.source.catalogPath), canonicalJson(catalog));
  await git(f.input.candidateRoot, "add", "--", entry.locator.path, f.source.catalogPath);
  await git(f.input.candidateRoot, "commit", "--quiet", "-m", "Synthetic self-consistent but forbidden policy change");
  f.input.candidateRevision = await git(f.input.candidateRoot, "rev-parse", "HEAD");
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit }), category("snapshot_import_protected_catalog_changed"));
  await f.unchanged();
});

test("a commit followed by failed acknowledgement stays fenced and retries the original journal without a second commit", async t => {
  const f = await fixture(t); let commits = 0;
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, async commit(paths, operationId) {
    commits++; await f.commit(paths, operationId); throw new Error("Synthetic post-commit acknowledgement failure");
  } }), /Synthetic post-commit/);
  const committed = await git(f.source.root, "rev-parse", "HEAD"); assert.notEqual(committed, f.input.expected.revision);
  assert.deepEqual(await f.authority.read(), f.input.expected);
  await assert.rejects((await CatalogReader.load(f.source.root, f.source.catalogPath)).assertCurrent(), category("memory_transaction_pending"));
  assert.ok(await readFile(path.join(f.source.root, ".stella-memory-transaction.json"), "utf8"));
  const recovered = await importCheckpointSnapshot(f.input, { authority: f.authority, async commit() { assert.fail("Recovery must authenticate the original commit"); } });
  assert.equal(recovered.replayed, true); assert.equal(recovered.authority?.revision, committed); assert.equal(commits, 1);
  await (await CatalogReader.load(f.source.root, f.source.catalogPath)).assertCurrent();
  await assert.rejects(readFile(path.join(f.source.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
});

test("pre-cancellation performs no preparation or mutation", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit, signal: controller.signal }), { name: "AbortError" });
  await f.unchanged();
});


test("a non-UTF-8 payload is rejected before any lossy write, fetch or CAS", async t => {
  const f = await fixture(t), reader = await CatalogReader.load(f.input.candidateRoot, f.source.catalogPath);
  const source = await reader.read(f.projection.sourceRef, "sources");
  const payload = (source.payloads as Array<{ path: string }>)[0]!;
  await writeFile(path.join(f.input.candidateRoot, payload.path), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
  await git(f.input.candidateRoot, "add", "--", payload.path);
  await git(f.input.candidateRoot, "commit", "--quiet", "-m", "Synthetic unsupported binary payload");
  f.input.candidateRevision = await git(f.input.candidateRoot, "rev-parse", "HEAD");
  await assert.rejects(importCheckpointSnapshot(f.input, { authority: f.authority, commit: f.commit }), category("snapshot_import_binary_unsupported"));
  await f.unchanged();
});
