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
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { createCheckpointWorkSource, WORK_CORRECTION, WORK_GOAL_A, WORK_GOAL_B, WORK_MODEL } from "./checkpoint-work-fixture.js";

type LlmParams = Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0];
type LlmResult = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>;
// Only the synthetic public Host callback/tool registry crosses this mock boundary.
type Hook = (event: any, context: any) => any;
type ToolContext = { agentId: string; sessionId: string; sessionKey: string; senderIsOwner: boolean; requesterSenderId: string };
type Tool = { name: string; execute(id: string, input: unknown, signal?: AbortSignal): Promise<{ details: any }> };
const execute = promisify(execFile);
const editable = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];

/** Synthetic public hooks and Host LLM API, actual local archive/Git/checkpoint writers.
 * No stock Host process, network, production state or real semantic inference is used.
 */
async function fixture(t: TestContext, options: { enabled?: boolean; viewGrant?: boolean } = {}) {
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
  if (options.viewGrant === false) {
    const grant = JSON.parse(await readFile(path.join(root, source.grantPath), "utf8")); delete grant.viewProcessingModelRefs;
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
  const api = { pluginConfig: config, config: live, source: "synthetic-full-checkpoint-registration", runtime: {
    version: "2026.8.2", state: { resolveStateDir: () => state }, config: { current: () => live,
      async mutateConfigFile() { configWrites++; throw new Error("No Host configuration writes in synthetic supply fixture"); } },
    llm: { async complete(params: LlmParams): Promise<LlmResult> {
      llmCalls.push(params); assert.equal(params.reasoning, "low"); assert.equal(params.model, undefined); assert.equal(params.agentId, undefined);
      const text = params.messages[0]!.content; assert.equal(typeof text, "string");
      const data = JSON.parse((text as string).split("\n").at(-1)!); let value: unknown;
      if (params.purpose === "stella-source-access") {
        assert.equal(data.request, WORK_CORRECTION);
        value = { requestHash: data.requestHash, sourceRef: data.sourceRef, policyRef: data.policyRef,
          applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
          ruleChecks: data.accessRules.map((rule: { id: string }) => ({ id: rule.id, satisfied: true })) };
      } else if (params.purpose === "stella-personal-views") {
        assert.equal(data.question, WORK_CORRECTION);
        value = { requestHash: data.requestHash, selections: data.candidates.map((candidate: { handle: string; group: string }) => ({ handle: candidate.handle, view: candidate.group === "works" ? "memory" : "omit" })) };
      } else {
        assert.equal(params.purpose, "stella-correction");
        if (data.bindingHash) value = { bindingHash: data.bindingHash, checks: data.data.requirements.map((rule: { handle: string }) => ({ handle: rule.handle, satisfied: true })) };
        else if (data.proposalHash) value = { requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true };
        else {
          assert.equal(data.request, WORK_CORRECTION); const work = data.candidates.find((candidate: { group: string }) => candidate.group === "works"); assert.ok(work);
          value = { requestHash: data.requestHash, disposition: "update", clarification: null, rationale: "Synthetic explicit owner correction preserves authorial distinctions.",
            reviewedHandles: data.candidates.map((candidate: { handle: string }) => candidate.handle),
            replacements: [{ handle: work.handle, group: "works", record: { ...Object.fromEntries(editable.map(field => [field, work.record[field]])), goal: WORK_GOAL_B } }] };
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
  const begin = async () => { assert.equal(await ingress(), undefined, JSON.stringify(await rpc("status"))); assert.equal((await admit()).outcome, "pass"); };
  return { source, root, revision, config, live, git, rpc, hooks, factories, llmCalls, controller, event, context, agent, tool, permit, call, ingress, admit, begin,
    counts: () => ({ modelCalls: llmCalls.length, configWrites }) };
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
  assert.notEqual(result.currentMemory.checkpointRevision, before.revision); assert.notEqual(result.currentMemory.checkpointToken, before.token);
  const status = (await f.rpc("status")).payload;
  assert.equal(status.authority.revision, result.currentMemory.checkpointRevision); assert.equal(status.authority.token, result.currentMemory.checkpointToken);
  assert.equal(await f.git("rev-list", "--count", `${f.revision}..HEAD`), "2");
  const reader = await CatalogReader.load(f.root, f.source.catalogPath), change = await reader.read(result.correction.changeRef, "changes");
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
  assert.equal(f.llmCalls.length, calls); assert.equal(await f.git("rev-parse", "HEAD"), head);
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
