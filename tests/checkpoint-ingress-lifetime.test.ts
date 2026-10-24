import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { CatalogError, CatalogReader } from "../src/canghai/catalog-reader.js";
import { readCheckpointCommittedDocument } from "../src/canghai/checkpoint-committed-document.js";
import { readRecordedMemoryTransaction, type MemoryTransactionPlan } from "../src/canghai/memory-transaction.js";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { registerCheckpointRequestIngress } from "../src/openclaw/checkpoint-request-ingress.js";
import { CHECKPOINT_MEMORY_TOOL, registerCheckpointAgentSupply } from "../src/openclaw/checkpoint-agent-supply.js";
import { isRecord } from "../src/shared/type-guards.js";
import { createAgentSupplySource } from "./checkpoint-agent-supply-fixture.js";

type Runtime = Awaited<ReturnType<typeof createCheckpointPluginRuntime>>;
type Ingress = ReturnType<typeof registerCheckpointRequestIngress>;
type Event = Parameters<Ingress["dispatch"]>[0];
type Context = Parameters<Ingress["dispatch"]>[1];
type Hook = (event: unknown, context: unknown) => unknown;
type Tool = { name: string; execute(id: string, input: unknown, signal?: AbortSignal): Promise<{ details: unknown }> };
type ToolContext = { agentId: string; sessionKey: string; sessionId: string; senderIsOwner: boolean; requesterSenderId: string };
const execute = promisify(execFile), key = "agent:synthetic:ingress-lifetime", sessionId = "synthetic-ingress-lifetime-session";
const preparationFailure = "synthetic_preparation_failed";
function record(value: unknown): Record<string, unknown> { assert.ok(isRecord(value)); return value; }

/** Synthetic API boundary, real public identity resolution and session store. No
 * Host process, provider, private main state or network is used by these tests.
 */
