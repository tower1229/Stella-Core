import { createPersonalContextAccess, loadPersonalContextAccess, parsePersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { createSourceAccessProvider, type SourceAccessTarget } from "../src/canghai/source-access.js";

const purpose = { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "owner-direct" };
const request = "请回顾我上次明确提到的那件合成事件。";
async function fixture(t: { after(fn: () => Promise<void>): void }, permissions = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-source-access-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  const put = async (group: "sources" | "policies", object: Record<string, unknown>) => {
    const ref = { id: String(object.id), version: objectVersion(object) }, file = `${ref.id}.json`;
    const bytes = canonicalJson(object);
    await writeFile(path.join(root, file), bytes);
    catalog[group].push({ ...ref, status: "current", dependencies: [], locator: { path: file, sha256: bytesVersion(bytes) } });
    return ref;
  };
  const policyRef = await put("policies", { schemaVersion: "stella.source-policy/v2", id: "policy", ownerId: "synthetic",
    readPurposes: permissions ? [purpose.readPurpose] : [], derivePurposes: [purpose.derivePurpose], deliveryScopes: [purpose.deliveryScope],
    retention: "retain", authorityEvidenceRefs: [], restrictions: { sensitivity: "sensitive", quotePolicy: "summarize_only",
      allowedScenarios: ["self_reflection"], forbiddenScenarios: ["relationship_judgment"] } });
  const sourceRef = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "source-one" });
  const otherRef = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "source-two" });
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  return { root, catalog, target: { sourceRef, policyRef }, other: { sourceRef: otherRef, policyRef }, reader: await CatalogReader.load(root, "catalog.json") };
}
const answer = (target: SourceAccessTarget, extra: Record<string, unknown> = {}) => ({ text: JSON.stringify({
  requestHash: bytesVersion(request), ...target, applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true, ...extra,
}) });
const describe = async (_reader: CatalogReader, target: SourceAccessTarget) => ({ ...target, description: "Reviewed synthetic event topic, not original evidence." });

test("one source's semantic verdict cannot authorize a second source sharing its policy", async t => {
  const f = await fixture(t);
  const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [], describe,
    complete: async () => answer(f.target) });
  const context = await access(f.reader, f.target, purpose);
  assert.equal(context.judgment.topicExplicitlyNamed, true);
  await assert.rejects(access(f.reader, f.other, purpose), /invalid_source_access_verdict/);
});

test("denied purposes and missing quote grants stop before metadata or model disclosure", async t => {
  const f = await fixture(t, false);
  let calls = 0;
  const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [],
    describe: async (...args) => { calls++; return describe(...args); }, complete: async () => { calls++; return answer(f.target); } });
  await assert.rejects(access(f.reader, f.target, purpose), /permission_denied/);
  assert.equal(calls, 0);
  const g = await fixture(t);
  const quoting = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "quote", quoteGrants: [],
    describe: async (...args) => { calls++; return describe(...args); }, complete: async () => { calls++; return answer(g.target); } });
  await assert.rejects(quoting(g.reader, g.target, purpose), /source_quote_authorization_required/);
  assert.equal(calls, 0);
});

test("model output cannot override Host trigger, presentation or quote authority", async t => {
  const f = await fixture(t);
  for (const injected of [{ trigger: "user_requested" }, { quoteGrants: [f.target.policyRef] }, { presentation: "summary" }]) {
    const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [], describe,
      complete: async () => answer(f.target, injected) });
    await assert.rejects(access(f.reader, f.target, purpose), /invalid_source_access_verdict/);
  }
  const access = createSourceAccessProvider({ request, trigger: "proactive", presentation: "summary", quoteGrants: [], describe,
    complete: async () => { throw new Error("Must not call model"); } });
  await assert.rejects(access(f.reader, f.target, purpose), /source_trigger_forbidden/);
});

test("unrelated topics, forbidden uses, and old request verdicts fail explicitly", async t => {
  const f = await fixture(t);
  for (const [extra, category] of [
    [{ applicable: false, scenarios: [] }, /source_topic_unresolved/],
    [{ scenarios: ["self_reflection", "relationship_judgment"] }, /source_scenario_forbidden/],
    [{ topicExplicitlyNamed: false }, /source_topic_required/],
    [{ requestHash: bytesVersion("another request") }, /invalid_source_access_verdict/],
  ] as const) {
    const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [], describe,
      complete: async () => answer(f.target, extra) });
    await assert.rejects(access(f.reader, f.target, purpose), category);
  }
});

test("source descriptors are version bound and cannot rewrite the requested target", async t => {
  const f = await fixture(t);
  const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [],
    describe: async (_reader, target) => { Object.assign(target, f.other); return { ...target, description: "Wrong source" }; },
    complete: async () => { throw new Error("Must not call model"); } });
  await assert.rejects(access(f.reader, f.target, purpose), /source_access_descriptor_mismatch/);
});

