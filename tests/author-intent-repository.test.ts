import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { createAuthorIntentRepository, type AuthorIntentPorts } from "../src/canghai/author-intent-repository.js";
import { intentDocument, type IntentPublication } from "../src/canghai/author-intent-asset.js";

const run = promisify(execFile);
const sourceExcerpt = "This outline must retain its argument appendix.";
const sourceVersion = bytesVersion(sourceExcerpt);
function proposal(operationId = "publish_A", expectedVersion: string | null = null): IntentPublication {
  return { operationId, expectedVersion, confirmation: "author_confirmed", triggerSourceId: "source_A", replaces: [], reason: "Explicit scoped author clarification",
    content: { topic: "Synthetic harbor exhibit", scope: "One internal outline", nonGoals: ["No general writing preference"],
      sources: [{ id: "source_A", version: sourceVersion, authorId: "synthetic_author", role: "author", locator: "paragraph:1",
        purpose: "clarification", excerpt: sourceExcerpt }],
      originalIntent: [{ id: "intent_A", text: "An understandable internal outline", sourceIds: ["source_A"] }],
      established: [{ id: "rule_A", text: "Retain this outline's argument appendix", sourceIds: ["source_A"] }],
      candidates: [{ id: "candidate_A", text: "Three tables could present the argument", sourceIds: ["source_A"] }],
      unresolved: ["The appendix length is undecided"], interpretation: null, authorityConflicts: [] } };
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-intent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Test"); await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(root, "source.txt"), sourceExcerpt);
  await git("add", "source.txt"); await git("commit", "--quiet", "-m", "Synthetic baseline");
  const state = { allowed: true, sourceAllowed: true, sourceVersion, excerpt: sourceExcerpt, verified: true };
  const ports: AuthorIntentPorts = {
    async assertRequest() { if (!state.allowed) throw new Error("request_denied"); },
    async assertSources() { if (!state.sourceAllowed) throw new Error("source_denied"); },
    async currentSourceVersion() { return state.sourceVersion; },
    async verifyAuthor() { return state.verified ? { sourceId: "source_A", version: state.sourceVersion, authorId: "synthetic_author", locator: "paragraph:1",
      excerptHash: bytesVersion(state.excerpt) } : null; },
  };
  const open = () => createAuthorIntentRepository({ root, directory: "intent", assetId: "harbor", ports });
  const updateSource = async () => {
    state.excerpt = "This outline must retain its argument appendix with a one-page limit.";
    state.sourceVersion = bytesVersion(state.excerpt);
    await writeFile(path.join(root, "source.txt"), state.excerpt);
    await git("add", "--", "source.txt"); await git("commit", "--quiet", "-m", "Synthetic source refresh");
  };
  const refreshed = (operationId: string, expectedVersion: string): IntentPublication => {
    const input = proposal(operationId, expectedVersion);
    input.content.sources[0]!.version = state.sourceVersion; input.content.sources[0]!.excerpt = state.excerpt;
    input.content.established[0]!.text = "Retain this outline's argument appendix with a one-page limit"; input.replaces = ["rule_A"];
    return input;
  };
  return { root, git, state, ports, open, updateSource, refreshed };
}

async function recoverInChild(root: string, input: IntentPublication, version = sourceVersion, excerpt = sourceExcerpt) {
  const moduleUrl = new URL("../src/canghai/author-intent-repository.js", import.meta.url).href;
  const code = `import { createAuthorIntentRepository } from ${JSON.stringify(moduleUrl)};
    const sourceVersion = ${JSON.stringify(version)}, excerptHash = ${JSON.stringify(bytesVersion(excerpt))};
    const repo = createAuthorIntentRepository({ root: process.argv[1], directory: 'intent', assetId: 'harbor', ports: {
      async assertRequest() {}, async assertSources() {}, async currentSourceVersion() { return sourceVersion; },
      async verifyAuthor() { return { sourceId: 'source_A', version: sourceVersion, authorId: 'synthetic_author', locator: 'paragraph:1', excerptHash }; }
    }});
    const result = await repo.publish(JSON.parse(process.argv[2])); const current = await repo.readCurrent();
    console.log(JSON.stringify({ result, currentVersion: current.version }));`;
  const child = await run(process.execPath, ["--input-type=module", "--eval", code, root, JSON.stringify(input)], { timeout: 30_000 });
  return JSON.parse(child.stdout);
}

