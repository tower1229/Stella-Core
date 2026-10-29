import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { registerCheckpointPlugin } from "../src/openclaw/checkpoint-plugin-registration.js";
import { parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { CHECKPOINT_CORRECTION_TOOL, CHECKPOINT_MEMORY_TOOL } from "../src/openclaw/checkpoint-agent-supply.js";
import { CatalogReader, validMemoryRef } from "../src/canghai/catalog-reader.js";
import { applyMemoryTransaction } from "../src/canghai/memory-transaction.js";
import { openLocalCheckpointRecovery } from "../src/canghai/local-checkpoint-recovery.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { createCheckpointWorkSource, WORK_CORRECTION, WORK_GOAL_A, WORK_GOAL_B, WORK_MODEL } from "./checkpoint-work-fixture.js";

type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;
// Only the synthetic public Host callback/tool registry crosses this mock boundary.
type Hook = (event: any, context: any) => any;
type ToolContext = { agentId: string; sessionId: string; sessionKey: string; senderIsOwner: boolean; requesterSenderId: string };
type Tool = { parameters: unknown; name: string; execute(id: string, input: unknown, signal?: AbortSignal): Promise<{ details: any }> };
const execute = promisify(execFile);
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];

/** Synthetic public hooks and Host LLM API, actual local archive/Git/checkpoint writers.
 * No stock Host process, network, production state or real semantic inference is used.
 */
