import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { synchronize, type SynchronizePorts } from "../src/canghai/synchronize.js";
import { ownerDirectAuthority } from "./processing-authority-fixture.js";

async function setup(t: Parameters<typeof personalMemoryFixture>[0]) {
  const f = await personalMemoryFixture(t);
  const run = promisify(execFile);
  const remote = await mkdtemp(path.join(os.tmpdir(), "stella-sync-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await run("git", ["-c", "core.fsmonitor=false", "-C", f.root, ...args])).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Test"); await git("config", "user.email", "synthetic@example.invalid");
  await git("add", "."); await git("commit", "--quiet", "-m", "baseline");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await git("remote", "add", "origin", remote); await git("push", "origin", "main");
  const fromRevision = await git("rev-parse", "HEAD");
  const restart = () => new GitCangHaiDurability({ root: f.root, remote: "origin", branch: "main",
    criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0 });
  const resolver = await f.resolver();
  const ports: SynchronizePorts = { root: f.root, catalogPath: "catalog.json", objectRoot: "objects", durability: restart(),
    modelRef: "synthetic/model", ownerId: "owner", purpose: resolver.purpose,
    processingAuthority: ownerDirectAuthority({ purpose: resolver.purpose }), assertProcessingCurrent: async () => {},
    complete: async ({ prompt }) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      return { provider: "synthetic", model: "model", text: JSON.stringify(input.proposalHash
        ? { bindingHash: input.bindingHash, proposalHash: input.proposalHash, valid: true }
        : { bindingHash: input.bindingHash, decisions: input.targets.map((target: { ref: unknown }) => ({ ref: target.ref,
          disposition: "withdraw", record: null })), rationale: "The removed source no longer supports current use." }) };
    } };
  const request = async () => { await git("push", "origin", "main"); return ({ operationId: "sync_test", fromRevision, toRevision: await git("rev-parse", "HEAD"), expectedGenerationId: "one" }); };
  return { f, git, restart, ports, request };
}

test("synchronize durably fences before reevaluation, removes transitive recall and preserves sealed history", async t => {
  const { f, git, ports, request } = await setup(t);
  const sealed = await readFile(path.join(f.root, f.catalog.understandings[0]!.locator.path));
  await rm(path.join(f.root, "payload.json")); await git("add", "-u"); await git("commit", "--quiet", "-m", "owner deletes source");
  const input = await request();
  let calls = 0;
  const complete = ports.complete;
  ports.complete = async args => {
    calls++;
    // A fresh reader in the model callback is also an ordinary read, not a sync capability.
    const reader = await CatalogReader.load(f.root, "catalog.json");
    await assert.rejects(reader.read(f.understanding), /source_synchronization_pending/);
    assert.ok((await git("ls-files", ".stella-source-synchronization.json")).length);
    return complete(args);
  };
  const receipt = await synchronize(input, ports);
  assert.deepEqual(receipt.removedSourceIds, [f.source.id]);
  assert.ok(receipt.affectedIds.includes(f.understanding.id));
  assert.ok(receipt.affectedIds.includes(f.workRef.id));
  const reader = await CatalogReader.load(f.root, "catalog.json");
  await assert.rejects(reader.read(f.understanding), /evidence_not_currently_eligible/);
  await assert.rejects(reader.readPayload(f.source, "sha256:" + "a".repeat(64)), /source_removed/);
  assert.deepEqual(await readFile(path.join(f.root, f.catalog.understandings[0]!.locator.path)), sealed);
  assert.equal((await reader.read(f.understanding, "understandings", "historical")).statement, "本篇文章保留未决问题。");
  assert.equal(await git("status", "--porcelain"), "");
  const replay = await synchronize(input, { ...ports, complete: async () => { throw new Error("must replay"); } });
  assert.deepEqual(replay, receipt);
  assert.equal(calls, 2);
});

