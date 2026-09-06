import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../shared/type-guards.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { bytesVersion, objectVersion } from "./content-version.js";

const run = promisify(execFile);
const groups = ["sources", "evidence", "policies", "understandings", "works", "changes", "bundles", "coverage"] as const;
export type CatalogGroup = (typeof groups)[number];
export type CatalogEntry = VersionedRef & {
  locator: { path: string; sha256: string };
  status: "current" | "superseded" | "removed";
  dependencies: VersionedRef[];
  metadataRef?: VersionedRef;
};
export type MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1"; generationId: string; parentGenerationId: string | null;
  views: unknown[] } & Record<CatalogGroup, CatalogEntry[]>;
export class CatalogError extends Error {
  constructor(readonly category: string) { super(`Memory catalog failed: ${category}`); }
}
function requireCondition(condition: unknown, category: string): asserts condition {
  if (!condition) throw new CatalogError(category);
}
function validVersion(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
export function validMemoryRef(value: unknown): value is VersionedRef & Record<string, unknown> {
  return isRecord(value) && typeof value.id === "string" && Boolean(value.id) && validVersion(value.version);
}
const validRef = validMemoryRef;
const key = (ref: VersionedRef) => JSON.stringify([ref.id, ref.version]);
export function parseMemoryCatalog(value: unknown): MemoryCatalog {
  requireCondition(isRecord(value) && value.schemaVersion === "stella.memory-catalog/v1" && typeof value.generationId === "string" && value.generationId &&
    (value.parentGenerationId === null || typeof value.parentGenerationId === "string" && value.parentGenerationId) && Array.isArray(value.views), "invalid_catalog");
  const seen = new Set<string>();
  const current = new Set<string>();
  for (const group of groups) {
    const entries = value[group];
    requireCondition(Array.isArray(entries), "invalid_catalog");
    for (const entry of entries) {
      requireCondition(validRef(entry) && isRecord(entry) && isRecord(entry.locator) && typeof entry.locator.path === "string" &&
        validVersion(entry.locator.sha256) && ["current", "superseded", "removed"].includes(String(entry.status)) &&
        Array.isArray(entry.dependencies) && entry.dependencies.every(validRef) && (entry.metadataRef === undefined || validRef(entry.metadataRef)), "invalid_catalog_entry");
      requireCondition(!seen.has(key(entry)), "duplicate_object_version");
      seen.add(key(entry));
      if (entry.status === "current") {
        requireCondition(!current.has(entry.id), "ambiguous_current_version");
        current.add(entry.id);
      }
    }
  }
  return value as MemoryCatalog;
}

function safeRelative(value: string): string {
  const relative = value.replaceAll("\\", "/");
  requireCondition(relative && !path.isAbsolute(relative) && !relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":")), "unsafe_locator");
  return relative;
}
async function readLocal(root: string, relativePath: string): Promise<Buffer> {
  const parts = safeRelative(relativePath).split("/");
  let current = root;
  const rootStat = await lstat(current);
  requireCondition(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "unsafe_locator");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    const stat = await lstat(current);
    requireCondition(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), "unsafe_locator");
    if (index === parts.length - 1) requireCondition(stat.size <= 16 * 1024 * 1024, "resource_exhausted");
  }
  return readFile(current);
}

