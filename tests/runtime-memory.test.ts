import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { EpisodeRepository } from "../src/praxis/episode-repository.js";
import { PraxisRuntimeMemory } from "../src/praxis/runtime-memory.js";
import type { EpisodeV2 } from "../src/praxis/episode-v2.js";

const now = "2026-09-06T00:00:00Z";
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "episodes"));
  const object = { schemaVersion: "stella.memory-source/v1", id: "source-synthetic", label: "Synthetic historical source descriptor" };
  const ref = { id: object.id, version: objectVersion(object) };
  const body = canonicalJson(object);
  await writeFile(path.join(root, "source.json"), body);
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "synthetic", parentGenerationId: null,
    sources: [{ ...ref, status: "current", dependencies: [], locator: { path: "source.json", sha256: bytesVersion(body) } }],
    evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  const save = () => writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  await save();
  const create = async () => {
    const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), {
      readPurpose: "synthetic", derivePurpose: "synthetic", deliveryScope: "synthetic", evidenceCutoff: now,
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] },
    }, async () => { throw new Error("This fixture has no action evidence and must not claim one"); });
    const repository = new EpisodeRepository(root, "episodes", {
      resolveHistorical: (value) => resolver.resolveHistorical(value), resolveEvidence: (value) => resolver.resolveEvidence(value),
      resolveLearning: (value) => resolver.resolveLearning(value), verifyActionEvidence: (value) => resolver.verifyActionEvidence(value),
      verifyOutcomeEvidence: (actual, outcome) => resolver.verifyOutcomeEvidence(actual, outcome),
      isCurrentlyEligible: (value) => resolver.isCurrentlyEligible(value), async persist() {},
    });
    return new PraxisRuntimeMemory(repository, resolver);
  };
  const episode: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "praxis-synthetic", status: "open",
    createdAt: now, updatedAt: now, recoveryPriority: "important", historicalInputRefs: [ref], provenance: {},
    situation: { summary: "Synthetic decision", domains: ["social"], observations: ["Synthetic observation"] } };
  return { root, catalog, save, create, episode };
}

test("v2 runtime recalls a no-prediction Episode with an exact immutable selection", async (t) => {
  const { create, episode } = await fixture(t);
  const runtime = await create();
  const result = await runtime.recommend({ operationId: "advice", episode, recordedAt: now,
    decision: { recommendation: "Synthetic advice", rationale: [] } });
  const memory = await runtime.listMemory();
  assert.equal(memory.openEpisodes.length, 1);
  assert.equal(memory.openEpisodes[0]!.prediction, undefined);
  assert.match(memory.openEpisodes[0]!.ref, /\.versions\/[a-f0-9]{64}\.json#object:praxis-synthetic@sha256:/);
  assert.deepEqual(await runtime.selectedEpisode(memory.openEpisodes[0]!.ref), result);
  assert.deepEqual(await runtime.recommend({ operationId: "advice", episode, recordedAt: now,
    decision: { recommendation: "Synthetic advice", rationale: [] } }), result);
});

test("v2 runtime rejects a stale selected Episode and never invents an outcome", async (t) => {
  const { create, episode } = await fixture(t);
  const runtime = await create();
  const result = await runtime.recommend({ operationId: "advice", episode, recordedAt: now,
    decision: { recommendation: "Synthetic advice", rationale: [] } });
  const memory = await runtime.listMemory();
  await runtime.repository.apply({ operationId: "revise", expectedVersion: result.version,
    episode: { ...result.episode, decision: { recommendation: "Changed synthetic advice", rationale: [] } } });
  await assert.rejects(runtime.selectedEpisode(memory.openEpisodes[0]!.ref), /stale_episode_selection/);
  const current = await runtime.repository.read(episode.id);
  assert.equal(current.episode.actual, undefined);
  assert.equal(current.episode.outcome, undefined);
  assert.deepEqual((await runtime.listMemory()).learningItems, []);
});

test("source removal suppresses normal Episode recall and preserves legal empty state", async (t) => {
  const { create, episode, catalog, save } = await fixture(t);
  const runtime = await create();
  assert.deepEqual((await runtime.listMemory()).openEpisodes, []);
  await runtime.recommend({ operationId: "advice", episode, recordedAt: now,
    decision: { recommendation: "Synthetic advice", rationale: [] } });
  catalog.sources[0]!.status = "removed";
  await save();
  assert.deepEqual((await (await create()).listMemory()).openEpisodes, []);
  await assert.rejects(runtime.listMemory(), /stale_generation/);
});

test("v2 runtime rejects v1 input and pre-cancelled writes", async (t) => {
  const { create, episode } = await fixture(t);
  const runtime = await create();
  const args = { operationId: "advice", episode, recordedAt: now, decision: { recommendation: "Synthetic advice", rationale: [] } };
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(runtime.recommend({ ...args, abortSignal: cancellation.signal }), /operation_cancelled/);
  await assert.rejects(runtime.recommend({ ...args, episode: { ...episode, schemaVersion: "stella.praxis-episode/v1" } as unknown as EpisodeV2 }));
  assert.deepEqual((await runtime.listMemory()).openEpisodes, []);
});