async function fixture(t: TestContext, options: { enabled?: boolean; viewGrant?: boolean; emptyDescriptors?: boolean; disposition?: "update" | "no_change" | "needs_clarification" } = {}) {
  const source = await createCheckpointWorkSource(), root = source.root;
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "stella-correction-supply-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const state = path.join(parent, "host-state"), authority = path.join(parent, "authority"), storePath = path.join(parent, "sessions.json");
  for (const directory of [state, authority]) await mkdir(directory, { mode: 0o700 });
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root, ...args], { timeout: 15_000 })).stdout.trim();
  const catalog = JSON.parse(await readFile(path.join(root, source.catalogPath), "utf8"));
  const policy = { schemaVersion: "stella.source-policy/v1", id: "synthetic-current-owner-ingress-policy", ownerId: "owner-fixture",
    readPurposes: [source.binding.purpose.readPurpose], derivePurposes: [source.binding.purpose.derivePurpose],
    deliveryScopes: [source.binding.purpose.deliveryScope], retention: "retain", authorityEvidenceRefs: [] };
  const policyRef = { id: policy.id, version: objectVersion(policy) }, policyPath = "synthetic-current-owner-ingress-policy.json", policyBytes = canonicalJson(policy);
  await writeFile(path.join(root, policyPath), policyBytes);
  catalog.policies.push({ ...policyRef, status: "current", dependencies: [], locator: { path: policyPath, sha256: bytesVersion(policyBytes) } });
  const archive = { ...source.binding.archive, policyRef }, bindingPath = "50_PersonalAgent/stella/praxis-binding.json";
  await writeFile(path.join(root, bindingPath), canonicalJson({ ...source.binding, archive }));
  await writeFile(path.join(root, source.catalogPath), canonicalJson(catalog));
  const originalGrantBytes = await readFile(path.join(root, source.grantPath), "utf8");
  if (options.viewGrant === false || options.emptyDescriptors) {
    const grant = JSON.parse(originalGrantBytes);
    if (options.viewGrant === false) delete grant.viewProcessingModelRefs;
    if (options.emptyDescriptors) grant.descriptors = [];
    await writeFile(path.join(root, source.grantPath), canonicalJson(grant));
  }
  await git("add", "--", policyPath, bindingPath, source.catalogPath, source.grantPath);
  await git("commit", "--quiet", "-m", "[synthetic] independent owner ingress for public correction supply");
  const revision = await git("rev-parse", "HEAD"); assert.equal(await git("remote"), "");
  const config = parseCheckpointPluginConfig({ recoveryAuthority: "core_checkpoint", canghaiRoot: root, checkpointStateDirectory: authority,
    agentId: "synthetic", dataMode: "local_write", agentMemory: "fresh_tools", requestArchive: "local",
    ...(options.enabled === false ? {} : { agentCorrection: "tool" }) });
  const live = { commands: { ownerAllowFrom: ["cli"] }, session: { store: storePath },
    agents: { entries: { synthetic: { model: { primary: WORK_MODEL, fallbacks: [] as string[] } } } },
    plugins: { entries: { "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config } } } };
  const key = "agent:synthetic:correction-supply", sessionId = "synthetic-correction-supply-session", runId = "synthetic-correction-supply-run";
  await upsertSessionEntry({ agentId: "synthetic", sessionKey: key, storePath, env: { OPENCLAW_STATE_DIR: state }, entry: { sessionId, updatedAt: 1 } });
  const hooks = new Map<string, Hook>(), methods = new Map<string, Hook>(), factories: Array<(context: ToolContext) => Tool | null> = [], stops: Array<() => Promise<void>> = [];
  const llmCalls: LlmParams[] = []; let configWrites = 0, toolCalls = 0;
  const control = { denyReadback: false, archivedRevision: "", question: WORK_CORRECTION };
  const api = { pluginConfig: config, config: live, source: "synthetic-full-checkpoint-registration", runtime: {
    version: "2026.10.8", state: { resolveStateDir: () => state }, config: { current: () => live,
      async mutateConfigFile() { configWrites++; throw new Error("No Host configuration writes in synthetic supply fixture"); } },
    llm: { async complete(params: LlmParams): Promise<LlmResult> {
      llmCalls.push(params); assert.equal(params.reasoning, "low"); assert.equal(params.model, undefined); assert.equal(params.agentId, undefined);
      const text = params.messages[0]!.content; assert.equal(typeof text, "string");
      const data = JSON.parse((text as string).split("\n").at(-1)!); let value: unknown;
      if (params.purpose === "stella-source-access") {
        assert.equal(data.request, control.question);
        value = { requestHash: data.requestHash, sourceRef: data.sourceRef, policyRef: data.policyRef,
          applicable: !(control.denyReadback && await git("rev-parse", "HEAD") !== control.archivedRevision), scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
          ruleChecks: data.accessRules.map((rule: { id: string }) => ({ id: rule.id, satisfied: true })) };
      } else if (params.purpose === "stella-personal-views") {
        assert.equal(data.question, control.question);
        value = { requestHash: data.requestHash, selections: data.candidates.map((candidate: { handle: string; group: string }) => ({ handle: candidate.handle, view: candidate.group === "works" ? "memory" : "omit" })) };
      } else {
        assert.equal(params.purpose, "stella-correction");
        if (data.bindingHash) value = { bindingHash: data.bindingHash, checks: data.data.requirements.map((rule: { handle: string }) => ({ handle: rule.handle, satisfied: true })) };
        else if (data.proposalHash) value = { requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true };
        else {
          assert.equal(data.request, control.question); const work = data.candidates.find((candidate: { group: string }) => candidate.group === "works"); assert.ok(work);
          const disposition = options.disposition ?? "update";
          value = { requestHash: data.requestHash, disposition, clarification: disposition === "needs_clarification" ? "Which synthetic premise remains open?" : null, rationale: "Synthetic explicit owner correction preserves authorial distinctions.",
            reviewedHandles: data.candidates.map((candidate: { handle: string }) => candidate.handle),
            replacements: disposition === "update" ? [{ handle: work.handle, group: "works", record: { ...Object.fromEntries(editable.map(field => [field, work.record[field]])), goal: WORK_GOAL_B } }] : [] };
        }
      }
      return { text: JSON.stringify(value), provider: "google", model: "gemini-3.8-flash", agentId: "synthetic", usage: {},
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "google" } },
        audit: { caller: { kind: "plugin", id: "stella-core" }, purpose: params.purpose } };
    } } }, logger: { info() {}, error() {}, warn() {}, debug() {} },
    on(name: string, handler: Hook) { hooks.set(name, handler); },
    registerGatewayMethod(name: string, handler: Hook) { methods.set(name, handler); },
    registerService(service: { stop(): Promise<void> }) { stops.push(() => service.stop()); },
    registerTool(factory: (context: ToolContext) => Tool | null) { factories.push(factory); },
  } as unknown as OpenClawPluginApi;
  registerCheckpointPlugin(api); t.after(async () => { for (const stop of stops) await stop(); });
  const rpc = async (action: string, extra: Record<string, unknown> = {}) => {
    let reply: { ok: boolean; payload?: any; error?: any } | undefined;
    await methods.get("stella.checkpoint")!({ params: { action, ...extra }, respond(ok: boolean, payload: unknown, error: unknown) { reply = { ok, payload, error }; } }, {});
    assert.ok(reply); return reply;
  };
  const initialized = await rpc("initialize", { revision, operationId: "synthetic-correction-supply-init" }); assert.equal(initialized.ok, true, JSON.stringify(initialized));
  const controller = new AbortController();
  const event = { runId, sessionKey: key, sendPolicy: "allow", inboundAudio: false,
    ctx: { SessionKey: key, Body: WORK_CORRECTION, SenderId: "cli", From: "cli", Provider: "webchat", ChatType: "direct", Timestamp: Date.now(), CommandAuthorized: true } };
  const context = { dispatchKind: "agent", cfg: live, abortSignal: controller.signal, dispatcher: { appendBeforeDeliver() {} }, recordProcessed() {}, markIdle() {} };
  const agent = { agentId: "synthetic", sessionKey: key, sessionId, runId, modelProviderId: "google", modelId: "gemini-3.8-flash" };
  const toolContext: ToolContext = { agentId: "synthetic", sessionKey: key, sessionId, senderIsOwner: true, requesterSenderId: "cli" };
  const tool = (name: string, overrides: Partial<ToolContext> = {}) => {
    const result = factories.map(factory => factory({ ...toolContext, ...overrides })).find(candidate => candidate?.name === name);
    assert.ok(result, `Missing synthetic registered tool ${name}`); return result;
  };
  const permit = async (name: string, value: unknown, signal = controller.signal) => {
    const id = `synthetic-correction-tool-${++toolCalls}`;
    const gate = await hooks.get("before_tool_call")!({ toolName: name, params: value }, { ...agent, toolName: name, toolCallId: id, abortSignal: signal });
    if (gate?.block) throw new Error(gate.blockReason); return id;
  };
  const call = async (name: string, value: unknown, options: { hook?: boolean; context?: Partial<ToolContext>; signal?: AbortSignal } = {}) => {
    const signal = options.signal ?? controller.signal;
    const id = options.hook === false ? `synthetic-no-hook-${++toolCalls}` : await permit(name, value, signal);
    return tool(name, options.context).execute(id, value, signal);
  };
  const ingress = () => hooks.get("reply_dispatch")!(event, context);
  const admit = () => hooks.get("before_agent_run")!({ prompt: event.ctx.Body, messages: [], senderIsOwner: true }, agent);
  const begin = async () => { assert.equal(await ingress(), undefined, JSON.stringify(await rpc("status"))); assert.equal((await admit()).outcome, "pass"); control.archivedRevision = await git("rev-parse", "HEAD"); };
  const next = async (reopen = false) => {
    await hooks.get("agent_end")!({}, agent);
    if (reopen) {
      for (const stop of stops.splice(0)) await stop(); hooks.clear(); methods.clear(); factories.splice(0);
      registerCheckpointPlugin(api);
    }
    const newRun = agent.runId + "-next";
    agent.runId = event.runId = newRun; event.ctx.Timestamp = Date.now();
    control.question = event.ctx.Body = "SYNTHETIC next user request: resume the corrected work and keep open questions.";
    await begin();
  };
  return { originalGrantBytes, source, root, revision, config, live, git, rpc, hooks, factories, llmCalls, controller, event, context, agent, tool, permit, call, ingress, admit, begin,
    control, next, counts: () => ({ modelCalls: llmCalls.length, configWrites }) };
}

