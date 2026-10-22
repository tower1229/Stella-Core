import type { RecoveryCheckpointBinding, RecoveryCheckpointLock, RecoveryCheckpointWriteResult } from "./recovery-checkpoint-contract.js";
export type RecoveryAuthoritySnapshot = Readonly<{
  mode: "legacy_config" | "core_checkpoint";
  binding: RecoveryCheckpointBinding;
  revision: string;
  token: string;
}>;
export interface RecoveryAuthorityResolver {
  readonly mode: RecoveryAuthoritySnapshot["mode"];
  read(): Promise<RecoveryAuthoritySnapshot>;
  assertCurrent(snapshot: RecoveryAuthoritySnapshot): Promise<void>;
}
export type CheckpointRecoveryRuntimeOptions = Readonly<{
  stateDirectory: string;
  binding: RecoveryCheckpointBinding;
  /** Explicit adapter required; no production passthrough or fixture default. */
  withCheckpointLock?: RecoveryCheckpointLock;
  /** Canonical repository key; must share/reenter the existing mutation fence when already owned. */
  withRepositoryLock?: RecoveryCheckpointLock;
}>;
export interface CheckpointRecoveryRuntime extends RecoveryAuthorityResolver {
  readonly mode: "core_checkpoint";
  /** Explicit clean selected commit only; ordinary read never initializes or adopts HEAD. */
  initialize(input: { revision: string; operationId: string }): Promise<RecoveryCheckpointWriteResult>;
  /** Authenticates one direct-child Git commit against its v2 journal's original expected tuple. */
  confirmCommitted(input: { revision: string; journalPath: string }): Promise<RecoveryCheckpointWriteResult>;
  /** One immutable journal identity per durability adapter; not a mutable current-operation slot. */
  durability(journalPath: string): Readonly<{ confirmRevision(revision: string): Promise<void> }>;
}
export class RecoveryAuthorityError extends Error {
  constructor(readonly category: string) { super(`Recovery authority failed: ${category}`); }
}
