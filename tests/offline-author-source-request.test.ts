import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { createOfflineAuthorSourceRequest, SourceRequestError, type SourceRequest, type SourceAdmission,
  type OfflineSourceBinding, type CommittedSourceInput } from "../src/openclaw/offline-author-source-request.js";
import type { AuthorIntentPorts } from "../src/canghai/author-intent-repository.js";
import { bytesVersion } from "../src/canghai/content-version.js";

const toolName = "stella_author_intent_candidate";
const raw = "Synthetic author text with an unresolved appendix.";
function fixture(suffix = "A") {
  const request: SourceRequest = { runId: `run_${suffix}`, agentId: "fixture_agent", sessionId: "session_synthetic", sessionKey: "fixture:direct",
    clientIdempotencyKey: `client_${suffix}`, channel: "synthetic", accountId: "fixture_account", senderId: "fixture_sender" };
  const admission: SourceAdmission = { agentId: request.agentId, sessionId: request.sessionId, sessionKey: request.sessionKey,
    storePath: "synthetic:never-read", entryId: `entry_${suffix}`, logicalTurnId: `turn_${suffix}`, generation: "generation_fixture", rawSeq: 1,
    effectiveParentId: null, activeMessagePosition: 0, idempotencyKey: `native_input_${suffix}`, role: "user" };
  const state = { persisted: true, blocked: false, admission: structuredClone(admission) as unknown,
    message: { role: "user", content: raw, idempotencyKey: admission.idempotencyKey } as Record<string, unknown> };
  const accesses = { reads: 0, forbidden: 0, request: 0, sources: 0, version: 0, author: 0, resolve: 0, guard: 0, transport: 0 };
  const forbidden = () => { accesses.forbidden++; throw new Error("forbidden_recorder_mutation"); };
  const recorder = { hasPersisted() { accesses.reads++; return state.persisted; }, isBlocked() { accesses.reads++; return state.blocked; },
    getAdmissionReceipt() { accesses.reads++; return state.admission; }, getPersistedMessage() { accesses.reads++; return state.message; },
    persist: forbidden, persistApproved: forbidden, stageApproved: forbidden, markPersisted: forbidden, markRuntimePersisted: forbidden,
    markBlocked: forbidden, markSentToProvider: forbidden, setAdmissionHandler: forbidden,
    get message() { throw new Error("precommit_message_must_not_be_read"); }, resolveMessage: forbidden };
  const binding: OfflineSourceBinding = { request: structuredClone(request), admission: structuredClone(admission),
    source: { id: `fixture_source_${suffix}`, version: bytesVersion(`whole_source_${suffix}`), authorId: "fixture_author", role: "author",
      locator: "synthetic:whole-text", purpose: "support", excerpt: raw }, origin: "direct_author", representation: "exact_whole_text",
    senderId: request.senderId, authorId: "fixture_author", authorMappingVersion: bytesVersion("fixture_mapping_v1") };
  const authoritativeSource = structuredClone(binding.source);
  let currentVersion = binding.source.version, denySource = false, proofValid = true, available = true, transportOk = true;
  let pause: (() => Promise<void>) | undefined;
  const ports: AuthorIntentPorts = {
    async assertRequest(action) { accesses.request++; assert.equal(action, "read_current"); },
    async assertSources(sources, action) { accesses.sources++; assert.equal(action, "read_current");
      if (denySource || !isDeepStrictEqual(sources, [authoritativeSource])) throw new SourceRequestError("source_purpose_denied"); },
    async currentSourceVersion(id) { accesses.version++; assert.equal(id, binding.source.id); return currentVersion; },
    async verifyAuthor() { accesses.author++; return proofValid ? { sourceId: authoritativeSource.id, version: authoritativeSource.version,
      authorId: authoritativeSource.authorId, locator: authoritativeSource.locator, excerptHash: bytesVersion(authoritativeSource.excerpt) } : null; },
  };
  const seen: CommittedSourceInput[] = [];
  const adapter = createOfflineAuthorSourceRequest({ toolName, ports,
    async resolveSource(input) { accesses.resolve++; seen.push(input); await pause?.(); return available ? structuredClone(binding) : null; },
    transport: { set(reference) { accesses.transport++; assert.equal(reference.runId, request.runId);
      assert.match(reference.admissionHash, /^sha256:[a-f0-9]{64}$/); assert.deepEqual(Object.keys(reference).sort(), ["admissionHash", "runId"]); return transportOk; } } });
  const controller = new AbortController();
  const observe = () => adapter.observe(request, recorder, controller.signal);
  const call = (id = "call_1") => ({ runId: request.runId, agentId: request.agentId, sessionId: request.sessionId, sessionKey: request.sessionKey,
    senderId: request.senderId, toolCallId: id, toolName });
  const factory = { agentId: request.agentId, sessionId: request.sessionId, sessionKey: request.sessionKey, requesterSenderId: request.senderId,
    assertInvocationCurrent() { accesses.guard++; if (controller.signal.aborted) throw new Error("fixture_inactive"); } };
  const execute = async (id = "call_1", parameters: unknown = {}) => { adapter.bindCall(call(id), call(id)); return adapter.candidate(id, factory, parameters); };
  return { adapter, request, admission, binding, state, accesses, recorder, controller, observe, call, execute, factory, seen,
    setVersion(v: string) { currentVersion = v; }, deny() { denySource = true; }, invalidateProof() { proofValid = false; },
    setOriginalText(text: string) { state.message.content = text; binding.source.excerpt = text; authoritativeSource.excerpt = text; },
    unavailable() { available = false; }, noTransport() { transportOk = false; }, pause(fn: () => Promise<void>) { pause = fn; } };
}
function category(code: string) { return (error: unknown) => error instanceof SourceRequestError && error.category === code; }

