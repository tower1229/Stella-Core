import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runRecoveryDrill } from "../src/acceptance/recovery-drill.js";
import { createFixture, initializeFixtureRepository, updateFixtureManifest } from "./consciousness-fixture.js";

async function addPraxisContinuityState(root: string): Promise<void> {
  const openRoot = path.join(root, "30_PersonalData/praxis/episodes/praxis-open");
  const learnedRoot = path.join(root, "30_PersonalData/praxis/episodes/praxis-learned");
  await mkdir(openRoot, { recursive: true });
  await mkdir(learnedRoot, { recursive: true });
  const prediction = { possibleActions: { wait: 0.7, ask: 0.3 } };
  await writeFile(path.join(openRoot, "prediction.json"), `${JSON.stringify(prediction)}\n`);
  await writeFile(path.join(openRoot, "episode.json"), `${JSON.stringify({
    schemaVersion: "stella.praxis-episode/v1",
    id: "praxis-open",
    status: "acted",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    provenance: {},
    situation: { summary: "important open state", domains: ["relationship"], observations: [] },
    twin: { prediction },
    decision: { recommendation: "wait once" },
  }, null, 2)}\n`);
  await writeFile(path.join(learnedRoot, "prediction.json"), `${JSON.stringify(prediction)}\n`);
  await writeFile(path.join(learnedRoot, "episode.json"), `${JSON.stringify({
    schemaVersion: "stella.praxis-episode/v1",
    id: "praxis-learned",
    status: "closed",
    createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    provenance: {},
    situation: { summary: "closed learning", domains: ["relationship"], observations: [] },
    twin: { prediction },
    learning: {
      algorithmVersion: "stella.praxis-learning/v1",
      predictionAssessment: "supported",
      evidenceRefs: ["path:30_PersonalData/praxis/episodes/praxis-learned/episode.json"],
      praxis: ["verify assumptions before escalating"],
    },
  }, null, 2)}\n`);
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
