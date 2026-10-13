import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { clearMemoryPluginState, registerMemoryCapability, registerMemoryCorpusSupplement, type MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import { createNativeMemoryReader } from "../src/openclaw/native-memory-reader.js";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "../src/canghai/native-memory-origin.js";
import { inspectDeclaredHostMemory } from "../src/openclaw/host-memory-inventory.js";
import type { OriginalEvidence } from "../src/praxis/episode-evidence.js";

const origin: NativeMemoryOrigin = { schemaVersion: "stella.native-memory-origin/v1", hostVersion: "2026.8.2",
  agentId: "stella", provider: "memory-core", path: "memory/retained.md", fromLine: 1, lineCount: 1 };
const original: OriginalEvidence = { ref: { id: "evidence", version: `sha256:${"a".repeat(64)}` },
  text: "Retained source fragment.\n", role: "owner", kind: "statement", independentOriginId: "source",
  sourceAdapterId: "synthetic", occurredAt: null, authoredAt: null,
  capturedAt: "2026-10-13T00:00:00Z", coverageComplete: true };
function fixture() {
  const calls: string[] = [];
  const config: OpenClawConfig = { agents: { entries: { stella: { model: "stella-guarded/model" } } },
    hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true } } } },
    plugins: { entries: { "memory-core": { enabled: true }, "memory-wiki": { enabled: true } } } };
  let result: unknown = { status: "ok", path: origin.path, from: 1, lines: 1, text: "Retained source fragment." };
  let hits: unknown[] = [{ path: origin.path, startLine: 1, endLine: 1, snippet: "Retained source fragment.", score: 1, source: "memory" }];
  let live = true;
  // Only the public native transport ports are synthetic here. Exact Host
  // acceptance separately verifies the native calls and emitted bytes.
  const runtime = { getMemorySearchManager: async () => { calls.push("manager"); return { manager: {
    search: async () => { calls.push("search"); return hits; },
    readFile: async () => { calls.push("read"); return result; },
  } }; }, authorizeSearchHits: async (input: { requesterSessionKey: string; hits: unknown[] }) => {
    assert.equal(input.requesterSessionKey, "agent:stella:main"); calls.push("authorize"); return input.hits;
  } } as unknown as NonNullable<MemoryPluginCapability["runtime"]>;
  registerMemoryCapability("memory-core", { runtime });
  registerMemoryCorpusSupplement("memory-wiki", {
    search: async input => { assert.equal(input.agentSessionKey, "agent:stella:main"); calls.push("wiki.search"); return hits; },
    get: async input => { assert.equal(input.agentSessionKey, "agent:stella:main"); calls.push("wiki.get"); return result; },
  } as Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0]);
  const api = { runtime: { version: "2026.8.2", config: { current: () => config } } } as unknown as OpenClawPluginApi;
  return { calls, config, api, reader: createNativeMemoryReader(api, "stella", "agent:stella:main"),
    setResult: (value: unknown) => { result = value; }, setHits: (value: unknown[]) => { hits = value; },
    revoke: () => { live = false; }, current: async () => { if (!live) throw new Error("source_revoked"); } };
}

test("native memory origin accepts only a closed versioned relative range", () => {
  assert.deepEqual(parseNativeMemoryOrigin(origin), origin);
  for (const patch of [{ path: "../private.md" }, { path: "/absolute.md" }, { path: "memory/.git/private.md" },
    { path: "memory/source.txt" }, { path: "memory/a\\b.md" }, { path: "memory/a\u0000.md" }, { lineCount: 0 }, { lineCount: 121 },
    { fromLine: Number.MAX_SAFE_INTEGER },
    { fromLine: 0 }, { agentId: "" }, { provider: "arbitrary-plugin" }, { claimId: "wrong-provider" }, { grant: true }]) {
    assert.throws(() => parseNativeMemoryOrigin({ ...origin, ...patch }), /invalid_native_memory_origin/);
  }
});