test("asynchronous judgments cannot outlive catalog changes, cancellation, or policy tampering", async t => {
  for (const kind of ["generation", "policy", "cancel"] as const) {
    const f = await fixture(t), abort = new AbortController();
    const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [], describe, signal: abort.signal,
      complete: async () => {
        if (kind === "generation") await writeFile(path.join(f.root, "catalog.json"), JSON.stringify({ ...f.catalog, generationId: "two" }));
        if (kind === "policy") await writeFile(path.join(f.root, "policy.json"), "{}");
        if (kind === "cancel") abort.abort();
        return answer(f.target);
      } });
    await assert.rejects(access(f.reader, f.target, purpose), kind === "generation" ? /stale_generation/ : kind === "policy" ? /locator_digest_mismatch/ : /source_access_cancelled/);
  }
});

test("provider failures expose only stable categories without private causes", async t => {
  const f = await fixture(t);
  const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [], describe,
    complete: async () => { throw new Error("PRIVATE_SENTINEL"); } });
  await assert.rejects(access(f.reader, f.target, purpose), error => error instanceof Error && error.message.endsWith("source_access_model_failed") && !error.message.includes("PRIVATE_SENTINEL"));
});

test("changing a topic descriptor during inference invalidates its verdict", async t => {
  const f = await fixture(t);
  let description = "Original reviewed topic";
  const access = createSourceAccessProvider({ request, trigger: "user_requested", presentation: "summary", quoteGrants: [],
    describe: async (_reader, target) => ({ ...target, description }),
    complete: async () => { description = "Different topic"; return answer(f.target); } });
  await assert.rejects(access(f.reader, f.target, purpose), /source_access_descriptor_changed/);
});

test("personal metadata processing requires exact Host requester, model, owner and purpose", async t => {
  const f = await fixture(t);
  const config = { schemaVersion: "stella.personal-context-access/v1", ownerId: "synthetic",
    requesterIds: ["owner-host-id"], modelRefs: ["synthetic/model"], purpose,
    descriptors: [{ ...f.target, description: "Reviewed synthetic topic" }] };
  const file = path.join(f.root, "access.json");
  await writeFile(file, JSON.stringify(config));
  const binding = await loadPersonalContextAccess(f.root, "access.json");
  const bound = snapshotTurnRequest({ agentId: "main", sessionId: "session", sessionKey: "agent:main:test",
    prompt: request, senderId: "owner-host-id", senderIsOwner: true, chatType: "direct" }, "run");
  let active = true, calls = 0;
  const input = { request: bound, binding, modelRef: "synthetic/model",
    assertRequestCurrent: () => { if (!active) throw new Error("expired"); },
    complete: async ({ prompt }: { prompt: string }) => {
      calls++;
      assert.match(prompt, /Reviewed synthetic topic/);
      return answer(f.target);
    } };
  const access = createPersonalContextAccess(input);
  await access(f.reader, f.target, purpose);
  assert.equal(calls, 1);
  for (const patch of [{ senderId: "other" }, { senderIsOwner: false }, { chatType: "group" as const }]) {
    assert.throws(() => createPersonalContextAccess({ ...input, request: { ...bound, ...patch } }), /personal_context_requester_forbidden/);
  }
  assert.throws(() => createPersonalContextAccess({ ...input, modelRef: "other/model" }), /personal_context_model_forbidden/);
  assert.throws(() => createPersonalContextAccess({ ...input, request: { ...bound, prompt: "different" } }), /personal_context_request_mismatch/);
  await assert.rejects(access(f.reader, f.target, { ...purpose, deliveryScope: "public" }), /personal_context_purpose_mismatch/);
  const wrongOwner = createPersonalContextAccess({ ...input, binding: { ...binding, config: { ...binding.config, ownerId: "other" } } });
  await assert.rejects(wrongOwner(f.reader, f.target, purpose), /source_access_descriptor_unavailable/);
  await assert.rejects(access(f.reader, f.other, purpose), /source_access_descriptor_unavailable/);
  assert.equal(calls, 1);
  active = false;
  await assert.rejects(access(f.reader, f.target, purpose), /expired/);
  active = true;
  await writeFile(file, JSON.stringify({ ...config, modelRefs: ["other/model"] }));
  await assert.rejects(access(f.reader, f.target, purpose), /personal_context_access_changed/);
  assert.equal(calls, 1);
  assert.throws(() => parsePersonalContextAccess({ ...config, descriptors: [...config.descriptors, ...config.descriptors] }), /duplicate_personal_context_descriptor/);
});

test("personal metadata grant revocation during inference invalidates the result", async t => {
  const f = await fixture(t);
  const config = { schemaVersion: "stella.personal-context-access/v1", ownerId: "synthetic",
    requesterIds: ["owner-host-id"], modelRefs: ["synthetic/model"], purpose,
    descriptors: [{ ...f.target, description: "Reviewed synthetic topic" }] };
  await writeFile(path.join(f.root, "access.json"), JSON.stringify(config));
  const access = createPersonalContextAccess({
    request: snapshotTurnRequest({ agentId: "main", sessionId: "session", sessionKey: "agent:main:test",
      prompt: request, senderId: "owner-host-id", senderIsOwner: true, chatType: "direct" }, "run"),
    modelRef: "synthetic/model", binding: await loadPersonalContextAccess(f.root, "access.json"),
    assertRequestCurrent() {},
    complete: async () => {
      await writeFile(path.join(f.root, "access.json"), JSON.stringify({ ...config, descriptors: [] }));
      return answer(f.target);
    },
  });
  await assert.rejects(access(f.reader, f.target, purpose), /personal_context_access_changed/);
});
