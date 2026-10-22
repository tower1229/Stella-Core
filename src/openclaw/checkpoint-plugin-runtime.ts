import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openLocalCheckpointRecovery } from "../canghai/local-checkpoint-recovery.js";
import { createRecoveryReadScope, freezeRecoveryReadBinding, type RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import { RecoveryBoundLoader } from "../canghai/recovery-bound-loader.js";
import { loadConsciousness } from "../canghai/manifest.js";
import { withExclusiveFileLock } from "../canghai/exclusive-file-lock.js";
import { persistCheckpointArchive, type CheckpointArchivePorts } from "../canghai/checkpoint-archive.js";
import type { CatalogReader } from "../canghai/catalog-reader.js";
import type { HostInputArchive } from "../canghai/host-input-archive.js";
import { RecoveryAuthorityError } from "../canghai/recovery-authority-contract.js";
import { StellaInitializer, type InitializationPorts, type InitializationSource } from "./initialization.js";

const run = promisify(execFile);
export type CheckpointPluginConfig = Readonly<{ recoveryAuthority: "core_checkpoint"; checkpointStateDirectory: string;
  canghaiRoot: string; manifestPath: string; agentId: string; dataMode: "read_only" | "local_write" }>;
export function parseCheckpointPluginConfig(value: unknown): CheckpointPluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecoveryAuthorityError("checkpoint_configuration_invalid");
  const config = value as Record<string, unknown>;
  const allowed = ["recoveryAuthority", "checkpointStateDirectory", "canghaiRoot", "manifestPath", "agentId", "dataMode"];
  if (Object.keys(config).some(key => !allowed.includes(key)) || config.recoveryAuthority !== "core_checkpoint" ||
    typeof config.canghaiRoot !== "string" || !path.isAbsolute(config.canghaiRoot) ||
    typeof config.checkpointStateDirectory !== "string" || !path.isAbsolute(config.checkpointStateDirectory) ||
    !["read_only", "local_write"].includes(String(config.dataMode)) ||
    config.agentId !== undefined && (typeof config.agentId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(config.agentId)) ||
    config.manifestPath !== undefined && (typeof config.manifestPath !== "string" || !config.manifestPath)) {
    throw new RecoveryAuthorityError("checkpoint_configuration_invalid");
  }
  return Object.freeze({ recoveryAuthority: "core_checkpoint", canghaiRoot: config.canghaiRoot, checkpointStateDirectory: config.checkpointStateDirectory,
    manifestPath: config.manifestPath as string | undefined ?? "50_PersonalAgent/stella/manifest.yaml", agentId: config.agentId as string | undefined ?? "stella",
    dataMode: config.dataMode as "read_only" | "local_write" });
}

