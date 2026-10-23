import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerCheckpointPlugin } from "../src/openclaw/checkpoint-plugin-registration.js";
import { createAgentSupplySource, BOOTSTRAP_MARKER, SKILL_MARKER } from "./checkpoint-agent-supply-fixture.js";
import { bytesVersion } from "../src/canghai/content-version.js";

async function fixture(t: TestContext, configuredIdentity = true) {
  const source = await createAgentSupplySource({ materialization: true }), parent = await realpath(await mkdtemp("/tmp/stella-checkpoint-init-"));
  t.after(async () => { await rm(source.root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });
  const authority = path.join(parent, "authority"), workspace = path.join(parent, "workspace"), state = path.join(parent, "host-state");
  await mkdir(authority); await mkdir(workspace); await mkdir(state);
  const config = { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: source.root, dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools" };
  const expectedIdentity = { name: `${BOOTSTRAP_MARKER}_IDENTITY.md`, theme: "Isolated local acceptance", emoji: "🧪" };
  const live: any = { agents: { entries: { synthetic: { workspace, ...(configuredIdentity ? { identity: expectedIdentity } : {}) } } },
    plugins: { entries: { "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config } } } };
  const methods = new Map<string, Function>(), hooks = new Map<string, Function>(), services: Array<{ stop(): Promise<void> }> = [];
  let configWrites = 0;
  let afterWrite: (() => void) | undefined;
  const factories: Function[] = [];
  const api = { pluginConfig: config, config: live, logger: { info() {}, warn() {}, error() {} },
    runtime: { version: "2026.8.2", state: { resolveStateDir: () => state }, config: { current: () => live,
      async mutateConfigFile(input: any) { configWrites++; input.mutate(live); afterWrite?.(); return {}; } } },
    registerGatewayMethod(name: string, fn: Function, options: { scope: string }) { assert.equal(options.scope, "operator.admin"); methods.set(name, fn); },
    registerService(service: { stop(): Promise<void> }) { services.push(service); }, registerTool(factory: Function) { factories.push(factory); },
    on(name: string, fn: Function) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  const register = () => registerCheckpointPlugin(api); register(); t.after(async () => { for (const service of services) await service.stop(); });
  const rpc = async (action: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
    let result: any; await methods.get("stella.checkpoint")!({ params: { action, ...extra }, signal, respond(ok: boolean, payload: any, error: any) { result = { ok, payload, error }; } }); return result;
  };
  assert.equal((await rpc("initialize", { revision: source.revision, operationId: "synthetic-checkpoint-init" })).ok, true);
  return { ...source, workspace, state, authority, config, live, expectedIdentity, api, hooks, services, register, rpc, factories, afterWrite: (hook: () => void) => { afterWrite = hook; }, configWrites: () => configWrites };
}

test("public checkpoint materialization installs manifest bootstrap and skill with durable ownership and idempotence", async t => {
  const f = await fixture(t), result = await f.rpc("materialize"); assert.equal(result.ok, true, JSON.stringify(result.error));
  const installed = result.payload.materialized; assert.equal(installed.state, "ready"); assert.equal(installed.consumed, false);
  assert.equal(installed.receipt.files.length, 6); assert.equal(result.payload.capabilities.hostBootstrap, true); assert.equal(result.payload.capabilities.full_memory, false);
  for (const file of installed.receipt.files) assert.equal(bytesVersion(await readFile(path.join(f.workspace, file.target))), file.hash);
  assert.ok((await readFile(path.join(f.workspace, "AGENTS.md"), "utf8")).includes(BOOTSTRAP_MARKER));
  assert.ok((await readFile(path.join(f.workspace, "skills/stella-initialization-probe/SKILL.md"), "utf8")).includes(SKILL_MARKER));
  const archived = JSON.parse(await readFile(path.join(installed.stateRoot, `operations/${installed.receipt.operationId}.json`), "utf8"));
  assert.ok(archived.changes.every((change: any) => change.before === null && change.beforeMode === null));
  assert.equal(archived.recoveryAuthority.revision, f.revision); assert.equal(archived.workspace, f.workspace);
  assert.equal((await f.rpc("materialize")).payload.materialized.receipt.operationId, installed.receipt.operationId);
  assert.equal(f.configWrites(), 0);
  assert.equal((await f.rpc("materialize", { workspace: "/tmp/forbidden-target" })).ok, false);
  for (const action of [["materialize"], null, "unknown"]) assert.equal((await f.rpc("materialize", { action })).ok, false);
});

test("unowned user bootstrap and later user modifications are never overwritten", async t => {
  for (const managed of [false, true]) await t.test(managed ? "managed drift" : "unowned", async t => {
    const f = await fixture(t); if (managed) assert.equal((await f.rpc("materialize")).ok, true);
    const file = path.join(f.workspace, "AGENTS.md"); await writeFile(file, "SYNTHETIC_USER_EDITS_KEEP_8615");
    const result = await f.rpc("materialize"); assert.equal(result.ok, false);
    assert.equal(result.error.message, managed ? "projection_drift" : "host_file_unowned");
    assert.equal(await readFile(file, "utf8"), "SYNTHETIC_USER_EDITS_KEEP_8615");
  });
});

test("failed verification remains fenced after registration restart and retries the original plan", async t => {
  const f = await fixture(t); f.live.agents.entries.synthetic.skills = [];
  const failed = await f.rpc("materialize"); assert.equal(failed.ok, false); assert.equal(failed.error.message, "skill_unavailable_or_shadowed");
  const root = path.join(f.authority, "initialization"), pending = await readFile(path.join(root, "pending.json"), "utf8"), plan = JSON.parse(pending);
  for (const service of f.services) await service.stop(); f.register();
  const gate = await f.hooks.get("before_agent_run")!({ messages: [], senderIsOwner: true }, { agentId: "synthetic" });
  assert.equal(gate.category, "initialization_pending");
  delete f.live.agents.entries.synthetic.skills;
  const retried = await f.rpc("materialize"); assert.equal(retried.ok, true, JSON.stringify(retried.error));
  assert.equal(retried.payload.materialized.receipt.operationId, plan.operationId);
  assert.equal(await readFile(path.join(root, `operations/${plan.operationId}.json`), "utf8"), pending);
  await assert.rejects(readFile(path.join(root, "pending.json")), { code: "ENOENT" });
});

test("explicit rollback restores original absence, preserves unrelated user files and stays fenced", async t => {
  const f = await fixture(t); await writeFile(path.join(f.workspace, "keep-user.txt"), "KEEP");
  const installed = (await f.rpc("materialize")).payload.materialized;
  const rollback = await f.rpc("rollback", { operationId: installed.receipt.operationId }); assert.equal(rollback.ok, true, JSON.stringify(rollback.error));
  assert.equal(rollback.payload.state, "fenced");
  for (const file of installed.receipt.files) await assert.rejects(readFile(path.join(f.workspace, file.target)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.workspace, "keep-user.txt"), "utf8"), "KEEP");
  assert.ok((await readFile(path.join(installed.stateRoot, `operations/${installed.receipt.operationId}.json`))).length);
  assert.equal((await f.hooks.get("before_agent_run")!({ messages: [] }, { agentId: "synthetic" })).category, "initialization_pending");
  assert.equal((await f.rpc("materialize")).ok, true);
});

test("display identity uses only the existing public config API", async t => {
  const f = await fixture(t, false); const result = await f.rpc("materialize"); assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.configWrites(), 1); assert.deepEqual(f.live.agents.entries.synthetic.identity, f.expectedIdentity);
  assert.deepEqual(Object.keys(f.live.agents.entries.synthetic).sort(), ["identity", "workspace"]);
});

test("managed skill supply stays in the existing data tool and busy initialization refuses without changing Host permissions", async t => {
  const f = await fixture(t); assert.equal((await f.rpc("materialize")).ok, true);
  const key = "agent:synthetic:managed-skill", sessionId = "synthetic-init-session", runId = "synthetic-init-run";
  const storePath = path.join(f.state, "sessions.json"); f.live.session = { store: storePath }; f.live.commands = { ownerAllowFrom: ["synthetic-owner"] };
  await upsertSessionEntry({ agentId: "synthetic", sessionKey: key, storePath, env: { OPENCLAW_STATE_DIR: f.state }, entry: { sessionId, updatedAt: 1 } });
  const signal = new AbortController().signal, event = { runId, sessionKey: key, sendPolicy: "allow", inboundAudio: false,
    ctx: { SessionKey: key, Body: "Use the declared managed skill", SenderId: "synthetic-owner", From: "synthetic-owner", Provider: "webchat", ChatType: "direct", CommandAuthorized: true } };
  assert.equal(await f.hooks.get("reply_dispatch")!(event, { dispatchKind: "agent", cfg: f.live, abortSignal: signal, dispatcher: {}, recordProcessed() {} }), undefined);
  const agent = { agentId: "synthetic", sessionKey: key, sessionId, runId };
  assert.equal((await f.rpc("materialize")).error.message, "active_turn_drain_required");
  assert.equal((await f.hooks.get("before_agent_run")!({ messages: [], senderIsOwner: true }, agent)).outcome, "pass");
  const prompt = await f.hooks.get("before_prompt_build")!({}, agent);
  assert.deepEqual(prompt.toolsAllow, ["stella_memory_data"]);
  assert.ok(prompt.appendSystemContext.includes("stella-initialization-probe") && prompt.appendSystemContext.includes("Managed skill catalogue"));
  assert.ok(!prompt.appendSystemContext.includes(SKILL_MARKER));
  const tool = f.factories.map(factory => factory({ ...agent, senderIsOwner: true, requesterSenderId: "synthetic-owner" })).find(tool => tool?.name === "stella_memory_data");
  let nextCall = 0;
  const execute = async (handle: string) => {
    const callId = `synthetic-skill-${++nextCall}`, params = { action: "skill", handle };
    assert.equal(await f.hooks.get("before_tool_call")!({ toolName: tool.name, params }, { ...agent, toolName: tool.name, toolCallId: callId, abortSignal: signal }), undefined);
    return tool.execute(callId, params, signal);
  };
  const skill = await execute("stella-initialization-probe"); assert.ok(skill.details.skill.text.includes(SKILL_MARKER));
  skill.details.skill.text = "CALLER_CHANGED"; assert.ok((await execute("stella-initialization-probe")).details.skill.text.includes(SKILL_MARKER));
  await assert.rejects(execute("../AGENTS.md"), /skill_read_forbidden/);
  await assert.rejects(execute("not-declared"));
  assert.equal((await f.rpc("materialize")).error.message, "active_turn_drain_required");
  await f.hooks.get("agent_end")!({}, agent);
  assert.equal((await f.rpc("materialize")).ok, true);
  event.runId = agent.runId = "synthetic-rejected-old-history";
  await f.hooks.get("reply_dispatch")!(event, { dispatchKind: "agent", cfg: f.live, abortSignal: signal, dispatcher: {}, recordProcessed() {} });
  assert.equal((await f.hooks.get("before_agent_run")!({ messages: [{ role: "assistant", content: "OLD" }], senderIsOwner: true }, agent)).outcome, "block");
  assert.equal((await f.rpc("materialize")).ok, true);
  assert.equal(f.live.tools, undefined); assert.equal(f.live.bindings, undefined); assert.equal(f.configWrites(), 0);
});

test("in-process cancellation preserves an interrupted materialization for retry without reporting success", async t => {
  const f = await fixture(t, false), controller = new AbortController();
  f.afterWrite(() => controller.abort());
  const result = await f.rpc("materialize", {}, controller.signal); assert.equal(result.ok, false); assert.equal(result.error.message, "operation_cancelled");
  const pending = await readFile(path.join(f.authority, "initialization/pending.json"), "utf8");
  assert.ok(pending); assert.ok((await readFile(path.join(f.authority, "initialization/fenced"))).length);
  const retry = await f.rpc("materialize"); assert.equal(retry.ok, true, JSON.stringify(retry.error));
  assert.equal(retry.payload.materialized.receipt.operationId, JSON.parse(pending).operationId);
});

test("read-only configuration refuses materialization before creating operation state", async t => {
  const f = await fixture(t); for (const service of f.services) await service.stop();
  f.config.dataMode = "read_only"; f.register();
  assert.equal((await f.rpc("materialize")).error.message, "checkpoint_write_disabled");
  await assert.rejects(readFile(path.join(f.workspace, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.authority, "initialization/receipt.json")), { code: "ENOENT" });
});
