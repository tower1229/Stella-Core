import { loadConsciousness, type LoadedConsciousness } from "../canghai/manifest.js";
import { createLegacyRecoveryAuthority, RecoveryBoundLoader } from "../canghai/recovery-bound-loader.js";
import { RecoveryAuthorityError, type RecoveryAuthorityResolver } from "../canghai/recovery-authority-contract.js";
import type { StellaDataMode } from "../praxis/episode-store.js";

type Config = { canghaiRoot: string; manifestPath: string; agentId: string; recoveryRevision: string; dataMode: StellaDataMode };
/** Shared real loader; the default plugin still uses legacy mode until every reader migrates. */
export class ConsciousnessLoader {
  readonly #loader: RecoveryBoundLoader<LoadedConsciousness>;
  readonly #authority: RecoveryAuthorityResolver;
  constructor(private readonly config: Config, openclawVersion: string, ttlMs = 1_000, authority?: RecoveryAuthorityResolver) {
    this.#authority = authority ?? createLegacyRecoveryAuthority({ agentId: config.agentId,
      repositoryRoot: config.canghaiRoot, manifestPath: config.manifestPath }, () => config.recoveryRevision);
    const { canghaiRoot, manifestPath, dataMode } = config;
    this.#loader = new RecoveryBoundLoader({ authority: this.#authority, ttlMs, load: snapshot =>
      loadConsciousness(canghaiRoot, manifestPath, { recoveryRevision: snapshot.revision,
        coreVersion: "3.0.0-alpha.0", openclawVersion, dataMode }) });
  }
  setRecoveryRevision(revision: string): void {
    if (this.#authority.mode !== "legacy_config") throw new RecoveryAuthorityError("recovery_checkpoint_setter_forbidden");
    this.config.recoveryRevision = revision;
    this.#loader.invalidate();
  }
  load(): Promise<LoadedConsciousness> { return this.#loader.load(); }
}
