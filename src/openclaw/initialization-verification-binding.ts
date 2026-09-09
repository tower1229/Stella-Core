import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parse as parseYaml } from "yaml";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { readRepositoryBytes } from "../canghai/catalog-reader.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { loadRuntimeProfileResources } from "../canghai/runtime-profile-resources.js";
import { isRecord } from "../shared/type-guards.js";
import { InitializationError, type InitializationVerificationBinding } from "./initialization.js";

// Hash installed bytes, including native harness implementation; package version alone is insufficient.
async function treeVersion(root: string): Promise<string> {
  const entries: Array<[string, string]> = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) entries.push([path.relative(root, file), bytesVersion(await readFile(file))]);
      else throw new InitializationError("verification_artifact_unsupported");
    }
  };
  await walk(root);
  return bytesVersion(canonicalJson(entries.sort(([a], [b]) => a.localeCompare(b))));
}

async function installedCodeIdentity() {
  const dist = fileURLToPath(new URL("../../", import.meta.url));
  const hostDist = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"))), "..");
  const [core, artifact, host] = await Promise.all([
    readFile(path.join(dist, "build-identity.json")).then(bytesVersion), treeVersion(dist), treeVersion(hostDist),
  ]);
  return { core, artifact, host };
}
// Pin at module loading. Never label old loaded code with subsequently replaced installed bytes.
const loadedCode = installedCodeIdentity().catch(() => null);

/** Private dependency inspection. Only digests leave the authenticated operator boundary. */
export async function captureInitializationVerificationBinding(api: OpenClawPluginApi,
  input: { canghaiRoot: string; manifestPath: string; agentId: string }): Promise<InitializationVerificationBinding> {
  const config = api.runtime.config.current();
  const plugin = config.plugins?.entries?.["stella-core"];
  if (!plugin?.enabled || typeof plugin.config?.recoveryRevision !== "string") throw new InitializationError("initialization_config_changed");
  const manifest: unknown = parseYaml((await readRepositoryBytes(input.canghaiRoot, input.manifestPath)).toString("utf8"));
  if (!isRecord(manifest) || !isRecord(manifest.identity) || typeof manifest.identity.runtimeProfileRef !== "string") throw new InitializationError("profile_required");
  const profileBytes = await readRepositoryBytes(input.canghaiRoot, parseCangHaiRef(manifest.identity.runtimeProfileRef).relativePath);
  const profile = parseRuntimeProfile(parseYaml(profileBytes.toString("utf8")));
  const resources = await loadRuntimeProfileResources(input.canghaiRoot, profile);
  const hashes: Array<[string, string]> = [];
  for (const file of resources.authorityPaths) hashes.push([file, bytesVersion(await readRepositoryBytes(input.canghaiRoot, file))]);
  const loaded = await loadedCode;
  if (!loaded || canonicalJson(await installedCodeIdentity()) !== canonicalJson(loaded)) throw new InitializationError("verification_code_reload_required");
  const { core, artifact, host } = loaded;
  const generation = profile.memory ? bytesVersion(await readRepositoryBytes(input.canghaiRoot, parseCangHaiRef(profile.memory.catalog_ref).relativePath))
    : bytesVersion(canonicalJson({ memory: null }));
  return { core, artifact, host, harness: bytesVersion(canonicalJson({ name: "openclaw", version: api.runtime.version })),
    source: bytesVersion(plugin.config.recoveryRevision), profile: bytesVersion(profileBytes), policy: bytesVersion(canonicalJson(hashes.sort())),
    configuration: bytesVersion(JSON.stringify(config)), model: bytesVersion(canonicalJson(profile.models)),
    cases: bytesVersion("installed-bootstrap:files,skills,identity,context:v1"),
    deployment: bytesVersion(canonicalJson({ source: api.source, agentId: input.agentId })), generation };
}