test("correction is opt-in and missing view permission does not disable existing data reads", async t => {
  const f = await fixture(t, { enabled: false, viewGrant: false }); await f.begin();
  assert.equal(f.factories.map(factory => factory({ ...f.agent, senderIsOwner: true, requesterSenderId: "cli" })).some(value => value?.name === CHECKPOINT_CORRECTION_TOOL), false);
  const prompt = await f.hooks.get("before_prompt_build")!({}, f.agent); assert.deepEqual(prompt.toolsAllow, [CHECKPOINT_MEMORY_TOOL]);
  await assert.rejects(f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" }), /view_processing_grant/);
  assert.ok((await f.call(CHECKPOINT_MEMORY_TOOL, { action: "list" })).details.items.length > 0);
  assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, 0);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1"); assert.equal(f.counts().configWrites, 0);
});

test("correction opt-in requires local writes, local archive and fresh-tools together", () => {
  const base = { recoveryAuthority: "core_checkpoint", canghaiRoot: "/synthetic/source", checkpointStateDirectory: "/synthetic/authority",
    agentId: "synthetic", dataMode: "local_write", agentMemory: "fresh_tools", requestArchive: "local", agentCorrection: "tool" };
  assert.equal(parseCheckpointPluginConfig(base).agentCorrection, "tool");
  for (const delta of [{ dataMode: "read_only" }, { requestArchive: undefined }, { agentMemory: undefined }, { agentCorrection: "automatic" }]) {
    assert.throws(() => parseCheckpointPluginConfig({ ...base, ...delta }), /checkpoint_configuration_invalid/);
  }
});