test("one complete intent publication is committed locally and controlled reads preserve candidates and unresolved questions", async t => {
  const f = await fixture(t), repository = f.open(), before = await f.git("rev-parse", "HEAD");
  const result = await repository.publish(proposal());
  assert.equal(result.persistenceStatus, "local_committed");
  assert.equal(result.replayed, false);
  assert.notEqual(result.commitRevision, before);
  const current = await repository.readCurrent();
  assert.equal(current.version, result.publishedVersion);
  assert.equal(current.document.content.established[0].text, "Retain this outline's argument appendix");
  assert.equal(current.document.content.candidates[0].id, "candidate_A");
  assert.deepEqual(current.document.content.unresolved, ["The appendix length is undecided"]);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("remote"), "");
});

test("durable retries retain their original result after a later publication and reject operation ID reuse", async t => {
  const f = await fixture(t), first = proposal(), a = await f.open().publish(first);
  const replay = await f.open().publish(first);
  assert.equal(replay.replayed, true); assert.equal(replay.commitRevision, a.commitRevision);
  const newer = proposal("publish_B", a.publishedVersion);
  newer.content.established[0]!.text = "The argument appendix has a one-page limit";
  newer.replaces = ["rule_A"];
  const b = await f.open().publish(newer), head = await f.git("rev-parse", "HEAD");
  const historical = await f.open().publish(first);
  assert.equal(historical.publishedVersion, a.publishedVersion);
  assert.equal(historical.currentVersion, b.publishedVersion);
  assert.equal(historical.commitRevision, a.commitRevision);
  assert.equal((await f.open().readHistorical(a.publishedVersion)).position, "historical");
  const collision = proposal(); collision.reason = "A different proposal under the same ID";
  await assert.rejects(f.open().publish(collision), /operation_identity_conflict/);
  assert.equal(await f.git("rev-parse", "HEAD"), head);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "3");
});

