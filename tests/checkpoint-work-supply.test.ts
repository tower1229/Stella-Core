import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { prepareCheckpointWork } from "../src/openclaw/checkpoint-source-access.js";
import { CatalogError, CatalogReader } from "../src/canghai/catalog-reader.js";
import { canonicalJson } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { fixturePurpose, ownerDirectAuthority } from "./processing-authority-fixture.js";

type WorkInput = Parameters<typeof prepareCheckpointWork>[0];
type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;
const execute = promisify(execFile);
const question = "继续这篇文章，保留已经确认、尚未采纳、被否定和未决的区别。";

/** Real local Git catalog anchor; entirely synthetic sources, grants and Host API.
 * This is not a stock Host/model transport acceptance or an automatic writer trigger.
 */
async function fixture(t: TestContext, restricted = false) {
  const memory = await personalMemoryFixture(t, restricted), root = await realpath(memory.root);
  const authority = ownerDirectAuthority({ purpose: fixturePurpose });
  const request = snapshotTurnRequest({ agentId: "stella", sessionId: authority.sessionId, sessionKey: authority.sessionKey,
    prompt: question, senderId: authority.senderId, senderIsOwner: authority.senderIsOwner, chatType: "direct" }, authority.runId);
  const bindingPath = "synthetic-personal-access.json";
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: authority.ownerId,
    requesterIds: [authority.senderId!], modelRefs: [authority.modelRef], viewProcessingModelRefs: [authority.modelRef],
    purpose: fixturePurpose, descriptors: [] };
  await writeFile(path.join(root, bindingPath), canonicalJson(grant));
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects",
    "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root, ...args],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Work Supply Test"); await git("config", "user.email", "synthetic@example.invalid");
  await git("config", "commit.gpgsign", "false");
  const groups = ["policies", "coverage", "sources", "evidence", "understandings", "changes", "works"] as const;
  await git("add", "--", "catalog.json", "payload.json", bindingPath,
    ...groups.flatMap(group => memory.catalog[group].map(entry => entry.locator.path)));
  await git("commit", "--quiet", "-m", "Synthetic selected work catalog A");
  const revision = await git("rev-parse", "HEAD"); assert.equal(await git("remote"), "");
  const baseResolver = await memory.resolver(), controller = new AbortController(), calls: LlmParams[] = [];
  const live = { agents: { entries: { stella: { model: { primary: "synthetic/model", fallbacks: [] as string[] } } } } };
  const controls: { result: Partial<LlmResult>; denySource: boolean; sourceChecks: number } = { result: {}, denySource: false, sourceChecks: 0 };
  const resolver = async () => new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), {
    ...baseResolver.purpose,
    ...(baseResolver.purpose.sourceAccess ? { sourceAccess: async (...args: Parameters<NonNullable<typeof baseResolver.purpose.sourceAccess>>) => {
      controls.sourceChecks++; if (controls.denySource) throw new CatalogError("permission_denied");
      return baseResolver.purpose.sourceAccess!(...args);
    } } : {}),
  }, baseResolver.complete);
  const api = { source: "synthetic-installed-core-plugin", runtime: { config: { current: () => live }, llm: {
    async complete(params: LlmParams): Promise<LlmResult> {
      calls.push(params);
      const content = params.messages[0]?.content; assert.equal(typeof content, "string");
      const selected = JSON.parse((content as string).split("\n").at(-1)!) as {
        requestHash: string; question: string; candidates: Array<{ handle: string; group: string }>;
      };
      assert.equal(selected.question, request.prompt, "The Host request fixes the selector question");
      assert.equal(selected.requestHash, request.requestHash);
      return { text: JSON.stringify({ requestHash: selected.requestHash,
        selections: selected.candidates.map(candidate => ({ handle: candidate.handle, view: candidate.group === "works" ? "memory" : "omit" })) }),
        provider: "synthetic", model: "model", agentId: "stella", usage: {},
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "synthetic" } },
        audit: { caller: { kind: "plugin", id: "stella-core" }, purpose: params.purpose }, ...controls.result };
    },
  } } } as unknown as OpenClawPluginApi;
  const input = async (): Promise<WorkInput> => ({ api, agentId: "stella", root, bindingPath, request, purpose: fixturePurpose,
    signal: controller.signal, assertCurrent: async () => {}, resolver: await resolver(), recoveryRevision: revision });
  const run = async (overrides: Partial<WorkInput> = {}) => prepareCheckpointWork({ ...await input(), ...overrides });
  return { memory, root, grant, bindingPath, revision, git, request, controller, calls, controls, live, resolver, input, run };
}

test("checkpoint work uses the Host request and returns selected current works without originals or other views", async t => {
  const f = await fixture(t), result = await f.run();
  assert.deepEqual(Object.keys(result).sort(), ["exclusions", "generation", "works"]);
  assert.equal(result.generation, f.memory.catalog.generationId); assert.deepEqual(result.exclusions, {});
  assert.deepEqual(result.works, [{ ref: f.memory.workRef, record: f.memory.work }]);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.reasoning, "low"); assert.equal(call.model, undefined); assert.equal(call.agentId, undefined);
  assert.equal(call.signal, f.controller.signal);
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision); assert.equal(await f.git("status", "--porcelain"), "");
});