test("registered correction uses archived current owner input once and rebinds subsequent work to C", async t => {
  const f = await fixture(t); await f.begin();
  const before = (await f.rpc("status")).payload.authority;
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "1", "Public synthetic ingress archives once before Agent admission");
  const workA = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details;
  assert.equal(workA.works[0].record.goal, WORK_GOAL_A); assert.equal(workA.currentMemory.checkpointToken, before.token);
  const listA = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "list" })).details;
  const handleA = listA.items[0].handle;
  const readA = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "read", handle: handleA })).details;
  assert.equal(readA.currentMemory.checkpointToken, before.token);
  const oldPermit = await f.permit(CHECKPOINT_MEMORY_TOOL, { action: "work" });
  const [firstCorrection, concurrentCorrection] = await Promise.allSettled([
    f.call(CHECKPOINT_CORRECTION_TOOL, {}), f.call(CHECKPOINT_CORRECTION_TOOL, {}),
  ]);
  // Drain both callers before fixture cleanup, including a failure regression.
  assert.ok(firstCorrection.status === "fulfilled", firstCorrection.status === "rejected" ? String(firstCorrection.reason) : "");
  assert.ok(concurrentCorrection.status === "fulfilled", concurrentCorrection.status === "rejected" ? String(concurrentCorrection.reason) : "");
  const result = firstCorrection.value.details; assert.deepEqual(concurrentCorrection.value.details, result);
  assert.equal(result.correction.disposition, "update"); assert.equal(result.correction.persistenceStatus, "local_committed");
  assert.equal(result.status, "readback_verified"); assert.equal(result.readback.status, "verified");
  assert.equal(result.readback.documents.length, 1);
  const document = result.readback.documents[0];
  assert.equal(document.target.group, "works"); assert.equal(document.reference, undefined, "formal tools have no native transport identity");
  assert.equal(objectVersion(JSON.parse(document.text)), document.target.ref.version); assert.equal(JSON.parse(document.text).goal, WORK_GOAL_B);
  assert.deepEqual(f.tool(CHECKPOINT_CORRECTION_TOOL).parameters, { type: "object", properties: {}, additionalProperties: false });
  assert.notEqual(result.currentMemory.checkpointRevision, before.revision); assert.notEqual(result.currentMemory.checkpointToken, before.token);
  const status = (await f.rpc("status")).payload;
  assert.equal(status.authority.revision, result.currentMemory.checkpointRevision); assert.equal(status.authority.token, result.currentMemory.checkpointToken);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "2");
  const reader = await CatalogReader.load(f.root, f.source.catalogPath), change = await reader.read(result.correction.changeRef, "changes");
  assert.deepEqual(change.targetRefs, [document.target.ref]);
  assert.deepEqual(await reader.read(document.target.ref, "works"), JSON.parse(document.text));
  assert.ok(Array.isArray(change.inputRefs)); assert.equal(change.inputRefs.length, 1);
  for (const ref of change.inputRefs as Array<{ id: string; version: string }>) {
    const evidence = await reader.read(ref, "evidence"); assert.ok(validMemoryRef(evidence.source));
    const source = await reader.read(evidence.source, "sources");
    assert.equal((source.origin as { upstreamId: string }).upstreamId, f.event.runId);
    assert.equal(evidence.role, "owner"); assert.equal(evidence.speakerId, "owner-fixture");
    assert.equal(typeof evidence.payloadSha256, "string");
    const payload = await reader.readPayload(evidence.source, evidence.payloadSha256 as string);
    const original = JSON.parse(payload.bytes.toString("utf8"));
    assert.equal(original.request.prompt, f.event.ctx.Body); assert.equal(original.request.runId, f.event.runId);
    assert.equal(original.request.requestHash, bytesVersion(f.event.ctx.Body));
  }
  const calls = f.llmCalls.length, head = await f.git("rev-parse", "HEAD");
  assert.deepEqual((await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details, result);
  assert.deepEqual(f.llmCalls.slice(calls).map(call => call.purpose), ["stella-source-access"], "retry may revalidate source use, never infer the correction again"); assert.equal(await f.git("rev-parse", "HEAD"), head);
  await assert.rejects(f.tool(CHECKPOINT_MEMORY_TOOL).execute(oldPermit, { action: "work" }, f.controller.signal), /checkpoint_agent_memory_changed/);
  await assert.rejects(f.call(CHECKPOINT_MEMORY_TOOL, { action: "read", handle: handleA }), /checkpoint_agent_handle_unavailable/);
  const workC = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details;
  assert.equal(workC.works[0].record.goal, WORK_GOAL_B); assert.deepEqual(workC.currentMemory, result.currentMemory);
  for (const field of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"]) assert.deepEqual(workC.works[0].record[field], f.source.workRecord[field as keyof typeof f.source.workRecord]);
  const listC = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "list" })).details;
  assert.notEqual(listC.items[0].handle, handleA);
  assert.deepEqual((await f.call(CHECKPOINT_MEMORY_TOOL, { action: "read", handle: listC.items[0].handle })).details.currentMemory, result.currentMemory);
  assert.equal(status.capabilities.full_memory, false); assert.equal(f.counts().configWrites, 0); assert.equal(await f.git("status", "--porcelain"), "");
});

