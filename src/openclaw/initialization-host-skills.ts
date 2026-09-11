import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { bytesVersion } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { InitializationError } from "./initialization.js";
import type { Materialization } from "./initialization.js";
import { parseDisplayIdentityFields, type HostIdentity } from "./initialization-templates.js";

export type HostSkillFileReader = (path: string) => Promise<Buffer>;

/** Verify skill body and resources through the Host-resolved skill root, not a guessed workspace path alone. */
export async function verifyHostSkillTree(input: {
  skillName: string;
  skillRoot: string;
  files: Materialization["files"];
  readFile?: HostSkillFileReader;
  realpath?: (path: string) => Promise<string>;
}): Promise<void> {
  const read = input.readFile ?? (async (filePath) => readFile(filePath));
  const resolve = input.realpath ?? realpath;
  const skillFiles = input.files.filter((file) => file.target.startsWith(`skills/${input.skillName}/`));
  if (!skillFiles.some((file) => file.target === `skills/${input.skillName}/SKILL.md`)) {
    throw new InitializationError("skill_body_missing");
  }
  for (const file of skillFiles) {
    const relative = file.target.slice(`skills/${input.skillName}/`.length);
    if (!relative || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new InitializationError("invalid_skill_tree");
    }
    let resolved: string;
    try { resolved = await resolve(path.join(input.skillRoot, relative)); }
    catch { throw new InitializationError("host_skill_content_mismatch"); }
    const relativeResolved = path.relative(input.skillRoot, resolved).split(path.sep).join("/");
    if (relativeResolved !== relative || relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
      throw new InitializationError("unsafe_skill_source");
    }
    let observed: Buffer;
    try { observed = await read(resolved); }
    catch { throw new InitializationError("host_skill_content_mismatch"); }
    if (bytesVersion(observed) !== file.sha256) throw new InitializationError("host_skill_content_mismatch");
    if (relative === "SKILL.md") {
      const text = observed.toString("utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata: unknown = frontmatter ? parseYaml(frontmatter[1]!) : undefined;
      if (!isRecord(metadata) || metadata.name !== input.skillName || typeof metadata.description !== "string") {
        throw new InitializationError("invalid_skill_metadata");
      }
    }
  }
}

/** Compare Host config identity with Host-served IDENTITY.md fields (channel/UI config slice). */
export function assertHostChannelIdentity(identity: HostIdentity | null, identityDocument: string): void {
  if (!identity) return;
  const fields = parseDisplayIdentityFields(identityDocument);
  if (identity.name !== undefined && fields.name !== identity.name) {
    throw new InitializationError("host_channel_identity_mismatch");
  }
  if (identity.emoji !== undefined && fields.emoji !== identity.emoji) {
    throw new InitializationError("host_channel_identity_mismatch");
  }
  if (identity.theme !== undefined && fields.theme !== identity.theme) {
    throw new InitializationError("host_channel_identity_mismatch");
  }
  if (identity.avatar !== undefined && fields.avatar !== identity.avatar) {
    throw new InitializationError("host_channel_identity_mismatch");
  }
}
