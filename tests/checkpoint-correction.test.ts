import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { ownerDirectAuthority } from "./processing-authority-fixture.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";

type Runtime = Awaited<ReturnType<typeof createCheckpointPluginRuntime>>;
type CorrectionInput = Parameters<Runtime["correctLocal"]>[0];
const execute = promisify(execFile);
const request = "我希望这篇文章保留疑问，不要替我加上励志结尾。";
const correctedGoal = "保留疑问，先检查论证";
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];
const noInference: CorrectionInput["complete"] = async () => { throw new Error("Recorded checkpoint correction must not run semantic inference"); };

/** Actual local Git/checkpoint writer, synthetic owner Evidence and structured model responses.
 * No remote, Host process, model API, private configuration or production source is involved.
 */
async function fixture(t: TestContext) {
  const memory = await personalMemoryFixture(t), root = await realpath(memory.root);
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "stella-checkpoint-correction-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const state = path.join(parent, "authority"); await mkdir(state, { mode: 0o700 });
  assert.ok(state !== root && !state.startsWith(root + path.sep));
  const manifestPath = "fixture-manifest.json";
  await writeFile(path.join(root, manifestPath), '{"scope":"synthetic checkpoint writer fixture; no manifest loader"}');
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root, ...args],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Checkpoint Test"); await git("config", "user.email", "synthetic@example.invalid");
  await git("config", "commit.gpgsign", "false");
  const groups = ["policies", "coverage", "sources", "evidence", "understandings", "changes", "works"] as const;
  await git("add", "--", "catalog.json", "payload.json", manifestPath, ...groups.flatMap(group => memory.catalog[group].map(entry => entry.locator.path)));
  await git("commit", "--quiet", "-m", "Synthetic writing checkpoint baseline");
  const revision = await git("rev-parse", "HEAD"); assert.equal(await git("remote"), "");
  const config = parseCheckpointPluginConfig({ recoveryAuthority: "core_checkpoint", canghaiRoot: root,
    manifestPath, checkpointStateDirectory: state, agentId: "stella", dataMode: "local_write" });
  const runtimes: Runtime[] = [];
  const open = async () => { const runtime = await createCheckpointPluginRuntime(config, "2026.8.2"); runtimes.push(runtime); return runtime; };
  t.after(() => { for (const runtime of runtimes) runtime.close(); });
  const runtime = await open(); await runtime.initializeAuthority({ revision, operationId: "synthetic-correction-init" });
  const purpose = (await memory.resolver()).purpose;
  const resolver = async () => new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, noInference);
  let calls = 0;
  const complete: CorrectionInput["complete"] = async ({ prompt }) => {
    calls++; const data = JSON.parse(prompt.split("\n").at(-1)!);
    if (data.proposalHash) return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true }) };
    const candidates = data.candidates as Array<{ handle: string; group: string; record: Record<string, unknown> }>;
    const work = candidates.find(candidate => candidate.group === "works"); assert.ok(work);
    return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: data.requestHash, disposition: "update", clarification: null,
      rationale: "Synthetic author correction preserves unresolved questions and unaccepted endings.", reviewedHandles: candidates.map(candidate => candidate.handle),
      replacements: [{ handle: work.handle, group: "works", record: { ...Object.fromEntries(editable.map(field => [field, work.record[field]])), goal: correctedGoal } }] }) };
  };
  const input = async (active = runtime): Promise<CorrectionInput> => {
    const recovery = await active.capture();
    return { recovery, operationId: "checkpoint_writing_correction", request, ownerId: "owner", modelRef: "synthetic/model",
      recordedAt: "2026-09-03T00:00:00Z", evidenceRefs: [memory.evidence], resolver: await resolver(), objectRoot: "objects",
      processingAuthority: ownerDirectAuthority({ purpose }),
      // This callback owns the processing scope only. The runtime independently
      // freezes A and uses accepted B after CAS; it must not reuse an A-bound closure.
      assertProcessingCurrent: async () => {}, complete, signal: new AbortController().signal };
  };
  return { memory, root, state, runtime, config, revision, git, open, resolver, purpose, input, calls: () => calls };
}

