import path from "node:path";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";
import { openCheckpointRecoveryRuntime } from "./checkpoint-recovery-runtime.js";
import type { CheckpointRecoveryRuntimeOptions } from "./recovery-authority-contract.js";

/** Explicit local adapter. No SDK/PID query and no implicit initialization.
 * Upgrade must drain legacy writers; existing or crash-residue locks fail closed.
 * Every future business writer must cooperate with this same repository fence.
 */
export function openLocalCheckpointRecovery(options: Pick<CheckpointRecoveryRuntimeOptions, "stateDirectory" | "binding">) {
  const root = options.binding.repositoryRoot;
  return openCheckpointRecoveryRuntime({ ...options,
    withRepositoryLock: (key, work) => {
      if (key !== root) throw new Error("Recovery repository lock scope mismatch");
      return withExclusiveFileLock(path.join(root, ".stella-memory-transaction.json"), work);
    },
    withCheckpointLock: (key, work) => withExclusiveFileLock(key, work),
  });
}
