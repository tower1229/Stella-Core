import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { CatalogError } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { contextHistorySignerId } from "./host-context-history.js";

type KeyScope = { stateDirectory: string; repositoryRoot: string; agentId: string };
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const hasCode = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;

async function keyPath(scope: KeyScope, create: boolean): Promise<string> {
  check(path.isAbsolute(scope.stateDirectory) && path.isAbsolute(scope.repositoryRoot) && scope.agentId.trim() &&
    scope.agentId.length <= 128, "host_context_archive_key_scope_invalid");
  const repository = await realpath(scope.repositoryRoot);
  const state = await lstat(scope.stateDirectory);
  check(state.isDirectory() && !state.isSymbolicLink() && (state.mode & 0o022) === 0 &&
    (process.getuid === undefined || state.uid === process.getuid()), "host_context_archive_key_unsafe");
  let directory = await realpath(scope.stateDirectory);
  // The signing secret must never enter the Git-backed personal data source.
  const relative = path.relative(repository, directory);
  check(relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative), "host_context_archive_key_scope_invalid");
  const identity = bytesVersion(canonicalJson({ agentId: scope.agentId, repositoryRoot: repository })).slice(7);
  const target = path.join(directory, "stella-core", "context-signing", identity);
  const targetRelative = path.relative(repository, target);
  check(targetRelative.startsWith(`..${path.sep}`) || targetRelative === ".." || path.isAbsolute(targetRelative),
    "host_context_archive_key_scope_invalid");
  for (const part of ["stella-core", "context-signing", identity]) {
    directory = path.join(directory, part);
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    }
    const stat = await lstat(directory);
    check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
      (process.getuid === undefined || stat.uid === process.getuid()), "host_context_archive_key_unsafe");
  }
  check(await realpath(directory) === target, "host_context_archive_key_unsafe");
  return path.join(directory, "signing-key.pem");
}

async function readKey(file: string) {
  const before = await lstat(file);
  check(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o777) === 0o600 && before.size <= 8192 &&
    (process.getuid === undefined || before.uid === process.getuid()), "host_context_archive_key_unsafe");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(opened.dev === before.dev && opened.ino === before.ino, "host_context_archive_key_changed");
    const bytes = await handle.readFile();
    const after = await lstat(file);
    check(after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
      after.mtimeMs === before.mtimeMs && after.mode === before.mode, "host_context_archive_key_changed");
    let signingKey;
    try { signingKey = createPrivateKey(bytes); } catch { throw new CatalogError("host_context_archive_key_invalid"); }
    check(signingKey.asymmetricKeyType === "ed25519", "host_context_archive_key_invalid");
    const verificationKey = createPublicKey(signingKey);
    return { keyPath: file, signingKey, verificationKey, signerId: contextHistorySignerId(verificationKey) };
  } finally { await handle.close(); }
}

/** Runtime loading never creates or repairs a key. The expected identity must
 * come from the reviewed deployment configuration, independently of archives. */
export async function loadContextHistoryKeys(scope: KeyScope, expectedSignerId: string) {
  check(/^sha256:[a-f0-9]{64}$/.test(expectedSignerId), "host_context_archive_key_scope_invalid");
  try {
    const keys = await readKey(await keyPath(scope, false));
    check(keys.signerId === expectedSignerId, "host_context_archive_signer_mismatch");
    return keys;
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new CatalogError("host_context_archive_key_missing");
    throw error;
  }
}

/** Explicit initialization only. Publish a fully written key without replacing
 * an existing identity; concurrent initializers all load the winning key. */
export async function initializeContextHistoryKeys(scope: KeyScope) {
  const file = await keyPath(scope, true);
  try { return await readKey(file); }
  catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const staging = `${file}.${randomUUID()}.staging`;
  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(staging, file); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await unlink(staging); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  return readKey(file);
}