test("correction rejects model arguments, missing hook, foreign sender and cancelled permits", async t => {
  const f = await fixture(t); await f.begin();
  const head = await f.git("rev-parse", "HEAD"), models = f.llmCalls.length;
  await assert.rejects(f.call(CHECKPOINT_CORRECTION_TOOL, { request: "A model-authored replacement request" }), /checkpoint_agent_tool_arguments_invalid/);
  await assert.rejects(f.call(CHECKPOINT_CORRECTION_TOOL, {}, { hook: false }), /checkpoint_agent_tool_scope_unavailable/);
  await assert.rejects(f.call(CHECKPOINT_CORRECTION_TOOL, {}, { context: { requesterSenderId: "another-owner" } }), /checkpoint_agent_tool_scope_unavailable/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.call(CHECKPOINT_CORRECTION_TOOL, {}, { signal: cancelled.signal }), /cancel/);
  assert.equal(f.llmCalls.length, models); assert.equal(await f.git("rev-parse", "HEAD"), head); assert.equal(f.counts().configWrites, 0);
});

test("non-owner synthetic ingress cannot archive or obtain a correction permit", async t => {
  const f = await fixture(t); f.event.ctx.SenderId = f.event.ctx.From = "ungranted-sender";
  assert.equal((await f.ingress()).handled, true); assert.equal((await f.admit()).outcome, "block");
  await assert.rejects(f.call(CHECKPOINT_CORRECTION_TOOL, {}), /scope_unavailable/);
  assert.equal(f.llmCalls.length, 0); assert.equal(await f.git("rev-parse", "HEAD"), f.revision);
});

test("registered tool preserves local_committed on read denial and retries only the receipt read", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.begin(); f.control.denyReadback = true;
  const failed = (await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details;
  assert.equal(failed.status, "readback_failed"); assert.equal(failed.correction.persistenceStatus, "local_committed");
  assert.equal(failed.readback.category, "source_topic_unresolved"); assert.deepEqual(failed.readback.documents, []);
  const head = await f.git("rev-parse", "HEAD"), inference = f.llmCalls.filter(call => call.purpose === "stella-correction").length;
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "2", "one archive plus one correction commit");
  assert.equal(failed.currentMemory.checkpointRevision, head);
  await assert.rejects(f.call(CHECKPOINT_CORRECTION_TOOL, {}, { hook: false }), /scope_unavailable/);
  assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, inference);
  f.control.denyReadback = false;
  const grantPath = path.join(f.root, f.source.grantPath), originalGrant = await readFile(grantPath, "utf8");
  const reduced = JSON.parse(originalGrant); reduced.descriptors = [];
  await writeFile(grantPath, canonicalJson(reduced));
  try {
    const changed = (await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details;
    assert.equal(changed.status, "readback_failed"); assert.equal(changed.readback.category, "personal_context_access_changed");
    assert.deepEqual(changed.correction, failed.correction); assert.deepEqual(changed.readback.documents, []);
    assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, inference);
  } finally { await writeFile(grantPath, originalGrant); }
  const read = (await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details;
  assert.equal(read.status, "readback_verified"); assert.deepEqual(read.correction, failed.correction);
  assert.deepEqual(read.currentMemory, failed.currentMemory);
  assert.equal(JSON.parse(read.readback.documents[0].text).goal, WORK_GOAL_B);
  assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, inference);
  assert.equal(await f.git("rev-parse", "HEAD"), head);
});

