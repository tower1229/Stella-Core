import type { RecoveryCheckpointBinding, RecoveryCheckpointVersion } from "./recovery-checkpoint-contract.js";
export type MemoryFileEncoding = "utf8" | "base64";
export type MemoryFileChange = {
  path: string;
  before: string | null;
  after: string;
  /** Default utf8. base64 stores exact binary bytes. */
  encoding?: MemoryFileEncoding;
};
export type MemoryTransactionPlan = {
  operationId: string;
  journalPath: string;
  files: MemoryFileChange[];
  /** Locator only; recovery must authenticate the archive with deployment-owned keys. */
  contextArchive?: { archiveRoot: string; digest: string };
  /** v2 only: fixed before the business commit, never reconstructed from observed checkpoint. */
  recoveryCheckpoint?: { binding: RecoveryCheckpointBinding; expected: RecoveryCheckpointVersion };
};
