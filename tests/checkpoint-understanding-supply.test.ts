import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createCheckpointSourceAccess, prepareCheckpointUnderstanding } from "../src/openclaw/checkpoint-source-access.js";
import { CatalogError, CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { canonicalJson } from "../src/canghai/content-version.js";
import type { PersonalContextAccess } from "../src/canghai/personal-context-access.js";
import type { SourceAccessProvider } from "../src/canghai/source-access.js";
import { HOST_REQUEST_ARCHIVE_ADAPTER } from "../src/canghai/host-request-archive.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "../src/canghai/host-input-archive.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { SUPPLY_MARKER } from "./checkpoint-agent-supply-fixture.js";
import { createCheckpointUnderstandingSource, UNDERSTANDING_IDS, UNDERSTANDING_MODEL,
  UNDERSTANDING_STATEMENT_A, UNDERSTANDING_HYPOTHESIS, UNDERSTANDING_QUESTIONS } from "./checkpoint-understanding-fixture.js";

type Input = Parameters<typeof prepareCheckpointUnderstanding>[0];
type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;
const execute = promisify(execFile);

/** Genuine local catalog, grant and SourceAccess; only public Host LLM replies
 * are synthetic. No Host transport or real-model quality claim is made here. */
async function fixture(t: TestContext) {
  const source = await createCheckpointUnderstandingSource(), root = source.root;
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = JSON.parse(await readFile(path.join(root, source.catalogPath), "utf8")) as MemoryCatalog;
  const grant = JSON.parse(await readFile(path.join(root, source.grantPath), "utf8")) as PersonalContextAccess;
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects",
    "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root, ...args], { timeout: 15_000 })).stdout.trim();
  assert.equal(await git("remote"), "");
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-understanding-unit-session",
    sessionKey: "agent:synthetic:understanding-unit", senderId: "cli", senderIsOwner: true,
    chatType: "direct", prompt: UNDERSTANDING_QUESTIONS[0] }, "synthetic-understanding-unit-run");
  const controller = new AbortController(), calls: LlmParams[] = [];
  const live = { agents: { entries: { synthetic: { model: { primary: UNDERSTANDING_MODEL, fallbacks: [] as string[] } } } } };
  const controls: { result: Partial<LlmResult>; promoteHypothesis: boolean; denySource: boolean; sourceChecks: number } = {
    result: {}, promoteHypothesis: false, denySource: false, sourceChecks: 0,
  };
  const api = { source: "synthetic-installed-understanding-plugin", runtime: { config: { current: () => live }, llm: {
    async complete(params: LlmParams): Promise<LlmResult> {
      calls.push(params); const content = params.messages[0]?.content; assert.equal(typeof content, "string");
      const data = JSON.parse((content as string).split("\n").at(-1)!); let value: unknown;
      if (params.purpose === "stella-source-access") {
        assert.ok(!(content as string).includes(SUPPLY_MARKER), "Source judgment receives reviewed metadata, not original text");
        value = { requestHash: data.requestHash, sourceRef: data.sourceRef, policyRef: data.policyRef,
          applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
          ruleChecks: data.accessRules.map((rule: { id: string }) => ({ id: rule.id, satisfied: true })) };
      } else {
        assert.equal(params.purpose, "stella-personal-views");
        assert.equal(data.question, request.prompt, "The original Host request fixes the semantic question");
        assert.equal(data.requestHash, request.requestHash);
        value = { requestHash: data.requestHash, selections: data.candidates.map((candidate: { handle: string; ref: { id: string } }) => ({
          handle: candidate.handle, view: candidate.ref.id === UNDERSTANDING_IDS.owner || controls.promoteHypothesis ? "user" : "memory",
        })) };
      }
      return { text: JSON.stringify(value), provider: "google", model: "gemini-3.8-flash", agentId: "synthetic", usage: {},
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "google" } },
        audit: { caller: { kind: "plugin", id: "stella-core" }, purpose: params.purpose },
        ...(params.purpose === "stella-personal-views" ? controls.result : {}) };
    },
  } } } as unknown as OpenClawPluginApi;
  const input = async (): Promise<Input> => {
    const common = { api, agentId: "synthetic", root, bindingPath: source.grantPath, request,
      purpose: source.binding.purpose, signal: controller.signal, assertCurrent: async () => {} };
    const access = await createCheckpointSourceAccess(common); assert.ok(access);
    const sourceAccess: SourceAccessProvider = async (...args) => {
      controls.sourceChecks++; if (controls.denySource) throw new CatalogError("permission_denied");
      return access(...args);
    };
    const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, source.catalogPath), {
      ...source.binding.purpose, evidenceCutoff: "2026-10-24T00:00:00Z", signal: controller.signal, sourceAccess,
      trustedAdapters: { user_report: [HOST_REQUEST_ARCHIVE_ADAPTER, HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] },
    }, async () => { throw new Error("Understanding supply must not infer an action or write a record"); });
    return { ...common, resolver, recoveryRevision: source.revision };
  };
  const run = async (overrides: Partial<Input> = {}) => prepareCheckpointUnderstanding({ ...await input(), ...overrides });
  const saveCatalog = async () => {
    await writeFile(path.join(root, source.catalogPath), canonicalJson(catalog));
    await git("add", "--", source.catalogPath); await git("commit", "--quiet", "-m", "[synthetic] change current understanding catalog");
    return git("rev-parse", "HEAD");
  };
  const selectorCalls = () => calls.filter(call => call.purpose === "stella-personal-views");
  return { source, root, catalog, grant, request, controller, calls, controls, live, git, input, run, saveCatalog, selectorCalls };
}

