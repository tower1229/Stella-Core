import type { RecoveryCheckpointBinding, RecoveryCheckpointVersion } from "./recovery-checkpoint-contract.js";
export type PlannedFileVersion = Readonly<{ sha256: string; mode: number }>;
export type ManagedPlannedFile = Readonly<{ rootId: string; path: string; version: PlannedFileVersion }>;
/** Every affected path requires an observation, including explicit absence. This is input data,
 * not an on-disk ownership/permission certificate; an eventual writer must revalidate actual bytes.
 */
export type ObservedPlannedFile = Readonly<{ rootId: string; path: string; version: PlannedFileVersion | null }>;
export type ExplicitPlannedRename = Readonly<{ rootId: string; fromPath: string; toPath: string }>;
export type FileChangePlanInput = Readonly<{
  operationId: string;
  binding: RecoveryCheckpointBinding;
  from: RecoveryCheckpointVersion;
  target: RecoveryCheckpointVersion;
  /** Previously acknowledged managed file manifest; not arbitrary observed files. */
  managedBefore: readonly ManagedPlannedFile[];
  desired: readonly ManagedPlannedFile[];
  observed: readonly ObservedPlannedFile[];
  /** Nonoverlapping explicit pairs only; no inferred rename by matching content. */
  renames?: readonly ExplicitPlannedRename[];
}>;
export type PlannedFileChange =
  | Readonly<{ kind: "add"; rootId: string; path: string; after: PlannedFileVersion }>
  | Readonly<{ kind: "modify"; rootId: string; path: string; before: PlannedFileVersion; after: PlannedFileVersion }>
  | Readonly<{ kind: "delete"; rootId: string; path: string; before: PlannedFileVersion }>
  | Readonly<{ kind: "rename"; rootId: string; fromPath: string; path: string; before: PlannedFileVersion; after: PlannedFileVersion }>;
export type FileChangePlan = Readonly<{
  schemaVersion: "stella.file-change-plan/v1";
  status: "planned";
  operationId: string;
  binding: RecoveryCheckpointBinding;
  from: RecoveryCheckpointVersion;
  target: RecoveryCheckpointVersion;
  changes: readonly PlannedFileChange[];
  digest: string;
}>;
export class FileChangePlanError extends Error {
  constructor(readonly category: string) { super(`File change plan failed: ${category}`); }
}