test("native index bytes are consumed only after exact authorized hit and range validation", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture();
  assert.equal(await f.reader(origin, original, f.current), original.text);
  assert.deepEqual(f.calls, ["manager", "search", "authorize", "read"]);
  f.setResult({ status: "ok", path: origin.path, from: 1, lines: 1,
    text: "Retained source fragment.\n\n[More content available. Use from=2 to continue.]", truncated: true, nextFrom: 2 });
  assert.equal(await f.reader(origin, original, f.current), original.text);
  for (const patch of [{ text: "Changed cached content" }, { path: "memory/other.md" }, { from: 2 }, { lines: 2 },
    { status: "not_found" }, { text: "Retained source fragment.\nUNKNOWN" }, { truncated: true, nextFrom: 3 }]) {
    f.setResult({ status: "ok", path: origin.path, from: 1, lines: 1, text: "Retained source fragment.", ...patch });
    await assert.rejects(f.reader(origin, original, f.current), /native_memory_(payload_changed|read_unverifiable)/);
  }
  f.setHits([{ path: "memory/other.md", startLine: 1, endLine: 1 }]);
  const before = f.calls.filter(call => call === "read").length;
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_index_miss/);
  assert.equal(f.calls.filter(call => call === "read").length, before);
});

test("native wiki consumption revalidates between search and get and refuses changed cached bytes", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture(), wiki = { ...origin, provider: "memory-wiki" as const };
  f.setResult({ corpus: "wiki", path: origin.path, fromLine: 1, lineCount: 1, content: original.text });
  assert.equal(await f.reader(wiki, original, f.current), original.text);
  assert.deepEqual(f.calls, ["wiki.search", "wiki.get"]);
  f.setResult(null);
  await assert.rejects(f.reader({ ...wiki, claimId: "compiled-claim" }, original, f.current), /native_memory_read_unverifiable/);
  assert.equal(f.calls.filter(call => call === "wiki.get").length, 2, "Missing claim cache never retries by page path");
  f.setResult({ corpus: "wiki", path: origin.path, fromLine: 1, lineCount: 1, content: "Old cache bytes." });
  await assert.rejects(f.reader(wiki, original, f.current), /native_memory_payload_changed/);
  f.calls.length = 0;
  let checks = 0;
  await assert.rejects(f.reader(wiki, original, async () => { if (++checks === 2) f.revoke(); await f.current(); }), /source_revoked/);
  assert.deepEqual(f.calls, ["wiki.search"]);
});

test("native locators cannot enable absent providers, other agents or other Host versions", async t => {
  t.after(clearMemoryPluginState);
  const f = fixture();
  for (const patch of [{ agentId: "other" }, { hostVersion: "2026.8.3" }]) {
    await assert.rejects(f.reader({ ...origin, ...patch }, original, f.current));
  }
  f.config.plugins!.entries!["memory-core"]!.enabled = false;
  await assert.rejects(f.reader(origin, original, f.current), /native_memory_provider_disabled/);
  f.config.plugins!.entries!["memory-core"]!.enabled = true;
  f.config.hooks!.internal!.entries!["session-memory"]!.enabled = false;
  await assert.rejects(f.reader({ ...origin, provider: "session-memory" }, original, f.current), /native_session_memory_disabled/);
  assert.deepEqual(f.calls, []);
});

test("inventory records the built-in session-memory hook independently of plugins.list", () => {
  const f = fixture();
  const inspect = () => inspectDeclaredHostMemory({ config: f.config, agentId: "stella", generationId: "one", plugins: { plugins: [] } });
  const enabled = inspect();
  assert.equal(enabled.entries.find(entry => entry.kind === "session-memory")?.state, "unverifiable");
  assert.equal(enabled.complete, false);
  assert.ok(enabled.blockers.includes("host_memory_consumption_unverifiable"));
  delete f.config.hooks!.internal!.entries!["session-memory"];
  assert.equal(inspect().entries.find(entry => entry.kind === "session-memory")?.state, "unverifiable");
  f.config.hooks!.internal!.enabled = false;
  assert.equal(inspect().entries.find(entry => entry.kind === "session-memory")?.state, "disabled");
  clearMemoryPluginState();
});