test("stale asset or source expectations do not write or silently rebase", async t => {
  const f = await fixture(t), before = await f.git("rev-parse", "HEAD");
  f.state.sourceVersion = bytesVersion("A changed author source");
  await assert.rejects(f.open().publish(proposal()), /source_version_conflict/);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(await f.git("rev-parse", "HEAD"), before);
  f.state.sourceVersion = sourceVersion;
  const a = await f.open().publish(proposal());
  await assert.rejects(f.open().publish(proposal("old_proposal")), /asset_version_conflict/);
  assert.equal(await f.git("rev-parse", "HEAD"), a.commitRevision);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("current qualification is required before a new publication, durable replay, or controlled read", async t => {
  const f = await fixture(t), input = proposal(), a = await f.open().publish(input);
  f.state.allowed = false;
  await assert.rejects(f.open().publish(input), /request_denied/);
  await assert.rejects(f.open().publish(proposal("denied", a.publishedVersion)), /request_denied/);
  await assert.rejects(f.open().readCurrent(), /request_denied/);
  await assert.rejects(f.open().readHistorical(a.publishedVersion), /request_denied/);
  assert.equal(await f.git("rev-parse", "HEAD"), a.commitRevision);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("without trusted author evidence only an explicit candidate can be published", async t => {
  const f = await fixture(t); f.state.verified = false;
  await assert.rejects(f.open().publish(proposal()), /author_source_required/);
  assert.equal(await f.git("status", "--porcelain"), "");
  const candidate = proposal("candidate_only"); candidate.confirmation = "candidate"; candidate.triggerSourceId = null;
  candidate.content.originalIntent = []; candidate.content.established = [];
  const a = await f.open().publish(candidate);
  const current = await f.open().readCurrent();
  assert.equal(current.version, a.publishedVersion);
  assert.equal(current.document.revision.confirmation, "candidate");
  assert.equal(current.document.content.candidates.length, 1);
});

test("a model-supplied excerpt cannot borrow a genuine author's identity and source version", async t => {
  const f = await fixture(t), input = proposal();
  input.content.sources[0]!.excerpt = "The author supposedly confirmed publishing without an appendix.";
  await assert.rejects(f.open().publish(input), /author_source_required/);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("a source version change at the precommit boundary never becomes a successful publication", async t => {
  const f = await fixture(t), before = await f.git("rev-parse", "HEAD");
  f.ports.onPhase = async phase => { if (phase === "replaced") f.state.sourceVersion = bytesVersion("Changed source"); };
  await assert.rejects(f.open().publish(proposal()), /source_version_conflict/);
  assert.equal(await f.git("rev-parse", "HEAD"), before);
  await assert.rejects(f.open().readCurrent(), /memory_transaction_pending/);
});

test("source permission is independently required for replay and reads even when request qualification remains valid", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal());
  f.state.sourceAllowed = false;
  await assert.rejects(f.open().publish(proposal()), /source_denied/);
  await assert.rejects(f.open().readCurrent(), /source_denied/);
  assert.equal(await f.git("rev-parse", "HEAD"), a.commitRevision);
  assert.equal(await f.git("status", "--porcelain"), "");
});

for (const boundary of ["replaced", "committed", "before_return"] as const) {
  test(`a failure at ${boundary} reconstructs from disk without duplicate publication`, async t => {
    const f = await fixture(t), input = proposal(), baseline = await f.git("rev-parse", "HEAD");
    f.ports.onPhase = async phase => { if (phase === boundary) throw new Error("Synthetic boundary failure"); };
    await assert.rejects(f.open().publish(input), /publication_unconfirmed/);
    if (boundary === "before_return") assert.equal((await f.open().readCurrent()).document.revision.operationId, input.operationId);
    else await assert.rejects(f.open().readCurrent(), /memory_transaction_pending/);
    const priorHead = await f.git("rev-parse", "HEAD");
    assert.equal(priorHead === baseline, boundary === "replaced");
    f.ports.onPhase = undefined;
    const recovered = await f.open().publish(input);
    assert.equal(recovered.replayed, true);
    assert.equal((await f.open().readCurrent()).version, recovered.publishedVersion);
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "2");
    if (boundary !== "replaced") assert.equal(recovered.commitRevision, priorHead);
    assert.equal(await f.git("status", "--porcelain"), "");
  });
}

test("an interrupted file replacement remains fenced until the exact persisted intent is completed", async t => {
  const f = await fixture(t), input = proposal();
  const version = bytesVersion(canonicalJson(intentDocument("harbor", input)));
  const obstruction = path.join(f.root, "intent/history", `${version.slice(7)}.json`);
  f.ports.onPhase = async phase => { if (phase === "validated") await mkdir(obstruction); };
  await assert.rejects(f.open().publish(input), /unsafe_transaction_file/);
  // The first replacement happened; a raw file existing is deliberately insufficient for controlled supply.
  assert.equal(JSON.parse(await readFile(path.join(f.root, "intent/current.json"), "utf8")).revision.operationId, input.operationId);
  await assert.rejects(f.open().readCurrent(), /memory_transaction_pending/);
  await rm(obstruction, { recursive: true }); f.ports.onPhase = undefined;
  const result = await f.open().publish(input);
  assert.equal((await f.open().readCurrent()).version, result.publishedVersion);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "2");
});

test("the local commit cannot absorb unrelated staged or untracked files", async t => {
  const f = await fixture(t), baseline = await f.git("rev-parse", "HEAD");
  f.ports.onPhase = async phase => {
    if (phase === "replaced") { await writeFile(path.join(f.root, "unrelated.txt"), "Synthetic unrelated file"); await f.git("add", "unrelated.txt"); }
  };
  await assert.rejects(f.open().publish(proposal()), /asset_repository_dirty/);
  assert.equal(await f.git("rev-parse", "HEAD"), baseline);
  await assert.rejects(f.open().readCurrent(), /memory_transaction_pending/);
});

test("malformed versions, source references and injected fields cannot write", async t => {
  const f = await fixture(t);
  const bad: unknown[] = [];
  const version = proposal(); (version as unknown as Record<string, unknown>).expectedVersion = [sourceVersion]; bad.push(version);
  const confirmation = proposal(); (confirmation as unknown as Record<string, unknown>).confirmation = ["author_confirmed"]; bad.push(confirmation);
  const fields = proposal(); (fields as unknown as Record<string, unknown>).senderIsOwner = true; bad.push(fields);
  const ref = proposal(); ref.content.established[0]!.sourceIds = ["missing_source"]; bad.push(ref);
  const duplicate = proposal(); duplicate.content.sources.push(structuredClone(duplicate.content.sources[0]!)); bad.push(duplicate);
  for (const value of bad) await assert.rejects(f.open().publish(value as IntentPublication), /invalid_asset/);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("a canceled request cannot publish or use a retained repository to read", async t => {
  const f = await fixture(t), signal = AbortSignal.abort(new Error("Synthetic cancellation"));
  await assert.rejects(f.open().publish(proposal(), signal), /Synthetic cancellation/);
  await assert.rejects(f.open().readCurrent(signal), /Synthetic cancellation/);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("changed or removed current statements must be named in the revision relation", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal());
  const missingRelation = proposal("missing_relation", a.publishedVersion);
  missingRelation.content.established[0]!.text = "The appendix is no longer required";
  await assert.rejects(f.open().publish(missingRelation), /invalid_revision_relation/);
  assert.equal(await f.git("rev-parse", "HEAD"), a.commitRevision);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("a candidate cannot erase previously confirmed intent without author evidence", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal()), candidate = proposal("candidate_overwrite", a.publishedVersion);
  candidate.confirmation = "candidate"; candidate.triggerSourceId = null;
  candidate.content.originalIntent = []; candidate.content.established = [];
  await assert.rejects(f.open().publish(candidate), /author_source_required/);
  assert.equal(await f.git("rev-parse", "HEAD"), a.commitRevision);
});

test("a new request cannot supply changed-source intent as current, while authorized history stays explicitly historical", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal());
  f.state.sourceVersion = bytesVersion("The source changed after publication");
  await assert.rejects(f.open().readCurrent(), /source_version_conflict/);
  const historical = await f.open().readHistorical(a.publishedVersion);
  assert.equal(historical.position, "historical"); assert.equal(historical.version, a.publishedVersion);
});

test("missing retained material is unavailable instead of falling back to a different version", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal());
  await rm(path.join(f.root, "intent/operations/publish_A.json"));
  await assert.rejects(f.open().readCurrent(), /asset_incomplete/);
  await assert.rejects(f.open().readHistorical(a.publishedVersion), /asset_incomplete/);
});