/** Reads a fixed catalog snapshot; it never treats older Git content as current evidence. */
export class CatalogReader {
  readonly #entries = new Map<string, { group: CatalogGroup; entry: CatalogEntry }>();
  private constructor(readonly root: string, readonly catalogPath: string, readonly catalog: MemoryCatalog, readonly catalogHash: string) {
    for (const group of groups) for (const entry of catalog[group]) this.#entries.set(key(entry), { group, entry });
  }
  static async load(root: string, catalogPath: string): Promise<CatalogReader> {
    try {
      const bytes = await readLocal(path.resolve(root), catalogPath);
      return new CatalogReader(path.resolve(root), safeRelative(catalogPath), parseMemoryCatalog(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), bytesVersion(bytes));
    } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("catalog_unavailable"); }
  }
  async assertCurrent(): Promise<void> {
    try { requireCondition(bytesVersion(await readLocal(this.root, this.catalogPath)) === this.catalogHash, "stale_generation"); }
    catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("catalog_unavailable"); }
  }
  entry(ref: VersionedRef, group?: CatalogGroup): CatalogEntry {
    const found = this.#entries.get(key(ref));
    requireCondition(found && (!group || found.group === group), "reference_unavailable");
    return found.entry;
  }
  currentRef(id: string, group: CatalogGroup): VersionedRef {
    const entry = this.catalog[group].find((item) => item.id === id && item.status === "current");
    requireCondition(entry, "reference_unavailable");
    return { id: entry.id, version: entry.version };
  }
  eligible(ref: VersionedRef, seen = new Set<string>()): boolean {
    const entry = this.entry(ref);
    if (entry.status !== "current") return false;
    requireCondition(!seen.has(key(ref)), "dependency_cycle");
    const visited = new Set([...seen, key(ref)]);
    return [...entry.dependencies, ...(entry.metadataRef ? [entry.metadataRef] : [])].every((dependency) => this.eligible(dependency, visited));
  }
  async read(ref: VersionedRef, group?: CatalogGroup, mode: "current" | "historical" = "current"): Promise<Record<string, unknown>> {
    await this.assertCurrent();
    const entry = this.entry(ref, group);
    requireCondition(entry.status !== "removed", "source_removed");
    if (mode === "current") requireCondition(this.eligible(ref), "evidence_not_currently_eligible");
    try {
      const bytes = await readLocal(this.root, entry.locator.path);
      requireCondition(bytesVersion(bytes) === entry.locator.sha256, "locator_digest_mismatch");
      const object: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      requireCondition(isRecord(object) && object.id === ref.id && typeof object.schemaVersion === "string" &&
        (object.version === undefined || object.version === ref.version) && objectVersion(object) === ref.version, "object_version_mismatch");
      await this.assertCurrent();
      return object;
    } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("object_unavailable"); }
  }
  async readPayload(sourceRef: VersionedRef, payloadSha256: string): Promise<{ bytes: Buffer; mediaType: string }> {
    const source = await this.read(sourceRef, "sources");
    requireCondition(source.schemaVersion === "stella.memory-source/v1" && Array.isArray(source.payloads), "invalid_source");
    const payloads = source.payloads.filter((item: unknown) => isRecord(item) && item.sha256 === payloadSha256);
    requireCondition(payloads.length === 1 && isRecord(payloads[0]), "payload_unavailable");
    const payload = payloads[0];
    requireCondition(typeof payload.path === "string" && typeof payload.mediaType === "string" &&
      Number.isSafeInteger(payload.bytes) && Number(payload.bytes) >= 0 && validVersion(payload.sha256), "invalid_payload");
    let bytes: Buffer;
    try {
      if (payload.revision === undefined) bytes = await readLocal(this.root, payload.path);
      else {
        requireCondition(typeof payload.revision === "string" && /^[a-f0-9]{40}$/.test(payload.revision), "invalid_payload_revision");
        const relative = safeRelative(payload.path);
        const { stdout: tree } = await run("git", ["-C", this.root, "ls-tree", payload.revision, "--", relative]);
        requireCondition(/^100(644|755) blob [a-f0-9]{40}\t/.test(tree), "unsafe_historical_payload");
        const result = await run("git", ["-C", this.root, "cat-file", "blob", `${payload.revision}:${relative}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
        bytes = result.stdout;
      }
    } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("source_unavailable"); }
    requireCondition(bytes.length === payload.bytes && bytesVersion(bytes) === payload.sha256, "payload_digest_mismatch");
    await this.assertCurrent();
    return { bytes, mediaType: payload.mediaType };
  }
}

export function selectTextEvidence(bytes: Uint8Array, selector: unknown): string {
  requireCondition(isRecord(selector) && typeof selector.kind === "string" && typeof selector.value === "string", "invalid_selector");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    if (selector.kind === "utf8_bytes") {
      requireCondition(/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(selector.value), "invalid_selector");
      const [start, end] = selector.value.split(":").map(Number);
      requireCondition(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start! < end! && end! <= bytes.length, "invalid_selector");
      decoder.decode(bytes.slice(0, start));
      decoder.decode(bytes.slice(end));
      return decoder.decode(bytes.slice(start, end));
    }
    if (selector.kind === "json_pointer") {
      requireCondition(selector.value === "" || selector.value.startsWith("/"), "invalid_selector");
      let value: unknown = JSON.parse(decoder.decode(bytes));
      for (const token of selector.value === "" ? [] : selector.value.slice(1).split("/")) {
        requireCondition(!/~[^01]|~$/.test(token), "invalid_selector");
        const part = token.replaceAll("~1", "/").replaceAll("~0", "~");
        if (Array.isArray(value)) requireCondition(/^(0|[1-9][0-9]*)$/.test(part), "invalid_selector");
        requireCondition(value !== null && typeof value === "object" && Object.hasOwn(value, part), "selector_unavailable");
        value = (value as Record<string, unknown>)[part];
      }
      requireCondition(typeof value === "string" && value.trim(), "non_text_evidence");
      return value;
    }
    throw new CatalogError("text_selector_capability_unavailable");
  } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("invalid_utf8_or_json"); }
}