test("checkpoint understanding preserves USER owner facts and scoped MEMORY hypotheses with v3 usage constraints", async t => {
  const f = await fixture(t), result = await f.run();
  assert.deepEqual(Object.keys(result).sort(), ["exclusions", "generation", "understandings", "usageConstraints"]);
  assert.equal(result.generation, f.catalog.generationId); assert.deepEqual(result.exclusions, {});
  assert.deepEqual(result.understandings, [
    { view: "user", ref: f.source.understandingRefs.owner, record: f.source.records.owner },
    { view: "memory", ref: f.source.understandingRefs.hypothesis, record: f.source.records.hypothesis },
  ]);
  assert.equal(result.understandings[0]!.record.statement, UNDERSTANDING_STATEMENT_A);
  assert.equal(result.understandings[1]!.record.statement, UNDERSTANDING_HYPOTHESIS);
  assert.equal(result.understandings[1]!.record.status, "candidate");
  assert.deepEqual(result.understandings[1]!.record.scope, { workIds: [], contexts: ["synthetic-writing-project"], domains: ["writing"], global: false });
  const policies = [{ policyRef: f.source.originalPolicyRef,
    rules: [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }], quotePolicy: "summarize_only" }];
  assert.deepEqual(result.usageConstraints, [
    { understanding: f.source.understandingRefs.owner, view: "user", policies },
    { understanding: f.source.understandingRefs.hypothesis, view: "memory", policies },
  ]);
  for (const object of [result, ...result.understandings]) for (const field of ["originals", "text", "context", "works"]) {
    assert.equal(Object.hasOwn(object, field), false);
  }
  assert.ok(!JSON.stringify(result).includes(SUPPLY_MARKER));
  assert.equal(f.selectorCalls().length, 1); assert.ok(f.controls.sourceChecks > 0);
  for (const call of f.calls) {
    assert.equal(call.reasoning, "low"); assert.equal(call.agentId, undefined); assert.equal(call.model, undefined);
    assert.equal(call.signal, f.controller.signal);
  }
  assert.equal(await f.git("rev-parse", "HEAD"), f.source.revision); assert.equal(await f.git("status", "--porcelain"), "");
});

