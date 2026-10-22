import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CatalogError } from "./catalog-reader.js";
const run = promisify(execFile);

/** Exact committed regular blob, never a working-tree value or filesystem symlink.
 * Used to authenticate recovery business inputs against the original authority A.
 */
export async function readCheckpointCommittedDocument(root: string, revision: string, relativePath: string): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(revision) || !relativePath || relativePath.includes("\\") ||
    relativePath.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[:\x00-\x1f]/.test(part))) {
    throw new CatalogError("archive_recovery_authority_invalid");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  const args = ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", root];
  const entry = (await run("git", [...args, "ls-tree", "-z", revision, "--", ":(literal)" + relativePath], { cwd: root, env, maxBuffer: 16_384 })).stdout;
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== relativePath) throw new CatalogError("archive_recovery_authority_invalid");
  return (await run("git", [...args, "cat-file", "blob", match[2]!], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 })).stdout;
}
