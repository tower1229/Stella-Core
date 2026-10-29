import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { CatalogError, CatalogReader } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { readCheckpointCommittedDocument } from "../canghai/checkpoint-committed-document.js";
import { freezeRecoveryReadBinding, type RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import { isRecord } from "../shared/type-guards.js";
import { correctCheckpointRequest } from "./checkpoint-agent-correction.js";
import { type NativeReadbackReference } from "./checkpoint-native-readback.js";
import { learningChangeReadbackTargets, readAuthorizedExact, type AuthorizedExactReadScope, type ExactReadbackTarget } from "../canghai/authorized-exact-readback.js";
import { snapshotTurnRequest, type BoundTurnRequest } from "./turn-request.js";

type CorrectionInput = Parameters<typeof correctCheckpointRequest>[0];
type Receipt = Awaited<ReturnType<typeof correctCheckpointRequest>>;
type Capability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];
type Lease = NonNullable<Awaited<ReturnType<NonNullable<Capability["providerRuntime"]>["open"]>>["provider"]>;
type NativeDocument = { reference: NativeReadbackReference; text: string };
type ExactDocument = { target: ExactReadbackTarget; text: string };
type Document = NativeDocument | ExactDocument;
type Outcome<D = Document> = { correction: Receipt } & (
  { status: "readback_verified"; readback: { status: "verified"; documents: D[] } } |
  { status: "no_change" | "needs_clarification"; readback: { status: "not_required"; documents: [] } } |
  { status: "readback_failed"; readback: { status: "failed"; category: string; documents: [] } }
);
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const failureCategory = (error: unknown) => isRecord(error) && typeof error.category === "string" ? error.category : "checkpoint_correction_readback_failed";

type ReadBinding = { recovery: RecoveryReadBinding; reader: CatalogReader; request: BoundTurnRequest; signal: AbortSignal };
type NativeInput = { correction: CorrectionInput; providerId: string;
  openNativeReadback(binding: ReadBinding): Promise<{ adapter: string; providerId?: string; provider?: Lease | null; error?: string }> };
type DirectInput = { correction: CorrectionInput; openReadScope(binding: ReadBinding): Promise<AuthorizedExactReadScope> };
type Coordinator<D> = { parameters: ReturnType<typeof Type.Object>; execute(value: unknown, signal?: AbortSignal): Promise<Outcome<D>> };

export type CheckpointToolCorrectionReadback = Coordinator<ExactDocument>;

/** One admitted request, one existing writer. A committed receipt is retained
 * across read failures; subsequent executions only reopen and read that revision.
 * Direct tools bind Core scope, without native callers, slots or authority maps. */
export function createCheckpointCorrectionReadback(input: DirectInput): Coordinator<ExactDocument>;
export function createCheckpointCorrectionReadback(input: NativeInput): Coordinator<NativeDocument>;
export function createCheckpointCorrectionReadback(input: DirectInput | NativeInput): Coordinator<Document> {
  const initial = input.correction;
  if ("providerId" in input) check(input.providerId.trim(), "native_readback_provider_required");
  const recovery = freezeRecoveryReadBinding(initial.recovery, initial.runtime.config);
  const correction: CorrectionInput = { ...initial, recovery, request: snapshotTurnRequest(initial.request, initial.request.runId),
    archive: { ...initial.archive, evidenceRefs: structuredClone(initial.archive.evidenceRefs), sourceRefs: structuredClone(initial.archive.sourceRefs),
      recovery: initial.archive.recovery ? freezeRecoveryReadBinding(initial.archive.recovery, initial.runtime.config) : initial.archive.recovery } };
  let committed: Promise<Receipt> | undefined, reading: Promise<Outcome> | undefined;

  const readCommitted = async (receipt: Receipt, signal: AbortSignal): Promise<Outcome> => {
    try {
      const accepted = freezeRecoveryReadBinding({ resolver: recovery.resolver, expected: receipt.authority }, correction.runtime.config);
      const current = async () => {
        signal.throwIfAborted(); await correction.assertCurrent(); await correction.runtime.assert(accepted); signal.throwIfAborted();
      };
      await current();
      const reader = await CatalogReader.load(correction.runtime.config.canghaiRoot, correction.resolver.reader.catalogPath);
      const committedCatalog = await readCheckpointCommittedDocument(reader.root, accepted.expected.revision, reader.catalogPath);
      check(bytesVersion(committedCatalog) === reader.catalogHash && reader.catalog.generationId === receipt.generationId,
        "correction_readback_catalog_mismatch");
      const targets = await learningChangeReadbackTargets({ reader, changeRef: receipt.changeRef });
      await current();
      const binding = { recovery: accepted, reader, request: correction.request, signal };
      const directScope = "openReadScope" in input ? await input.openReadScope(binding) : undefined;
      await current();
      if (receipt.disposition !== "update") {
        check(targets.length === 0, "learning_change_target_mismatch");
        return { correction: receipt, status: receipt.disposition, readback: { status: "not_required", documents: [] } };
      }
      check(targets.length > 0, "learning_change_target_mismatch");
      let lease: Lease | null | undefined;
      const documents: Document[] = [];
      try {
        let read: (target: ExactReadbackTarget) => Promise<Document>;
        if (directScope) {
          read = target => readAuthorizedExact({ scope: directScope, target, assertCurrent: current });
        } else {
          check("openNativeReadback" in input, "correction_readback_scope_required");
          const opened = await input.openNativeReadback(binding); lease = opened.provider;
          check(opened.adapter === "native" && opened.providerId === input.providerId && !opened.error && lease, "correction_native_readback_unavailable");
          const provider = lease;
          read = async target => {
            const reference: NativeReadbackReference = { providerId: input.providerId, id: canonicalJson([target.group, target.ref.id]), revision: target.ref.version };
            const result = await provider.get({ reference });
            check(result.status === "ok" && canonicalJson(result.reference) === canonicalJson(reference), "correction_readback_reference_mismatch");
            return { reference, text: result.text };
          };
        }
        for (const target of targets) {
          await current(); const result = await read(target); await current();
          const record: unknown = JSON.parse(result.text);
          check(isRecord(record) && record.id === target.ref.id && objectVersion(record) === target.ref.version && result.text === canonicalJson(record),
            "correction_readback_object_mismatch");
          documents.push(result);
        }
      } finally { await lease?.close(); }
      await current();
      return { correction: receipt, status: "readback_verified", readback: { status: "verified", documents } };
    } catch (error) {
      return { correction: receipt, status: "readback_failed", readback: { status: "failed", category: failureCategory(error), documents: [] } };
    }
  };

  return {
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(value: unknown, signal = correction.signal): Promise<Outcome> {
      check(isRecord(value) && Object.keys(value).length === 0, "checkpoint_agent_tool_arguments_invalid");
      committed ??= correctCheckpointRequest(correction).then(receipt => structuredClone(receipt));
      const receipt = await committed;
      const pending = reading ??= readCommitted(receipt, signal);
      try { return structuredClone(await pending); }
      finally { if (reading === pending) reading = undefined; }
    },
  };
}