async function hostFixture(t: TestContext, repositoryRoot?: string) {
  const parent = await realpath(await mkdtemp("/tmp/stella-ingress-lifetime-"));
  const root = repositoryRoot ?? path.join(parent, "repository"), state = path.join(parent, "host-state");
  const authority = path.join(parent, "authority"), storePath = path.join(parent, "sessions.json");
  for (const directory of [root, state, authority]) await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const config = parseCheckpointPluginConfig({ recoveryAuthority: "core_checkpoint", canghaiRoot: root,
    checkpointStateDirectory: authority, dataMode: "local_write", agentId: "synthetic", requestArchive: "local", agentMemory: "fresh_tools" });
  const live = { commands: { ownerAllowFrom: ["synthetic-owner"] }, session: { store: storePath },
    plugins: { entries: { "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config } } } };
  await upsertSessionEntry({ agentId: "synthetic", sessionKey: key, storePath, env: { OPENCLAW_STATE_DIR: state }, entry: { sessionId, updatedAt: 1 } });
  assert.equal(getSessionEntry({ agentId: "synthetic", sessionKey: key, storePath, env: { OPENCLAW_STATE_DIR: state }, readConsistency: "latest" })?.sessionId, sessionId);
  const hooks = new Map<string, Hook>(), factories: Array<(context: ToolContext) => Tool | null> = [];
  const controller = new AbortController(); let modelCalls = 0, configWrites = 0;
  const api = { pluginConfig: config, config: live, runtime: { version: "2026.8.2", state: { resolveStateDir: () => state },
    config: { current: () => live, async mutateConfigFile() { configWrites++; throw new Error("No Host config writes"); } },
    llm: { async complete() { modelCalls++; throw new Error("No model requests in this Core/Git fixture"); } } },
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    on(name: string, handler: Hook) { hooks.set(name, handler); },
    registerTool(factory: (context: ToolContext) => Tool | null) { factories.push(factory); },
  } as unknown as OpenClawPluginApi;
  // Only the synthetic Host envelope/context cross a type assertion boundary.
  const event = (index: number, body = `SYNTHETIC_LIFETIME_OWNER_INPUT_${String(index).padStart(4, "0")}`): Event => ({
    runId: `synthetic-lifetime-run-${index}`, sessionKey: key, sendPolicy: "allow", inboundAudio: false,
    ctx: { SessionKey: key, Body: body, SenderId: "synthetic-owner", From: "synthetic-owner", Provider: "webchat", ChatType: "direct", CommandAuthorized: true },
  } as Event);
  const context = { dispatchKind: "agent", cfg: live, abortSignal: controller.signal, recordProcessed() {}, markIdle() {},
    dispatcher: { appendBeforeDeliver() {}, sendFinalReply() { throw new Error("No generated delivery"); } } } as unknown as Context;
  return { root, parent, config, api, authority, state, storePath, hooks, factories, controller, event, context,
    counts: () => ({ modelCalls, configWrites }) };
}

test("failed ingress preparations release completed frames across 260 distinct requests", async t => {
  const f = await hostFixture(t); let calls = 0;
  const current: () => Promise<Runtime> = async () => { calls++; throw new CatalogError(preparationFailure); };
  const ingress = registerCheckpointRequestIngress(f.api, f.config, current); t.after(() => ingress.close());
  for (let index = 1; index <= 260; index++) {
    const result = await ingress.dispatch(f.event(index), f.context);
    assert.ok(result && "handled" in result && result.handled);
    assert.equal(ingress.status()?.category, preparationFailure, `Request ${index} must reach its preparation, not an accumulated capacity limit`);
  }
  assert.equal(calls, 260); assert.deepEqual(f.counts(), { modelCalls: 0, configWrites: 0 });
});

test("256 live ingress keys remain bounded, same-key users share preparation, and settled failures free capacity", async t => {
  const f = await hostFixture(t); let calls = 0, release!: () => void;
  const held = new Promise<Runtime>((_resolve, reject) => { release = () => reject(new CatalogError(preparationFailure)); });
  const current: () => Promise<Runtime> = () => { calls++; return held; };
  const ingress = registerCheckpointRequestIngress(f.api, f.config, current); t.after(() => ingress.close());
  const first = f.event(1), pending = [ingress.dispatch(first, f.context), ingress.dispatch(first, f.context)];
  for (let index = 2; index <= 256; index++) pending.push(ingress.dispatch(f.event(index), f.context));
  try {
    assert.equal(calls, 256, "One pending Frame per key; duplicate users share its prepared promise");
    const refused = await ingress.dispatch(f.event(257), f.context);
    assert.ok(refused && "handled" in refused && refused.handled);
    assert.equal(ingress.status()?.category, "checkpoint_ingress_capacity"); assert.equal(calls, 256);
    release(); await Promise.all(pending);
    await ingress.dispatch(f.event(258), f.context);
    assert.equal(calls, 257, "A settled failed preparation must no longer consume the active-key budget");
    assert.equal(ingress.status()?.category, preparationFailure);
  } finally { release(); await Promise.all(pending); }
  assert.deepEqual(f.counts(), { modelCalls: 0, configWrites: 0 });
});

function archivedSnapshot(plan: MemoryTransactionPlan, runId: string) {
  const matches = plan.files.flatMap(file => {
    try { const value: unknown = JSON.parse(file.after);
      return isRecord(value) && value.schemaVersion === "stella.host-request-snapshot/v1" && isRecord(value.request) && value.request.runId === runId ? [{ file, value }] : [];
    } catch { return []; }
  });
  assert.equal(matches.length, 1); return matches[0]!;
}

test("260 real Core archive transactions preserve journals and feed the final request into fresh tools without a lifetime cap", { timeout: 600_000 }, async t => {
  const source = await createAgentSupplySource(); t.after(() => rm(source.root, { recursive: true, force: true }));
  const f = await hostFixture(t, source.root);
  let currentPromise: ReturnType<typeof createCheckpointPluginRuntime> = createCheckpointPluginRuntime(f.config, "2026.8.2");
  const current = () => currentPromise, runtime = await current();
  t.after(async () => { (await currentPromise).close(); });
  await runtime.initializeAuthority({ revision: source.revision, operationId: "synthetic-lifetime-initialize" });
  const ingress = registerCheckpointRequestIngress(f.api, f.config, current); t.after(() => ingress.close());
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", source.root, ...args], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const first = f.event(1), latest = f.event(260);
  let firstRevision = "", firstOperation = "";
  for (let index = 1; index <= 259; index++) {
    const event = index === 1 ? first : f.event(index), result = await ingress.dispatch(event, f.context);
    assert.ok(result && "recovery" in result && result.recovery, `Archive ${index} failed: ${JSON.stringify(ingress.status())}`);
    if (index % 64 === 0) console.log(JSON.stringify({ stage: "checkpoint-ingress-lifetime", archived: index, total: 260 }));
    assert.equal(ingress.status()?.state, "local_committed"); assert.equal(ingress.status()?.runId, event.runId);
    assert.equal(ingress.status()?.capturedAtSource, "core_receive_clock");
    if (index === 1) { firstRevision = result.recovery.expected.revision; firstOperation = ingress.status()!.operationId!; }
  }
  let beforePrepareCalls = 0;
  const supply = registerCheckpointAgentSupply(f.api, f.config, current, undefined, async (event, ctx) => {
    beforePrepareCalls++; return ingress.dispatch(event, ctx);
  });
  t.after(() => supply.close());
  assert.equal(await f.hooks.get("reply_dispatch")!(latest, f.context), undefined, JSON.stringify(ingress.status()));
  assert.equal(beforePrepareCalls, 1); assert.equal(ingress.status()?.runId, latest.runId);
  assert.equal(ingress.status()?.state, "local_committed"); assert.equal(ingress.status()?.capturedAtSource, "core_receive_clock");
  const accepted = (await runtime.capture()).expected;
  const agent = { agentId: "synthetic", sessionKey: key, sessionId, runId: latest.runId };
  assert.equal((await supply.beforeAgentRun({ messages: [], senderIsOwner: true }, agent)).outcome, "pass");
  const toolContext: ToolContext = { agentId: "synthetic", sessionKey: key, sessionId, senderIsOwner: true, requesterSenderId: "synthetic-owner" };
  const tool = f.factories.map(factory => factory(toolContext)).find(value => value?.name === CHECKPOINT_MEMORY_TOOL); assert.ok(tool);
  let toolCalls = 0;
  const call = async (input: unknown) => {
    const toolCallId = `synthetic-lifetime-tool-${++toolCalls}`;
    assert.equal(await f.hooks.get("before_tool_call")!({ toolName: CHECKPOINT_MEMORY_TOOL, params: input },
      { ...agent, toolName: CHECKPOINT_MEMORY_TOOL, toolCallId, abortSignal: f.controller.signal }), undefined);
    return record((await tool.execute(toolCallId, input, f.controller.signal)).details);
  };
  const reader = await CatalogReader.load(source.root, source.catalogPath), count = reader.catalog.evidence.filter(entry => entry.status === "current").length;
  assert.equal(count, 261, "The seed plus all 260 owner inputs remain catalogued");
  const page = await call({ action: "list", cursor: Math.floor((count - 1) / 16) * 16 });
  assert.equal(page.nextCursor, null); assert.ok(Array.isArray(page.items));
  const finalItem = page.items.map(record).find(item => typeof item.preview === "string" && item.preview.includes(latest.ctx.Body!)); assert.ok(finalItem);
  const read = await call({ action: "read", handle: finalItem.handle });
  assert.equal(record(read.original).text, latest.ctx.Body); assert.deepEqual(record(read.original).ref, finalItem.evidence);
  assert.equal(record(read.currentMemory).checkpointRevision, accepted.revision);
  assert.equal(record(read.currentMemory).checkpointToken, accepted.token);
  assert.equal(record(read.currentMemory).userRequest, latest.runId);
  await f.hooks.get("agent_end")!({}, agent); supply.assertIdle();
  const operations = path.posix.join(path.posix.dirname(source.catalogPath), "operations");
  const paths = (await git("ls-tree", "-r", "--name-only", "HEAD", "--", operations)).split("\n");
  assert.equal(paths.filter(file => file.endsWith(".checkpoint.json")).length, 260);
  assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), "260");
  const firstPlan = await readRecordedMemoryTransaction(source.root, firstOperation, `${operations}/${firstOperation}.checkpoint.json`);
  const original = archivedSnapshot(firstPlan, first.runId!);
  assert.equal(record(original.value.request).prompt, first.ctx.Body);
  const historic = record(JSON.parse(await readCheckpointCommittedDocument(source.root, firstRevision, original.file.path)));
  assert.equal(record(historic.request).prompt, first.ctx.Body, "The first original remains readable at its original committed Git version");
  const latestOperation = ingress.status()!.operationId!;
  const latestPlan = await readRecordedMemoryTransaction(source.root, latestOperation, `${operations}/${latestOperation}.checkpoint.json`);
  assert.equal(record(archivedSnapshot(latestPlan, latest.runId!).value.request).prompt, latest.ctx.Body);
  const replay = await ingress.dispatch(latest, f.context); assert.ok(replay && "recovery" in replay && replay.recovery);
  assert.deepEqual(replay.recovery.expected, accepted); assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), "260");
  const changed = f.event(260, "SYNTHETIC_CHANGED_BODY_WITH_THE_SAME_RUN_ID");
  assert.ok("handled" in (await ingress.dispatch(changed, f.context))!);
  assert.equal(ingress.status()?.category, "checkpoint_ingress_replay_conflict"); assert.deepEqual((await runtime.capture()).expected, accepted);
  const stale = await ingress.dispatch(first, f.context); assert.ok(stale && "handled" in stale);
  assert.ok(["checkpoint_runtime_git_mismatch", "checkpoint_runtime_stale", "checkpoint_conflict"].includes(ingress.status()?.category ?? ""), JSON.stringify(ingress.status()));
  assert.deepEqual((await runtime.capture()).expected, accepted); assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), "260");
  ingress.close(); supply.close(); runtime.close();
  currentPromise = createCheckpointPluginRuntime(f.config, "2026.8.2");
  const restarted = registerCheckpointRequestIngress(f.api, f.config, current); t.after(() => restarted.close());
  const restored = await restarted.dispatch(latest, f.context); assert.ok(restored && "recovery" in restored && restored.recovery, JSON.stringify(restarted.status()));
  assert.deepEqual(restored.recovery.expected, accepted);
  assert.equal(restarted.status()?.capturedAtSource, "core_receive_clock");
  assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), "260"); assert.equal(await git("status", "--porcelain"), "");
  assert.deepEqual(f.counts(), { modelCalls: 0, configWrites: 0 });
});