test("new registered request and disk reopen obtain fresh checkpoint and independently scoped reads", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.begin();
  const oldReader = await CatalogReader.load(f.root, f.source.catalogPath);
  const result = (await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details;
  assert.equal(result.status, "readback_verified");
  const target = result.readback.documents[0].target.ref, oldTool = f.tool(CHECKPOINT_MEMORY_TOOL);
  const oldPermit = await f.permit(CHECKPOINT_MEMORY_TOOL, { action: "work" });
  await assert.rejects(oldReader.read(f.source.workRef, "works"), /stale_generation/);
  const inference = f.llmCalls.filter(call => call.purpose === "stella-correction").length;
  for (const reopen of [false, true]) {
    const before = (await f.rpc("status")).payload.authority, calls = f.llmCalls.length;
    await f.next(reopen);
    assert.notEqual(f.event.runId, result.currentMemory.userRequest);
    const current = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details;
    assert.equal(current.works.length, 1); assert.deepEqual(current.works[0].ref, target);
    assert.equal(current.works[0].record.goal, WORK_GOAL_B);
    for (const field of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"])
      assert.deepEqual(current.works[0].record[field], f.source.workRecord[field as keyof typeof f.source.workRecord]);
    const checkpoint = (await f.rpc("status")).payload.authority;
    assert.equal(current.currentMemory.checkpointRevision, checkpoint.revision);
    assert.notEqual(checkpoint.token, before.token, "new request archives to its own current checkpoint");
    const sourceCalls = f.llmCalls.slice(calls).filter(call => call.purpose === "stella-source-access");
    assert.ok(sourceCalls.length > 0);
    for (const call of sourceCalls) {
      const data = JSON.parse(String(call.messages[0]!.content).split("\n").at(-1)!);
      assert.equal(data.requestHash, bytesVersion(f.event.ctx.Body)); assert.notEqual(data.requestHash, bytesVersion(WORK_CORRECTION));
    }
    await assert.rejects(oldTool.execute(oldPermit, { action: "work" }, f.controller.signal), /scope_unavailable/);
    assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, inference);
  }
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "4", "three ingress archives and only one correction");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("next registered request reloads reduced source permission; owner and old permits cannot release bodies", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.begin();
  const result = (await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details;
  assert.equal(result.status, "readback_verified");
  const oldTool = f.tool(CHECKPOINT_MEMORY_TOOL), oldPermit = await f.permit(CHECKPOINT_MEMORY_TOOL, { action: "work" });
  await f.hooks.get("agent_end")!({}, f.agent);
  const before = (await f.rpc("status")).payload.authority;
  const grantPath = f.source.grantPath, grantBytes = await readFile(path.join(f.root, grantPath), "utf8"), reduced = JSON.parse(grantBytes);
  reduced.descriptors = []; // Reduces only this synthetic fixture's existing permission.
  const authority = await openLocalCheckpointRecovery({ stateDirectory: f.config.checkpointStateDirectory!, binding: before.binding });
  await applyMemoryTransaction(f.root, { operationId: "synthetic-withdraw-source-context", journalPath: "30_PersonalData/memory/operations/synthetic-withdraw-source-context.json",
    recoveryCheckpoint: { binding: before.binding, expected: { revision: before.revision, token: before.token } },
    files: [{ path: grantPath, before: grantBytes, after: canonicalJson(reduced) }] }, {
    recovery: { authority, expected: before, assertPublication: accepted => authority.assertCurrent(accepted) },
    validate: () => authority.assertCurrent(before),
    async persist(paths) { await f.git("add", "--", ...paths); await f.git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "[synthetic] withdraw source descriptors", "--", ...paths); },
    async confirmPreviouslyCommitted() { throw new Error("Exact synthetic checkpoint publication required"); },
  });
  const inference = f.llmCalls.filter(call => call.purpose === "stella-correction").length;
  await f.next(true);
  const currentReader = await CatalogReader.load(f.root, f.source.catalogPath);
  const committedChange = await currentReader.read(result.correction.changeRef, "changes");
  const authorizedOwnerInputs = new Set<string>();
  for (const ref of committedChange.inputRefs as Array<{ id: string; version: string }>) {
    const evidence = await currentReader.read(ref, "evidence"); assert.ok(validMemoryRef(evidence.source));
    const source = await currentReader.read(evidence.source, "sources"); assert.ok(validMemoryRef(source.policyRef));
    const policy = await currentReader.read(source.policyRef, "policies");
    assert.equal(policy.schemaVersion, "stella.source-policy/v1"); assert.equal(policy.retention, "retain");
    assert.ok((policy.readPurposes as string[]).includes(f.source.binding.purpose.readPurpose));
    authorizedOwnerInputs.add(canonicalJson(evidence.source));
  }
  const protectedSources = new Set(JSON.parse(grantBytes).descriptors.map((entry: { sourceRef: unknown }) => canonicalJson(entry.sourceRef)));
  let protectedPayloadReads = 0, authorizedOwnerPayloadReads = 0;
  const payload = CatalogReader.prototype.readPayload;
  t.mock.method(CatalogReader.prototype, "readPayload", async function(this: CatalogReader, ...args: Parameters<typeof payload>) {
    const sourceKey = canonicalJson(args[0]);
    if (protectedSources.has(sourceKey)) protectedPayloadReads++;
    else { assert.ok(authorizedOwnerInputs.has(sourceKey), "any earlier payload I/O must belong to the independently permitted owner input"); authorizedOwnerPayloadReads++; }
    return payload.apply(this, args);
  });
  let documentsReleased = 0;
  await assert.rejects((async () => {
    const denied = await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" }); documentsReleased++; return denied;
  })(), { category: "personal_context_descriptor_required" });
  assert.equal(protectedPayloadReads, 0); assert.equal(documentsReleased, 0);
  assert.equal(authorizedOwnerPayloadReads, 1, "an allowed ingress dependency may be read before the separate protected-source denial");
  assert.equal(f.tool(CHECKPOINT_MEMORY_TOOL).name, CHECKPOINT_MEMORY_TOOL); assert.equal(f.event.ctx.SenderId, "cli");
  await assert.rejects(oldTool.execute(oldPermit, { action: "work" }, f.controller.signal), /scope_unavailable/);
  assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, inference);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "4", "archive, correction, explicit permission reduction, next archive");
});