test("a separate Node process recovers a committed-but-unacknowledged publication using only the synthetic repository", async t => {
  const f = await fixture(t), input = proposal();
  f.ports.onPhase = async phase => { if (phase === "committed") throw new Error("Synthetic lost acknowledgement"); };
  await assert.rejects(f.open().publish(input), /publication_unconfirmed/);
  const committedHead = await f.git("rev-parse", "HEAD");
  const recovered = await recoverInChild(f.root, input);
  assert.equal(recovered.result.replayed, true);
  assert.equal(recovered.result.commitRevision, committedHead);
  assert.equal(recovered.currentVersion, recovered.result.publishedVersion);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "2");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("a source-B revision validates source-A only as its qualified historical base and preserves current freshness", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal());
  await f.updateSource();
  await assert.rejects(f.open().readCurrent(), /source_version_conflict/);
  const input = f.refreshed("refresh_B", a.publishedVersion);
  const result = await f.open().publish(input), current = await f.open().readCurrent();
  assert.notEqual(result.publishedVersion, a.publishedVersion);
  assert.equal(current.version, result.publishedVersion);
  assert.equal(current.document.content.sources[0]!.version, f.state.sourceVersion);
  assert.equal(current.document.content.established[0]!.text, "Retain this outline's argument appendix with a one-page limit");
  assert.equal((await f.open().readHistorical(a.publishedVersion)).position, "historical");
  const retry = await f.open().publish(input);
  assert.equal(retry.commitRevision, result.commitRevision); assert.equal(retry.replayed, true);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "4");
  assert.equal(await f.git("remote"), ""); assert.equal(await f.git("status", "--porcelain"), "");
});