test("T1 exact synthetic request/admission/source/call qualifies only a candidate", async () => {
  const f = fixture(); f.observe(); assert.equal(f.accesses.reads, 0); assert.equal(f.accesses.resolve, 0);
  const result = await f.execute(); assert.deepEqual({ ...result, source: undefined }, {
    status: "candidate", confirmation: "candidate", code: "semantic_adoption_unavailable", source: undefined, publisherBound: false });
  assert.deepEqual(result.source, f.binding.source); assert.equal(f.accesses.guard, 2);
  assert.equal(f.accesses.forbidden, 0); assert.equal(f.accesses.sources, 1); assert.equal(f.accesses.author, 1);
  assert.notEqual(f.request.runId, f.request.clientIdempotencyKey); assert.notEqual(f.admission.entryId, f.admission.idempotencyKey);
  assert.notEqual(f.binding.source.version, bytesVersion(f.binding.source.excerpt)); f.adapter.close();
});

test("T2 actual missing-source shape never qualifies via prompt, history or source-shaped params", async () => {
  const f = fixture(); await assert.rejects(f.execute(), category("request_inactive"));
  f.observe(); f.unavailable(); await assert.rejects(f.execute(), category("source_producer_unavailable"));
  assert.equal(f.accesses.author, 0); assert.equal(f.accesses.forbidden, 0);
});

test("T3 dispatch can precede commit; only first-call current committed state matters", async () => {
  const later = fixture(); later.state.persisted = false; later.observe(); assert.equal(later.accesses.reads, 0);
  later.state.persisted = true; assert.equal((await later.execute()).status, "candidate");
  for (const mode of ["uncommitted", "blocked", "no_receipt", "no_message"] as const) {
    const f = fixture(); f.state.persisted = false; f.observe();
    f.state.persisted = mode !== "uncommitted"; f.state.blocked = mode === "blocked";
    if (mode === "no_receipt") f.state.admission = undefined;
    if (mode === "no_message") f.state.message = {};
    await assert.rejects(f.execute(), category("admission_uncommitted")); assert.equal(f.accesses.resolve, 0); assert.equal(f.accesses.forbidden, 0);
  }
  assert.equal(later.accesses.forbidden, 0);
});