test("missing understanding binding or view grant and unapproved requester or model refuse before semantic processing", async t => {
  for (const kind of ["binding", "view-grant", "requester", "model"] as const) await t.test(kind, async t => {
    const f = await fixture(t); let overrides: Partial<Input> = {};
    if (kind === "binding") overrides = { bindingPath: undefined };
    else if (kind === "view-grant") {
      const { viewProcessingModelRefs: _views, ...withoutViews } = f.grant;
      await writeFile(path.join(f.root, f.source.grantPath), canonicalJson(withoutViews));
    } else if (kind === "requester") overrides = { request: snapshotTurnRequest({ ...f.request, senderId: "another-synthetic-owner" }, f.request.runId) };
    else f.live.agents.entries.synthetic.model.primary = "google/unapproved";
    await assert.rejects(f.run(overrides), /grant|binding|requester|model/);
    assert.equal(f.calls.length, 0); assert.equal(await f.git("rev-parse", "HEAD"), f.source.revision);
  });
});

test("understanding supply rejects a catalog D not selected by checkpoint A before calling any model", async t => {
  const f = await fixture(t); f.catalog.generationId = "synthetic-unselected-understanding-D";
  const revisionD = await f.saveCatalog(), bytesD = await readFile(path.join(f.root, f.source.catalogPath), "utf8");
  await assert.rejects(f.run(), /understanding_checkpoint_catalog_mismatch/); assert.equal(f.calls.length, 0);
  assert.notEqual(revisionD, f.source.revision); assert.equal(await f.git("rev-parse", "HEAD"), revisionD);
  assert.equal(await readFile(path.join(f.root, f.source.catalogPath), "utf8"), bytesD); assert.equal(await f.git("status", "--porcelain"), "");
});

test("pre-cancelled understanding supply never calls a model", async t => {
  const f = await fixture(t); f.controller.abort();
  await assert.rejects(f.run(), /abort|cancel/i); assert.equal(f.calls.length, 0);
  assert.equal(await f.git("rev-parse", "HEAD"), f.source.revision);
});

test("a legitimate empty understanding set succeeds without inventing an owner statement", async t => {
  const f = await fixture(t); f.catalog.understandings = []; f.catalog.changes = [];
  const revision = await f.saveCatalog(), result = await f.run({ recoveryRevision: revision });
  assert.deepEqual(result.understandings, []); assert.deepEqual(result.exclusions, {});
  assert.equal(Object.hasOwn(result, "usageConstraints"), false); assert.equal(result.generation, f.catalog.generationId);
  assert.equal(f.calls.length, 0); assert.equal(await f.git("status", "--porcelain"), "");
});

test("a missing catalog-declared understanding file is a technical failure, not a legitimate empty view", async t => {
  const f = await fixture(t), entry = f.catalog.understandings[0]!;
  await rm(path.join(f.root, entry.locator.path));
  await assert.rejects(f.run(), /object_unavailable/); assert.equal(f.calls.length, 0);
});

test("understanding supply respects the resolver SourceAccess refusal without returning source text or constraints", async t => {
  const f = await fixture(t); f.controls.denySource = true;
  const result = await f.run();
  assert.deepEqual(result.understandings, []); assert.ok((result.exclusions.permission_denied ?? 0) > 0);
  assert.equal(Object.hasOwn(result, "usageConstraints"), false); assert.equal(f.calls.length, 0);
  assert.ok(f.controls.sourceChecks > 0); assert.ok(!JSON.stringify(result).includes(SUPPLY_MARKER));
});

test("a mismatched actual Host selector model cannot supply an understanding", async t => {
  const f = await fixture(t); f.controls.result = { model: "another-model" };
  await assert.rejects(f.run(), /model/); assert.equal(f.selectorCalls().length, 1);
  assert.equal(await f.git("rev-parse", "HEAD"), f.source.revision); assert.equal(await f.git("status", "--porcelain"), "");
});

test("a semantic selector cannot promote an unaccepted candidate hypothesis into USER", async t => {
  const f = await fixture(t); f.controls.promoteHypothesis = true;
  await assert.rejects(f.run(), /personal_view_owner_support_required/); assert.equal(f.selectorCalls().length, 1);
  assert.equal(await f.git("rev-parse", "HEAD"), f.source.revision); assert.equal(await f.git("status", "--porcelain"), "");
});
