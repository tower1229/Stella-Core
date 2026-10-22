import { assertRecoveryReadBinding, freezeRecoveryReadBinding, type RecoveryReadBinding } from "../canghai/recovery-read-binding.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadConsciousness } from "../canghai/manifest.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { loadPraxisRuntimeBinding } from "./runtime-binding.js";
import { EpisodeV2Error } from "./episode-v2.js";

const run = promisify(execFile);
/** Pending business files may differ, but recovery authority must still match the configured revision. */
export async function loadOutcomeRecoveryBinding(root: string, manifestPath: string, recoveryRevision: string, provided?: RecoveryReadBinding) {
  const recovery = provided ? freezeRecoveryReadBinding(provided, { agentId: provided.expected.binding.agentId, canghaiRoot: root, manifestPath }) : undefined;
  const assertRecovery = async () => {
    if (!recovery) return;
    if (recovery.expected.revision !== recoveryRevision) throw new EpisodeV2Error("recovery_binding_changed");
    await assertRecoveryReadBinding(recovery, { agentId: recovery.expected.binding.agentId, canghaiRoot: root, manifestPath });
  };
  await assertRecovery();
  if (!/^[a-f0-9]{40}$/i.test(recoveryRevision)) throw new EpisodeV2Error("recovery_binding_changed");
  const loaded = await loadConsciousness(root, manifestPath);
  if (loaded.manifest.runtimeState.activationStatus !== "active") throw new EpisodeV2Error("recovery_binding_inactive");
  const binding = await loadPraxisRuntimeBinding(loaded);
  const paths = [...new Set([path.relative(loaded.canghaiRoot, loaded.manifestPath).replaceAll("\\", "/"), binding.configPath, ...binding.profileAuthorityPaths,
    ...loaded.bootstrapDocuments.map((document) => parseCangHaiRef(document.ref).relativePath)])];
  const assertCurrent = async () => {
    await assertRecovery();
    try {
      for (const file of paths) {
        const { stdout } = await run("git", ["--no-optional-locks", "-C", loaded.canghaiRoot, "ls-tree", recoveryRevision, "--", file]);
        if (!/^100(644|755) blob [a-f0-9]{40}\t/.test(stdout)) throw new Error("Untracked recovery authority");
      }
      // Porcelain diff can refresh the index even with optional locks disabled.
      await run("git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-C", loaded.canghaiRoot, "diff", "--exit-code", recoveryRevision, "--", ...paths]);
    } catch { throw new EpisodeV2Error("recovery_binding_changed"); }
    await assertRecovery();
  };
  await assertCurrent();
  return { loaded, binding, assertCurrent, ...(recovery ? { recoveryAuthority: recovery.expected } : {}), episodeRoot: parseCangHaiRef(loaded.manifest.praxis.episodeRootRef).relativePath };
}
