import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CatalogReader, readRepositoryBytes } from "../src/canghai/catalog-reader.js";
import { parseCangHaiRef } from "../src/canghai/ref.js";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { createPublicEvaluationFixture } from "./public-evaluation-fixture.js";
import { createFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { assertPublicEvaluationSource } from "../src/acceptance/public-evaluation-source.js";

async function sourceFor(reader: CatalogReader, relative: string) {
  const matches = [];
  for (const entry of reader.catalog.sources) {
    const source = await reader.read(entry, "sources");
    const origin = source.origin as { collectionId: string; upstreamId: string };
    if (origin.collectionId === "public-evaluation-fixture" && origin.upstreamId === `public:${relative}`) matches.push(entry);
  }
  assert.equal(matches.length, 1, "Public original has exactly one current source identity");
  return matches[0]!;
}

test("standalone public cases receive no fixture owner hypotheses while retaining general framework operators", async (t) => {
  const root = await createPublicEvaluationFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadConsciousness(root);
  assert.equal(loaded.bootstrapDocuments.filter(document => document.category === "twin").length, 0);
  const frameworks = loaded.bootstrapDocuments.filter(document => document.category === "framework");
  assert.ok(frameworks.length > 0);
  const reader = await CatalogReader.load(root, "30_PersonalData/memory/catalog.json");
  assert.deepEqual(reader.catalog.understandings, []);
  assert.deepEqual(reader.catalog.changes, []);
  for (const document of frameworks) {
    const relative = parseCangHaiRef(document.ref).relativePath;
    const source = await sourceFor(reader, relative);
    const object = await reader.read(source, "sources");
    const payload = (object.payloads as Array<{ sha256: string }>)[0]!;
    assert.deepEqual((await reader.readPayload(source, payload.sha256)).bytes, await readRepositoryBytes(root, relative));
  }
  await initializeFixtureRepository(root);
  await assertPublicEvaluationSource(root);
});

test("public source bytes survive a clone with Windows-style Git line-ending conversion enabled", async (t) => {
  const root = await createPublicEvaluationFixture();
  const clone = `${root}-clone`;
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(clone, { recursive: true, force: true }); });
  const revision = await initializeFixtureRepository(root);
  await promisify(execFile)("git", ["clone", "--config", "core.autocrlf=true", "--no-local", root, clone]);
  await assertPublicEvaluationSource(clone);
  const loaded = await loadConsciousness(clone, undefined, {
    recoveryRevision: revision, coreVersion: "3.0.0-alpha.0", openclawVersion: "2026.8.2", dataMode: "managed_durable_write",
  });
  const reader = await CatalogReader.load(clone, "30_PersonalData/memory/catalog.json");
  for (const document of loaded.bootstrapDocuments.filter(document => document.category === "framework")) {
    const relative = parseCangHaiRef(document.ref).relativePath;
    const source = await sourceFor(reader, relative);
    const object = await reader.read(source, "sources");
    const payload = (object.payloads as Array<{ sha256: string }>)[0]!;
    assert.deepEqual((await reader.readPayload(source, payload.sha256)).bytes, await readRepositoryBytes(root, relative));
  }
});

test("public source admission rejects the generic owner fixture and changes to declared originals", async (t) => {
  const generic = await createFixture();
  const root = await createPublicEvaluationFixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(generic, { recursive: true, force: true }); });
  assert.ok((await loadConsciousness(generic)).bootstrapDocuments.some(document => document.category === "twin"),
    "The ordinary Twin integration fixture retains its owner profile");
  await assert.rejects(assertPublicEvaluationSource(generic), /public_evaluation_source_declaration_required/);
  const soul = path.join(root, "50_PersonalAgent/openclaw/workspace/SOUL.md");
  const original = await readFile(soul);
  await writeFile(soul, "Changed synthetic identity bytes");
  await assert.rejects(assertPublicEvaluationSource(root), /public_evaluation_source_changed/);
  await writeFile(soul, original);
  await assertPublicEvaluationSource(root);
  await writeFile(path.join(root, "__proto__"), "{}");
  await assert.rejects(assertPublicEvaluationSource(root), /public_evaluation_source_changed/);
  await rm(path.join(root, "__proto__"));
  await rm(soul);
  await assert.rejects(assertPublicEvaluationSource(root), /public_evaluation_source_changed/);
});
