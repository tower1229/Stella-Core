import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { prepareRepositorySource, REPOSITORY_SOURCE_ADAPTER } from "../src/canghai/repository-source.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { createFixture } from "./consciousness-fixture.js";

test("repository import retains mixed original bytes as unknown, never as owner action", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const relativePath = "mixed-original.md";
  const original = Buffer.from("原始转录\r\n用户：谢谢。\r\n旧模型分析：已经采取行动。\r\n", "utf8");
  await writeFile(path.join(root, relativePath), original);
  const catalogPath = "30_PersonalData/memory/catalog.json";
  const catalog = JSON.parse(await readFile(path.join(root, catalogPath), "utf8")) as MemoryCatalog;
  const policy = catalog.policies[0]!;
  const input = { root, collectionId: "synthetic-import", sourceId: "explicit-origin-1", relativePath,
    expectedSha256: bytesVersion(original), capturedAt: "2026-09-06T00:00:00Z",
    policyRef: { id: policy.id, version: policy.version }, objectRoot: "30_PersonalData/memory/imports" };
  const prepared = await prepareRepositorySource(input);
  assert.deepEqual(await readFile(path.join(root, relativePath)), original);
  for (const object of prepared.objects) {
    await mkdir(path.dirname(path.join(root, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(root, object.entry.locator.path), object.bytes);
    catalog[object.group].push(object.entry);
  }
  await writeFile(path.join(root, catalogPath), canonicalJson(catalog));
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, catalogPath), {
    readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat", evidenceCutoff: input.capturedAt,
    trustedAdapters: { user_report: [REPOSITORY_SOURCE_ADAPTER], tool_observation: [], system_event: [] },
  }, async () => { throw new Error("Unknown provenance must fail before semantic action judgment"); });
  const evidence = await resolver.readEvidence(prepared.evidenceRefs[0]!);
  assert.equal(evidence.text, original.toString("utf8"));
  assert.equal(evidence.role, "unknown");
  assert.equal(evidence.kind, "unknown");
  assert.equal(evidence.occurredAt, null);
  assert.equal(evidence.authoredAt, null);
  await assert.rejects(resolver.verifyActionEvidence({ action: "already acted", occurredAt: null, recordedAt: input.capturedAt,
    source: "user_report", evidenceRefs: prepared.evidenceRefs }), /unsupported_actual_evidence/);
  await writeFile(path.join(root, relativePath), "changed original");
  await assert.rejects(prepareRepositorySource(input), /repository_source_changed/);
  await assert.rejects(resolver.readEvidence(prepared.evidenceRefs[0]!));
  await writeFile(path.join(root, relativePath), Buffer.from([0xff, 0xfe]));
  await assert.rejects(prepareRepositorySource({ ...input, expectedSha256: bytesVersion(Buffer.from([0xff, 0xfe])) }), /media_adapter_required/);
});
