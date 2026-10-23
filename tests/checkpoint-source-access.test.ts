import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createCheckpointSourceAccess } from "../src/openclaw/checkpoint-source-access.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";

// These records and grants are entirely synthetic. No Host, API, real source,
// checkpoint state or model is contacted by this fixture.
const purpose = { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "owner-direct" };
const prompt = "Summarize the specific synthetic writing event I am asking about.";
const original = "SYNTHETIC_ORIGINAL_NOT_METADATA_8372";
type Options = Parameters<typeof createCheckpointSourceAccess>[0];
type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-checkpoint-source-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "synthetic-generation-one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  const put = async (group: "sources" | "policies", object: Record<string, unknown>) => {
    const ref = { id: String(object.id), version: objectVersion(object) }, relative = `${ref.id}.json`, bytes = canonicalJson(object);
    await writeFile(path.join(root, relative), bytes);
    catalog[group].push({ ...ref, status: "current", dependencies: [], locator: { path: relative, sha256: bytesVersion(bytes) } });
    return ref;
  };
  const policy = { schemaVersion: "stella.source-policy/v3", id: "synthetic-policy", ownerId: "synthetic-owner",
    readPurposes: [purpose.readPurpose], derivePurposes: [purpose.derivePurpose], deliveryScopes: [purpose.deliveryScope],
    retention: "retain", authorityEvidenceRefs: [], restrictions: { sensitivity: "sensitive", quotePolicy: "summarize_only",
      allowedScenarios: ["writing"], forbiddenScenarios: ["public_profile"] },
    usageRules: { access: [{ id: "exact_topic", requirement: "Use only for the exact synthetic topic requested by the owner." }],
      interpretation: [{ id: "preserve_uncertainty", requirement: "Preserve uncertainty in this synthetic account." }] } };
  const policyRef = await put("policies", policy);
  await writeFile(path.join(root, "original.txt"), original);
  const sourceRef = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "synthetic-source", policyRef,
    payloads: [{ path: "original.txt", mediaType: "text/plain", bytes: Buffer.byteLength(original), sha256: bytesVersion(original) }] });
  const target = { sourceRef, policyRef };
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: "synthetic-owner", requesterIds: ["synthetic-owner"],
    modelRefs: ["synthetic/model"], purpose, descriptors: [{ ...target, description: "Reviewed metadata for one synthetic writing event; no original text." }] };
  await writeFile(path.join(root, "access.json"), JSON.stringify(grant));
  await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  const reader = await CatalogReader.load(root, "catalog.json");
  let payloadReads = 0;
  reader.readPayload = async () => { payloadReads++; throw new Error("Policy evaluation must not read original payloads"); };
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-session", sessionKey: "agent:synthetic:test",
    prompt, senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-run");
  const live: { agents: { entries: Record<string, { model: { primary: string; fallbacks: string[] } }> } } = {
    agents: { entries: { synthetic: { model: { primary: "synthetic/model", fallbacks: [] } } } },
  };
  const controller = new AbortController(), calls: LlmParams[] = [];
  const controls: { verdict: Record<string, unknown>; result: Partial<LlmResult>; onAssert?: () => Promise<void>; onModel?: () => Promise<void>; assertions: number } = {
    verdict: {}, result: {}, assertions: 0,
  };
  const api = { runtime: { config: { current: () => live }, llm: { async complete(params: LlmParams): Promise<LlmResult> {
    calls.push(params);
    assert.doesNotMatch(JSON.stringify(params), /SYNTHETIC_ORIGINAL_NOT_METADATA_8372/);
    await controls.onModel?.();
    return { text: JSON.stringify({ requestHash: request.requestHash, ...target, applicable: true, scenarios: ["writing"],
      topicRequested: true, topicExplicitlyNamed: true, ruleChecks: [{ id: "exact_topic", satisfied: true }], ...controls.verdict }),
      provider: "synthetic", model: "model", agentId: "synthetic", usage: {},
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "synthetic" } },
      audit: { caller: { kind: "plugin", id: "stella-core" }, purpose: "stella-source-access" }, ...controls.result };
  } } } } as unknown as OpenClawPluginApi;
  const create = (overrides: Partial<Options> = {}) => createCheckpointSourceAccess({ api, agentId: "synthetic", root, bindingPath: "access.json",
    request, purpose, signal: controller.signal, async assertCurrent() { controls.assertions++; await controls.onAssert?.(); }, ...overrides });
  const access = async (overrides: Partial<Options> = {}) => { const value = await create(overrides); assert.ok(value); return value; };
  return { root, catalog, policy, reader, target, grant, request, controller, live, calls, controls, create, access, payloadReads: () => payloadReads };
}

test("checkpoint source access remains absent without an explicit metadata processing binding", async t => {
  const f = await fixture(t);
  assert.equal(await f.create({ bindingPath: undefined }), undefined);
  assert.equal(f.calls.length, 0);
});

test("v3 summary and complete source-specific rule checks use the public pinned Host model port", async t => {
  const f = await fixture(t), access = await f.access(), context = await access(f.reader, f.target, purpose);
  assert.equal(context.judgment.presentation, "summary");
  assert.equal(context.judgment.trigger, "user_requested");
  assert.deepEqual(context.quoteGrants, []);
  assert.deepEqual(context.ruleChecks, { policyRef: f.target.policyRef, checks: [{ id: "exact_topic", satisfied: true }] });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.agentId, "synthetic");
  assert.equal(call.model, "synthetic/model");
  assert.equal(call.reasoning, "low");
  assert.equal(call.purpose, "stella-source-access");
  assert.equal(call.signal, f.controller.signal);
  assert.match(JSON.stringify(call.messages), /Reviewed metadata for one synthetic writing event/);
  assert.match(JSON.stringify(call.messages), /exact synthetic topic/);
  assert.equal(f.payloadReads(), 0);
});