for (const scenario of ["stale_A", "B_permission", "B_author", "base_permission", "missing_history", "uncommitted_current"] as const) {
  test(`source refresh retains the ${scenario} refusal boundary`, async t => {
    const f = await fixture(t), a = await f.open().publish(proposal()); await f.updateSource();
    let beforeHead = await f.git("rev-parse", "HEAD");
    const input = f.refreshed("denied_refresh", a.publishedVersion);
    let expected = /source_version_conflict/;
    if (scenario === "stale_A") input.content.sources = proposal().content.sources;
    if (scenario === "B_permission") {
      const original = f.ports.assertSources;
      f.ports.assertSources = async (sources, action) => {
        if (sources.some(source => source.version === f.state.sourceVersion)) throw new Error("B_source_denied");
        await original(sources, action);
      }; expected = /B_source_denied/;
    }
    if (scenario === "B_author") { f.state.verified = false; expected = /author_source_required/; }
    if (scenario === "base_permission") {
      const original = f.ports.assertSources;
      f.ports.assertSources = async (sources, action) => {
        if (sources.some(source => source.version === sourceVersion)) throw new Error("base_source_denied");
        await original(sources, action);
      }; expected = /base_source_denied/;
    }
    if (scenario === "missing_history") {
      await rm(path.join(f.root, "intent/history", `${a.publishedVersion.slice(7)}.json`)); expected = /asset_not_found/;
    }
    if (scenario === "uncommitted_current") {
      // A is genuine retained history, but HEAD now publishes B. Restoring A only in
      // the working tree must not make it an authenticated current revision base.
      await f.open().publish(f.refreshed("already_committed_B", a.publishedVersion));
      beforeHead = await f.git("rev-parse", "HEAD");
      const oldBytes = await readFile(path.join(f.root, "intent/history", `${a.publishedVersion.slice(7)}.json`), "utf8");
      await writeFile(path.join(f.root, "intent/current.json"), oldBytes); expected = /asset_not_committed/;
    }
    const beforeStatus = await f.git("status", "--porcelain");
    await assert.rejects(f.open().publish(input), expected);
    assert.equal(await f.git("rev-parse", "HEAD"), beforeHead);
    assert.equal(await f.git("status", "--porcelain"), beforeStatus);
  });
}

test("a concurrent complete publication cannot be overwritten while the old source-A base is being checked", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal()); await f.updateSource();
  const input = f.refreshed("losing_refresh", a.publishedVersion), original = f.ports.assertSources;
  let competed = false, winningVersion: string | undefined;
  f.ports.assertSources = async (sources, action) => {
    await original(sources, action);
    if (!competed && action === "read_history") {
      competed = true;
      winningVersion = (await f.open().publish(f.refreshed("winning_refresh", a.publishedVersion))).publishedVersion;
    }
  };
  await assert.rejects(f.open().publish(input), /asset_version_conflict/);
  assert.equal(competed, true);
  assert.equal((await f.open().readCurrent()).version, winningVersion);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "4");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("an independent process retries an unacknowledged source-B revision without rewriting it", async t => {
  const f = await fixture(t), a = await f.open().publish(proposal()); await f.updateSource();
  const input = f.refreshed("refresh_B_lost_ack", a.publishedVersion);
  f.ports.onPhase = async phase => { if (phase === "committed") throw new Error("Synthetic refreshed acknowledgement loss"); };
  await assert.rejects(f.open().publish(input), /publication_unconfirmed/);
  const committedHead = await f.git("rev-parse", "HEAD");
  const recovered = await recoverInChild(f.root, input, f.state.sourceVersion, f.state.excerpt);
  assert.equal(recovered.result.replayed, true); assert.equal(recovered.result.commitRevision, committedHead);
  assert.equal(recovered.currentVersion, recovered.result.publishedVersion);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "4"); assert.equal(await f.git("status", "--porcelain"), "");
});