test("missing work processing binding or view grant and wrong requester or model refuse before semantic processing", async t => {
  for (const kind of ["binding", "view-grant", "requester", "model"] as const) await t.test(kind, async t => {
    const f = await fixture(t); let overrides: Partial<WorkInput> = {};
    if (kind === "binding") overrides = { bindingPath: undefined };
    else if (kind === "view-grant") {
      const { viewProcessingModelRefs: _viewGrant, ...withoutViews } = f.grant;
      await writeFile(path.join(f.root, f.bindingPath), canonicalJson(withoutViews));
    } else if (kind === "requester") overrides = { request: snapshotTurnRequest({ ...f.request, senderId: "another-synthetic-owner" }, f.request.runId) };
    else f.live.agents.entries.stella.model.primary = "synthetic/unapproved";
    await assert.rejects(f.run(overrides), /grant|binding|requester|model/);
    assert.equal(f.calls.length, 0); assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
  });
});

test("checkpoint work rejects a fresh catalog D that is not the selected revision A before semantic processing", async t => {
  const f = await fixture(t);
  f.memory.catalog.generationId = "synthetic-unselected-work-D"; await f.memory.save();
  await f.git("add", "--", "catalog.json"); await f.git("commit", "--quiet", "-m", "Synthetic unselected work catalog D");
  const revisionD = await f.git("rev-parse", "HEAD"), catalogD = await readFile(path.join(f.root, "catalog.json"), "utf8");
  await assert.rejects(f.run(), /catalog.*mismatch|revision.*mismatch/);
  assert.equal(f.calls.length, 0); assert.notEqual(revisionD, f.revision); assert.equal(await f.git("rev-parse", "HEAD"), revisionD);
  assert.equal(await readFile(path.join(f.root, "catalog.json"), "utf8"), catalogD); assert.equal(await f.git("status", "--porcelain"), "");
});

test("pre-cancelled work supply never calls the semantic selector", async t => {
  const f = await fixture(t); f.controller.abort();
  await assert.rejects(f.run(), /abort|cancel/i); assert.equal(f.calls.length, 0);
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
});

test("a legal empty works set succeeds without inventing an ongoing work", async t => {
  const f = await fixture(t); f.memory.catalog.works = []; await f.memory.save();
  await f.git("add", "--", "catalog.json"); await f.git("commit", "--quiet", "-m", "Synthetic catalog with no current work");
  const revision = await f.git("rev-parse", "HEAD"), result = await f.run({ recoveryRevision: revision });
  assert.deepEqual(result.works, []); assert.deepEqual(result.exclusions, {});
  assert.equal(result.generation, f.memory.catalog.generationId); assert.equal(await f.git("status", "--porcelain"), "");
});

test("a missing catalog-declared work file is a technical failure rather than an empty successful result", async t => {
  const f = await fixture(t), entry = f.memory.catalog.works[0]!;
  await rm(path.join(f.root, entry.locator.path));
  await assert.rejects(f.run(), /object_unavailable/); assert.equal(f.calls.length, 0);
});

test("selected v3 work retains its interpretation and quote constraints without returning original evidence", async t => {
  const f = await fixture(t, true), result = await f.run(), policy = f.memory.catalog.policies[0]!;
  assert.deepEqual(Object.keys(result).sort(), ["exclusions", "generation", "usageConstraints", "works"]);
  assert.deepEqual(result.works, [{ ref: f.memory.workRef, record: f.memory.work }]);
  assert.deepEqual(result.usageConstraints, [{ work: f.memory.workRef, policies: [{
    policyRef: { id: policy.id, version: policy.version },
    rules: [{ id: "preserve_author_intent", requirement: "Preserve the owner's unresolved question, not an uplifting ending." }],
    quotePolicy: "summarize_only",
  }] }]);
  for (const object of [result, ...result.works]) for (const field of ["originals", "text", "context", "understandings"]) {
    assert.equal(Object.hasOwn(object, field), false);
  }
  const original = JSON.parse(await readFile(path.join(f.root, "payload.json"), "utf8")).report;
  assert.ok(!JSON.stringify(result).includes(original), "The raw original is not a work-tool result field");
  assert.equal(f.calls.length, 1); assert.ok(f.controls.sourceChecks > 0);
});

test("work preparation reuses the resolver SourceAccess refusal and does not expose denied candidates", async t => {
  const f = await fixture(t, true); f.controls.denySource = true;
  const result = await f.run();
  assert.ok(f.controls.sourceChecks > 0); assert.equal(f.calls.length, 0); assert.deepEqual(result.works, []);
  assert.ok((result.exclusions.permission_denied ?? 0) > 0);
  assert.equal(Object.hasOwn(result, "usageConstraints"), false);
});

test("a mismatched actual Host model result cannot become a supplied work", async t => {
  const f = await fixture(t); f.controls.result = { model: "different-synthetic-model" };
  await assert.rejects(f.run(), /model/); assert.equal(f.calls.length, 1);
  assert.equal(await f.git("rev-parse", "HEAD"), f.revision); assert.equal(await f.git("status", "--porcelain"), "");
});
