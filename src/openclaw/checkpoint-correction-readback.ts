import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { CatalogError, CatalogReader } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { readCheckpointCommittedDocument } from "../canghai/checkpoint-committed-document.js";
import { freezeRecoveryReadBinding, type RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import { isRecord } from "../shared/type-guards.js";
import { correctCheckpointRequest } from "./checkpoint-agent-correction.js";
import { learningChangeNativeReferences, type NativeReadbackReference } from "./checkpoint-native-readback.js";
import { snapshotTurnRequest, type BoundTurnRequest } from "./turn-request.js";

type CorrectionInput = Parameters<typeof correctCheckpointRequest>[0];
type Receipt = Awaited<ReturnType<typeof correctCheckpointRequest>>;
type Capability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];
type Lease = NonNullable<Awaited<ReturnType<NonNullable<Capability["providerRuntime"]>["open"]>>["provider"]>;
type Document = { reference: NativeReadbackReference; text: string };
type Outcome = { correction: Receipt } & (
  { status: "readback_verified"; readback: { status: "verified"; documents: Document[] } } |
  { status: "no_change" | "needs_clarification"; readback: { status: "not_required"; documents: [] } } |
  { status: "readback_failed"; readback: { status: "failed"; category: string; documents: [] } }
);
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const failureCategory = (error: unknown) => isRecord(error) && typeof error.category === "string" ? error.category : "checkpoint_correction_readback_failed";

/** One already admitted request, not a production registration or a durable retry service.
 * The existing writer alone commits. Once it returns a receipt, all retries are reads.
 * openNativeReadback must bind C2's real native lease/source scope to the supplied accepted reader.
 */
export function createCheckpointCorrectionReadback(input: {
  correction: CorrectionInput;
  providerId: string;
  openNativeReadback(binding: { recovery: RecoveryReadBinding; reader: CatalogReader; request: BoundTurnRequest; signal: AbortSignal }):
    Promise<{ adapter: string; providerId?: string; provider?: Lease | null; error?: string }>;
}) {
  const providerId = input.providerId, openNativeReadback = input.openNativeReadback, initial = input.correction;
  check(providerId.trim(), "native_readback_provider_required");
  const recovery = freezeRecoveryReadBinding(initial.recovery, initial.runtime.config);
  const correction: CorrectionInput = { ...initial, recovery, request: snapshotTurnRequest(initial.request, initial.request.runId),
    archive: { ...initial.archive, evidenceRefs: structuredClone(initial.archive.evidenceRefs), sourceRefs: structuredClone(initial.archive.sourceRefs),
      recovery: initial.archive.recovery ? freezeRecoveryReadBinding(initial.archive.recovery, initial.runtime.config) : initial.archive.recovery } };
  let committed: Promise<Receipt> | undefined, reading: Promise<Outcome> | undefined;

  const readCommitted = async (receipt: Receipt): Promise<Outcome> => {
    try {
      const accepted = freezeRecoveryReadBinding({ resolver: recovery.resolver, expected: receipt.authority }, correction.runtime.config);
      const current = async () => {
        correction.signal.throwIfAborted(); await correction.assertCurrent(); await correction.runtime.assert(accepted); correction.signal.throwIfAborted();
      };
      await current();
      const reader = await CatalogReader.load(correction.runtime.config.canghaiRoot, correction.resolver.reader.catalogPath);
      const committedCatalog = await readCheckpointCommittedDocument(reader.root, accepted.expected.revision, reader.catalogPath);
      check(bytesVersion(committedCatalog) === reader.catalogHash && reader.catalog.generationId === receipt.generationId,
        "correction_readback_catalog_mismatch");
      const references = await learningChangeNativeReferences({ providerId, reader, changeRef: receipt.changeRef });
      await current();
      if (receipt.disposition !== "update") {
        check(references.length === 0, "learning_change_target_mismatch");
        return { correction: receipt, status: receipt.disposition, readback: { status: "not_required", documents: [] } };
      }
      check(references.length > 0, "learning_change_target_mismatch");
      let lease: Lease | null | undefined;
      const documents: Document[] = [];
      try {
        const opened = await openNativeReadback({ recovery: accepted, reader, request: correction.request, signal: correction.signal });
        lease = opened.provider;
        check(opened.adapter === "native" && opened.providerId === providerId && !opened.error && lease, "correction_native_readback_unavailable");
        for (const reference of references) {
          await current(); const result = await lease.get({ reference }); await current();
          check(result.status === "ok" && canonicalJson(result.reference) === canonicalJson(reference), "correction_readback_reference_mismatch");
          const record: unknown = JSON.parse(result.text), [, id] = JSON.parse(reference.id) as [string, string];
          check(isRecord(record) && record.id === id && objectVersion(record) === reference.revision && result.text === canonicalJson(record),
            "correction_readback_object_mismatch");
          documents.push({ reference: { ...reference }, text: result.text });
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
    async execute(value: unknown): Promise<Outcome> {
      check(isRecord(value) && Object.keys(value).length === 0, "checkpoint_agent_tool_arguments_invalid");
      committed ??= correctCheckpointRequest(correction).then(receipt => structuredClone(receipt));
      const receipt = await committed;
      const pending = reading ??= readCommitted(receipt);
      try { return structuredClone(await pending); }
      finally { if (reading === pending) reading = undefined; }
    },
  };
}