test("synchronize preserves identity on exact move and does not invoke semantic reevaluation for locator-only changes", async t => {
  const { f, git, ports, request } = await setup(t);
  await rename(path.join(f.root, "payload.json"), path.join(f.root, "moved.json"));
  await git("add", "-A"); await git("commit", "--quiet", "-m", "move original");
  ports.complete = async () => { throw new Error("move is not semantic"); };
  const receipt = await synchronize(await request(), ports);
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.deepEqual(reader.currentRef(f.source.id, "sources"), f.source);
  assert.deepEqual(receipt.affectedIds, []);
  assert.match((await (await f.resolver()).readEvidence(f.evidence)).text, /保留疑问/);
  assert.equal((await reader.read(f.source)).version, undefined); // relocation need not rewrite semantic metadata
});

test("failed reevaluation stays fenced across restart, then resumes without altering user edits", async t => {
  const { f, git, ports, request, restart } = await setup(t);
  const edited = JSON.stringify({ report: "改为开放式问题，继续核对论证。" });
  await writeFile(path.join(f.root, "payload.json"), edited);
  await git("add", "payload.json"); await git("commit", "--quiet", "-m", "owner edit");
  const input = await request();
  await assert.rejects(synchronize(input, { ...ports, complete: async () => { throw new Error("offline"); } }), /synchronization_model_failed/);
  await assert.rejects((await CatalogReader.load(f.root, "catalog.json")).read(f.understanding), /source_synchronization_pending/);
  const result = await synchronize(input, { ...ports, durability: restart() });
  assert.ok(result.affectedIds.includes(f.source.id));
  assert.equal(await readFile(path.join(f.root, "payload.json"), "utf8"), edited);
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.notEqual(reader.currentRef(f.source.id, "sources").version, f.source.version);
  assert.equal((await reader.read(f.source, "sources", "historical")).id, f.source.id);
  assert.equal(await git("status", "--porcelain"), "");
});

test("concurrent manual edit during model call is preserved and cannot publish a generation", async t => {
  const { f, git, ports, request } = await setup(t);
  await rm(path.join(f.root, "payload.json")); await git("add", "-u"); await git("commit", "--quiet", "-m", "remove");
  const input = await request();
  await assert.rejects(synchronize(input, { ...ports, complete: async args => {
    await writeFile(path.join(f.root, "user-note.txt"), "new manual text"); return ports.complete(args);
  } }), /write_conflict/);
  assert.equal(await readFile(path.join(f.root, "user-note.txt"), "utf8"), "new manual text");
  await assert.rejects((await CatalogReader.load(f.root, "catalog.json")).read(f.understanding), /source_synchronization_pending/);
  assert.equal(await git("diff", "--cached", "--name-only"), "");
});

test("policy revocation is versioned, propagates transitively and does not expose revoked originals to the model", async t => {
  const { f, git, ports, request } = await setup(t);
  const policyPath = f.catalog.policies[0]!.locator.path;
  const policy = JSON.parse(await readFile(path.join(f.root, policyPath), "utf8"));
  policy.readPurposes = [];
  await writeFile(path.join(f.root, policyPath), JSON.stringify(policy));
  await git("add", policyPath); await git("commit", "--quiet", "-m", "revoke reading");
  const receipt = await synchronize(await request(), { ...ports, complete: async args => {
    assert.doesNotMatch(args.prompt, /我希望这篇文章/); return ports.complete(args);
  } });
  assert.ok(receipt.affectedIds.includes(f.understanding.id));
  const reader = await CatalogReader.load(f.root, "catalog.json");
  await assert.rejects(reader.read(f.understanding), /evidence_not_currently_eligible/);
  assert.deepEqual((await reader.read(f.catalog.policies[0]!, "policies", "historical")).readPurposes, ["retrieve"]);
  assert.equal(await readFile(path.join(f.root, policyPath), "utf8"), JSON.stringify(policy));
});