test("v3 business refusals remain refusals rather than a generic v1 restriction or successful grant", async t => {
  for (const [verdict, reason] of [
    [{ ruleChecks: [{ id: "exact_topic", satisfied: false }] }, /source_rule_forbidden/],
    [{ scenarios: ["public_profile"] }, /source_scenario_forbidden/],
  ] as const) {
    const f = await fixture(t); f.controls.verdict = verdict;
    const access = await f.access();
    await assert.rejects(access(f.reader, f.target, purpose), reason);
    assert.equal(f.calls.length, 1);
    assert.equal(f.payloadReads(), 0);
  }
});

test("non-owner, group and unapproved requester facts cannot obtain a metadata model call", async t => {
  for (const patch of [{ senderIsOwner: false }, { chatType: "group" as const }, { senderId: "synthetic-other" }]) {
    const f = await fixture(t);
    await assert.rejects(async () => { const access = await f.access({ request: { ...f.request, ...patch } }); await access(f.reader, f.target, purpose); },
      /personal_context_requester_forbidden|private_context_audience_forbidden/);
    assert.equal(f.calls.length, 0);
  }
});

test("the exact processing model and purpose are required before descriptor disclosure", async t => {
  for (const mismatch of ["model", "purpose"] as const) {
    const f = await fixture(t);
    if (mismatch === "model") f.live.agents.entries.synthetic!.model.primary = "synthetic/other-model";
    const selectedPurpose = mismatch === "purpose" ? { ...purpose, deliveryScope: "public" } : purpose;
    await assert.rejects(async () => { const access = await f.access({ purpose: selectedPurpose }); await access(f.reader, f.target, selectedPurpose); }, /model|purpose/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.payloadReads(), 0);
  }
});

test("a configured fallback cannot silently send processing metadata to another model", async t => {
  const f = await fixture(t); f.live.agents.entries.synthetic!.model.fallbacks = ["synthetic/fallback"];
  await assert.rejects(async () => { const access = await f.access(); await access(f.reader, f.target, purpose); }, /fallback/);
  assert.equal(f.calls.length, 0);
});

test("a missing reviewed descriptor fails before a model or original payload is read", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "access.json"), JSON.stringify({ ...f.grant, descriptors: [] }));
  const access = await f.access();
  await assert.rejects(access(f.reader, f.target, purpose), /source_access_descriptor_unavailable|personal_context_descriptor_required/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.payloadReads(), 0);
});

test("wrong model, agent or execution ownership in the Host result cannot mint a verdict", async t => {
  const mismatches: Partial<LlmResult>[] = [
    { model: "other-model" }, { agentId: "another-agent" },
    { execution: { mode: "isolated-agent-runtime", owner: { kind: "cli", id: "synthetic-cli" } } },
  ];
  for (const result of mismatches) {
    const f = await fixture(t); f.controls.result = result;
    const access = await f.access();
    await assert.rejects(access(f.reader, f.target, purpose), /source_access_model_failed|model|execution|agent/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.payloadReads(), 0);
  }
});

test("an asynchronous current-request rejection is awaited before the model port", async t => {
  const f = await fixture(t);
  f.controls.onAssert = async () => { await new Promise<void>(resolve => setImmediate(resolve)); throw new Error("synthetic_generation_changed"); };
  await assert.rejects(async () => { const access = await f.access(); await access(f.reader, f.target, purpose); }, /synthetic_generation_changed/);
  assert.ok(f.controls.assertions > 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.payloadReads(), 0);
});

test("cancellation before or during the synthetic judgment never authorizes original reads", async t => {
  for (const when of ["before", "during"] as const) {
    const f = await fixture(t);
    if (when === "before") f.controller.abort(); else f.controls.onModel = async () => { f.controller.abort(); };
    await assert.rejects(async () => { const access = await f.access(); await access(f.reader, f.target, purpose); }, /cancel|abort/i);
    assert.equal(f.calls.length, when === "before" ? 0 : 1);
    assert.equal(f.payloadReads(), 0);
  }
});

test("one request reuses an exact successful target but never a changed processing grant", async t => {
  const f = await fixture(t), access = await f.access();
  const first = await access(f.reader, f.target, purpose);
  first.ruleChecks!.checks[0]!.satisfied = false;
  const second = await access(f.reader, f.target, purpose);
  assert.equal(second.ruleChecks!.checks[0]!.satisfied, true);
  assert.equal(f.calls.length, 1);
  await writeFile(path.join(f.root, "access.json"), JSON.stringify({ ...f.grant, descriptors: [] }));
  await assert.rejects(access(f.reader, f.target, purpose), /personal_context_access_changed/);
  assert.equal(f.calls.length, 1);
});

test("cached success cannot bypass a new catalog generation or changed policy bytes", async t => {
  for (const mutation of ["catalog", "policy"] as const) {
    const f = await fixture(t), access = await f.access();
    await access(f.reader, f.target, purpose);
    if (mutation === "catalog") await writeFile(path.join(f.root, "catalog.json"), canonicalJson({ ...f.catalog, generationId: "synthetic-generation-two" }));
    else {
      const file = path.join(f.root, "synthetic-policy.json"), value = JSON.parse(await readFile(file, "utf8"));
      value.usageRules.access[0].requirement = "Changed synthetic rule, not the approved version.";
      await writeFile(file, canonicalJson(value));
    }
    await assert.rejects(access(f.reader, f.target, purpose), /stale_generation|locator_digest_mismatch/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.payloadReads(), 0);
  }
});
