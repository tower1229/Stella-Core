import type { VersionedRef } from "../praxis/episode-v2.js";
import { validateSchema } from "./schema.js";

export type ReassessmentProgress = {
  parentOperationId: string;
  batchOperationIds: string[];
  pendingRefs: VersionedRef[];
  completedIds: string[];
  currentWorkReady: boolean;
};
export type SynchronizationState = ReassessmentProgress & {
  schemaVersion: "stella.source-synchronization/v2";
  phase: "pending" | "partial" | "completed";
  operationId: string;
  inputDigest: string;
  affectedIds: string[];
  generationId?: string;
};

/** Explicit lossless read migration: v1 only ever published complete generations. */
export async function migrateSynchronizationState(value: unknown): Promise<SynchronizationState> {
  await validateSchema("source-synchronization", value);
  const state = structuredClone(value) as SynchronizationState & { request: { operationId: string } };
  if (String(state.schemaVersion) === "stella.source-synchronization/v1") {
    Object.assign(state, { schemaVersion: "stella.source-synchronization/v2",
      parentOperationId: state.request.operationId, batchOperationIds: [state.request.operationId],
      pendingRefs: [], completedIds: [], currentWorkReady: false });
  }
  const pendingIds = state.pendingRefs.map(ref => ref.id);
  if (new Set(pendingIds).size !== pendingIds.length || pendingIds.some(id => state.completedIds.includes(id)) ||
      state.batchOperationIds.at(-1) !== state.request.operationId ||
      [...pendingIds, ...state.completedIds].some(id => !state.affectedIds.includes(id))) throw new Error("invalid_synchronization_progress");
  await validateSchema("source-synchronization", state);
  return state;
}
