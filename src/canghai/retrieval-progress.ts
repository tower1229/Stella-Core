import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CatalogError, readRepositoryBytes, type CatalogReader } from "./catalog-reader.js";
import { canonicalJson } from "./content-version.js";
import type { GitCangHaiDurability } from "./durability.js";
import { parseRetrievalCheckpoint, type RetrievalCheckpoint } from "./retrieve.js";

const check: (value: unknown, category?: string) => asserts value = (value, category = "invalid_retrieval_checkpoint") => {
  if (!value) throw new CatalogError(category);
};

/** Stable resume key from Host session; must match ingest checkpoint resumeKey charset. */
export function retrievalResumeKey(sessionKey: string): string {
  check(typeof sessionKey === "string" && sessionKey.trim(), "invalid_retrieval_resume_key");
  const digest = createHash("sha256").update(sessionKey, "utf8").digest("hex");
  const resumeKey = `retrieval-${digest}`;
  checkpointPath("catalog.json", resumeKey);
  return resumeKey;
}

export function checkpointPath(catalogPath: string, resumeKey: string): string {
  check(typeof resumeKey === "string" && /^retrieval-[a-f0-9]{64}$/.test(resumeKey));
  return path.posix.join(path.posix.dirname(catalogPath), "operations", `${resumeKey}.retrieval-checkpoint.json`);
}

export async function loadRetrievalCheckpoint(
  reader: CatalogReader,
  resumeKey: string,
): Promise<{ bytes: string; value: RetrievalCheckpoint } | null> {
  checkpointPath(reader.catalogPath, resumeKey);
  try {
    const bytes = (await readRepositoryBytes(reader.root, checkpointPath(reader.catalogPath, resumeKey))).toString("utf8");
    const value = parseRetrievalCheckpoint(JSON.parse(bytes));
    return { bytes, value };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Prepare durable checkpoint bytes for the same memory transaction as other catalog writes. */
export function prepareRetrievalCheckpointWrite(input: {
  catalogPath: string;
  resumeKey: string;
  checkpoint: RetrievalCheckpoint;
  previousBytes?: string | null;
}): { path: string; before: string | null; after: string } {
  checkpointPath(input.catalogPath, input.resumeKey);
  const value = parseRetrievalCheckpoint(input.checkpoint);
  check(value.requestId.trim(), "invalid_retrieval_checkpoint");
  const after = canonicalJson(value);
  return { path: checkpointPath(input.catalogPath, input.resumeKey), before: input.previousBytes ?? null, after };
}

export async function persistRetrievalCheckpoint(input: {
  reader: CatalogReader;
  resumeKey: string;
  checkpoint: RetrievalCheckpoint;
  dataMode: "read_only" | "local_write" | "managed_durable_write";
  durability?: GitCangHaiDurability;
}): Promise<void> {
  if (input.dataMode === "read_only") return;
  const stored = await loadRetrievalCheckpoint(input.reader, input.resumeKey);
  const prepared = prepareRetrievalCheckpointWrite({
    catalogPath: input.reader.catalogPath,
    resumeKey: input.resumeKey,
    checkpoint: input.checkpoint,
    previousBytes: stored?.bytes ?? null,
  });
  const absolute = path.join(input.reader.root, prepared.path);
  if (input.dataMode === "managed_durable_write") {
    check(input.durability, "critical_durability_required");
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, prepared.after, "utf8");
    await input.durability!.syncCritical([prepared.path], `stella: retrieval checkpoint ${input.resumeKey}`);
    return;
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, prepared.after, "utf8");
}

export async function clearRetrievalCheckpoint(reader: CatalogReader, resumeKey: string): Promise<void> {
  checkpointPath(reader.catalogPath, resumeKey);
  const absolute = path.join(reader.root, checkpointPath(reader.catalogPath, resumeKey));
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
