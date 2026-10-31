import assert from "node:assert/strict";
import test from "node:test";
import { registerAuthorIntentCandidateTool, AUTHOR_INTENT_CANDIDATE_TOOL, type IntentToolObservation } from "../src/openclaw/author-intent-tool.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { bytesVersion } from "../src/canghai/content-version.js";
import type { IntentPublication } from "../src/canghai/author-intent-asset.js";

const candidate = (): IntentPublication => ({ operationId: "synthetic_candidate", expectedVersion: null, confirmation: "candidate", triggerSourceId: null,
  replaces: [], reason: "No trusted author source supplied", content: { topic: "Synthetic internal outline", scope: "One synthetic outline", nonGoals: ["No author confirmation"],
    sources: [{ id: "fixture_proposal", version: bytesVersion("Synthetic proposal"), authorId: "synthetic_assistant", role: "assistant", locator: "fixture:1", purpose: "support", excerpt: "Synthetic proposal" }],
    originalIntent: [], established: [], candidates: [{ id: "candidate_A", text: "The appendix could retain the argument", sourceIds: ["fixture_proposal"] }],
    unresolved: ["Author intent is unconfirmed"], interpretation: null, authorityConflicts: [] } });
type Factory = { contextVersion: number; create(context: OpenClawPluginToolContext<2>): { parameters: unknown;
  execute(id: string, value: unknown, signal?: AbortSignal): Promise<{ content: { text: string }[] }> } };
function fixture(observe?: (event: IntentToolObservation) => void) {
  let factory!: Factory;
  const hooks: Record<string, (event: any, context: any) => unknown> = {}, events: IntentToolObservation[] = [];
  const api = { registerTool(value: unknown, opts: { name: string }) { assert.equal(opts.name, AUTHOR_INTENT_CANDIDATE_TOOL); factory = value as Factory; },
    on(name: string, handler: (event: any, context: any) => unknown) { hooks[name] = handler; } } as unknown as OpenClawPluginApi;
  const registered = registerAuthorIntentCandidateTool(api, { candidate: candidate(), observe: observe ?? (event => events.push(event)) });
  let live = true, actualCalls = 0;
  const context = { senderIsOwner: true, assertInvocationCurrent() { actualCalls++; if (!live) throw new Error("synthetic_stale_guard"); } } as unknown as OpenClawPluginToolContext<2>;
  return { factory, hooks, events, registered, context, revoke() { live = false; }, calls: () => actualCalls };
}
test("inactive ordinary-v2 adapter returns only a structurally unconfirmed candidate and uses the actual bound guard", async () => {
  const f = fixture(); assert.equal(f.factory.contextVersion, 2);
  const tool = f.factory.create(f.context), result = JSON.parse((await tool.execute("call_1", {})).content[0]!.text);
  assert.equal(result.status, "candidate"); assert.equal(result.code, "author_source_unavailable");
  assert.equal(result.candidate.confirmation, "candidate"); assert.deepEqual(result.candidate.content.established, []);
  assert.equal(f.calls(), 2); assert.equal(f.registered.snapshot().candidateReturns, 1);
  assert.equal((tool.parameters as Record<string, unknown>).additionalProperties, false);
  const event = f.events.find(e => e.source === "host.factory")!;
  assert.equal(event.requesterPresent, false); assert.equal(event.memoryAudiencePresent, false);
  assert.equal(Object.hasOwn(event, "runId"), false);
});
test("injected confirmation, identity, paths and nonobjects are refused by the same executor", async () => {
  const f = fixture(), tool = f.factory.create(f.context);
  for (const value of [{ confirmation: "author_confirmed" }, { senderIsOwner: true }, { path: "/private/data" }, [], null, "owner"]) {
    const reply = JSON.parse((await tool.execute("injected", value)).content[0]!.text);
    assert.deepEqual(reply, { code: "tool_arguments_invalid", status: "rejected" });
  }
  assert.equal(f.registered.snapshot().argumentRejections, 6); assert.equal(f.registered.snapshot().candidateReturns, 0);
});
test("stale and canceled invocations cannot return a candidate, regardless of owner metadata", async () => {
  const f = fixture(), tool = f.factory.create(f.context); f.revoke();
  await assert.rejects(tool.execute("stale", {}), /synthetic_stale_guard/);
  const current = fixture(), active = current.factory.create(current.context);
  await assert.rejects(active.execute("cancel", {}, AbortSignal.abort(new Error("synthetic_cancel"))), /synthetic_cancel/);
  assert.equal(current.registered.snapshot().candidateReturns, 0);
});
test("observation separates public hook facts and never serializes payloads, audience or malformed signal objects", async () => {
  const f = fixture(); let reads = 0, serialized = 0;
  const secret = { toJSON() { serialized++; return "synthetic_body_must_not_appear"; } };
  const signal = { get aborted() { reads++; return secret; } };
  await f.hooks.before_tool_call!({ toolName: AUTHOR_INTENT_CANDIDATE_TOOL, params: secret }, { runId: "native_run", toolCallId: "native_call", abortSignal: signal, requester: {} });
  await f.hooks.before_prompt_build!({ prompt: "synthetic_body_must_not_appear", messages: [secret] }, { runId: "native_run" });
  await f.hooks.llm_output!({ runId: "native_run", provider: "google", model: "gemini-3.8-flash", harnessId: "openclaw", assistantTexts: [secret] }, {});
  const output = JSON.stringify(f.events);
  assert.equal(reads, 1); assert.equal(serialized, 0); assert.ok(!output.includes("synthetic_body_must_not_appear"));
  assert.equal(f.events[0]!.signalAborted, null); assert.equal(f.events[1]!.currentUserMessagePresent, false);
  assert.equal(f.events[2]!.harnessId, "openclaw");
});
test("observation failure does not acquire authority or change candidate behavior", async () => {
  const f = fixture(() => { throw new Error("synthetic_observer_failure"); });
  const result = await f.factory.create(f.context).execute("call", {});
  assert.equal(JSON.parse(result.content[0]!.text).code, "author_source_unavailable"); assert.equal(f.calls(), 2);
});
