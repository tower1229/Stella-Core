import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { bytesVersion } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";

/** Explicit diagnostic, never called at module loading or normal registration.
 * Paths are supplied by trusted local packaging code, never model/config arguments.
 * Reads exactly two package metadata files and optionally one project lockfile.
 */
export async function inspectPublicPackageProvenance(input: { corePackageJson: string; hostPackageJson: string; projectLockfile?: string }) {
  const read = async (file: string, basename: string) => {
    if (!path.isAbsolute(file) || path.basename(file) !== basename) throw new Error("Invalid public package metadata path");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("Unsafe public package metadata");
    const bytes = await readFile(file), value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) throw new Error("Invalid public package metadata");
    return { value, sha256: bytesVersion(bytes) };
  };
  const metadata = async (file: string, name: string) => {
    const result = await read(file, "package.json");
    if (result.value.name !== name || typeof result.value.version !== "string") throw new Error("Public package metadata mismatch");
    return { name, declaredVersion: result.value.version, metadataSha256: result.sha256 };
  };
  const core = await metadata(input.corePackageJson, "@tower1229/stella-core"), host = await metadata(input.hostPackageJson, "openclaw");
  let lockedHost: { version: string; integrity: string | null; matchesDeclaredVersion: boolean } | null = null;
  if (input.projectLockfile) {
    const lock = await read(input.projectLockfile, "package-lock.json"), entry = isRecord(lock.value.packages) ? lock.value.packages["node_modules/openclaw"] : undefined;
    if (!isRecord(entry) || typeof entry.version !== "string") throw new Error("Missing public Host lock entry");
    lockedHost = { version: entry.version, integrity: typeof entry.integrity === "string" && /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity) ? entry.integrity : null,
      matchesDeclaredVersion: entry.version === host.declaredVersion };
  }
  return Object.freeze({ scope: "declared_public_package_metadata" as const, core, host, lockedHost,
    loadedCodeIdentity: "unverified" as const, installedTreeIdentity: "unverified" as const, archiveIntegrityVerified: false as const,
    capabilityReceipt: null, functionalAcceptance: false as const });
}
