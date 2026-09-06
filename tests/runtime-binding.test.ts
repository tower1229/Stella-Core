import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { loadPraxisRuntimeBinding, createBoundPraxisRuntime, persistBoundAdvice, resolveBoundInputRefs } from "../src/praxis/runtime-binding.js";
import type { HostInputSnapshot } from "../src/openclaw/host-input.js";
import type { EpisodeV2 } from "../src/praxis/episode-v2.js";
import { loadOutcomeRecoveryBinding } from "../src/praxis/outcome-recovery-binding.js";

const run = promisify(execFile);
const now = "2026-09-06T00:00:00Z";
const complete = async () => { throw new Error("Synthetic advice must not assert any action or call an evidence judge"); };
const original: HostInputSnapshot = { schemaVersion: "stella.host-input-snapshot/v1", hostVersion: "2026.8.2", agentId: "fixture",
  sessionId: "fixture-session", sessionKey: "agent:fixture:test", entryId: "fixture-message", logicalTurnId: "fixture-turn",
  generation: "fixture-host-generation", rawSeq: 1, parentId: null, text: "Synthetic original question",
  event: { type: "message", id: "fixture-message", parentId: null, timestamp: now,
    message: { role: "user", content: [{ type: "text", text: "Synthetic original question" }] } } };
const episode: Omit<EpisodeV2, "historicalInputRefs"> = { schemaVersion: "stella.praxis-episode/v2", id: "praxis-fixture", status: "open",
  createdAt: now, updatedAt: now, recoveryPriority: "important", provenance: { messageRefs: [original.entryId] },
  situation: { summary: original.text, domains: ["social"], observations: ["Synthetic question"] } };

test("runtime binding requires explicit v2 configuration and refuses unknown cognitive references", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadConsciousness(root);
  const binding = await loadPraxisRuntimeBinding(loaded);
  assert.equal(binding.catalogPath, "30_PersonalData/memory/catalog.json");
  const runtime = await createBoundPraxisRuntime(loaded, binding, complete, async () => { throw new Error("No writes expected"); });
  assert.deepEqual((await runtime.listMemory()).openEpisodes, []);
  await assert.rejects(resolveBoundInputRefs(runtime, binding, ["path:unverified.json"]), /cognitive_source_binding_required/);
  const profile = loaded.bootstrapDocuments.find((document) => document.field === "identity.runtimeProfileRef")!;
  profile.content = "fixture: legacy";
  await assert.rejects(loadPraxisRuntimeBinding(loaded), /runtime_binding_migration_required/);
});

test("recovery bindings tolerate pending business files but reject changed authority at the configured revision", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const revision = await initializeFixtureRepository(root);
  const loaded = await loadConsciousness(root);
  const context = await loadOutcomeRecoveryBinding(root, loaded.manifestPath, revision);
  assert.equal(context.episodeRoot, "30_PersonalData/praxis/episodes");
  await writeFile(path.join(root, "30_PersonalData/praxis/episodes/pending-synthetic.json"), "{}");
  assert.equal((await loadOutcomeRecoveryBinding(root, loaded.manifestPath, revision)).binding.catalogPath, context.binding.catalogPath);
  const file = path.join(root, context.binding.configPath);
  await writeFile(file, `${await readFile(file, "utf8")}\n`);
  await assert.rejects(loadOutcomeRecoveryBinding(root, loaded.manifestPath, revision), /recovery_binding_changed/);
});

test("bound v2 advice archives original input, resumes pointer failure, and restores from a clean Git clone", async (t) => {
  const root = await createFixture();
  const temp = await mkdtemp(path.join(os.tmpdir(), "stella-v2-bound-git-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(temp, { recursive: true, force: true }); });
  const revision = await initializeFixtureRepository(root);
  const remote = path.join(temp, "remote.git");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["-C", root, "remote", "add", "origin", remote]);
  await run("git", ["-C", root, "push", "origin", "HEAD:refs/heads/main"]);
  const pointerFile = path.join(temp, "recovery-pointer.txt");
  await writeFile(pointerFile, revision);
  let failPointer = true;
  const durability = new GitCangHaiDurability({ root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
    onRevision: async (next) => { if (failPointer) throw new Error("Synthetic pointer storage failure"); await writeFile(pointerFile, next); } });
  const loaded = await loadConsciousness(root);
  const binding = await loadPraxisRuntimeBinding(loaded);
  const runtime = await createBoundPraxisRuntime(loaded, binding, complete, async () => { throw new Error("Read runtime must not write"); });
  const args = { loaded, binding, runtime, durability, complete, operationId: "fixture-run", original, episode, inputRefs: [],
    decision: { recommendation: "Synthetic final advice", rationale: [] }, abortSignal: new AbortController().signal };
  await assert.rejects(persistBoundAdvice(args), /Synthetic pointer storage failure/);
  assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim(), revision);
  failPointer = false;
  const result = await persistBoundAdvice(args);
  assert.equal(result.writeOperationIds.length, 3);
  assert.equal(result.revision, (await readFile(pointerFile, "utf8")).trim());
  assert.equal(result.revision, (await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim());
  const beforeReplay = (await run("git", ["-C", root, "rev-list", "--count", "HEAD"])).stdout;
  assert.deepEqual(await persistBoundAdvice(args), result);
  assert.equal((await run("git", ["-C", root, "rev-list", "--count", "HEAD"])).stdout, beforeReplay);
  const restored = path.join(temp, "restored");
  await run("git", ["clone", "--quiet", "--branch", "main", remote, restored]);
  const restoredLoaded = await loadConsciousness(restored);
  const restoredRuntime = await createBoundPraxisRuntime(restoredLoaded, await loadPraxisRuntimeBinding(restoredLoaded), complete, async () => {});
  const memory = await restoredRuntime.listMemory();
  assert.equal(memory.openEpisodes.length, 1);
  assert.equal(memory.openEpisodes[0]!.prediction, undefined);
  assert.equal(memory.openEpisodes[0]!.recommendation, "Synthetic final advice");
  const capturedRef = restoredRuntime.evidence.reader.catalog.evidence[0]!;
  const captured = await restoredRuntime.evidence.readEvidence(capturedRef);
  assert.equal(captured.text, original.text);
  assert.equal(captured.role, "unknown");
  const restoredEpisode = await restoredRuntime.repository.read(episode.id);
  assert.equal(restoredEpisode.episode.actual, undefined);
  assert.equal(restoredEpisode.episode.outcome, undefined);
  assert.equal(restoredEpisode.episode.learning, undefined);
});
