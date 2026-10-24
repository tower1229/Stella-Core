import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { correctCheckpointRequest } from "../src/openclaw/checkpoint-agent-correction.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import type { CheckpointRequestArchiveReceipt } from "../src/openclaw/checkpoint-request-ingress.js";
import { archiveCorrectionInput } from "../src/learning/host-correction.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { HOST_REQUEST_ARCHIVE_ADAPTER } from "../src/canghai/host-request-archive.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "../src/canghai/host-input-archive.js";
import { createCheckpointWorkSource, WORK_CORRECTION, WORK_GOAL_B, WORK_MODEL } from "./checkpoint-work-fixture.js";

type Input = Parameters<typeof correctCheckpointRequest>[0];
type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;
const execute = promisify(execFile);
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];

/** Actual local archive/checkpoint/correction writers, fake public Host LLM only.
 * The new v1 policy governs owner ingress; existing Work/source v3 policy stays intact. */
async function fixture(t: TestContext) {
  const source = await createCheckpointWorkSource(), root = source.root;
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "stella-agent-correction-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const state = path.join(parent, "authority"); await mkdir(state, { mode: 0o700 });
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root, ...args], { timeout: 15_000 })).stdout.trim();
  const catalog = JSON.parse(await readFile(path.join(root, source.catalogPath), "utf8"));
  const policy = { schemaVersion: "stella.source-policy/v1", id: "synthetic-correction-owner-input-policy", ownerId: "owner-fixture",
    readPurposes: [source.binding.purpose.readPurpose], derivePurposes: [source.binding.purpose.derivePurpose], deliveryScopes: [source.binding.purpose.deliveryScope], retention: "retain", authorityEvidenceRefs: [] };
  const policyRef = { id: policy.id, version: objectVersion(policy) }, policyPath = "synthetic-owner-input-policy.json", policyBytes = canonicalJson(policy);
  await writeFile(path.join(root, policyPath), policyBytes);
  catalog.policies.push({ ...policyRef, status: "current", dependencies: [], locator: { path: policyPath, sha256: bytesVersion(policyBytes) } });
  const archive = { ...source.binding.archive, policyRef }, bindingPath = "50_PersonalAgent/stella/praxis-binding.json";
  await writeFile(path.join(root, bindingPath), canonicalJson({ ...source.binding, archive }));
  await writeFile(path.join(root, source.catalogPath), canonicalJson(catalog));
  await git("add", "--", policyPath, source.catalogPath, bindingPath); await git("commit", "--quiet", "-m", "[synthetic] independent v1 owner ingress policy");
  const initialRevision = await git("rev-parse", "HEAD"); assert.equal(await git("remote"), "");
  const config = parseCheckpointPluginConfig({ recoveryAuthority: "core_checkpoint", checkpointStateDirectory: state, canghaiRoot: root,
    agentId: "synthetic", dataMode: "local_write", agentMemory: "fresh_tools", requestArchive: "local", agentCorrection: "tool" });
  const runtime = await createCheckpointPluginRuntime(config, "2026.8.2"); t.after(() => runtime.close());
  await runtime.initializeAuthority({ revision: initialRevision, operationId: "synthetic-agent-correction-init" });
  const controller = new AbortController(), capturedAt = "2026-10-24T00:00:00Z";
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-current-correction-session", sessionKey: "agent:synthetic:current-correction",
    senderId: "cli", senderIsOwner: true, chatType: "direct", prompt: WORK_CORRECTION }, "synthetic-current-correction-run");
  const purpose = { ...source.binding.purpose, evidenceCutoff: capturedAt,
    trustedAdapters: { user_report: [HOST_REQUEST_ARCHIVE_ADAPTER, HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] } };
  const before = await runtime.capture(), retained = await archiveCorrectionInput({ request, original: { schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt },
    ownerId: "owner-fixture", archive, reader: await CatalogReader.load(root, source.catalogPath), purpose,
    signal: controller.signal, assertCurrent: async () => {}, checkpoint: { runtime, recovery: before,
      assertPublication: accepted => runtime.assert({ resolver: before.resolver, expected: accepted }) } });
  assert.ok(retained.recovery);
  const receipt: CheckpointRequestArchiveReceipt = { recovery: retained.recovery, evidenceRefs: retained.evidenceRefs,
    sourceRefs: retained.sourceRefs, capturedAt, requestHash: request.requestHash, runId: request.runId };
  const calls: LlmParams[] = [], live = { agents: { entries: { synthetic: { model: { primary: WORK_MODEL, fallbacks: [] as string[] } } } } };
  const control: { result: Partial<LlmResult>; oldSourceChecks: number } = { result: {}, oldSourceChecks: 0 };
  const api = { source: "synthetic-agent-correction-plugin", runtime: { config: { current: () => live }, llm: {
    async complete(params: LlmParams): Promise<LlmResult> {
      calls.push(params); const text = params.messages[0]!.content; assert.equal(typeof text, "string");
      const data = JSON.parse((text as string).split("\n").at(-1)!); let value: unknown;
      if (params.purpose === "stella-source-access") {
        assert.ok(!(text as string).includes("SYNTHETIC_ALLOWED_MEMORY_4931"));
        value = { requestHash: data.requestHash, sourceRef: data.sourceRef, policyRef: data.policyRef,
          applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
          ruleChecks: data.accessRules.map((rule: { id: string }) => ({ id: rule.id, satisfied: true })) };
      } else {
        assert.equal(params.purpose, "stella-correction");
        if (data.bindingHash) value = { bindingHash: data.bindingHash, checks: data.data.requirements.map((requirement: { handle: string }) => ({ handle: requirement.handle, satisfied: true })) };
        else if (data.proposalHash) value = { requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true };
        else {
          assert.equal(data.request, request.prompt); const work = data.candidates.find((candidate: { group: string }) => candidate.group === "works"); assert.ok(work);
          value = { requestHash: data.requestHash, disposition: "update", clarification: null, rationale: "Synthetic correction preserves all authorial distinctions.",
            reviewedHandles: data.candidates.map((candidate: { handle: string }) => candidate.handle),
            replacements: [{ handle: work.handle, group: "works", record: { ...Object.fromEntries(editable.map(key => [key, work.record[key]])), goal: WORK_GOAL_B } }] };
        }
      }
      return { text: JSON.stringify(value), provider: "google", model: "gemini-3.8-flash", agentId: "synthetic", usage: {},
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "google" } },
        audit: { caller: { kind: "plugin", id: "stella-core" }, purpose: params.purpose }, ...control.result };
    },
  } } } as unknown as OpenClawPluginApi;
  const resolver = () => CatalogReader.load(root, source.catalogPath).then(reader => new EpisodeEvidenceResolver(reader, { ...purpose,
    sourceAccess: async () => { control.oldSourceChecks++; await runtime.assert(receipt.recovery); throw new Error("The old B-bound SourceAccess must not be reused"); } },
    async () => { throw new Error("The old completion must not be reused"); }));
  const input = async (): Promise<Input> => ({ api, runtime, recovery: receipt.recovery, resolver: await resolver(), bindingPath: source.grantPath,
    objectRoot: archive.objectRoot, request, archive: receipt, signal: controller.signal, assertCurrent: async () => {} });
  return { source, root, runtime, receipt, calls, controller, control, live, git, resolver, input, run: async (overrides: Partial<Input> = {}) => correctCheckpointRequest({ ...await input(), ...overrides }) };
}

