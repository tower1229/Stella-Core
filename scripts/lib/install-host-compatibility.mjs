import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOST_COMPATIBILITY, hostModuleHash, patchPrivateDraftHost } from "../../dist/src/acceptance/host-compatibility.js";

/** Only a runner-created isolated consumer is accepted, never a global install. */
export async function installHostCompatibility(consumerRoot) {
  const root = await realpath(consumerRoot);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.private !== true || !["stella-private-recovery", "stella-private-evaluation", "stella-private-praxis"].includes(manifest.name)) {
    throw new Error("host_patch_requires_isolated_consumer");
  }
  const hostRoot = await realpath(path.join(root, "node_modules/openclaw"));
  if (hostRoot !== path.join(root, "node_modules/openclaw")) throw new Error("host_patch_symlink_rejected");
  if (JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8")).version !== HOST_COMPATIBILITY.hostVersion) {
    throw new Error("host_patch_version_mismatch");
  }
  const target = path.join(hostRoot, HOST_COMPATIBILITY.module);
  if (await realpath(target) !== target) throw new Error("host_patch_symlink_rejected");
  const before = await readFile(target);
  const patched = patchPrivateDraftHost(before);
  if (!before.equals(patched)) await writeFile(target, patched);
  if (hostModuleHash(await readFile(target)) !== HOST_COMPATIBILITY.patchedSha256) throw new Error("host_patch_readback_failed");
  return { ...HOST_COMPATIBILITY };
}