test("T4 owner/external_user/current-input strings cannot replace a trusted producer proof", async () => {
  for (const fake of ["owner", "provenance", "id", "mapping", "proof"]) {
    const f = fixture(); f.observe();
    f.state.message.senderIsOwner = true; f.state.message.provenance = { kind: "external_user" };
    f.state.message.currentUserMessage = raw; f.state.message.currentUserMessageId = "guessed_id";
    if (fake === "owner" || fake === "provenance") f.binding.origin = "third_party";
    if (fake === "id") f.binding.admission.entryId = "forged_entry";
    if (fake === "mapping") f.binding.authorMappingVersion = "unverified";
    if (fake === "proof") f.invalidateProof();
    await assert.rejects(f.execute(), category(fake === "id" ? "request_binding_mismatch" : "author_binding_unavailable"));
  }
});

test("T5 exact event/context/factory identities and unique calls, never session latest", async () => {
  for (const field of ["runId", "agentId", "sessionId", "sessionKey", "senderId", "toolCallId", "toolName"] as const) {
    const f = fixture(); f.observe(); assert.throws(() => f.adapter.bindCall(f.call(), { ...f.call(), [field]: "other" }), category("request_binding_mismatch"));
  }
  const f = fixture(); f.observe(); f.adapter.bindCall(f.call(), f.call());
  assert.throws(() => f.adapter.bindCall(f.call(), f.call()), category("call_identity_conflict"));
  await assert.rejects(f.adapter.candidate("call_1", { ...f.factory, requesterSenderId: "other" }, {}), category("request_binding_mismatch"));
  await assert.rejects(f.adapter.candidate("call_1", f.factory, {}), category("request_binding_mismatch"));
  assert.throws(() => f.adapter.bindCall(f.call(), f.call()), category("call_identity_conflict"));
  const a = fixture("A"), b = fixture("B"); a.observe(); b.observe();
  assert.equal(a.request.sessionKey, b.request.sessionKey); b.binding.request = a.binding.request; b.binding.admission = a.binding.admission;
  assert.equal((await a.execute()).status, "candidate"); await assert.rejects(b.execute(), category("request_binding_mismatch"));
  const client = fixture(); client.observe(); client.binding.request.clientIdempotencyKey = "another_client_key";
  await assert.rejects(client.execute(), category("request_binding_mismatch"));
  const nativeKey = fixture(); nativeKey.observe(); nativeKey.state.message.idempotencyKey = "another_native_key";
  await assert.rejects(nativeKey.execute(), category("request_binding_mismatch"));
  const capped = fixture(); capped.observe();
  for (let i = 0; i < 32; i++) capped.adapter.bindCall(capped.call(`c${i}`), capped.call(`c${i}`));
  assert.throws(() => capped.adapter.bindCall(capped.call("overflow"), capped.call("overflow")), category("call_identity_conflict"));
});

test("T6 duplicate observation is idempotent; changed request/admission or new request cannot reuse proof", async () => {
  const f = fixture(); f.observe(); f.observe(); await f.execute();
  await f.execute("call_2"); assert.equal(f.accesses.resolve, 1); assert.equal(f.accesses.sources, 1);
  assert.throws(() => f.adapter.observe({ ...f.request, clientIdempotencyKey: "new_request" }, f.recorder, f.controller.signal), category("request_binding_mismatch"));
  await assert.rejects(f.execute("call_3"), category("request_inactive"));
  const changed = fixture(); changed.observe(); await changed.execute(); changed.state.admission = { ...changed.admission, entryId: "other_entry" };
  await assert.rejects(changed.execute("call_2"), category("admission_replay_conflict"));
  const ambiguous = fixture(); ambiguous.observe();
  assert.throws(() => ambiguous.adapter.observe(ambiguous.request, Object.create(ambiguous.recorder), ambiguous.controller.signal), category("request_binding_mismatch"));
  await assert.rejects(ambiguous.execute(), category("request_inactive"));
  const next = fixture("B"); next.observe(); next.deny(); await assert.rejects(next.execute(), category("source_purpose_denied"));
  assert.equal(next.accesses.request, 1); assert.equal(next.accesses.resolve, 1);
});

