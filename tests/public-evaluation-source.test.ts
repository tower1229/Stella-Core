import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { listSemanticRoutingCandidates } from "../src/praxis/packet.js";
import { createPublicEvaluationFixture } from "./public-evaluation-fixture.js";
import { createFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { assertPublicEvaluationSource } from "../src/acceptance/public-evaluation-source.js";
import { createBoundPraxisRuntime, loadPraxisRuntimeBinding, resolveBoundInputRefs } from "../src/praxis/runtime-binding.js";

test("standalone public cases receive no fixture owner hypotheses while retaining general framework operators", async (t) => {
  const root = await createPublicEvaluationFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadConsciousness(root);
  const candidates = listSemanticRoutingCandidates(loaded);
  assert.deepEqual(candidates.twin, [], "A standalone case must not inherit the generic fixture owner's Twin");
  assert.ok(candidates.frameworks.length > 0, "General reasoning operators remain available");
  const binding = await loadPraxisRuntimeBinding(loaded);
  const runtime = await createBoundPraxisRuntime(loaded, binding, async () => { throw new Error("No model call"); },
    async () => { throw new Error("No persistence expected"); });
  assert.ok((await resolveBoundInputRefs(runtime, binding, loaded.bootstrapDocuments
    .filter(document => document.category === "framework").map(document => document.ref))).length > 0,
  "General framework selections can be pinned by the actual v2 advice path");
  const memory = await runtime.listMemory();
  assert.deepEqual(memory.openEpisodes, []);
  assert.deepEqual(runtime.evidence.reader.catalog.understandings, []);
  assert.deepEqual(runtime.evidence.reader.catalog.changes, []);
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
  const binding = await loadPraxisRuntimeBinding(loaded);
  const runtime = await createBoundPraxisRuntime(loaded, binding, async () => { throw new Error("No model call"); }, async () => {});
  await resolveBoundInputRefs(runtime, binding, loaded.bootstrapDocuments
    .filter(document => document.category === "framework").map(document => document.ref));
});

test("public source admission rejects the generic owner fixture and changes to declared originals", async (t) => {
  const generic = await createFixture();
  const root = await createPublicEvaluationFixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(generic, { recursive: true, force: true }); });
  assert.ok(listSemanticRoutingCandidates(await loadConsciousness(generic)).twin.length > 0,
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
