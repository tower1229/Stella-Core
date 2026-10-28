import assert from "node:assert/strict";
import test from "node:test";
import { assertHostReplayTarget, loadHostReplayProjection, resolveHostReplayTarget } from "../src/openclaw/host-context-replay.js";
import { FRAGMENT_READ_DESCRIPTION, FRAGMENT_READ_PARAMETERS, FRAGMENT_READ_TOOL } from "../src/openclaw/fragment-read-tool.js";
import { appendAssistantTrace, assembleContextTrace, contextFragmentTrace, contextInputDigest, projectContextTrace, readContextInputTrace } from "../src/openclaw/host-context-graph.js";
import type { HostMemoryInput } from "../src/openclaw/host-memory-provider.js";

const modelRef = "stella-guarded/gemini-3.8-flash";
const configuration = () => ({ models: { providers: { "stella-guarded": { api: "google-generative-ai",
  models: [{ id: "gemini-3.8-flash" }] } } } });
type Input = Omit<HostMemoryInput, "tools"> & { tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> };
const schema = (value: HostMemoryInput) => value.tools[0]!.parameters as Record<string, unknown>;
const input = (): Input => ({ systemPrompt: "Synthetic public rules", messages: [{ role: "user", content: "Synthetic current input", timestamp: 0 }],
  tools: [{ name: FRAGMENT_READ_TOOL, description: FRAGMENT_READ_DESCRIPTION, parameters: structuredClone(FRAGMENT_READ_PARAMETERS) as unknown as Record<string, unknown> }] });

test("replay target requires explicit unique model/API configuration without reading credentials", () => {
  const config = configuration();
  Object.defineProperty(config.models.providers["stella-guarded"], "apiKey", { get() { throw new Error("Credentials must not be read"); } });
  const target = resolveHostReplayTarget(config, modelRef)!;
  assert.deepEqual(target, { provider: "stella-guarded", modelId: "gemini-3.8-flash", api: "google-generative-ai" });
  assert.ok(Object.isFrozen(target));
  config.models.providers["stella-guarded"].api = "other";
  assert.equal(target.api, "google-generative-ai");
  assert.equal(resolveHostReplayTarget({}, modelRef), undefined);
  assert.equal(resolveHostReplayTarget(configuration(), "google/gemini-3.8-flash"), undefined);
  const duplicate = configuration(); duplicate.models.providers["stella-guarded"].models.push({ id: "gemini-3.8-flash" });
  assert.equal(resolveHostReplayTarget(duplicate, modelRef), undefined);
});

test("actual provider API/model must match the independently bound replay target", () => {
  const target = resolveHostReplayTarget(configuration(), modelRef);
  assertHostReplayTarget(target, modelRef, "google-generative-ai");
  assert.throws(() => assertHostReplayTarget(target, modelRef, "openai-completions"), /host_context_replay_target_changed/);
  assert.throws(() => assertHostReplayTarget(target, "stella-guarded/other", "google-generative-ai"), /host_context_replay_target_changed/);
});

test("fixed Google projection changes only the known declaration from original bound input", async () => {
  const prior = input(), snapshot = structuredClone(prior);
  const project = await loadHostReplayProjection("2026.8.2", resolveHostReplayTarget(configuration(), modelRef));
  const wire = project(prior);
  const expected = structuredClone(prior); delete expected.tools[0]!.parameters.additionalProperties;
  assert.equal(contextInputDigest(wire), contextInputDigest(expected));
  assert.deepEqual(prior, snapshot);
  assert.equal(schema(prior).additionalProperties, false);
  assert.equal(Object.hasOwn(schema(wire), "additionalProperties"), false);
  const wrong = structuredClone(wire); wrong.messages[0]!.content = "Unbound source";
  assert.notEqual(contextInputDigest(wrong), contextInputDigest(project(prior)));
});

test("Google codec cannot be selected by observed schema or for another Host/model", async () => {
  const prior = input();
  assert.equal(schema((await loadHostReplayProjection("2026.8.2"))(prior)).additionalProperties, false);
  const openai = { provider: "stella-guarded", modelId: "gemini-3.8-flash", api: "openai-completions" };
  assert.equal(schema((await loadHostReplayProjection("2026.8.2", openai))(prior)).additionalProperties, false);
  await assert.rejects(loadHostReplayProjection("2026.8.1", resolveHostReplayTarget(configuration(), modelRef)), /host_context_replay_version_unsupported/);
  await assert.rejects(loadHostReplayProjection("2026.8.2", { ...openai, api: "google-generative-ai", modelId: "other" }), /host_context_replay_target_unsupported/);
});

// D-062 replacements for "already omitted" and the non-Stella schema assertion:
// docs/HOST-REPLAY-CODEC-MIGRATION.md. The other seven legacy cases stay active.
for (const mutation of ["required", "enum", "extra property", "description"] as const) test(`Google original schema rejects unbound ${mutation}`, async () => {
  const original = input(), tool = original.tools[0]!;
  if (mutation === "required") tool.parameters.required = ["action", "handle"];
  if (mutation === "enum") tool.parameters.properties = { action: { type: "string", enum: ["read", "delete"] } };
  if (mutation === "extra property") tool.parameters.properties = { ...(tool.parameters.properties as Record<string, unknown>), path: { type: "string" } };
  if (mutation === "description") tool.description += " extra";
  const project = await loadHostReplayProjection("2026.8.2", resolveHostReplayTarget(configuration(), modelRef));
  assert.throws(() => project(original), /host_context_google_tool_schema_unbound/);
});

test("Google projected tool declaration keeps original system lineage and validates archived assistant basis", async () => {
  const original = input();
  const sources = { dependencies: [], originals: [], payloads: [], configurationInputs: [], archives: [] };
  const trace = assembleContextTrace(original, [], [contextFragmentTrace("current_input", "Synthetic current input", sources)]);
  const wire = (await loadHostReplayProjection("2026.8.2", resolveHostReplayTarget(configuration(), modelRef)))(original);
  const projected = projectContextTrace(trace, wire);
  assert.notEqual(projected.system, trace.system);
  assert.deepEqual(projected.nodes.find(node => node.id === projected.system)!.parents, [trace.system]);
  assert.ok(projected.nodes.some(node => node.id === trace.system && node.content.includes('"additionalProperties":false')));
  readContextInputTrace(projected, wire, sources);
  const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "Synthetic answer" }],
    api: "google-generative-ai", provider: "stella-guarded", model: "gemini-3.8-flash", stopReason: "stop" as const, timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const archived = appendAssistantTrace(projected, wire, message);
  const completed = { ...wire, messages: [...wire.messages, message] };
  readContextInputTrace(archived, completed, sources);
  const restored = projectContextTrace(archived, { ...completed, tools: original.tools });
  readContextInputTrace(restored, { ...completed, tools: original.tools }, sources);
  const tampered = structuredClone(restored);
  tampered.nodes.find(node => node.producer === "assistant")!.basisDigest = contextInputDigest(original);
  assert.throws(() => readContextInputTrace(tampered, { ...completed, tools: original.tools }, sources), /host_context_graph_invalid/);
});