test("local checkpoint correction commits one writing work and a restarted reader preserves authorial distinctions", async t => {
  const f = await fixture(t), input = await f.input();
  const oldView = await preparePersonalViews({ ...input, requestId: "before-correction", question: request, audience: "owner_direct", selection: "all_authorized" });
  let publications = 0;
  const result = await f.runtime.correctLocal({ ...input, async assertPublication(accepted) {
    publications++; assert.notEqual(accepted.revision, input.recovery.expected.revision);
    await f.runtime.assert({ resolver: input.recovery.resolver, expected: accepted });
  } });
  assert.equal(result.disposition, "update"); assert.equal(result.clarification, null);
  assert.equal(result.persistenceStatus, "local_committed"); assert.ok(publications > 0 && f.calls() > 0);
  assert.deepEqual(result.authority, (await f.runtime.capture()).expected);
  assert.equal(result.revision, await f.git("rev-parse", "HEAD"));
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1"); assert.equal(await f.git("remote"), "");
  const journal = JSON.parse(await readFile(path.join(f.root, "operations", `${result.operationId}.transaction.json`), "utf8"));
  assert.equal(journal.schemaVersion, "stella.memory-transaction/v2");
  assert.deepEqual(journal.recoveryCheckpoint, { binding: input.recovery.expected.binding,
    expected: { revision: input.recovery.expected.revision, token: input.recovery.expected.token } });
  await assert.rejects(oldView.assertCurrent(), /stale_generation/);
  const current = await f.resolver();
  assert.deepEqual(await current.reader.read(f.memory.workRef, "works", "historical"), f.memory.work);
  assert.equal(current.reader.eligible(f.memory.workRef), false);
  f.runtime.close(); const reopened = await f.open(), recovery = await reopened.capture();
  const fresh = await preparePersonalViews({ requestId: "restarted-work-view", question: request, ownerId: "owner", modelRef: "synthetic/model",
    audience: "owner_direct", selection: "all_authorized", processingAuthority: ownerDirectAuthority({ runId: "restarted-work-view", purpose: f.purpose }),
    resolver: await f.resolver(), assertProcessingCurrent: () => reopened.assert(recovery), complete: noInference });
  const work = fresh.view.memory.find(candidate => candidate.group === "works")!.record;
  assert.equal(work.goal, correctedGoal); assert.equal(work.status, "active");
  for (const field of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions"] as const) assert.deepEqual(work[field], f.memory.work[field]);
  assert.equal(work.nextStep, null); await fresh.assertCurrent(); assert.equal(await f.git("status", "--porcelain"), "");
});

test("latest correction replays after restart without new inference, commit or token and rejects a changed request", async t => {
  const f = await fixture(t), input = await f.input(), result = await f.runtime.correctLocal(input), calls = f.calls();
  const revision = await f.git("rev-parse", "HEAD"); f.runtime.close();
  const reopened = await f.open(), replayInput = { ...await f.input(reopened), complete: noInference };
  const replay = await reopened.correctLocal(replayInput);
  assert.deepEqual(replay, result); assert.equal(f.calls(), calls); assert.equal(await f.git("rev-parse", "HEAD"), revision);
  assert.deepEqual((await reopened.capture()).expected, result.authority);
  await assert.rejects(reopened.correctLocal({ ...replayInput, request: "A different synthetic request with the same operation identity" }), /correction_operation_conflict/);
  assert.deepEqual((await reopened.capture()).expected, result.authority); assert.equal(await f.git("status", "--porcelain"), "");
});

test("new correction rejects stale expected, foreign scope, forbidden learning and pre-cancellation before mutation", async t => {
  for (const kind of ["stale", "scope", "learn", "cancel"] as const) await t.test(kind, async t => {
    const f = await fixture(t); let input = await f.input(); let category: RegExp = /checkpoint_runtime_stale/;
    if (kind === "stale") {
      const original = input.recovery; await f.runtime.correctLocal(input);
      input = { ...await f.input(), operationId: "another_correction", recovery: original };
    } else if (kind === "scope") {
      input = { ...input, recovery: await (await f.open()).capture() }; category = /recovery_read_binding_mismatch/;
    } else if (kind === "learn") {
      input = { ...input, processingAuthority: ownerDirectAuthority({ purpose: { readPurpose: f.purpose.readPurpose, derivePurpose: "forbidden", deliveryScope: f.purpose.deliveryScope } }) };
      category = /permission_denied/;
    } else {
      const controller = new AbortController(); controller.abort(); input = { ...input, signal: controller.signal }; category = /abort/i;
    }
    const head = await f.git("rev-parse", "HEAD"), authority = (await f.runtime.capture()).expected;
    const catalog = await readFile(path.join(f.root, "catalog.json"), "utf8"), calls = f.calls();
    await assert.rejects(f.runtime.correctLocal(input), category);
    assert.equal(await f.git("rev-parse", "HEAD"), head); assert.deepEqual((await f.runtime.capture()).expected, authority);
    assert.equal(await readFile(path.join(f.root, "catalog.json"), "utf8"), catalog); assert.equal(f.calls(), calls);
    await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
    assert.equal(await f.git("status", "--porcelain"), "");
  });
});

test("new correction rejects a committed but unselected catalog before inference and preserves both Git D and authority A", async t => {
  const f = await fixture(t), input = await f.input(), authorityA = input.recovery.expected;
  const catalogPath = path.join(f.root, "catalog.json"), catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.generationId = "synthetic-unselected-generation";
  await writeFile(catalogPath, JSON.stringify(catalog));
  await f.git("add", "--", "catalog.json"); await f.git("commit", "--quiet", "-m", "Synthetic unselected catalog D");
  const revisionD = await f.git("rev-parse", "HEAD"), catalogD = await readFile(catalogPath, "utf8"), resolverD = await f.resolver();
  assert.notEqual(revisionD, authorityA.revision); assert.notEqual(resolverD.reader.catalogHash, input.resolver.reader.catalogHash);
  assert.deepEqual((await f.runtime.capture()).expected, authorityA); assert.equal(f.calls(), 0);
  await assert.rejects(f.runtime.correctLocal({ ...input, resolver: resolverD }), /correction_checkpoint_catalog_mismatch/);
  assert.equal(f.calls(), 0); assert.equal(await f.git("rev-parse", "HEAD"), revisionD);
  assert.deepEqual((await f.runtime.capture()).expected, authorityA); assert.equal(await readFile(catalogPath, "utf8"), catalogD);
  await assert.rejects(readFile(path.join(f.root, ".stella-memory-transaction.json")), { code: "ENOENT" });
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("publication failure retains the original v2 journal and restart recovers it without re-inference or another advance", async t => {
  const f = await fixture(t), input = await f.input();
  await assert.rejects(f.runtime.correctLocal({ ...input, async assertPublication() { throw new Error("Synthetic correction publication failure"); } }), /Synthetic correction publication failure/);
  const revision = await f.git("rev-parse", "HEAD"), accepted = (await f.runtime.capture()).expected, calls = f.calls();
  assert.notEqual(revision, f.revision); assert.equal(accepted.revision, revision);
  const markerPath = path.join(f.root, ".stella-memory-transaction.json"), marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.schemaVersion, "stella.memory-transaction/v2");
  assert.deepEqual(marker.recoveryCheckpoint.expected, { revision: input.recovery.expected.revision, token: input.recovery.expected.token });
  const fenced = await f.resolver();
  await assert.rejects(fenced.reader.read(f.memory.workRef, "works", "historical"), /memory_transaction_pending/); f.runtime.close();
  const reopened = await f.open();
  // Preserve the pre-fence resolver only as root/catalog identity. The existing
  // recovery path rebuilds readers under the transaction fence from the journal.
  const retried = await reopened.correctLocal({ ...input, recovery: await reopened.capture(), complete: noInference });
  assert.equal(retried.persistenceStatus, "local_committed"); assert.deepEqual(retried.authority, accepted);
  assert.equal(retried.revision, revision); assert.equal(f.calls(), calls);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1");
  assert.deepEqual((await reopened.capture()).expected, accepted);
  await assert.rejects(readFile(markerPath), { code: "ENOENT" }); assert.equal(await f.git("status", "--porcelain"), "");
});
