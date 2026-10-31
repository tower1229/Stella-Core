import test from "node:test";
import assert from "node:assert/strict";
import { createToolRequestBinding } from "../src/openclaw/tool-request-binding.js";
import plugin, { CANDIDATE_TOOL } from "../src/ordinary-plugin.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const identity = { agentId: "main", sessionKey: "agent:main:synthetic", sessionId: "synthetic-session" };
const event = (call = "call-1", run: string | undefined = "run-1") => ({ toolName: CANDIDATE_TOOL, toolCallId: call, runId: run });

test("exact public run/call and factory session bind without reading tool params or author facts", () => {
  const binding = createToolRequestBinding("main", CANDIDATE_TOOL);
  const e = Object.defineProperty(event(), "params", { get() { throw Error("No proposal reads"); } });
  const c = Object.defineProperty({ ...identity, ...event() }, "requester", { get() { throw Error("No author reads"); } });
  assert.equal(binding.observe(e, c), undefined);
  assert.deepEqual(binding.consume("call-1", identity), { status: "bound", scope: "run_and_tool_call", code: "host_run_and_call_observed",
    agentId: "main", toolCallId: "call-1", runId: "run-1", sessionBound: true, sessionIncarnationBound: true,
    authorConfirmation: false, inputAdmission: "not_connected" });
  assert.deepEqual(binding.consume("call-1", identity), { status: "unavailable", code: "host_tool_hook_not_observed" });
});

test("direct invocation keeps missing run explicit and never upgrades it to user admission", () => {
  const binding = createToolRequestBinding("main", CANDIDATE_TOOL);
  const e = { toolName: CANDIDATE_TOOL, toolCallId: "rpc-call" };
  assert.equal(binding.observe(e, { ...identity, ...e }), undefined);
  const result = binding.consume("rpc-call", identity);
  assert.equal(result.status, "bound"); assert.equal(result.scope, "tool_call");
  assert.equal(result.runId, null); assert.equal(result.code, "host_run_not_provided");
  assert.equal(result.inputAdmission, "not_connected"); assert.equal(result.authorConfirmation, false);
  const { sessionId: _sessionId, ...withoutIncarnation } = identity;
  for (const [hook, factory] of [[withoutIncarnation, withoutIncarnation], [identity, withoutIncarnation], [withoutIncarnation, identity]]) {
    const next = createToolRequestBinding("main", CANDIDATE_TOOL);
    next.observe(e, { ...hook, ...e });
    const missing = next.consume("rpc-call", factory);
    assert.equal(missing.status, "bound"); assert.equal(missing.sessionIncarnationBound, false);
  }
});

test("different calls and same-session runs stay distinct; identity conflicts and ambiguity reject", () => {
  const binding = createToolRequestBinding("main", CANDIDATE_TOOL);
  binding.observe(event("a", "run-a"), { ...identity, ...event("a", "run-a") });
  binding.observe(event("b", "run-b"), { ...identity, ...event("b", "run-b") });
  assert.equal(binding.consume("b", identity).runId, "run-b");
  assert.equal(binding.consume("a", identity).runId, "run-a");
  for (const changed of [{ ...identity, agentId: "other" }, { ...identity, sessionKey: "agent:main:other" }, { ...identity, sessionId: "other-incarnation" }]) {
    binding.observe(event(), { ...identity, ...event() });
    assert.equal(binding.consume("call-1", changed).status, "rejected");
  }
  binding.observe(event(), { ...identity, ...event() });
  assert.equal(binding.observe(event(), { ...identity, ...event() }), "stella_request_binding_ambiguous");
  assert.equal(binding.consume("call-1", identity).status, "rejected");
});

test("malformed event/context pairs reject; unrelated agents/tools never enter the pending map", () => {
  const binding = createToolRequestBinding("main", CANDIDATE_TOOL);
  for (const change of [{ toolCallId: "different" }, { runId: "different" }, { sessionKey: undefined }, { runId: "x".repeat(513) }, { sessionId: "x".repeat(513) }]) {
    assert.equal(binding.observe(event(), { ...identity, ...event(), ...change }), "stella_request_binding_invalid");
  }
  binding.observe(event(), { ...identity, ...event(), agentId: "other" });
  binding.observe({ ...event(), toolName: "other_tool" }, { ...identity, ...event() });
  assert.equal(binding.consume("call-1", identity).status, "unavailable");
});

for (const [name, invalid] of [["empty", ""], ["null", null], ["number", 7], ["same object", {}]] as const) {
  test(`incarnation rejects ${name} sessionId from hook and factory`, () => {
    const malformed = { ...identity, sessionId: invalid } as unknown as typeof identity;
    const observed = createToolRequestBinding("main", CANDIDATE_TOOL);
    assert.equal(observed.observe(event(), { ...malformed, ...event() }), "stella_request_binding_invalid");
    const result = observed.consume("call-1", malformed);
    assert.equal(result.status, "unavailable"); assert.notEqual(result.sessionIncarnationBound, true);
    const factory = createToolRequestBinding("main", CANDIDATE_TOOL);
    assert.equal(factory.observe(event(), { ...identity, ...event() }), undefined);
    assert.equal(factory.consume("call-1", malformed).status, "rejected");
  });
}

test("cancellation removes pending metadata; capacity is explicit and consumption frees a slot", () => {
  const binding = createToolRequestBinding("main", CANDIDATE_TOOL), abort = new AbortController();
  binding.observe(event(), { ...identity, ...event(), abortSignal: abort.signal }); abort.abort();
  assert.equal(binding.consume("call-1", identity).status, "unavailable");
  assert.equal(binding.observe(event(), { ...identity, ...event(), abortSignal: abort.signal }), "stella_request_binding_cancelled");
  for (let i = 0; i < 128; i++) assert.equal(binding.observe(event(`c${i}`), { ...identity, ...event(`c${i}`) }), undefined);
  assert.equal(binding.observe(event("overflow"), { ...identity, ...event("overflow") }), "stella_request_binding_capacity");
  binding.consume("c0", identity);
  assert.equal(binding.observe(event("after-consume"), { ...identity, ...event("after-consume") }), undefined);
});

test("plugin hook metadata reaches only the exact candidate execution and retains unsaved/source-off contract", async () => {
  let factory: any; const hooks = new Map<string, Function>();
  plugin.register!({ pluginConfig: { agentId: "main", publisher: false }, on(name: string, handler: Function) { hooks.set(name, handler); },
    registerTool(value: unknown) { factory = value; }, registerCommand() {} } as unknown as OpenClawPluginApi);
  const context = { ...identity, assertInvocationCurrent() {} };
  const tool = factory.create(context).find((t: any) => t.name === CANDIDATE_TOOL);
  assert.equal(hooks.get("before_tool_call")!(event(), { ...identity, ...event() }), undefined);
  const proposal = { topic: "Synthetic", interpretation: "Unconfirmed", proposedPremises: [], openQuestions: ["Still unresolved"], evidenceReferences: [] };
  const result = await tool.execute("call-1", proposal);
  assert.equal(result.details.requestBinding.runId, "run-1"); assert.equal(result.details.status, "candidate");
  assert.equal(result.details.saved, false); assert.equal(result.details.publisher, false); assert.equal(result.details.authorConfirmation, false);
  context.sessionId = "changed";
  await assert.rejects(tool.execute("call-2", proposal), /factory_identity_changed/);
});
