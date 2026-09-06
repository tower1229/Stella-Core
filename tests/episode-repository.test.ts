import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { EpisodeRepository, episodeVersion, type EpisodeRepositoryPorts } from "../src/praxis/episode-repository.js";
import type { EpisodeV2 } from "../src/praxis/episode-v2.js";

const ref = { id: "evidence-synthetic", version: `sha256:${"a".repeat(64)}` };
function initial(): EpisodeV2 {
  return { schemaVersion: "stella.praxis-episode/v2", id: "praxis-synthetic", status: "open",
    createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z", recoveryPriority: "important",
    historicalInputRefs: [ref], provenance: { messageRefs: ["synthetic-owner-message"] },
    situation: { summary: "Synthetic decision", domains: ["social"], observations: ["Synthetic report"] } };
}
function recommended(): EpisodeV2 {
  return { ...initial(), status: "recommended", updatedAt: "2026-09-06T00:01:00Z",
    decision: { recommendation: "Synthetic suggestion", rationale: [] } };
}
function closed(): EpisodeV2 {
  return { ...recommended(), status: "closed", updatedAt: "2026-09-06T00:03:00Z",
    actual: { action: "Synthetic reported action", source: "user_report", occurredAt: null,
      recordedAt: "2026-09-06T00:02:00Z", evidenceRefs: [ref] },
    outcome: { observations: ["Synthetic outcome report"], result: "Synthetic result", observedAt: "2026-09-06T00:02:00Z", evidenceRefs: [ref] },
    learning: { algorithmVersion: "synthetic-v2", predictionAssessment: "unresolved", evidenceRefs: [ref], twin: [], praxis: [] } };
}
function ports(overrides: Partial<EpisodeRepositoryPorts> = {}): EpisodeRepositoryPorts {
  return { async resolveHistorical(value) { assert.deepEqual(value, ref); },
    async resolveEvidence(value) { assert.deepEqual(value, ref); }, async resolveLearning() {},
    async verifyActionEvidence() { return true; }, async isCurrentlyEligible() { return true; },
    async verifyOutcomeEvidence() { return true; },
    async persist() {}, ...overrides };
}
async function fixture(t: { after(fn: () => Promise<void>): void }, overrides: Partial<EpisodeRepositoryPorts> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repository: new EpisodeRepository(root, "episodes", ports(overrides)) };
}

test("v2 repository persists no-prediction lifecycle, historical versions and exact idempotent results", async (t) => {
  const writes: Array<{ operationId: string; priority: string }> = [];
  const { root, repository } = await fixture(t, { async persist(value) { writes.push(value); } });
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  const advised = await repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended() });
  const notes = path.join(root, "episodes/praxis-synthetic/notes.md");
  await writeFile(notes, "Owner synthetic note, do not overwrite.");
  const result = await repository.apply({ operationId: "op-close", expectedVersion: advised.version, episode: closed() });
  assert.equal(result.episode.actual?.occurredAt, null);
  assert.equal(result.episode.learning?.predictionAssessment, "unresolved");
  const repeated = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  assert.deepEqual(repeated, opened);
  assert.deepEqual(await repository.read("praxis-synthetic"), result);
  assert.equal(await readFile(notes, "utf8"), "Owner synthetic note, do not overwrite.");
  assert.equal((await readdir(path.join(root, "episodes/praxis-synthetic/.versions"))).length, 3);
  assert.equal((await readdir(path.join(root, "episodes/praxis-synthetic"))).includes("prediction.json"), false);
  assert.deepEqual(writes.map((write) => write.priority), ["critical", "critical", "normal", "critical"]);
});

test("legacy ownerless Episode locks require explicit recovery rather than silent deletion", async (t) => {
  const { root, repository } = await fixture(t);
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  const legacy = path.join(root, "episodes", ".write-lock");
  await writeFile(legacy, "");
  await assert.rejects(repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended() }),
    /legacy_write_lock_requires_recovery/);
  assert.equal(await readFile(legacy, "utf8"), "");
  assert.equal((await repository.read(initial().id)).version, opened.version);
});

test("v2 repository rejects stale CAS and operation reuse without overwriting", async (t) => {
  const { repository } = await fixture(t);
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  const advised = await repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended() });
  await assert.rejects(repository.apply({ operationId: "op-conflict", expectedVersion: opened.version, episode: closed() }), /version_conflict/);
  await assert.rejects(repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: { ...recommended(), situation: { ...initial().situation, summary: "Changed" } } }), /operation_id_conflict/);
  assert.deepEqual(await repository.read("praxis-synthetic"), advised);
});

test("v2 repository resumes a failed durability call without replaying lifecycle or duplicating versions", async (t) => {
  let fail = true;
  const { root, repository } = await fixture(t, { async persist() { if (fail) throw new Error("synthetic push failure"); } });
  const operation = { operationId: "op-open", expectedVersion: null, episode: initial() };
  await assert.rejects(repository.apply(operation), /synthetic push failure/);
  fail = false;
  const restarted = new EpisodeRepository(root, "episodes", ports());
  assert.equal((await restarted.apply(operation)).version, episodeVersion(initial()));
  assert.equal((await readdir(path.join(root, "episodes/praxis-synthetic/.versions"))).length, 1);
});

test("v2 repository rejects fabricated action before exposing a closed record", async (t) => {
  const { repository } = await fixture(t, { async verifyActionEvidence() { return false; } });
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  const advised = await repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended() });
  await assert.rejects(repository.apply({ operationId: "op-close", expectedVersion: advised.version, episode: closed() }), /unsupported_actual_action/);
  assert.equal((await repository.read("praxis-synthetic")).episode.status, "recommended");
});

