import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { validateSchema } from "../src/canghai/schema.js";
import {
  CangHaiPraxisEpisodeStore,
  type EpisodePredictionInput,
} from "../src/praxis/episode-store.js";
import { createFixture, initializeFixtureRepository } from "./consciousness-fixture.js";

const execFileAsync = promisify(execFile);

const prediction: EpisodePredictionInput = {
  provenance: {
    agentId: "stella",
    sessionId: "session-1",
    runId: "run-1",
    messageRefs: ["message-1"],
  },
  situation: {
    summary: "对方两天没有回复，用户在决定是否再发一条低压消息。",
    domains: ["relationship"],
    actors: ["self", "other"],
    observations: ["对方两天没有回复"],
    interpretations: ["用户担心对方正在疏远"],
    unknowns: ["对方未回复的原因"],
    goals: ["选择一个尊重边界的下一步"],
    stakes: "medium",
    reversibility: "high",
  },
  twin: {
    hypothesisRefs: ["path:30_PersonalData/twin/hypotheses/twin_fixture.md"],
    prediction: {
      possibleActions: { "send-one-low-pressure-message": 0.7, wait: 0.3 },
      likelyInterpretations: ["用户会优先选择可逆行动"],
      keyFactors: ["避免给对方压力"],
    },
  },
  framework: {
    frameworkRefs: ["path:30_RAG/frameworks/fixture.md"],
    operatorRefs: [
      "path:30_PersonalData/framework-runtime/active-ir/fw_ir_fixture.yaml#operator:reversible_test",
    ],
  },
  reality: {
    modes: ["base_model"],
    hiddenVariables: ["对方的时间和精力"],
    uncertainties: ["对方未回复的原因"],
  },
};