test("T7 model parameter authority and third-party/internal/inter-session sources are rejected", async () => {
  for (const parameters of [{ owner: true }, { confirmation: "author_confirmed" }, { source: "fake" }, { currentUserMessage: raw }, [], null]) {
    const f = fixture(); f.observe(); await assert.rejects(f.execute("call", parameters), category("tool_arguments_invalid")); assert.equal(f.accesses.resolve, 0);
  }
  for (const origin of ["third_party", "assistant", "internal", "inter_session"] as const) {
    const f = fixture(); f.observe(); f.binding.origin = origin; await assert.rejects(f.execute(), category("author_binding_unavailable"));
  }
  for (const kind of ["inter_session", "internal_system"]) {
    const f = fixture(); f.observe(); f.state.message.provenance = { kind }; await assert.rejects(f.execute(), category("author_binding_unavailable"));
  }
});

test("T8 no normalization or attachment projection is silently declared exact author original", async () => {
  for (const changed of [` ${raw}`, `${raw}\n`, `\uFEFF${raw}`, "\u00e9", "assistant rewritten text"]) {
    const f = fixture(); f.observe(); if (changed === "\u00e9") f.binding.source.excerpt = "e\u0301";
    f.state.message.content = changed; await assert.rejects(f.execute(), category("source_representation_unverified"));
  }
  for (const field of ["media", "attachments"]) {
    const f = fixture(); f.observe(); f.state.message[field] = []; await assert.rejects(f.execute(), category("source_representation_unverified"));
  }
  const projected = fixture(); projected.observe(); projected.binding.representation = "projected";
  await assert.rejects(projected.execute(), category("source_representation_unverified"));
  const altered = fixture(); altered.observe(); altered.pause(async () => { altered.state.message.content = "changed during qualification"; });
  await assert.rejects(altered.execute(), category("admission_replay_conflict"));
});

test("T9 first supply/new request recheck sources; admitted continuations do not implement live revocation", async () => {
  const stale = fixture(); stale.observe(); stale.setVersion(bytesVersion("changed_source"));
  await assert.rejects(stale.execute(), category("source_version_conflict"));
  const denied = fixture(); denied.observe(); denied.deny(); await assert.rejects(denied.execute(), category("source_purpose_denied"));
  const moved = fixture(); moved.observe(); moved.binding.source.locator = "synthetic:other-location";
  await assert.rejects(moved.execute(), category("source_purpose_denied"));
  const current = fixture(); current.observe(); await current.execute(); current.setVersion(bytesVersion("later_version")); current.deny();
  assert.equal((await current.execute("continuation")).status, "candidate"); assert.equal(current.accesses.version, 1); assert.equal(current.accesses.sources, 1);
  const next = fixture("B"); next.observe(); next.setVersion(bytesVersion("later_version")); await assert.rejects(next.execute(), category("source_version_conflict"));
  // No publisher/transaction/CAS is exposed by this module. Existing writer CAS is not simulated as passing here.
  assert.equal("publish" in current.adapter, false); assert.equal("ports" in current.adapter, false);
});

test("T10 cancellation, missing transport acceptance and closed/recreated instances fail closed", async () => {
  const canceled = fixture(); canceled.observe(); canceled.controller.abort(); await assert.rejects(canceled.execute(), category("request_inactive"));
  const late = fixture(); late.observe(); late.pause(async () => { late.controller.abort(); }); await assert.rejects(late.execute(), category("request_inactive"));
  const transport = fixture(); transport.observe(); transport.noTransport(); await assert.rejects(transport.execute(), category("run_context_unavailable"));
  await assert.rejects(transport.execute("retry"), category("request_inactive"));
  const closed = fixture(); closed.observe(); closed.adapter.close(); closed.adapter.close(); await assert.rejects(closed.execute(), category("request_inactive"));
  const restarted = fixture(); await assert.rejects(restarted.execute(), category("request_inactive")); assert.equal(restarted.accesses.resolve, 0);
  const stale = fixture(); stale.observe(); stale.adapter.bindCall(stale.call(), stale.call());
  await assert.rejects(stale.adapter.candidate("call_1", { ...stale.factory, assertInvocationCurrent() { throw new Error("stale_fixture_guard"); } }, {}), /stale_fixture_guard/);
  assert.equal(stale.accesses.resolve, 0);
});