for (const disposition of ["no_change", "needs_clarification"] as const) test(`registered ${disposition} keeps no-target semantics and a usable rebound request`, async t => {
  const f = await fixture(t, { disposition }); await f.begin();
  const result = (await f.call(CHECKPOINT_CORRECTION_TOOL, {})).details;
  assert.equal(result.status, disposition); assert.equal(result.correction.persistenceStatus, "local_committed");
  assert.deepEqual(result.readback, { status: "not_required", documents: [] });
  const reader = await CatalogReader.load(f.root, f.source.catalogPath), change = await reader.read(result.correction.changeRef, "changes");
  assert.deepEqual(change.targetRefs, []); assert.deepEqual(change.changes, []);
  const current = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details;
  assert.equal(current.works[0].record.goal, WORK_GOAL_A); assert.deepEqual(current.currentMemory, result.currentMemory);
});

/** Test-only publication of a synthetic permission file, using the existing
 * transaction/CAS. It never advances a live grant or creates real permissions. */
async function publishFixtureGrant(f: Awaited<ReturnType<typeof fixture>>, after: string, operationId: string) {
  const expected = (await f.rpc("status")).payload.authority, grantPath = f.source.grantPath;
  const before = await readFile(path.join(f.root, grantPath), "utf8");
  const authority = await openLocalCheckpointRecovery({ stateDirectory: f.config.checkpointStateDirectory!, binding: expected.binding });
  return applyMemoryTransaction(f.root, { operationId, journalPath: `30_PersonalData/memory/operations/${operationId}.json`,
    recoveryCheckpoint: { binding: expected.binding, expected: { revision: expected.revision, token: expected.token } },
    files: [{ path: grantPath, before, after }] }, {
    recovery: { authority, expected, assertPublication: accepted => authority.assertCurrent(accepted) },
    validate: () => authority.assertCurrent(expected),
    async persist(paths) { await f.git("add", "--", ...paths); await f.git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "[synthetic] publish fixture source permission", "--", ...paths); },
    async confirmPreviouslyCommitted() { throw new Error("Exact synthetic checkpoint publication required"); },
  });
}

