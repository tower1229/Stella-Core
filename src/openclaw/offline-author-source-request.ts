import type { AuthorIntentPorts } from "../canghai/author-intent-repository.js";
import type { IntentSource } from "../canghai/author-intent-asset.js";
import { intentId, intentVersion } from "../canghai/author-intent-asset.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";

/** Synthetic offline contract only. No Host registration, source reader, publisher,
 * persistence or authority recovery. Production ingress/lifetime remains unverified. */
export type SourceRequest = {
  runId: string; agentId: string; sessionId: string; sessionKey: string;
  clientIdempotencyKey: string; channel: string; accountId: string; senderId: string;
};
export type SourceAdmission = {
  agentId: string; sessionId: string; sessionKey: string; storePath: string;
  entryId: string; logicalTurnId: string; generation: string; rawSeq: number;
  effectiveParentId: string | null; activeMessagePosition: number; idempotencyKey: string; role: "user";
};
type Message = { role: "user"; content: string; idempotencyKey: string; provenance?: { kind: string } };
export type CommittedSourceInput = { request: SourceRequest; admission: SourceAdmission; message: Message };
/** Read-only subset; deliberately has no persist/stage/mark/handler methods. */
export type PassiveSourceRecorder = {
  hasPersisted(): boolean; isBlocked(): boolean;
  getAdmissionReceipt(): unknown; getPersistedMessage(): unknown;
};
export type OfflineSourceBinding = {
  request: SourceRequest; admission: SourceAdmission; source: IntentSource;
  origin: "direct_author" | "third_party" | "assistant" | "internal" | "inter_session";
  representation: "exact_whole_text" | "projected";
  senderId: string; authorId: string; authorMappingVersion: string;
};
type CallIdentity = Pick<SourceRequest, "runId" | "agentId" | "sessionId" | "sessionKey" | "senderId"> & { toolCallId: string; toolName: string };
type Factory = Pick<SourceRequest, "agentId" | "sessionId" | "sessionKey"> & {
  requesterSenderId: string; assertInvocationCurrent(): void;
};
export class SourceRequestError extends Error {
  constructor(readonly category: string) { super(`Offline author source: ${category}`); }
}
function check(ok: unknown, category: string): asserts ok { if (!ok) throw new SourceRequestError(category); }
function record(x: unknown): x is Record<string, unknown> { return x !== null && typeof x === "object" && !Array.isArray(x); }
function text(x: unknown): x is string { return typeof x === "string" && x.length > 0 && x.length <= 16_384; }
function equal(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b); }
function factoryIdentity(factory: Factory) {
  return { agentId: factory.agentId, sessionId: factory.sessionId, sessionKey: factory.sessionKey,
    requesterSenderId: factory.requesterSenderId };
}
function requestValid(x: SourceRequest) { return record(x) && Object.keys(x).sort().join() ===
  "accountId,agentId,channel,clientIdempotencyKey,runId,senderId,sessionId,sessionKey" && Object.values(x).every(text); }
function admissionValid(x: unknown): x is SourceAdmission {
  return record(x) && ["agentId", "sessionId", "sessionKey", "storePath", "entryId", "logicalTurnId", "generation", "idempotencyKey"].every(k => text(x[k])) &&
    x.role === "user" && Number.isSafeInteger(x.rawSeq) && Number(x.rawSeq) >= 1 &&
    Number.isSafeInteger(x.activeMessagePosition) && Number(x.activeMessagePosition) >= 0 &&
    (x.effectiveParentId === null || text(x.effectiveParentId));
}