test("T11 ambiguous new input/concurrent first qualification rejected, same-request tool continuation allowed", async () => {
  const f = fixture(); f.observe(); let release!: () => void;
  f.pause(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.execute("first"); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(f.execute("concurrent"), category("request_concurrency_unsupported")); release();
  assert.equal((await first).status, "candidate"); assert.equal((await f.execute("continuation")).status, "candidate");
  f.state.admission = { ...f.admission, logicalTurnId: "new_user_input" };
  await assert.rejects(f.execute("ambiguous"), category("admission_replay_conflict")); assert.equal(f.accesses.resolve, 1);
});

test("T12 source qualification never manufactures semantic adoption, even for confirmation-shaped text", async () => {
  for (const text of ["Synthetic: why do you interpret it this way?", "Synthetic: yes", "Synthetic: scope remains unresolved"]) {
    const f = fixture(); f.setOriginalText(text); f.observe();
    const result = await f.execute(); assert.equal(result.confirmation, "candidate"); assert.equal(result.publisherBound, false);
    assert.equal(result.code, "semantic_adoption_unavailable"); assert.equal("author_confirmed" in result, false);
    assert.equal(f.accesses.forbidden, 0);
  }
});

function barrier() {
  let release!: () => void;
  const entered = new Promise<void>(resolve => { release = resolve; });
  return { entered, release };
}
for (const field of ["requesterSenderId", "sessionId"] as const) {
  test(`R1 changed factory ${field} during qualification cannot supply source`, async () => {
    const f = fixture(); f.observe(); const entered = barrier(), resume = barrier();
    f.pause(() => { entered.release(); return resume.entered; });
    const pending = f.execute(); await entered.entered;
    f.factory[field] = "different_identity_after_first_check"; resume.release();
    await assert.rejects(pending, category("request_binding_mismatch"));
  });
}
test("R1 original guard survives replacement; a stale original guard rejects final supply", async () => {
  for (const becomeStale of [true, false]) {
    const f = fixture(); f.observe(); let stale = false, originalCalls = 0, replacementCalls = 0;
    f.factory.assertInvocationCurrent = () => { originalCalls++; if (stale) throw new Error("original_capability_stale"); };
    const entered = barrier(), resume = barrier(); f.pause(() => { entered.release(); return resume.entered; });
    const pending = f.execute(); await entered.entered;
    stale = becomeStale; f.factory.assertInvocationCurrent = () => { replacementCalls++; }; resume.release();
    if (becomeStale) await assert.rejects(pending, /original_capability_stale/);
    else assert.equal((await pending).status, "candidate");
    assert.equal(originalCalls, 2); assert.equal(replacementCalls, 0);
  }
});
test("R2 observed admitted identity conflict cannot revive after recorder restoration", async () => {
  for (const field of ["entryId", "sessionId", "logicalTurnId", "idempotencyKey"] as const) {
    const f = fixture(); f.observe(); await f.execute("first");
    const old = structuredClone(f.state.admission); f.state.admission = { ...f.admission, [field]: "different_native_identity" };
    await assert.rejects(f.execute("conflict"), category(field === "sessionId" || field === "idempotencyKey" ? "request_binding_mismatch" : "admission_replay_conflict"));
    f.state.admission = old;
    await assert.rejects(f.execute("restored"), category("request_inactive")); assert.equal(f.accesses.resolve, 1);
  }
  // Ordinary argument errors and merely pending first admission do not poison a request.
  const pending = fixture(); pending.observe(); pending.state.persisted = false;
  await assert.rejects(pending.execute("early"), category("admission_uncommitted")); pending.state.persisted = true;
  await assert.rejects(pending.execute("bad_args", { owner: true }), category("tool_arguments_invalid"));
  assert.equal((await pending.execute("now_committed")).status, "candidate"); assert.equal(pending.accesses.resolve, 1);
});
test("R1/R2 returned-source copy isolation control remains independent of qualification", async () => {
  const f = fixture(); f.observe(); const original = structuredClone(f.binding.source), first = await f.execute("first");
  first.source.authorId = "mutated_return"; first.source.excerpt = "mutated text"; first.source.version = bytesVersion("mutated");
  const next = await f.execute("next"); assert.deepEqual(next.source, original); assert.equal(f.accesses.resolve, 1);
});