test("same-run grant expansion cannot authorize first source or view supply; a new request independently loads it", { timeout: 120_000 }, async t => {
  const f = await fixture(t, { emptyDescriptors: true }); await f.begin();
  const grantPath = path.join(f.root, f.source.grantPath), admittedBytes = await readFile(grantPath, "utf8");
  assert.deepEqual(JSON.parse(admittedBytes).descriptors, []);
  for (let retry = 0; retry < 2; retry++)
    await assert.rejects(f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" }), { category: "personal_context_descriptor_required" });
  const head = await f.git("rev-parse", "HEAD"), modelCalls = f.llmCalls.length;
  const protectedSources = new Set(JSON.parse(f.originalGrantBytes).descriptors.map((d: { sourceRef: unknown }) => canonicalJson(d.sourceRef)));
  let protectedPayloadReads = 0, returnedDocuments = 0;
  const payload = CatalogReader.prototype.readPayload;
  const spy = t.mock.method(CatalogReader.prototype, "readPayload", async function(this: CatalogReader, ...args: Parameters<typeof payload>) {
    if (protectedSources.has(canonicalJson(args[0]))) protectedPayloadReads++; return payload.apply(this, args);
  });
  await writeFile(grantPath, f.originalGrantBytes);
  try {
    for (const action of ["work", "understanding", "list"] as const) {
      await assert.rejects((async () => { const result = await f.call(CHECKPOINT_MEMORY_TOOL, { action }); returnedDocuments++; return result; })(),
        { category: "personal_context_access_changed" });
      assert.equal(protectedPayloadReads, 0); assert.equal(returnedDocuments, 0);
    }
    assert.equal(f.llmCalls.length, modelCalls); assert.equal(await f.git("rev-parse", "HEAD"), head);
    const reader = await CatalogReader.load(f.root, f.source.catalogPath); assert.equal(reader.catalog.changes.length, 0);
  } finally {
    t.diagnostic(JSON.stringify({ scenario: "same-run-grant-expansion", protectedPayloadReads, returnedDocuments }));
    await writeFile(grantPath, admittedBytes); spy.mock.restore();
  }
  await f.hooks.get("agent_end")!({}, f.agent);
  await publishFixtureGrant(f, f.originalGrantBytes, "synthetic-next-request-expanded-permission");
  const calls = f.llmCalls.length; await f.next(true);
  const current = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details;
  assert.equal(current.works.length, 1); assert.equal(current.works[0].record.goal, WORK_GOAL_A);
  assert.equal(current.currentMemory.userRequest, f.event.runId);
  assert.equal(current.currentMemory.checkpointRevision, (await f.rpc("status")).payload.authority.revision);
  assert.ok(f.llmCalls.slice(calls).some(call => call.purpose === "stella-source-access"));
  assert.equal(f.llmCalls.filter(call => call.purpose === "stella-correction").length, 0);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "3", "two ingress commits and one explicit fixture permission publication, zero correction commits");
});

test("already supplied work and originals remain request-local caches after grant changes; unseen views stay refused", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.begin();
  const work = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details;
  const list = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "list" })).details;
  const handle = list.items.find((item: { evidence: { id: string } }) => item.evidence.id === f.source.evidenceRef.id).handle;
  const read = (await f.call(CHECKPOINT_MEMORY_TOOL, { action: "read", handle })).details;
  const head = await f.git("rev-parse", "HEAD"), calls = f.llmCalls.length;
  const grantPath = path.join(f.root, f.source.grantPath), original = await readFile(grantPath, "utf8"), reduced = JSON.parse(original);
  reduced.descriptors = [];
  let payloadReads = 0;
  const payload = CatalogReader.prototype.readPayload;
  t.mock.method(CatalogReader.prototype, "readPayload", async function(this: CatalogReader, ...args: Parameters<typeof payload>) {
    payloadReads++; return payload.apply(this, args);
  });
  try {
    assert.deepEqual((await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details, work);
    await writeFile(grantPath, canonicalJson(reduced));
    assert.deepEqual((await f.call(CHECKPOINT_MEMORY_TOOL, { action: "work" })).details, work);
    assert.deepEqual((await f.call(CHECKPOINT_MEMORY_TOOL, { action: "read", handle })).details, read);
    assert.deepEqual((await f.call(CHECKPOINT_MEMORY_TOOL, { action: "list" })).details, list);
    await assert.rejects(f.call(CHECKPOINT_MEMORY_TOOL, { action: "understanding" }), { category: "personal_context_access_changed" });
    assert.equal(payloadReads, 0); assert.equal(f.llmCalls.length, calls); assert.equal(await f.git("rev-parse", "HEAD"), head);
    assert.equal(f.counts().configWrites, 0);
  } finally { await writeFile(grantPath, original); }
});