test("source reevaluation publishes supported replacement and retains the previous understanding version", async t => {
  const { f, git, ports, request } = await setup(t);
  await writeFile(path.join(f.root, "payload.json"), JSON.stringify({ report: "继续保留问题，核对论证。" }));
  await git("add", "payload.json"); await git("commit", "--quiet", "-m", "edit original");
  const result = await synchronize(await request(), { ...ports, complete: async args => {
    const data = JSON.parse(args.prompt.split("\n").at(-1)!);
    if (data.proposalHash) return ports.complete(args);
    const target = data.targets.find((target: { group: string }) => target.group === "understandings");
    assert.equal(target.previous, null, "An older source version must not authorize previous derived text");
    assert.deepEqual(target.currentEvidenceRefs, [data.evidence[0].ref]);
    const record = { schemaVersion: "stella.understanding/v1", dependencyRefs: [], counterRefs: [] };
    return { provider: "synthetic", model: "model", text: JSON.stringify({ bindingHash: data.bindingHash,
      decisions: data.targets.map((target: { ref: unknown; group: string }) => ({ ref: target.ref,
        disposition: target.group === "understandings" ? "replace" : "withdraw",
        record: target.group === "understandings" ? { ...record, status: "contested", statement: "修改后的材料要求继续核对论证。", supportRefs: [data.evidence[0].ref] } : null })),
      rationale: "The revised material supports a narrower, uncertain current interpretation." }) };
  } });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  const current = await reader.read(reader.currentRef(f.understanding.id, "understandings"));
  assert.equal(current.statement, "修改后的材料要求继续核对论证。");
  assert.notEqual(result.generationId, "one");
  assert.equal((await reader.read(f.understanding, "understandings", "historical")).statement, "本篇文章保留未决问题。");
});

test("new material in declared scope is admitted and forces reevaluation without an old dependency edge", async t => {
  const { f, git, ports, request } = await setup(t);
  await mkdir(path.join(f.root, "materials"));
  await writeFile(path.join(f.root, "materials/new.txt"), "新增论证线索。");
  await writeFile(path.join(f.root, "registry.json"), JSON.stringify({ schema_version: "stella.corpus-registry/v1", id: "corpus",
    corpora: [{ id: "writing", root_ref: "path:materials", include: ["**/*"], exclude: [],
      policy_ref: `path:${f.catalog.policies[0]!.locator.path}`, adapter_id: "synthetic" }] }));
  await git("add", "materials", "registry.json"); await git("commit", "--quiet", "-m", "add declared material");
  const result = await synchronize(await request(), { ...ports, corpusRegistryRef: "path:registry.json",
    purpose: { ...ports.purpose, evidenceCutoff: "2099-01-01T00:00:00Z" } });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.equal(reader.catalog.sources.filter(entry => entry.status === "current").length, 2);
  assert.ok(result.affectedIds.includes(f.understanding.id));
  assert.equal(await readFile(path.join(f.root, "materials/new.txt"), "utf8"), "新增论证线索。");
});

test("policy locator remains authoritative across consecutive edits and exact relocation", async t => {
  const { f, git, ports, request, restart } = await setup(t);
  const oldPath = f.catalog.policies[0]!.locator.path;
  await rename(path.join(f.root, oldPath), path.join(f.root, "policy-live.json"));
  await git("add", "-A"); await git("commit", "--quiet", "-m", "move policy");
  let result = await synchronize(await request(), ports);
  let reader = await CatalogReader.load(f.root, "catalog.json");
  assert.equal(reader.entry(reader.currentRef("policy", "policies")).locator.path, "policy-live.json");
  for (let i = 0; i < 2; i++) {
    const fromRevision = await git("rev-parse", "HEAD");
    const policy = JSON.parse(await readFile(path.join(f.root, "policy-live.json"), "utf8"));
    policy.readPurposes = i === 0 ? [] : ["retrieve", "new-purpose"];
    await writeFile(path.join(f.root, "policy-live.json"), JSON.stringify(policy));
    await git("add", "policy-live.json"); await git("commit", "--quiet", "-m", `policy change ${i}`); await git("push", "origin", "main");
    result = await synchronize({ operationId: `policy_${i}`, fromRevision, toRevision: await git("rev-parse", "HEAD"),
      expectedGenerationId: result.generationId }, { ...ports, durability: restart() });
    reader = await CatalogReader.load(f.root, "catalog.json");
    assert.deepEqual((await reader.read(reader.currentRef("policy", "policies"))).readPurposes, policy.readPurposes);
    assert.equal(reader.entry(reader.currentRef("policy", "policies")).locator.path, "policy-live.json");
  }
});