test("original Praxis Episode v1 records remain schema-compatible", async () => {
  const root = await createFixture();
  try {
    const episode = {
      schemaVersion: "stella.praxis-episode/v1",
      id: "praxis-legacy",
      status: "open",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      provenance: {},
      situation: {
        summary: "legacy valid record",
        domains: ["testing"],
        observations: [],
      },
    };
    await validateSchema("praxis-episode", episode);
    const legacyRoot = path.join(root, "30_PersonalData/praxis/episodes/praxis-legacy");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(path.join(legacyRoot, "episode.json"), JSON.stringify(episode), "utf8");
    const loaded = await loadConsciousness(root);
    const store = new CangHaiPraxisEpisodeStore({ loaded, dataMode: "read_only" });

    assert.deepEqual(await store.listMemory(), { openEpisodes: [], learningItems: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local_write closes one Episode without rewriting its prediction and exposes versioned learning", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    await execFileAsync("git", ["-C", root, "switch", "-c", "local/stella-alpha"]);
    const loaded = await loadConsciousness(root, undefined, {
      recoveryRevision,
      coreVersion: "3.0.0-alpha.0",
      openclawVersion: "2026.8.2",
      dataMode: "local_write",
    });
    const store = new CangHaiPraxisEpisodeStore({
      loaded,
      dataMode: "local_write",
      now: (() => {
        const values = [
          "2026-09-03T01:00:00.000Z",
          "2026-09-03T02:00:00.000Z",
          "2026-09-03T02:00:00.000Z",
        ];
        return () => values.shift() ?? "2026-09-03T02:00:00.000Z";
      })(),
      createId: () => "praxis-private-case-1",
    });

    const staged = await store.stagePrediction(prediction);
    const episodePath = path.join(
      root,
      "30_PersonalData/praxis/episodes/praxis-private-case-1/episode.json",
    );
    const predictionPath = path.join(
      root,
      "30_PersonalData/praxis/episodes/praxis-private-case-1/prediction.json",
    );
    const stagedPredictionPath = path.join(
      root,
      "30_PersonalData/praxis/episodes/.staging/praxis-private-case-1/prediction.json",
    );
    const originalPredictionBytes = await readFile(stagedPredictionPath);
    assert.equal(
      (await readdir(path.join(root, "30_PersonalData/praxis/episodes"))).includes(
        "praxis-private-case-1",
      ),
      false,
    );
    const created = await store.publishRecommendation(
      staged,
      "发一条低压、可退出的消息，然后等待。",
      ["保留对方退出空间"],
    );
    const openEpisode = JSON.parse(await readFile(episodePath, "utf8")) as unknown;
    await validateSchema("praxis-episode", openEpisode);
    assert.equal(created.ref, "path:30_PersonalData/praxis/episodes/praxis-private-case-1/episode.json");

    await store.associateOutcome({
      episodeRef: created.ref,
      actualAction: "没有继续发消息，等待对方主动联系",
      source: "user_report",
      observations: ["一周后对方主动恢复联系"],
      result: "等待避免了额外压力",
      predictionAssessment: "countered",
      praxisLearning: "高不确定关系情境中，等待对方主动有时比追加消息更符合低压目标。",
      observedAt: "2026-09-03T02:00:00.000Z",
    });

    assert.deepEqual(await readFile(predictionPath), originalPredictionBytes);
    const closedEpisode = JSON.parse(await readFile(episodePath, "utf8")) as {
      status: string;
      decision?: { recommendation?: string };
      sourceBaseline?: { repository?: string; commit?: string };
      sourceSnapshot?: Record<string, string>;
      learning?: {
        algorithmVersion?: string;
        predictionAssessment?: string;
        evidenceRefs?: string[];
        praxis?: string[];
      };
    };
    await validateSchema("praxis-episode", closedEpisode);
    assert.equal(closedEpisode.status, "closed");
    assert.equal(closedEpisode.sourceBaseline?.repository, "tower1229/CangHai");
    assert.equal(closedEpisode.sourceBaseline?.commit, recoveryRevision);
    assert.ok(closedEpisode.sourceSnapshot?.[
      "path:30_PersonalData/twin/hypotheses/twin_fixture.md"
    ]);
    assert.match(closedEpisode.decision?.recommendation ?? "", /低压/);
    assert.equal(closedEpisode.learning?.algorithmVersion, "stella.praxis-learning/v1");
    assert.equal(closedEpisode.learning?.predictionAssessment, "countered");
    assert.deepEqual(closedEpisode.learning?.evidenceRefs, [created.ref]);
    assert.match(closedEpisode.learning?.praxis?.[0] ?? "", /等待对方主动/);

    const recalled = await store.listMemory();
    assert.deepEqual(recalled.openEpisodes, []);
    assert.equal(recalled.learningItems.length, 1);
    assert.equal(recalled.learningItems[0]?.domains[0], "relationship");
    assert.match(recalled.learningItems[0]?.content ?? "", /等待对方主动/);

    await loadConsciousness(root, undefined, {
      recoveryRevision,
      coreVersion: "3.0.0-alpha.0",
      openclawVersion: "2026.8.2",
      dataMode: "local_write",
    });
    await assert.rejects(
      loadConsciousness(root, undefined, {
        recoveryRevision,
        coreVersion: "3.0.0-alpha.0",
        openclawVersion: "2026.8.2",
        dataMode: "read_only",
      }),
      /clean at configured recovery revision/,
    );

    const { stdout: head } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    assert.equal(head.trim(), recoveryRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write modes fail closed and never publish a partial Episode", async () => {
  for (const dataMode of ["read_only", "managed_durable_write"] as const) {
    const root = await createFixture();
    try {
      const recoveryRevision = await initializeFixtureRepository(root);
      const loaded = await loadConsciousness(root, undefined, {
        recoveryRevision,
        coreVersion: "3.0.0-alpha.0",
        openclawVersion: "2026.8.2",
        dataMode,
      });
      const store = new CangHaiPraxisEpisodeStore({ loaded, dataMode });
      await assert.rejects(store.stagePrediction(prediction), /data mode|not enabled/i);
      const entries = await readdir(path.join(root, "30_PersonalData/praxis/episodes"));
      assert.deepEqual(entries, [".gitkeep"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("local_write rejects the wrong branch before staging any Episode", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const loaded = await loadConsciousness(root, undefined, {
      recoveryRevision,
      coreVersion: "3.0.0-alpha.0",
      openclawVersion: "2026.8.2",
      dataMode: "local_write",
    });
    const store = new CangHaiPraxisEpisodeStore({ loaded, dataMode: "local_write" });
    await assert.rejects(store.stagePrediction(prediction), /local\/stella-alpha/);
    const entries = await readdir(path.join(root, "30_PersonalData/praxis/episodes"));
    assert.deepEqual(entries, [".gitkeep"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a publish collision preserves the existing Episode and removes staging data", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    await execFileAsync("git", ["-C", root, "switch", "-c", "local/stella-alpha"]);
    const loaded = await loadConsciousness(root, undefined, {
      recoveryRevision,
      coreVersion: "3.0.0-alpha.0",
      openclawVersion: "2026.8.2",
      dataMode: "local_write",
    });
    const store = new CangHaiPraxisEpisodeStore({
      loaded,
      dataMode: "local_write",
      createId: () => "praxis-collision",
    });
    const first = await store.stagePrediction(prediction);
    await store.publishRecommendation(first, "original recommendation", []);
    const episodeRoot = path.join(root, "30_PersonalData/praxis/episodes");
    const episodePath = path.join(episodeRoot, "praxis-collision/episode.json");
    const originalEpisode = await readFile(episodePath);

    await assert.rejects(store.stagePrediction({
      ...prediction,
      situation: { ...prediction.situation, summary: "must not replace existing data" },
    }));

    assert.deepEqual(await readFile(episodePath), originalEpisode);
    assert.deepEqual(await readdir(path.join(episodeRoot, ".staging")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