test("v2 repository separates historical integrity from current evidence eligibility", async (t) => {
  let eligible = true;
  const { repository } = await fixture(t, { async isCurrentlyEligible() { return eligible; } });
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  eligible = false;
  assert.deepEqual(await repository.readHistorical(initial().id, opened.version), opened);
  assert.deepEqual(await repository.listEligible(), []);
  await assert.rejects(repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended() }), /evidence_not_currently_eligible/);
});

test("normal recall excludes invalidated Episodes before rereading their removed evidence", async (t) => {
  let eligible = true;
  let historicalReads = 0;
  const { repository } = await fixture(t, {
    async isCurrentlyEligible() { return eligible; },
    async resolveHistorical() { historicalReads++; if (!eligible) throw new Error("Removed evidence must not be reread"); },
  });
  await repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  eligible = false;
  historicalReads = 0;
  assert.deepEqual(await repository.listEligible(), []);
  assert.equal(historicalReads, 0);
});

test("cancellation during evidence validation cannot create an Episode or call durability", async (t) => {
  const controller = new AbortController();
  let persisted = false;
  const { root, repository } = await fixture(t, {
    async resolveHistorical() { controller.abort(); },
    async persist() { persisted = true; },
  });
  await assert.rejects(repository.apply({ operationId: "cancelled", expectedVersion: null, episode: initial(), abortSignal: controller.signal }), /operation_cancelled/);
  assert.equal(persisted, false);
  await assert.rejects(readFile(path.join(root, "episodes/praxis-synthetic/episode.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(root, "episodes/.operations")), []);
});

test("v2 repository verifies immutable prediction and rejects damaged history", async (t) => {
  const { root, repository } = await fixture(t);
  const episode: EpisodeV2 = { ...initial(), twin: { prediction: { possibleActions: { wait: 1 }, likelyInterpretations: [], keyFactors: [] } } };
  await repository.apply({ operationId: "op-open", expectedVersion: null, episode });
  await writeFile(path.join(root, "episodes/praxis-synthetic/prediction.json"), "{}");
  await assert.rejects(repository.read(episode.id), /sealed_prediction_changed/);
});

test("v2 repository refuses v1 activation, path traversal and concurrent ownership", async (t) => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { root, repository } = await fixture(t, { async persist() { entered(); await pending; } });
  const first = repository.apply({ operationId: "op-open", expectedVersion: null, episode: initial() });
  await ready;
  const other = new EpisodeRepository(root, "episodes", ports());
  await assert.rejects(other.apply({ operationId: "op-other", expectedVersion: null, episode: initial() }), /memory_transaction_in_progress/);
  release(); await first;
  assert.throws(() => new EpisodeRepository(root, "../outside", ports()), /unsafe_episode_root/);
  await assert.rejects(repository.apply({ operationId: "../outside", expectedVersion: null, episode: initial() }), /unsafe_record_id/);
  await writeFile(path.join(root, "episodes/praxis-synthetic/episode.json"), JSON.stringify({ ...initial(), schemaVersion: "stella.praxis-episode/v1" }));
  await assert.rejects(repository.listEligible(), /schema validation failed/);
});

test("v2 operations survive real Git pointer failure, retry and clean remote recovery", async (t) => {
  const run = promisify(execFile);
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-v2-durable-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "work");
  const remote = path.join(parent, "remote.git");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["init", "--quiet", "-b", "synthetic-alpha", root]);
  await run("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await run("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  await writeFile(path.join(root, "base.txt"), "Synthetic baseline");
  await run("git", ["-C", root, "add", "base.txt"]);
  await run("git", ["-C", root, "commit", "--quiet", "-m", "Synthetic base"]);
  await run("git", ["-C", root, "remote", "add", "origin", remote]);
  await run("git", ["-C", root, "push", "--quiet", "origin", "HEAD:refs/heads/synthetic-alpha"]);
  let failPointer = true;
  let pointer: string | undefined;
  const createDurability = () => new GitCangHaiDurability({ root, remote: "origin", branch: "synthetic-alpha",
    criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
    async onRevision(revision) { if (failPointer) throw new Error("Synthetic pointer failure"); pointer = revision; } });
  const createRepository = () => {
    const durability = createDurability();
    return new EpisodeRepository(root, "episodes", ports({ async persist(input) {
      if (input.priority === "critical") await durability.syncCritical(input.paths, input.operationId);
      else await durability.recordNormal(input.paths, input.operationId);
    } }));
  };
  const operation = { operationId: "op-open", expectedVersion: null, episode: initial() };
  await assert.rejects(createRepository().apply(operation), /Synthetic pointer failure/);
  const { stdout: local } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  const { stdout: beforeRemote } = await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/synthetic-alpha"]);
  assert.notEqual(local, beforeRemote);
  failPointer = false;
  const repository = createRepository();
  const opened = await repository.apply(operation);
  assert.equal(pointer, local.trim());
  const { stdout: afterRetry } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  assert.equal(afterRetry, local);
  const notes = path.join(root, "episodes/praxis-synthetic/notes.md");
  await writeFile(notes, "Uncommitted owner note");
  const advised = await repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended() });
  const clone = path.join(parent, "restored");
  await run("git", ["clone", "--quiet", "--branch", "synthetic-alpha", remote, clone]);
  const restored = new EpisodeRepository(clone, "episodes", ports());
  assert.deepEqual(await restored.read(initial().id), advised);
  assert.deepEqual(await restored.readHistorical(initial().id, opened.version), opened);
  assert.equal((await readdir(path.join(clone, "episodes/praxis-synthetic"))).includes("notes.md"), false);
  assert.equal(await readFile(notes, "utf8"), "Uncommitted owner note");
});
