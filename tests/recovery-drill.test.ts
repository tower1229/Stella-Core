import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { prepareHostInputArchive } from "../src/canghai/host-input-archive.js";
import { createBoundPraxisRuntime, loadPraxisRuntimeBinding } from "../src/praxis/runtime-binding.js";
import type { HostInputSnapshot } from "../src/openclaw/host-input.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";
import test from "node:test";
import { runRecoveryDrill } from "../src/acceptance/recovery-drill.js";
import { createFixture, initializeFixtureRepository, updateFixtureManifest } from "./consciousness-fixture.js";

async function addPraxisContinuityState(root: string, priority: "normal" | "important" = "important"): Promise<void> {
  const now = "2026-09-06T00:00:00Z";
  const loaded = await loadConsciousness(root);
  const binding = await loadPraxisRuntimeBinding(loaded);
  const snapshot: HostInputSnapshot = { schemaVersion: "stella.host-input-snapshot/v1", hostVersion: "2026.8.2",
    agentId: "fixture", sessionId: "synthetic", sessionKey: "agent:fixture:synthetic", entryId: "synthetic-report",
    logicalTurnId: "synthetic-turn", generation: "synthetic", rawSeq: 1, parentId: null,
    text: "Synthetic fixture: verify assumptions before escalating.",
    event: { type: "message", id: "synthetic-report", parentId: null, timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "Synthetic fixture: verify assumptions before escalating." }] } } };
  const archived = prepareHostInputArchive(snapshot, { ...binding.archive, speaker: { id: "synthetic-owner", role: "owner" } });
  const catalog = (await CatalogReader.load(root, binding.catalogPath)).catalog;
  await mkdir(path.dirname(path.join(root, archived.payload.path)), { recursive: true });
  await writeFile(path.join(root, archived.payload.path), archived.payload.bytes);
  for (const object of archived.objects) {
    await mkdir(path.dirname(path.join(root, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(root, object.entry.locator.path), object.bytes);
    catalog[object.group].push(object.entry);
  }
  const put = async (group: "understandings" | "changes", object: Record<string, unknown>, dependencies: VersionedRef[]) => {
    const ref = { id: String(object.id), version: objectVersion(object) };
    const bytes = canonicalJson({ ...object, version: ref.version });
    const relative = `30_PersonalData/memory/${ref.id}.json`;
    await writeFile(path.join(root, relative), bytes);
    catalog[group].push({ ...ref, status: "current", dependencies, locator: { path: relative, sha256: bytesVersion(bytes) } });
    return ref;
  };
  const supportRefs = archived.evidenceRefs;
  const strategy = await put("understandings", { schemaVersion: "stella.understanding/v1", id: "strategy-synthetic",
    statement: "Synthetic scoped learning", kind: "strategy", status: "active",
    scope: { workIds: [], contexts: ["synthetic"], domains: ["social"], global: false },
    supportRefs, counterRefs: [], dependencyRefs: supportRefs, originChangeId: "change-synthetic", createdAt: now, updatedAt: now }, supportRefs);
  await put("changes", { schemaVersion: "stella.learning-change/v1", id: "change-synthetic", operationId: "synthetic-learning",
    algorithmVersion: "synthetic", modelRef: "synthetic", promptVersion: "synthetic", inputRefs: supportRefs, targetRefs: [strategy],
    changes: [{ kind: "create", before: null, after: strategy, supportRefs, counterRefs: [] }],
    disposition: "update", rationale: "Synthetic preexisting scoped learning; not private learning proof" }, [...supportRefs, strategy]);
  await writeFile(path.join(root, binding.catalogPath), canonicalJson(catalog));
  const runtime = await createBoundPraxisRuntime(loaded, binding,
    async () => { throw new Error("No action/outcome exists in this recovery fixture"); }, async () => {});
  await runtime.recommend({ operationId: "synthetic-advice",
    episode: { schemaVersion: "stella.praxis-episode/v2", id: "praxis-open", status: "open",
      createdAt: now, updatedAt: now, recoveryPriority: priority, provenance: {},
      historicalInputRefs: [archived.sourceRef], situation: { summary: "important open state", domains: ["social"], observations: [] } },
    decision: { recommendation: "wait once", rationale: [] }, recordedAt: now });
  const durableStatePath = path.join(root, "50_PersonalAgent/stella/durable/goals.yaml");
  await mkdir(path.dirname(durableStatePath), { recursive: true });
  await writeFile(durableStatePath, "goals:\n  - preserve continuity\n", "utf8");
  await updateFixtureManifest(root, (manifest) => manifest.replace(
    "durability:\n  criticalWritePolicy:",
    "durableState:\n  goalsRef: path:50_PersonalAgent/stella/durable/goals.yaml\ndurability:\n  criticalWritePolicy:",
  ));
}

test("restores Level 3 continuity from one exact CangHai revision", async () => {
  const root = await createFixture();
  try {
    await addPraxisContinuityState(root);
    await updateFixtureManifest(root, (manifest) => manifest.replace(
      "derived:\n  rebuild: [bootstrap_projection, memory_index]",
      "derived:\n  rebuild: [bootstrap_projection, framework_registry, praxis_index]",
    ));
    const revision = await initializeFixtureRepository(root);
    const rebuilt: string[] = [];
    const report = await runRecoveryDrill({
      canghaiRoot: root,
      recoveryRevision: revision,
      coreVersion: "3.0.0-alpha.0",
      hostVersion: "2026.8.2",
      rebuild: async (target) => {
        rebuilt.push(target);
        return { target, evidence: `rebuilt:${target}` };
      },
      verifyContinuity: async ({ loaded, memory }) => ({
        accepted: loaded.manifest.instance.id === "stella" &&
          memory.learningItems.length === 1 && memory.openEpisodes.length === 1,
        evidence: ["fresh behavioral probe passed"],
      }),
    });

    assert.deepEqual(rebuilt, ["bootstrap_projection", "framework_registry", "praxis_index"]);
    assert.deepEqual(report.levels, {
      dataReadable: true,
      cognitiveBootstrapRestored: true,
      derivedRuntimeRebuilt: true,
      continuityAccepted: true,
    });
    assert.deepEqual(report.restored, {
      identity: true,
      framework: true,
      twin: true,
      praxisLearning: true,
      importantOpenState: true,
    });
    assert.equal(report.recoveryRevision, revision);
    assert.equal(report.structuralEvidence.openEpisodeRefs.length, 1);
    assert.match(report.structuralEvidence.openEpisodeRefs[0]!, /\.versions\/.+#object:praxis-open@sha256:/);
    assert.equal(report.structuralEvidence.praxisLearningRefs.length, 1);
    assert.match(report.structuralEvidence.praxisLearningRefs[0]!, /#object:strategy-synthetic@sha256:/);
    assert.equal(report.structuralEvidence.durableState.status, "restored");
    if (report.structuralEvidence.durableState.status === "restored") {
      assert.deepEqual(
        report.structuralEvidence.durableState.records.map(({ field, ref }) => ({ field, ref })),
        [{
          field: "durableState.goalsRef",
          ref: "path:50_PersonalAgent/stella/durable/goals.yaml",
        }],
      );
      assert.match(report.structuralEvidence.durableState.records[0]!.blobSha, /^[0-9a-f]{40}$/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows empty important state but does not substitute ordinary state for fixture coverage", async () => {
  const root = await createFixture();
  try {
    await addPraxisContinuityState(root, "normal");
    const revision = await initializeFixtureRepository(root);
    const report = await runRecoveryDrill({
      canghaiRoot: root,
      recoveryRevision: revision,
      coreVersion: "3.0.0-alpha.0",
      hostVersion: "2026.8.2",
      rebuild: async (target) => ({ target, evidence: `rebuilt:${target}` }),
      verifyContinuity: async () => ({ accepted: true, evidence: ["probe"] }),
    });
    assert.deepEqual(report.structuralEvidence.openEpisodeRefs, []);
    await assert.rejects(
      runRecoveryDrill({
        canghaiRoot: root,
        recoveryRevision: revision,
        coreVersion: "3.0.0-alpha.0",
        hostVersion: "2026.8.2",
        requiredCoverage: { praxisLearning: true, importantOpenState: true },
        rebuild: async (target) => ({ target, evidence: `rebuilt:${target}` }),
        verifyContinuity: async () => ({ accepted: true, evidence: ["probe"] }),
      }),
      /important open Praxis state/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores legal empty Episode and learning sets without fabricating coverage", async () => {
  const root = await createFixture();
  try {
    const revision = await initializeFixtureRepository(root);
    const options = {
      canghaiRoot: root,
      recoveryRevision: revision,
      coreVersion: "3.0.0-alpha.0",
      hostVersion: "2026.8.2",
      rebuild: async (target: string) => ({ target, evidence: `rebuilt:${target}` }),
      verifyContinuity: async () => ({ accepted: true, evidence: ["empty state verified"] }),
    };
    const report = await runRecoveryDrill(options);
    assert.deepEqual(report.structuralEvidence.praxisLearningRefs, []);
    assert.deepEqual(report.structuralEvidence.openEpisodeRefs, []);
    await assert.rejects(runRecoveryDrill({
      ...options, requiredCoverage: { praxisLearning: true, importantOpenState: true },
    }), /missing durable Praxis learning/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a durable-state directory instead of reporting a tree SHA as a blob", async () => {
  const root = await createFixture();
  try {
    await addPraxisContinuityState(root);
    await updateFixtureManifest(root, (manifest) => manifest.replace(
      "path:50_PersonalAgent/stella/durable/goals.yaml",
      "path:50_PersonalAgent/stella/durable",
    ));
    const revision = await initializeFixtureRepository(root);
    await assert.rejects(
      runRecoveryDrill({
        canghaiRoot: root,
        recoveryRevision: revision,
        coreVersion: "3.0.0-alpha.0",
        hostVersion: "2026.8.2",
        rebuild: async (target) => ({ target, evidence: `rebuilt:${target}` }),
        verifyContinuity: async () => ({ accepted: true, evidence: ["probe"] }),
      }),
      /could not identify durable state/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery fails closed when a declared rebuild or continuity probe fails", async () => {
  const root = await createFixture();
  try {
    await addPraxisContinuityState(root);
    const revision = await initializeFixtureRepository(root);
    await assert.rejects(
      runRecoveryDrill({
        canghaiRoot: root,
        recoveryRevision: revision,
        coreVersion: "3.0.0-alpha.0",
        hostVersion: "2026.8.2",
        rebuild: async (target) => target === "memory_index"
          ? { target, evidence: "" }
          : { target, evidence: `rebuilt:${target}` },
        verifyContinuity: async () => ({ accepted: true, evidence: ["probe"] }),
      }),
      /memory_index.*evidence/,
    );
    await assert.rejects(
      runRecoveryDrill({
        canghaiRoot: root,
        recoveryRevision: revision,
        coreVersion: "3.0.0-alpha.0",
        hostVersion: "2026.8.2",
        rebuild: async (target) => ({ target, evidence: `rebuilt:${target}` }),
        verifyContinuity: async () => ({ accepted: false, evidence: ["probe failed"] }),
      }),
      /continuity verification failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 recovery reads a standalone clean Git copy with no original runtime", async (t) => {
  const root = await createFixture();
  const staging = await mkdtemp(path.join(os.tmpdir(), "stella-v2-drill-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true }); });
  await addPraxisContinuityState(root);
  const revision = await initializeFixtureRepository(root);
  const clone = path.join(staging, "clone");
  await promisify(execFile)("git", ["clone", "--no-local", "--quiet", root, clone]);
  await promisify(execFile)("git", ["-C", clone, "remote", "remove", "origin"]);
  const report = await runRecoveryDrill({
    canghaiRoot: clone, recoveryRevision: revision, coreVersion: "3.0.0-alpha.0", hostVersion: "2026.8.2",
    requiredCoverage: { praxisLearning: true, importantOpenState: true },
    rebuild: async (target) => ({ target, evidence: `rebuilt:${target}` }),
    verifyContinuity: async ({ memory }) => ({ accepted: memory.openEpisodes.length === 1 && memory.learningItems.length === 1,
      evidence: ["synthetic exact stored sets"] }),
  });
  assert.equal(report.schemaVersion, "stella.recovery-drill/v2");
  assert.ok(report.memoryGeneration);
});

test("v2 recovery refuses a legacy Episode instead of promoting its learning", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "30_PersonalData/praxis/episodes/praxis-legacy");
  await mkdir(directory);
  await writeFile(path.join(directory, "episode.json"), JSON.stringify({ schemaVersion: "stella.praxis-episode/v1",
    id: "praxis-legacy", status: "closed", learning: { praxis: ["unverified model text"] } }));
  const revision = await initializeFixtureRepository(root);
  await assert.rejects(runRecoveryDrill({ canghaiRoot: root, recoveryRevision: revision,
    coreVersion: "3.0.0-alpha.0", hostVersion: "2026.8.2",
    rebuild: async () => { throw new Error("Legacy data must fail before rebuild"); },
    verifyContinuity: async () => { throw new Error("Legacy data must fail before probes"); },
  }), /legacy_episode_migration_required/);
});

test("declared v2 learning cannot recover without its original payload", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await addPraxisContinuityState(root);
  await rm(path.join(root, "30_PersonalData/host-archive"), { recursive: true });
  const revision = await initializeFixtureRepository(root);
  await assert.rejects(runRecoveryDrill({ canghaiRoot: root, recoveryRevision: revision,
    coreVersion: "3.0.0-alpha.0", hostVersion: "2026.8.2",
    rebuild: async () => { throw new Error("Missing originals must fail before rebuild"); },
    verifyContinuity: async () => { throw new Error("Missing originals must fail before probes"); },
  }), /unavailable|ENOENT/);
});

test("recovery cannot accept a source modified during continuity verification", async (t) => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const revision = await initializeFixtureRepository(root);
  await assert.rejects(runRecoveryDrill({ canghaiRoot: root, recoveryRevision: revision,
    coreVersion: "3.0.0-alpha.0", hostVersion: "2026.8.2",
    rebuild: async (target) => ({ target, evidence: `rebuilt:${target}` }),
    verifyContinuity: async () => {
      await writeFile(path.join(root, "30_RAG/frameworks/fixture.md"), "changed during probe");
      return { accepted: true, evidence: ["must not count as recovery"] };
    },
  }), /recovery_source_changed_during_verification/);
});
