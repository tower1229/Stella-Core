import { updateConfig } from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

export class RecoveryPointerSyncError extends Error {
  readonly category = "stella_recovery_pointer_sync_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoveryPointerSyncError";
  }
}

export function advanceStellaRecoveryPointer(
  config: OpenClawConfig,
  expectedRevision: string,
  nextRevision: string,
): OpenClawConfig {
  if (!SHA_PATTERN.test(expectedRevision) || !SHA_PATTERN.test(nextRevision)) {
    throw new RecoveryPointerSyncError("Stella recovery pointer requires full Git revisions");
  }
  const entry = config.plugins?.entries?.["stella-core"];
  if (entry?.config?.recoveryRevision !== expectedRevision) {
    throw new RecoveryPointerSyncError("Stella recovery pointer changed concurrently");
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        "stella-core": {
          ...entry,
          config: {
            ...entry.config,
            recoveryRevision: nextRevision,
          },
        },
      },
    },
  };
}

export type RecoveryPointerWriter = {
  advance(expectedRevision: string, nextRevision: string): Promise<void>;
};

export function createOpenClawRecoveryPointerWriter(): RecoveryPointerWriter {
  return {
    async advance(expectedRevision, nextRevision) {
      try {
        await updateConfig((config) =>
          advanceStellaRecoveryPointer(config, expectedRevision, nextRevision));
      } catch (error) {
        if (error instanceof RecoveryPointerSyncError) throw error;
        throw new RecoveryPointerSyncError("Stella recovery pointer could not be persisted", {
          cause: error,
        });
      }
    },
  };
}
