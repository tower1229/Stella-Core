import type { PluginHookReplyDispatchEvent, PluginHookReplyDispatchContext } from "openclaw/plugin-sdk/core";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";

type Identity = { agentId?: string; sessionKey?: string; sessionId?: string };
type Recorder = NonNullable<PluginHookReplyDispatchContext["userTurnTranscriptRecorder"]>;
type Entry = {
  sessionKey: string; recorder: Recorder; signal: AbortSignal;
  persisted(): boolean; blocked(): boolean; receipt(): unknown; release(): void;
  conflict: boolean; admitted?: string;
};
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 4096;
const unavailable = (code: string) => ({ status: "unavailable" as const, code });

/** Passive metadata only. No message/provenance/sender reads, source qualification,
 * persistent store or session-to-latest lookup. A receipt hash is NOT a Source
 * version, author proof, or proof of what the provider consumed. */
export function createCurrentInputMetadata(agentId: string) {
  const runs = new Map<string, Entry>();
  function forget(runId: string, entry: Entry) {
    if (runs.get(runId) === entry) runs.delete(runId);
    entry.release();
  }
  return {
    observe(event: PluginHookReplyDispatchEvent, context: PluginHookReplyDispatchContext) {
      // Observe the ordinary agent path only; never claim dispatch or wait for it.
      if (context.dispatchKind !== "agent" || event.ctx.AgentId !== agentId) return "dispatch_scope_unavailable";
      const runId = event.runId, sessionKey = event.sessionKey;
      const recorder = context.userTurnTranscriptRecorder, signal = context.abortSignal;
      if (!text(runId) || !text(sessionKey) || event.ctx.SessionKey !== sessionKey || !recorder || !signal || signal.aborted) {
        return "dispatch_identity_or_lifetime_unavailable";
      }
      const previous = runs.get(runId);
      if (previous) {
        if (previous.recorder !== recorder || previous.signal !== signal || previous.sessionKey !== sessionKey) previous.conflict = true;
        return previous.conflict ? "dispatch_ambiguous" : "dispatch_observed";
      }
      if (runs.size >= 32) return "dispatch_capacity";
      if (typeof recorder.hasPersisted !== "function" || typeof recorder.isBlocked !== "function" ||
          typeof recorder.getAdmissionReceipt !== "function") return "recorder_contract_unavailable";
      // Capture the original read methods; no recorder method is called here.
      const entry: Entry = { sessionKey, recorder, signal, conflict: false,
        persisted: recorder.hasPersisted.bind(recorder), blocked: recorder.isBlocked.bind(recorder),
        receipt: recorder.getAdmissionReceipt.bind(recorder), release: () => signal.removeEventListener("abort", discard) };
      function discard() { forget(runId!, entry); }
      runs.set(runId, entry); signal.addEventListener("abort", discard, { once: true });
      return "dispatch_observed";
    },
    inspect(runId: string | null | undefined, identity: Identity) {
      if (!text(runId)) return unavailable("host_run_not_provided");
      const entry = runs.get(runId);
      if (!entry || entry.signal.aborted) return unavailable("reply_dispatch_not_observed");
      const reject = (code: string) => { entry.conflict = true; return { status: "rejected" as const, code }; };
      if (entry.conflict) return reject("native_input_ambiguous");
      if (identity.agentId !== agentId || identity.sessionKey !== entry.sessionKey || !text(identity.sessionId)) {
        return reject("native_input_binding_mismatch");
      }
      try {
        if (entry.persisted() !== true || entry.blocked() !== false) {
          return entry.admitted ? reject("native_input_changed") : unavailable("admission_uncommitted");
        }
        const receipt = entry.receipt();
        if (!isRecord(receipt)) return reject("native_input_receipt_invalid");
        // Host objects may expose getters. Read each selected field once, then
        // validate, bind and hash only this immutable scalar snapshot.
        const a = Object.freeze({ agentId: receipt.agentId, sessionId: receipt.sessionId, sessionKey: receipt.sessionKey,
          storePath: receipt.storePath, entryId: receipt.entryId, logicalTurnId: receipt.logicalTurnId,
          generation: receipt.generation, idempotencyKey: receipt.idempotencyKey, role: receipt.role,
          rawSeq: receipt.rawSeq, effectiveParentId: receipt.effectiveParentId,
          activeMessagePosition: receipt.activeMessagePosition });
        if (!["agentId", "sessionId", "sessionKey", "storePath", "entryId", "logicalTurnId", "generation", "idempotencyKey"].every(k => text(a[k as keyof typeof a])) ||
            a.role !== "user" || !Number.isSafeInteger(a.rawSeq) || Number(a.rawSeq) < 1 ||
            !Number.isSafeInteger(a.activeMessagePosition) || Number(a.activeMessagePosition) < 0 ||
            !(a.effectiveParentId === null || text(a.effectiveParentId))) return reject("native_input_receipt_invalid");
        if (a.agentId !== agentId || a.sessionKey !== entry.sessionKey || a.sessionId !== identity.sessionId) {
          return reject("native_input_binding_mismatch");
        }
        // Deliberately select fields; neither transcript paths nor receipt objects
        // escape through the candidate result. Do not read getPersistedMessage.
        const encoded = canonicalJson({ agentId: a.agentId, sessionId: a.sessionId, sessionKey: a.sessionKey,
          storePath: a.storePath, entryId: a.entryId, logicalTurnId: a.logicalTurnId, generation: a.generation,
          idempotencyKey: a.idempotencyKey, role: a.role, rawSeq: a.rawSeq,
          effectiveParentId: a.effectiveParentId, activeMessagePosition: a.activeMessagePosition });
        if (entry.signal.aborted || runs.get(runId) !== entry) return unavailable("reply_dispatch_not_observed");
        if (entry.admitted !== undefined && entry.admitted !== encoded) return reject("native_input_changed");
        entry.admitted = encoded;
        return { status: "observed" as const, code: "native_input_metadata_only", receiptHash: bytesVersion(encoded),
          authorQualification: false as const, sourceRepresentation: "unverified" as const, modelConsumption: "unverified" as const };
      } catch {
        return reject("native_input_recorder_read_failed");
      }
    },
    end(event: { runId?: string }, context: Identity & { runId?: string }) {
      if (!text(event.runId) || event.runId !== context.runId || context.agentId !== agentId) return;
      const entry = runs.get(event.runId);
      if (entry && context.sessionKey === entry.sessionKey) forget(event.runId, entry);
    },
  };
}
