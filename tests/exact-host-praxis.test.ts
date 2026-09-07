import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseExactHostPraxisReceipt } from "../src/acceptance/exact-host-praxis.js";
import { listPraxisEpisodeIds, readPraxisEpisodeState } from "../src/acceptance/praxis-loop-state.js";
import { EpisodeRepository } from "../src/praxis/episode-repository.js";

const receipt = {
  schemaVersion: "stella.exact-host-praxis-receipt/v2",
  episodeSchemaVersion: "stella.praxis-episode/v2", transport: "chat.send",
  adviceRevisionPersisted: true, predictionStatus: "sealed",
  coreRevision: "1".repeat(40),
  initialCanghaiRevision: "2".repeat(40),
  finalCanghaiRevision: "3".repeat(40),
  hostVersion: "2026.8.2",
  artifactSha256: "4".repeat(64),
  dataMode: "managed_durable_write",
  predictionSealedBeforeOutcome: true,
  recommendationPersisted: true,
  actualRecorded: true,
  outcomeClosed: true,
  learningPersisted: true,
  learningRetrievedAfterRestart: true,
  finalRevisionRemoteSynchronized: true,
  sourceClean: true,
  exactHostAgentTurns: 4,
  episodeRefHash: "5".repeat(64),
  learningRefHash: "6".repeat(64),
  privateFixtureIncluded: true,
};

test("accepts only complete private managed-write Praxis evidence", () => {
  assert.deepEqual(parseExactHostPraxisReceipt(receipt), receipt);
  assert.throws(
    () => parseExactHostPraxisReceipt({ ...receipt, dataMode: "local_write" }),
    /Invalid exact-host Praxis receipt/,
  );
  assert.throws(
    () => parseExactHostPraxisReceipt({ ...receipt, learningRetrievedAfterRestart: false }),
    /Invalid exact-host Praxis receipt/,
  );
  assert.throws(
    () => parseExactHostPraxisReceipt({ ...receipt, finalCanghaiRevision: receipt.initialCanghaiRevision }),
    /Invalid exact-host Praxis receipt/,
  );
});

test("current Praxis candidate evidence rejects old transport and missing revision coverage", () => {
  for (const patch of [{ schemaVersion: "stella.exact-host-praxis-receipt/v1" }, { transport: "agent" },
    { adviceRevisionPersisted: false }, { exactHostAgentTurns: 3 }, { predictionStatus: "not_applicable" }]) {
    assert.throws(() => parseExactHostPraxisReceipt({ ...receipt, ...patch }), /Invalid exact-host Praxis receipt/);
  }
  const noPrediction = { ...receipt, predictionStatus: "not_applicable", predictionSealedBeforeOutcome: false };
  assert.deepEqual(parseExactHostPraxisReceipt(noPrediction), noPrediction);
});

test("private runner readback supports v2 IDs and absent predictions, and rejects unbound history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-praxis-readback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "episodes"));
  const repository = new EpisodeRepository(root, "episodes", {
    async resolveHistorical() {}, async resolveEvidence() {}, async resolveLearning() {},
    async verifyActionEvidence() { return false; }, async verifyOutcomeEvidence() { return false; },
    async isCurrentlyEligible() { return true; }, async persist() {},
  });
  const opened = await repository.apply({ operationId: "open", expectedVersion: null,
    episode: { schemaVersion: "stella.praxis-episode/v2", id: "praxis_underscore", status: "open",
      createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", recoveryPriority: "important",
      historicalInputRefs: [], provenance: {}, situation: { summary: "Synthetic request", domains: ["social"], observations: [] } } });
  const advised = await repository.apply({ operationId: "recommend", expectedVersion: opened.version,
    episode: { ...opened.episode, status: "recommended", decision: { recommendation: "Ask", rationale: [] } } });
  assert.deepEqual(await listPraxisEpisodeIds(root, "episodes"), new Set([advised.episode.id]));
  assert.deepEqual(await readPraxisEpisodeState(root, "episodes", advised.episode.id), { ...advised, predictionHash: null });
  const predictionPath = path.join(root, "episodes", advised.episode.id, "prediction.json");
  await writeFile(predictionPath, "{}");
  await assert.rejects(readPraxisEpisodeState(root, "episodes", advised.episode.id), /unexpected_prediction/);
  await rm(predictionPath);
  const archivedPath = path.join(root, repository.historicalPath(advised.episode.id, advised.version));
  const archived = await readFile(archivedPath);
  await writeFile(archivedPath, JSON.stringify(opened.episode));
  await assert.rejects(readPraxisEpisodeState(root, "episodes", advised.episode.id), /version_mismatch/);
  await writeFile(archivedPath, archived);
  await assert.rejects(readPraxisEpisodeState(root, "episodes", "../outside"), /invalid_record_id/);
  await assert.rejects(listPraxisEpisodeIds(root, "../outside"), /unsafe_record/);
});
