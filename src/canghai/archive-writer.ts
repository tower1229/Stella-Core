import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../shared/type-guards.js";
import { CatalogError, CatalogReader, parseMemoryCatalog, validMemoryRef, type MemoryCatalog } from "./catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import type { HostInputArchive } from "./host-input-archive.js";
import { withMemoryMutationLock } from "./memory-transaction.js";

type ArchiveWriterPorts = {
  persist(paths: string[], operationId: string): Promise<void>;
  confirmPreviouslyCommitted(operationPath: string): Promise<void>;
};
type Intent = { schemaVersion: "stella.archive-operation/v1"; operationId: string; inputHash: string;
  beforeHash: string; afterHash: string; after: MemoryCatalog; paths: string[] };
function requireValue(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
async function location(root: string, relative: string, create = false): Promise<string> {
  requireValue(relative && !path.isAbsolute(relative) && !relative.includes("\\") && relative.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !part.includes(":")), "unsafe_archive_locator");
  const parts = relative.split("/");
  let directory = root;
  for (const part of ["", ...parts.slice(0, -1)]) {
    if (part) directory = path.join(directory, part);
    if (create && part) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const stat = await lstat(directory);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_archive_locator");
  }
  const file = path.join(directory, parts.at(-1)!);
  try { const stat = await lstat(file); requireValue(stat.isFile() && !stat.isSymbolicLink(), "unsafe_archive_locator"); }
  catch (error) { if (!missing(error)) throw error; }
  return file;
}
async function optionalText(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) { if (missing(error)) return undefined; throw error; }
}
async function publishFile(file: string, bytes: string, replace = false): Promise<void> {
  if (!replace) {
    const existing = await optionalText(file);
    if (existing !== undefined) { requireValue(existing === bytes, "immutable_archive_conflict"); return; }
  }
  const staged = path.join(path.dirname(file), `.archive-${randomUUID()}.staging`);
  const handle = await open(staged, "wx", 0o600);
  try { await handle.writeFile(bytes, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { if (replace) await rename(staged, file); else await link(staged, file); }
  finally { try { await unlink(staged); } catch (error) { if (!missing(error)) throw error; } }
}

export async function persistHostInputArchive(input: {
  reader: CatalogReader; archive: HostInputArchive; operationId: string;
  purpose: { readPurpose: string; derivePurpose: string; deliveryScope: string };
}, ports: ArchiveWriterPorts): Promise<{ generationId: string; sourceRef: HostInputArchive["sourceRef"]; evidenceRefs: HostInputArchive["evidenceRefs"] }> {
  const frozen = { ...input, archive: JSON.parse(canonicalJson(input.archive)) as HostInputArchive,
    purpose: { ...input.purpose } };
  return withMemoryMutationLock(input.reader.root, () => persistArchive(frozen, ports));
}

async function persistArchive(input: {
  reader: CatalogReader; archive: HostInputArchive; operationId: string;
  purpose: { readPurpose: string; derivePurpose: string; deliveryScope: string };
}, ports: ArchiveWriterPorts): Promise<{ generationId: string; sourceRef: HostInputArchive["sourceRef"]; evidenceRefs: HostInputArchive["evidenceRefs"] }> {
  requireValue(/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(input.operationId), "invalid_archive_operation_id");
  const archive: HostInputArchive = JSON.parse(canonicalJson(input.archive));
  const inputHash = bytesVersion(canonicalJson({ archive, purpose: input.purpose }));
  requireValue(bytesVersion(archive.payload.bytes) === archive.payload.sha256, "payload_digest_mismatch");
  for (const object of archive.objects) {
    requireValue(["sources", "evidence", "coverage"].includes(object.group) &&
      (object.group === "coverage" || validMemoryRef(object.object.policyRef)) &&
      validMemoryRef(object.ref) && objectVersion(object.object) === object.ref.version && object.object.id === object.ref.id &&
      canonicalJson(JSON.parse(object.bytes)) === canonicalJson(object.object) && bytesVersion(object.bytes) === object.entry.locator.sha256 &&
      object.entry.id === object.ref.id && object.entry.version === object.ref.version, "invalid_archive_object");
  }
  const { reader } = input;
  const lockPath = await location(reader.root, `${reader.catalogPath}.write-lock`);
  requireValue(await optionalText(lockPath) === undefined, "legacy_archive_lock_requires_recovery");
  {
    const operationPath = path.posix.join(path.posix.dirname(reader.catalogPath), "operations", `${input.operationId}.json`);
    const operationFile = await location(reader.root, operationPath, true);
    const expectedPaths = [reader.catalogPath, operationPath, archive.payload.path, ...archive.objects.map((object) => object.entry.locator.path)];
    const recorded = await optionalText(operationFile);
    const current = await CatalogReader.load(reader.root, reader.catalogPath);
    for (const object of archive.objects) {
      if (!validMemoryRef(object.object.policyRef)) continue;
      const policy = await current.read(object.object.policyRef, "policies");
      requireValue(policy.schemaVersion === "stella.source-policy/v1" && policy.retention === "retain" &&
        Array.isArray(policy.readPurposes) && policy.readPurposes.includes(input.purpose.readPurpose) &&
        Array.isArray(policy.derivePurposes) && policy.derivePurposes.includes(input.purpose.derivePurpose) &&
        Array.isArray(policy.deliveryScopes) && policy.deliveryScopes.includes(input.purpose.deliveryScope), "archive_permission_denied");
    }
    let intent: Intent;
    if (recorded !== undefined) {
      const parsed: unknown = JSON.parse(recorded);
      requireValue(isRecord(parsed) && parsed.schemaVersion === "stella.archive-operation/v1" && parsed.operationId === input.operationId &&
        parsed.inputHash === inputHash && typeof parsed.beforeHash === "string" && typeof parsed.afterHash === "string" && Array.isArray(parsed.paths), "archive_operation_conflict");
      const after = parseMemoryCatalog(parsed.after);
      requireValue(bytesVersion(canonicalJson(after)) === parsed.afterHash && canonicalJson(parsed.paths) === canonicalJson(expectedPaths) &&
        after.generationId === `generation_${bytesVersion(`${parsed.beforeHash}:${inputHash}`).slice(7)}`, "archive_journal_invalid");
      intent = parsed as Intent;
      if (current.catalogHash !== intent.beforeHash && current.catalogHash !== intent.afterHash) {
        // A later generation must not be replaced by replaying an earlier operation.
        await ports.confirmPreviouslyCommitted(operationPath);
        return { generationId: intent.after.generationId, sourceRef: archive.sourceRef, evidenceRefs: archive.evidenceRefs };
      }
    } else {
      requireValue(current.catalogHash === reader.catalogHash, "stale_generation");
      const after: MemoryCatalog = JSON.parse(canonicalJson(current.catalog));
      for (const object of archive.objects) {
        const entries = after[object.group];
        const existing = entries.find((entry) => entry.id === object.ref.id && entry.version === object.ref.version);
        if (existing) { requireValue(canonicalJson(existing) === canonicalJson(object.entry), "archive_catalog_conflict"); continue; }
        for (const entry of entries) if (entry.id === object.ref.id && entry.status === "current") entry.status = "superseded";
        entries.push(object.entry);
      }
      after.parentGenerationId = current.catalog.generationId;
      after.generationId = `generation_${bytesVersion(`${current.catalogHash}:${inputHash}`).slice(7)}`;
      parseMemoryCatalog(after);
      intent = { schemaVersion: "stella.archive-operation/v1", operationId: input.operationId, inputHash,
        beforeHash: current.catalogHash, afterHash: bytesVersion(canonicalJson(after)), after,
        paths: expectedPaths };
      await publishFile(operationFile, canonicalJson(intent));
    }
    await publishFile(await location(reader.root, archive.payload.path, true), archive.payload.bytes);
    for (const object of archive.objects) await publishFile(await location(reader.root, object.entry.locator.path, true), object.bytes);
    await current.assertCurrent();
    await publishFile(await location(reader.root, reader.catalogPath), canonicalJson(intent.after), true);
    await ports.persist(intent.paths, input.operationId);
    return { generationId: intent.after.generationId, sourceRef: archive.sourceRef, evidenceRefs: archive.evidenceRefs };
  }
}
