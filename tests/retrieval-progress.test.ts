import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { CatalogReader, parseMemoryCatalog } from "../src/canghai/catalog-reader.js";
import { canonicalJson } from "../src/canghai/content-version.js";
import {
  checkpointPath,
  loadRetrievalCheckpoint,
  persistRetrievalCheckpoint,
  prepareRetrievalCheckpointWrite,
  retrievalResumeKey,
} from "../src/canghai/retrieval-progress.js";
import { parseRetrievalCheckpoint } from "../src/canghai/retrieve.js";

test("retrieval checkpoint path and persistence round-trip on local_write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-retrieval-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "operations"), { recursive: true });
  await writeFile(path.join(root, "catalog.json"), canonicalJson(parseMemoryCatalog({
    schemaVersion: "stella.memory-catalog/v1", generationId: "g1", parentGenerationId: null,
    sources: [], evidence: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [], policies: [],
  })));
  const reader = await CatalogReader.load(root, "catalog.json");
  const resumeKey = retrievalResumeKey("agent:fixture:session-1");
  assert.match(resumeKey, /^retrieval-[a-f0-9]{64}$/);
  const checkpoint = parseRetrievalCheckpoint({
    schemaVersion: "stella.retrieval-checkpoint/v1",
    requestId: "run-1",
    revision: "a".repeat(40),
    generationId: "g1",
    questionDigest: "sha256:" + "b".repeat(64),
    nextIntents: ["Follow counterevidence"],
    selectedRefs: [{ id: "e1", version: "sha256:" + "c".repeat(64) }],
    deniedRefKeys: [],
    roundsCompleted: 1,
    pagesReviewed: 2,
    modelRef: "synthetic/model",
    temporalScope: "current",
    config: { schemaVersion: "stella.semantic-retrieval/v1", pageSize: 16, maxRounds: 2, maxSelected: 4, maxOriginalChars: 96000 },
    exclusions: {},
  });
  assert.equal(checkpointPath("catalog.json", resumeKey), `operations/${resumeKey}.retrieval-checkpoint.json`);
  const prepared = prepareRetrievalCheckpointWrite({ catalogPath: "catalog.json", resumeKey, checkpoint });
  assert.equal(prepared.before, null);
  await persistRetrievalCheckpoint({ reader, resumeKey, checkpoint, dataMode: "local_write" });
  const loaded = await loadRetrievalCheckpoint(reader, resumeKey);
  assert.ok(loaded);
  assert.deepEqual(parseRetrievalCheckpoint(JSON.parse(loaded!.bytes)), checkpoint);
});