test("final critical push interruption resumes approved records without running the model again", async t => {
  const { f, git, ports, request, restart } = await setup(t);
  await rm(path.join(f.root, "payload.json")); await git("add", "-u"); await git("commit", "--quiet", "-m", "remove original");
  const input = await request();
  let pushes = 0;
  const durability = new GitCangHaiDurability({ root: f.root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0, onStage: stage => {
      if (stage === "synchronize" && ++pushes === 2) throw new Error("injected push interruption");
    } });
  await assert.rejects(synchronize(input, { ...ports, durability }), /synchronization failed/);
  await assert.rejects((await CatalogReader.load(f.root, "catalog.json")).read(f.understanding), /memory_transaction_pending/);
  const result = await synchronize(input, { ...ports, durability: restart(), complete: async () => { throw new Error("model replay forbidden"); } });
  assert.equal(result.durability.criticalSynchronized, true);
  assert.equal(await git("status", "--porcelain"), "");
});

test("ambiguous identical-content moves do not guess independent Source identities", async t => {
  const { f, git, ports, request } = await setup(t);
  const input = await request();
  await writeFile(path.join(f.root, "copy.json"), await readFile(path.join(f.root, "payload.json")));
  await git("add", "copy.json"); await git("commit", "--quiet", "-m", "independent same-content source");
  input.fromRevision = await git("rev-parse", "HEAD");
  await rename(path.join(f.root, "copy.json"), path.join(f.root, "second.json"));
  await rename(path.join(f.root, "payload.json"), path.join(f.root, "first.json"));
  await git("add", "-A"); await git("commit", "--quiet", "-m", "ambiguous moves"); await git("push", "origin", "main");
  input.toRevision = await git("rev-parse", "HEAD");
  await assert.rejects(synchronize(input, ports), /ambiguous_source_move/);
  await assert.rejects((await CatalogReader.load(f.root, "catalog.json")).read(f.understanding), /source_synchronization_pending/);
});

test("deletion of a current payload pinned to historical Git cannot revive it through that pin", async t => {
  const { f, git, ports, request } = await setup(t);
  const input = await request();
  const sourceEntry = f.catalog.sources[0]!;
  const object = JSON.parse(await readFile(path.join(f.root, sourceEntry.locator.path), "utf8"));
  object.payloads[0].revision = input.fromRevision;
  const bytes = JSON.stringify(object);
  const { bytesVersion } = await import("../src/canghai/content-version.js");
  sourceEntry.locator.sha256 = bytesVersion(bytes);
  await writeFile(path.join(f.root, sourceEntry.locator.path), bytes); await f.save();
  await git("add", "."); await git("commit", "--quiet", "-m", "historical payload locator");
  input.fromRevision = await git("rev-parse", "HEAD");
  await rm(path.join(f.root, "payload.json")); await git("add", "-u"); await git("commit", "--quiet", "-m", "owner removes pinned original");
  await git("push", "origin", "main"); input.toRevision = await git("rev-parse", "HEAD");
  const result = await synchronize(input, ports);
  assert.deepEqual(result.removedSourceIds, [f.source.id]);
  const reader = await CatalogReader.load(f.root, "catalog.json");
  await assert.rejects(reader.readPayload(f.source, object.payloads[0].sha256), /source_removed/);
});

