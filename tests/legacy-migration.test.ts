import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planLegacyEpisodeQuarantine, quarantineLegacyEpisodes } from "../src/praxis/legacy-migration.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-legacy-test-"));
  const directory = path.join(root, "praxis-unknown");
  await mkdir(directory);
  await writeFile(path.join(directory, "episode.json"), JSON.stringify({
    schemaVersion: "stella.praxis-episode/v1", id: "praxis-unknown", status: "closed",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    provenance: { sessionId: "synthetic-session", runId: "synthetic-run" },
    situation: { summary: "synthetic legacy record", domains: ["general"], observations: [] },
    actual: { source: "user_report", action: "claimed action", occurredAt: "2026-09-02T00:00:00Z" },
    decision: { recommendation: "synthetic recommendation", rationale: [] },
    outcome: { observations: [], result: "claimed result", observedAt: "2026-09-02T00:00:00Z" },
    learning: { algorithmVersion: "stella.praxis-learning/v1", predictionAssessment: "unresolved",
      evidenceRefs: ["path:episodes/praxis-unknown/episode.json"], praxis: ["unverified synthetic learning"] },
  }));
  await writeFile(path.join(directory, "notes.md"), "Owner-maintained notes\r\n");
  await writeFile(path.join(directory, "attachment.bin"), Buffer.from([0, 255, 128]));
  return root;
}

test("unverified source labels and tracking IDs never establish real action eligibility", async () => {
  const root = await fixture();
  try {
    const plan = await planLegacyEpisodeQuarantine(root);
    assert.equal(plan.records.length, 1);
    assert.deepEqual(plan.records[0]!.reasons, ["origin_unverified", "action_evidence_unverified"]);
    const before = await readFile(path.join(root, "praxis-unknown/episode.json"));
    const result = await quarantineLegacyEpisodes(root, plan);
    assert.deepEqual(result, { quarantinedCount: 1, activatedCount: 0 });
    assert.deepEqual(await readFile(path.join(root, ".legacy-v1/praxis-unknown/episode.json")), before);
    assert.equal(await readFile(path.join(root, ".legacy-v1/praxis-unknown/notes.md"), "utf8"), "Owner-maintained notes\r\n");
    assert.deepEqual(await readFile(path.join(root, ".legacy-v1/praxis-unknown/attachment.bin")), Buffer.from([0, 255, 128]));
    assert.deepEqual(await quarantineLegacyEpisodes(root, plan), result);
    assert.deepEqual((await planLegacyEpisodeQuarantine(root)).records, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration rejects stale plans, traversal, and archive tampering without overwriting history", async () => {
  const root = await fixture();
  try {
    const plan = await planLegacyEpisodeQuarantine(root);
    await assert.rejects(quarantineLegacyEpisodes(root, {
      ...plan, records: [{ ...plan.records[0]!, directory: "../outside" }],
    }), /Invalid legacy migration target/);
    await writeFile(path.join(root, "praxis-unknown/notes.md"), "changed");
    await assert.rejects(quarantineLegacyEpisodes(root, plan), /source changed/);
    const refreshed = await planLegacyEpisodeQuarantine(root);
    await quarantineLegacyEpisodes(root, refreshed);
    await writeFile(path.join(root, ".legacy-v1/praxis-unknown/notes.md"), "tampered");
    await assert.rejects(quarantineLegacyEpisodes(root, refreshed), /integrity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
