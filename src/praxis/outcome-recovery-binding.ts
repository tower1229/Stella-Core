import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadConsciousness } from "../canghai/manifest.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { loadPraxisRuntimeBinding } from "./runtime-binding.js";
import { EpisodeV2Error } from "./episode-v2.js";

const run = promisify(execFile);
/** Pending business files may differ, but recovery authority must still match the configured revision. */
export async function loadOutcomeRecoveryBinding(root: string, manifestPath: string, recoveryRevision: string) {
  if (!/^[a-f0-9]{40}$/i.test(recoveryRevision)) throw new EpisodeV2Error("recovery_binding_changed");
  const loaded = await loadConsciousness(root, manifestPath);
  if (loaded.manifest.runtimeState.activationStatus !== "active") throw new EpisodeV2Error("recovery_binding_inactive");
  const binding = await loadPraxisRuntimeBinding(loaded);
  const paths = [...new Set([path.relative(loaded.canghaiRoot, loaded.manifestPath).replaceAll("\\", "/"), binding.configPath,
    ...loaded.bootstrapDocuments.map((document) => parseCangHaiRef(document.ref).relativePath)])];
  try {
    for (const file of paths) {
      const { stdout } = await run("git", ["-C", loaded.canghaiRoot, "ls-tree", recoveryRevision, "--", file]);
      if (!/^100(644|755) blob [a-f0-9]{40}\t/.test(stdout)) throw new Error("Untracked recovery authority");
    }
    await run("git", ["-C", loaded.canghaiRoot, "diff", "--exit-code", recoveryRevision, "--", ...paths]);
  } catch { throw new EpisodeV2Error("recovery_binding_changed"); }
  return { loaded, binding, episodeRoot: parseCangHaiRef(loaded.manifest.praxis.episodeRootRef).relativePath };
}