test("content and policy revert reuse sealed versions instead of leaving synchronization permanently blocked", async t => {
  const { f, git, ports, request, restart } = await setup(t);
  const oldPayload = await readFile(path.join(f.root, "payload.json"));
  const policyPath = f.catalog.policies[0]!.locator.path;
  const oldPolicy = await readFile(path.join(f.root, policyPath));
  await writeFile(path.join(f.root, "payload.json"), JSON.stringify({ report: "temporary revision" }));
  const policy = JSON.parse(oldPolicy.toString()); policy.readPurposes = [];
  await writeFile(path.join(f.root, policyPath), JSON.stringify(policy));
  await git("add", "."); await git("commit", "--quiet", "-m", "temporary changes");
  const first = await synchronize(await request(), ports);
  const fromRevision = await git("rev-parse", "HEAD");
  await writeFile(path.join(f.root, "payload.json"), oldPayload); await writeFile(path.join(f.root, policyPath), oldPolicy);
  await git("add", "."); await git("commit", "--quiet", "-m", "restore original content"); await git("push", "origin", "main");
  await synchronize({ operationId: "restore", fromRevision, toRevision: await git("rev-parse", "HEAD"), expectedGenerationId: first.generationId },
    { ...ports, durability: restart() });
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.deepEqual(reader.currentRef(f.source.id, "sources"), f.source);
  assert.deepEqual(reader.currentRef("policy", "policies"), { id: "policy", version: f.catalog.policies[0]!.version });
});

test("a new operation can supersede an interrupted synchronization after a concurrent owner commit", async t => {
  const { f, git, ports, request, restart } = await setup(t);
  await writeFile(path.join(f.root, "payload.json"), JSON.stringify({ report: "first edit" }));
  await git("add", "."); await git("commit", "--quiet", "-m", "first owner edit");
  const input = await request();
  await assert.rejects(synchronize(input, { ...ports, complete: async args => {
    await writeFile(path.join(f.root, "payload.json"), JSON.stringify({ report: "newer owner edit" }));
    await git("add", "payload.json"); await git("commit", "--quiet", "-m", "concurrent owner edit");
    return ports.complete(args);
  } }), /write_conflict/);
  await git("push", "origin", "main");
  const result = await synchronize({ ...input, operationId: "superseding_operation", toRevision: await git("rev-parse", "HEAD") },
    { ...ports, durability: restart() });
  assert.equal(result.durability.criticalSynchronized, true);
  assert.match(await readFile(path.join(f.root, "payload.json"), "utf8"), /newer owner edit/);
  assert.equal(await git("status", "--porcelain"), "");
});

test("policy formatting followed by repeated content restoration retains live authority and sealed pins", async t => {
  const { f, git, ports, request, restart } = await setup(t);
  const policyPath = f.catalog.policies[0]!.locator.path;
  const policy = JSON.parse(await readFile(path.join(f.root, policyPath), "utf8"));
  const originalPayload = await readFile(path.join(f.root, "payload.json"), "utf8");
  await writeFile(path.join(f.root, policyPath), JSON.stringify(policy, null, 2));
  await git("add", "."); await git("commit", "--quiet", "-m", "format policy");
  let result = await synchronize(await request(), ports);
  let reader = await CatalogReader.load(f.root, "catalog.json");
  assert.equal(reader.entry(reader.currentRef("policy", "policies")).locator.path, policyPath);
  for (let index = 0; index < 3; index++) {
    const fromRevision = await git("rev-parse", "HEAD");
    await writeFile(path.join(f.root, policyPath), JSON.stringify({ ...policy, readPurposes: index % 2 === 0 ? [] : ["retrieve"] }));
    await writeFile(path.join(f.root, "payload.json"), index % 2 === 0 ? JSON.stringify({ report: "revised content" }) : originalPayload);
    await git("add", "."); await git("commit", "--quiet", "-m", `repeated revision ${index}`); await git("push", "origin", "main");
    result = await synchronize({ operationId: `repeat_${index}`, fromRevision, toRevision: await git("rev-parse", "HEAD"), expectedGenerationId: result.generationId },
      { ...ports, durability: restart() });
    reader = await CatalogReader.load(f.root, "catalog.json");
    assert.deepEqual((await reader.read(reader.currentRef("policy", "policies"))).readPurposes, index % 2 === 0 ? [] : ["retrieve"]);
  }
});