export function createOfflineAuthorSourceRequest(options: {
  toolName: string;
  /** Existing trusted caller-owned qualification ports; synthetic fixtures only here. */
  ports: AuthorIntentPorts;
  /** Missing production seam, supplied solely by synthetic offline fixtures. Never tool arguments. */
  resolveSource(input: CommittedSourceInput): Promise<OfflineSourceBinding | null>;
  transport?: { set(reference: { runId: string; admissionHash: string }): boolean };
}) {
  const { ports, resolveSource, transport, toolName } = options;
  let captured: { request: SourceRequest; recorder: PassiveSourceRecorder; signal: AbortSignal } | undefined;
  let admitted: CommittedSourceInput | undefined, source: IntentSource | undefined;
  let closed = false, failed = false, qualifying = false;
  const calls = new Map<string, CallIdentity>();
  const seenCalls = new Set<string>();
  const close = () => { closed = true; calls.clear(); seenCalls.clear(); source = undefined; admitted = undefined;
    captured?.signal.removeEventListener("abort", close); captured = undefined; };
  function active() {
    check(!closed && !failed && captured && !captured.signal.aborted, "request_inactive");
    return captured;
  }
  function snapshot(): CommittedSourceInput {
    const c = active(), r = c.recorder;
    check(r.hasPersisted() === true && r.isBlocked() === false, "admission_uncommitted");
    const a: unknown = structuredClone(r.getAdmissionReceipt()), m: unknown = structuredClone(r.getPersistedMessage());
    check(admissionValid(a) && record(m) && m.role === "user" && text(m.content) && text(m.idempotencyKey), "admission_uncommitted");
    check(!Object.hasOwn(m, "media") && !Object.hasOwn(m, "attachments") && m.excludeFromContext !== true && m.display !== false,
      "source_representation_unverified");
    check(m.provenance === undefined || record(m.provenance) && m.provenance.kind === "external_user", "author_binding_unavailable");
    check(a.agentId === c.request.agentId && a.sessionId === c.request.sessionId && a.sessionKey === c.request.sessionKey &&
      a.idempotencyKey === m.idempotencyKey, "request_binding_mismatch");
    return { request: structuredClone(c.request), admission: a, message: m as Message };
  }
  async function qualify(current: CommittedSourceInput) {
    check(!qualifying, "request_concurrency_unsupported"); qualifying = true;
    try {
      await ports.assertRequest("read_current"); active();
      const binding = structuredClone(await resolveSource(structuredClone(current))); active();
      check(binding, "source_producer_unavailable");
      check(equal(binding.request, current.request) && equal(binding.admission, current.admission), "request_binding_mismatch");
      check(binding.origin === "direct_author" && binding.source.role === "author" && binding.senderId === current.request.senderId &&
        binding.authorId === binding.source.authorId && text(binding.authorId) && intentVersion(binding.authorMappingVersion), "author_binding_unavailable");
      check(binding.representation === "exact_whole_text" && binding.source.excerpt === current.message.content,
        "source_representation_unverified");
      check(intentId(binding.source.id) && text(binding.source.locator) && intentVersion(binding.source.version), "source_version_conflict");
      await ports.assertSources([structuredClone(binding.source)], "read_current"); active();
      check(await ports.currentSourceVersion(binding.source.id) === binding.source.version, "source_version_conflict"); active();
      const proof = await ports.verifyAuthor(structuredClone(binding.source)); active();
      check(proof !== null && equal(proof, { sourceId: binding.source.id, version: binding.source.version, authorId: binding.source.authorId,
        locator: binding.source.locator, excerptHash: bytesVersion(binding.source.excerpt) }), "author_binding_unavailable");
      // Recheck admission/cancellation after awaits, without re-reading source/policy versions.
      check(equal(snapshot(), current), "admission_replay_conflict");
      check(!transport || transport.set({ runId: current.request.runId, admissionHash: bytesVersion(canonicalJson(current.admission)) }) === true,
        "run_context_unavailable"); active();
      check(equal(snapshot(), current), "admission_replay_conflict");
      admitted = current; source = structuredClone(binding.source);
    } catch (error) { failed = true; throw error; }
    finally { qualifying = false; }
  }
  return {
    /** Passive dispatch observation: no recorder reads, awaits, commit or qualification. */
    observe(request: SourceRequest, recorder: PassiveSourceRecorder, signal: AbortSignal) {
      check(!closed && !failed && requestValid(request) && !signal.aborted, "source_producer_unavailable");
      if (captured) {
        // Reference equality only rejects ambiguous re-observation; it grants no qualification.
        if (!equal(captured.request, request) || captured.recorder !== recorder || captured.signal !== signal) {
          failed = true; throw new SourceRequestError("request_binding_mismatch");
        }
        return;
      }
      captured = { request: structuredClone(request), recorder, signal }; signal.addEventListener("abort", close, { once: true });
    },
    /** Arguments are Host hook metadata, never the model's tool params. One use per call. */
    bindCall(event: CallIdentity, context: CallIdentity) {
      const c = active();
      check(equal(event, context) && text(event.toolCallId) && event.toolName === toolName &&
        ["runId", "agentId", "sessionId", "sessionKey", "senderId"].every(k => event[k as keyof CallIdentity] === c.request[k as keyof SourceRequest]),
        "request_binding_mismatch");
      check(!seenCalls.has(event.toolCallId) && seenCalls.size < 32, "call_identity_conflict");
      seenCalls.add(event.toolCallId);
      calls.set(event.toolCallId, structuredClone(event));
    },
    async candidate(callId: string, factory: Factory, parameters: unknown) {
      const c = active(), identity = Object.freeze(factoryIdentity(factory));
      const originalGuard = factory.assertInvocationCurrent;
      check(typeof originalGuard === "function", "request_binding_mismatch");
      // Preserve the method receiver, but never reacquire authority from its mutable property.
      const guard = originalGuard.bind(factory);
      guard(); active();
      check(equal(factoryIdentity(factory), identity), "request_binding_mismatch");
      const call = calls.get(callId); calls.delete(callId);
      check(call && identity.agentId === c.request.agentId && identity.sessionId === c.request.sessionId && identity.sessionKey === c.request.sessionKey &&
        identity.requesterSenderId === c.request.senderId, "request_binding_mismatch");
      check(record(parameters) && Object.getPrototypeOf(parameters) === Object.prototype && Object.keys(parameters).length === 0,
        "tool_arguments_invalid");
      let current: CommittedSourceInput;
      try {
        current = snapshot(); // Synchronous first-use observation, before qualification awaits.
        if (admitted) check(equal(current, admitted), "admission_replay_conflict");
      } catch (error) {
        // An observed conflict/loss of already-admitted native input is terminal.
        // Pending first admission and ordinary argument errors do not poison a request.
        if (admitted) close();
        throw error;
      }
      if (!admitted) await qualify(current);
      active(); guard(); active();
      check(equal(factoryIdentity(factory), identity), "request_binding_mismatch");
      return { status: "candidate" as const, confirmation: "candidate" as const, code: "semantic_adoption_unavailable" as const,
        source: structuredClone(source!), publisherBound: false as const };
    },
    close,
  };
}
