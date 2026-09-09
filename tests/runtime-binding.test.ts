import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFixture, initializeFixtureRepository, updateFixtureManifest } from "./consciousness-fixture.js";
import { listSemanticRoutingCandidates } from "../src/praxis/packet.js";
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
  await assert.rejects(loadPraxisRuntimeBinding(loaded), /profile_migration_required/);
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

test("runtime binding requires declared profile resources without promoting not-evaluated acceptance", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadConsciousness(root);
  const binding = await loadPraxisRuntimeBinding(loaded);
  assert.ok(binding.profileAuthorityPaths.includes("50_PersonalAgent/stella/capability-acceptance.json"));
  assert.ok(binding.profileAuthorityPaths.includes("30_PersonalData/memory/policy.json"));
  assert.ok(!binding.profileAuthorityPaths.includes(binding.catalogPath), "mutable catalog is not configuration authority");
  const acceptancePath = path.join(root, "50_PersonalAgent/stella/capability-acceptance.json");
  const acceptance = await readFile(acceptancePath);
  assert.equal(JSON.parse(acceptance.toString()).status, "not_evaluated");
  await rm(acceptancePath);
  await assert.rejects(loadPraxisRuntimeBinding(loaded), /profile_resource_unavailable/);
  await writeFile(acceptancePath, acceptance);
  assert.deepEqual(await readFile(acceptancePath), acceptance);
  const policyPath = path.join(root, "30_PersonalData/memory/policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  await writeFile(policyPath, JSON.stringify({ ...policy, id: "another-policy" }));
  await assert.rejects(loadPraxisRuntimeBinding(loaded), /source_policy_identity_mismatch/);
});

test("recovery pins referenced policies even when bootstrap documents and main binding are unchanged", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const revision = await initializeFixtureRepository(root);
  const loaded = await loadConsciousness(root);
  await loadOutcomeRecoveryBinding(root, loaded.manifestPath, revision);
  const policyPath = path.join(root, "30_PersonalData/memory/policy.json");
  await writeFile(policyPath, `${await readFile(policyPath, "utf8")}\n`);
  await assert.rejects(loadOutcomeRecoveryBinding(root, loaded.manifestPath, revision), /recovery_binding_changed/);
});

test("profile resources reject invalid UTF-8 and duplicate source-policy identities", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadConsciousness(root);
  const acceptancePath = path.join(root, "50_PersonalAgent/stella/capability-acceptance.json");
  const acceptance = await readFile(acceptancePath);
  await writeFile(acceptancePath, Buffer.from([0xff, 0xfe]));
  await assert.rejects(loadPraxisRuntimeBinding(loaded), /invalid_profile_resource/);
  await writeFile(acceptancePath, acceptance);
  const item = { id: "policy-fixture", ref: "path:30_PersonalData/memory/policy.json" };
  await writeFile(path.join(root, "50_PersonalAgent/stella/source-policies.yaml"), JSON.stringify({
    schema_version: "stella.source-policy-registry/v1", id: "fixture-policies", policies: [item, item],
  }));
  await assert.rejects(loadPraxisRuntimeBinding(loaded), /invalid_source_policy_registry/);
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
  const args = { loaded, binding, runtime, durability, complete, operationId: "fixture-run", original,
    target: { kind: "new" as const, episode }, inputRefs: [],
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
  const nextLoaded = await loadConsciousness(root);
  const nextRuntime = await createBoundPraxisRuntime(nextLoaded, binding, complete, async () => {});
  const firstMemory = await nextRuntime.listMemory();
  const selected = await nextRuntime.selectedEpisode(firstMemory.openEpisodes[0]!.ref);
  const revisedText = "Synthetic follow-up constraint";
  const revisedOriginal: HostInputSnapshot = { ...original, entryId: "fixture-followup", logicalTurnId: "fixture-followup-turn", rawSeq: 2,
    text: revisedText, event: { ...original.event, id: "fixture-followup", timestamp: "2026-09-06T01:00:00Z",
      message: { role: "user", content: [{ type: "text", text: revisedText }] } } };
  const reviseArgs = { ...args, loaded: nextLoaded, runtime: nextRuntime, operationId: "fixture-revision", original: revisedOriginal,
    target: { kind: "revision" as const, selected }, decision: { recommendation: "Revised synthetic advice", rationale: [] } };
  failPointer = true;
  await assert.rejects(persistBoundAdvice(reviseArgs), /Synthetic pointer storage failure/);
  failPointer = false;
  const revised = await persistBoundAdvice(reviseArgs);
  assert.equal(revised.episodeRef.id, selected.episode.id);
  assert.equal(revised.writeOperationIds.length, 2);
  assert.deepEqual(await persistBoundAdvice(reviseArgs), revised);
  const restored = path.join(temp, "restored");
  await run("git", ["clone", "--quiet", "--branch", "main", remote, restored]);
  const restoredLoaded = await loadConsciousness(restored);
  const restoredRuntime = await createBoundPraxisRuntime(restoredLoaded, await loadPraxisRuntimeBinding(restoredLoaded), complete, async () => {});
  assert.deepEqual((await restoredRuntime.repository.readHistorical(selected.episode.id, selected.version)).episode, selected.episode);
  const memory = await restoredRuntime.listMemory();
  assert.equal(memory.openEpisodes.length, 1);
  assert.equal(memory.openEpisodes[0]!.prediction, undefined);
  assert.equal(memory.openEpisodes[0]!.recommendation, "Revised synthetic advice");
  const capturedRef = restoredRuntime.evidence.reader.catalog.evidence[0]!;
  const captured = await restoredRuntime.evidence.readEvidence(capturedRef);
  assert.equal(captured.text, original.text);
  assert.equal(captured.role, "unknown");
  const restoredEpisode = await restoredRuntime.repository.read(episode.id);
  assert.deepEqual(restoredEpisode.episode.historicalInputRefs, selected.episode.historicalInputRefs);
  assert.notDeepEqual(restoredEpisode.episode.decision!.inputRefs, selected.episode.decision!.inputRefs);
  assert.equal(restoredEpisode.episode.provenance.runId, "fixture-revision");
  const retainedOriginals = await Promise.all(restoredRuntime.evidence.reader.catalog.evidence.map((ref) => restoredRuntime.evidence.readEvidence(ref)));
  assert.deepEqual(retainedOriginals.map((item) => item.text), [original.text, revisedText]);
  assert.equal(restoredEpisode.episode.actual, undefined);
  assert.equal(restoredEpisode.episode.outcome, undefined);
  assert.equal(restoredEpisode.episode.learning, undefined);
  // Current Alpha consumes authoritative documents/catalog and immutable Episode
  // versions directly; legacy derived targets have no runtime data consumer.
  const candidates = listSemanticRoutingCandidates(restoredLoaded, memory.openEpisodes);
  await updateFixtureManifest(restored, (manifest) => manifest.replace(
    "rebuild: [bootstrap_projection, memory_index]", "rebuild: []"));
  const directLoaded = await loadConsciousness(restored);
  assert.deepEqual(directLoaded.bootstrapDocuments, restoredLoaded.bootstrapDocuments);
  const directRuntime = await createBoundPraxisRuntime(directLoaded, await loadPraxisRuntimeBinding(directLoaded), complete, async () => {});
  assert.deepEqual(await directRuntime.listMemory(), memory);
  assert.deepEqual(listSemanticRoutingCandidates(directLoaded, memory.openEpisodes), candidates);
  assert.deepEqual(await directRuntime.repository.read(episode.id), restoredEpisode);
});