test("archived owner correction uses the pinned public Host model and commits one C without an old B publication closure", async t => {
  const f = await fixture(t), before = (await f.runtime.capture()).expected, result = await f.run();
  assert.equal(result.persistenceStatus, "local_committed"); assert.equal(result.disposition, "update"); assert.equal(result.clarification, null);
  assert.notEqual(result.authority.revision, before.revision); assert.notEqual(result.authority.token, before.token);
  assert.deepEqual((await f.runtime.capture()).expected, result.authority); assert.equal(await f.git("rev-list", "--count", `${before.revision}..HEAD`), "1");
  assert.equal(f.control.oldSourceChecks, 0); assert.ok(f.calls.some(call => call.purpose === "stella-correction"));
  assert.ok(f.calls.some(call => call.purpose === "stella-source-access"));
  for (const call of f.calls) { assert.equal(call.reasoning, "low"); assert.equal(call.model, undefined); assert.equal(call.agentId, undefined); assert.equal(call.signal, f.controller.signal); }
  const reader = await CatalogReader.load(f.root, f.source.catalogPath), ref = reader.currentRef(f.source.workRef.id, "works"), work = await reader.read(ref, "works");
  assert.equal(work.goal, WORK_GOAL_B); assert.equal(work.updatedAt, f.receipt.capturedAt);
  for (const key of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"] as const) assert.deepEqual(work[key], f.source.workRecord[key]);
  const change = await reader.read(result.changeRef, "changes"); assert.deepEqual(change.inputRefs, f.receipt.evidenceRefs);
  const calls = f.calls.length; await assert.rejects(f.run(), /stale/); assert.equal(f.calls.length, calls);
  assert.equal(await f.git("rev-parse", "HEAD"), result.authority.revision); assert.equal(await f.git("status", "--porcelain"), "");
});

test("missing or mismatched internal request archive receipts refuse before model access or mutation", async t => {
  for (const kind of ["missing", "run", "hash", "time", "recovery"] as const) await t.test(kind, async t => {
    const f = await fixture(t), expected = (await f.runtime.capture()).expected;
    const archive = kind === "missing" ? undefined : { ...f.receipt, ...(kind === "run" ? { runId: "another-run" } : {}),
      ...(kind === "hash" ? { requestHash: bytesVersion("another request") } : {}), ...(kind === "time" ? { capturedAt: "2026-10-23T00:00:00Z" } : {}),
      ...(kind === "recovery" ? { recovery: { ...f.receipt.recovery, expected: { ...expected, token: "not-the-archive-tuple" } } } : {}) };
    await assert.rejects(f.run({ archive: archive as Input["archive"] }), /archive_receipt/);
    assert.equal(f.calls.length, 0); assert.deepEqual((await f.runtime.capture()).expected, expected); assert.equal(await f.git("rev-parse", "HEAD"), expected.revision);
  });
});

test("missing view authorization, wrong model, pre-cancellation and non-granted learning purpose cannot write", async t => {
  for (const kind of ["grant", "model", "cancel", "purpose"] as const) await t.test(kind, async t => {
    const f = await fixture(t), expected = (await f.runtime.capture()).expected; let overrides: Partial<Input> = {};
    if (kind === "grant") overrides = { bindingPath: undefined };
    else if (kind === "model") f.live.agents.entries.synthetic.model.primary = "google/unapproved";
    else if (kind === "cancel") f.controller.abort();
    else { const original = await f.resolver(); overrides = { resolver: new EpisodeEvidenceResolver(original.reader, { ...original.purpose, derivePurpose: "not-granted-learning" }, original.complete) }; }
    await assert.rejects(f.run(overrides), /grant|model|abort|cancel|purpose/i);
    assert.equal(f.calls.length, 0); assert.deepEqual((await f.runtime.capture()).expected, expected); assert.equal(await f.git("rev-parse", "HEAD"), expected.revision);
  });
});

test("a different actual Host model result cannot publish a correction", async t => {
  const f = await fixture(t), expected = (await f.runtime.capture()).expected; f.control.result = { model: "another-model" };
  await assert.rejects(f.run(), /model/); assert.ok(f.calls.length > 0);
  assert.deepEqual((await f.runtime.capture()).expected, expected); assert.equal(await f.git("rev-parse", "HEAD"), expected.revision);
});