/** One resolver per registration. No config writer, implicit seed or mutable current-operation slot. */
export async function createCheckpointPluginRuntime(input: CheckpointPluginConfig, hostVersion: string) {
  const config = parseCheckpointPluginConfig(input), root = config.canghaiRoot;
  const runtime = await openLocalCheckpointRecovery({ stateDirectory: config.checkpointStateDirectory,
    binding: { agentId: config.agentId, repositoryRoot: root, manifestPath: config.manifestPath } });
  const scope = createRecoveryReadScope(config, runtime), shutdown = new AbortController();
  const active = () => { if (shutdown.signal.aborted) throw new RecoveryAuthorityError("recovery_scope_closed"); };
  const writable = () => { active(); if (config.dataMode !== "local_write") throw new RecoveryAuthorityError("checkpoint_write_disabled"); };
  const repository = <T>(work: () => Promise<T>) => withExclusiveFileLock(path.join(root, ".stella-memory-transaction.json"), work);
  const loader = new RecoveryBoundLoader({ authority: scope.resolver, load: async expected => {
    const loaded = await loadConsciousness(root, config.manifestPath, { recoveryRevision: expected.revision,
      coreVersion: "3.0.0-alpha.0", openclawVersion: hostVersion, dataMode: config.dataMode });
    return Object.freeze({ loaded, recovery: Object.freeze({ resolver: scope.resolver, expected }) });
  } });
  const assert = async (value: RecoveryReadBinding) => {
    const fixed = freezeRecoveryReadBinding(value, config);
    if (fixed.resolver !== scope.resolver) throw new RecoveryAuthorityError("recovery_read_binding_mismatch");
    await scope.resolver.assertCurrent(fixed.expected);
  };
  return Object.freeze({
    config,
    capture: scope.capture,
    assert,
    async initializeAuthority(selected: { revision: string; operationId: string }) {
      writable(); const result = await runtime.initialize({ ...selected }); active(); return result;
    },
    async load() { active(); const result = await loader.load(); active(); return result; },
    /** Trusted Core callers supply an already authenticated Host event archive, never a model tool argument. */
    async archiveLocal(input: { recovery: RecoveryReadBinding; reader: Pick<CatalogReader, "root" | "catalogPath" | "catalogHash">; archive: HostInputArchive; operationId: string;
      purpose: { readPurpose: string; derivePurpose: string; deliveryScope: string };
      assertPublication?: CheckpointArchivePorts["recovery"]["assertPublication"]; signal?: AbortSignal }) {
      writable();
      const fixed = freezeRecoveryReadBinding(input.recovery, config);
      if (fixed.resolver !== scope.resolver || input.reader.root !== root) throw new RecoveryAuthorityError("recovery_read_binding_mismatch");
      const cancellation = AbortSignal.any([shutdown.signal, ...input.signal ? [input.signal] : []]);
      const checkActive = () => { active(); cancellation.throwIfAborted(); };
      checkActive();
      const publication = input.assertPublication;
      return persistCheckpointArchive(input, {
        signal: cancellation,
        recovery: { authority: runtime, expected: fixed.expected, async assertPublication(accepted) {
          checkActive(); await publication?.(accepted); checkActive();
        } },
        async commit(paths, operationId) {
          checkActive();
          await run("git", ["-C", root, "add", "--", ...paths]); checkActive();
          const changed = (await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root,
            "diff", "--cached", "--name-only", "--", ...paths])).stdout;
          if (changed.trim()) await run("git", ["-C", root, "commit", "--quiet", "-m", `[stella:local] ${operationId}`, "--", ...paths]);
          checkActive();
        },
      });
    },
    /** Explicit file materialization only. Caller supplies existing Host fence/verify/identity adapters.
     * Each operation owns one fixed authority and fresh initializer; receipts do not prove Agent consumption.
     */
    async prepareInitialization(input: { workspace: string; stateRoot: string;
      source: Omit<InitializationSource, "root" | "revision" | "agentId" | "hostVersion">; ports: InitializationPorts }) {
      writable();
      const ports = { ...input.ports }, source = { ...input.source, ...(input.source.requiredCapabilities ? { requiredCapabilities: [...input.source.requiredCapabilities] } : {}) };
      const recovery = await scope.capture();
      const guarded = async (work: () => Promise<void>) => { await assert(recovery); await work(); await assert(recovery); };
      const initializer = new StellaInitializer(input.workspace, input.stateRoot,
        Object.freeze({ ...source, root, revision: recovery.expected.revision, agentId: config.agentId, hostVersion }),
        { ...ports, withLock: withExclusiveFileLock, strictOwnership: true, recoveryAuthority: recovery.expected,
          fence: () => guarded(() => ports.fence()), verify: (recipe, host) => guarded(() => ports.verify(recipe, host)),
          release: () => guarded(() => ports.release()) }, shutdown.signal);
      const operation = <T>(work: () => Promise<T>) => repository(async () => { await assert(recovery); const result = await work(); await assert(recovery); return result; });
      return Object.freeze({ recovery, initialize: () => operation(() => initializer.initialize()), assertCurrent: () => operation(() => initializer.assertCurrent()) });
    },
    close() { shutdown.abort(); scope.close(); loader.invalidate(); },
  });
}