test("full-memory uses its explicit lifecycle binding and requires private processing for every model role", async t => {
  const { parse, stringify } = await import("yaml");
  const { parseRuntimeProfile } = await import("../src/canghai/runtime-profile.js");
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const base = "50_PersonalAgent/stella";
  const profilePath = path.join(root, base, "runtime-profile.yaml");
  const profile = parseRuntimeProfile(parse(await readFile(profilePath, "utf8")));
  profile.contract_profile = "full_memory";
  profile.memory = { ...profile.memory!, semantic_provider: "stella-structured-llm", required_views: ["current_understanding", "ongoing_work"] };
  const lifecycle = profile.capabilities.find(c => c.id === "transcript_archive")!;
  lifecycle.id = "memory_lifecycle"; lifecycle.adapter_id = "stella.memory-lifecycle";
  const accessPath = `${base}/personal-context.json`;
  profile.capabilities.push({ id: "source_access_context", required: true, adapter_id: "stella.personal-context-access", adapter_version: "1",
    config_ref: `path:${accessPath}`, acceptance_ref: `path:${base}/capability-acceptance.json`, required_secret_refs: [] });
  const bindingPath = path.join(root, base, "praxis-binding.json");
  const binding: Record<string, unknown> = JSON.parse(await readFile(bindingPath, "utf8"));
  binding.schemaVersion = "stella.memory-runtime-binding/v1";
  await writeFile(bindingPath, JSON.stringify(binding));
  const access = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner-fixture", requesterIds: ["cli"],
    modelRefs: ["synthetic/synthetic"], viewProcessingModelRefs: ["synthetic/synthetic"], purpose: binding.purpose, descriptors: [] };
  await writeFile(path.join(root, accessPath), JSON.stringify(access));
  const saveProfile = () => writeFile(profilePath, stringify(profile));
  await saveProfile();
  const load = async () => loadPraxisRuntimeBinding(await loadConsciousness(root));
  const result = await load();
  assert.equal(result.personalContextAccessPath, accessPath);
  const runtime = await createBoundPraxisRuntime(await loadConsciousness(root), result, complete, async () => {});
  assert.equal(runtime.evidence.reader.catalog.generationId, "fixture-empty-v2");
  profile.models.learning.model = "unapproved"; await saveProfile();
  await assert.rejects(load(), /runtime_binding_migration_required/);
  profile.models.learning.model = "synthetic"; await saveProfile();
  binding.schemaVersion = "stella.alpha-praxis-binding/v2"; await writeFile(bindingPath, JSON.stringify(binding));
  await assert.rejects(load(), /runtime_binding_migration_required/);
  binding.schemaVersion = "stella.memory-runtime-binding/v1"; await writeFile(bindingPath, JSON.stringify(binding));
  await writeFile(path.join(root, accessPath), JSON.stringify({ ...access, viewProcessingModelRefs: undefined }));
  await assert.rejects(load(), /runtime_binding_migration_required/);
});
