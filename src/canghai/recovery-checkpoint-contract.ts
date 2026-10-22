/** Local authority only: neither a target journal nor proof of Host/model consumption. */
export type RecoveryCheckpointBinding = Readonly<{
  agentId: string;
  repositoryRoot: string;
  manifestPath: string;
}>;
export type RecoveryCheckpointVersion = Readonly<{ revision: string; token: string }>;
export type RecoveryCheckpoint = Readonly<{
  schemaVersion: "stella.recovery-checkpoint/v1";
  binding: RecoveryCheckpointBinding;
  revision: string;
  token: string;
  lastOperationId: string;
  lastOperationDigest: string;
}>;
/** Must serialize all processes using the same canonical checkpoint path.
 * Runtime integration will supply the existing public lock adapter; no lock is inferred from a read.
 * When combined with a repository mutation lock, acquire repository first, checkpoint second.
 */
export type RecoveryCheckpointLock = <T>(key: string, work: () => Promise<T>) => Promise<T>;
/** Optional fault/diagnostic observer; it confers no authority or consumption receipt. */
export type RecoveryCheckpointWritePhase = "file_synced" | "replaced" | "directory_synced";
export type RecoveryCheckpointStoreOptions = Readonly<{
  /** Explicit, existing canonical directory outside repositoryRoot; never chmods existing paths. */
  stateDirectory: string;
  binding: RecoveryCheckpointBinding;
  withLock: RecoveryCheckpointLock;
  onWritePhase?: (phase: RecoveryCheckpointWritePhase) => void | Promise<void>;
}>;
export type RecoveryCheckpointWriteResult = Readonly<{ checkpoint: RecoveryCheckpoint; replayed: boolean }>;
export interface RecoveryCheckpointStore {
  readonly path: string;
  /** Missing/corrupt/mismatched authority fails; never adopts Git HEAD or an implicit seed. */
  read(): Promise<RecoveryCheckpoint>;
  /** Explicit initial choice only; exact retry is idempotent, other initializations conflict. */
  initialize(input: { revision: string; operationId: string }): Promise<RecoveryCheckpointWriteResult>;
  /** The original expectation remains fixed on retries, including an accepted but unacknowledged CAS. */
  compareAndSet(input: { expected: RecoveryCheckpointVersion; nextRevision: string; operationId: string }): Promise<RecoveryCheckpointWriteResult>;
}
export class RecoveryCheckpointError extends Error {
  constructor(readonly category: string, options?: ErrorOptions) {
    super(`Recovery checkpoint failed: ${category}`, options);
  }
}
