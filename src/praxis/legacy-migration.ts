import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { validateSchema } from "../canghai/schema.js";

type FileFingerprint = { path: string; sha256: string };
type LegacyRecord = {
  directory: string;
  id: string;
  eligibility: "blocked";
  reasons: Array<"origin_unverified" | "action_evidence_unverified">;
  files: FileFingerprint[];
};
export type LegacyMigration = {
  schemaVersion: "stella.legacy-episode-quarantine/v1";
  records: LegacyRecord[];
};

const ARCHIVE = ".legacy-v1";
const JOURNAL = ".legacy-v1-migration.json";

async function fingerprints(root: string, relative = ""): Promise<FileFingerprint[]> {
  const result: FileFingerprint[] = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Legacy migration does not follow symbolic links");
    if (entry.isDirectory()) result.push(...await fingerprints(root, child));
    else if (entry.isFile()) result.push({
      path: child,
      sha256: createHash("sha256").update(await readFile(path.join(root, child))).digest("hex"),
    });
    else throw new Error("Legacy migration encountered an unsupported filesystem entry");
  }
  return result;
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sameFiles(left: FileFingerprint[], right: FileFingerprint[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Unknown legacy origin is never promoted merely because a record says user_report. */
export async function planLegacyEpisodeQuarantine(episodeRoot: string): Promise<LegacyMigration> {
  const records: LegacyRecord[] = [];
  const entries = await readdir(episodeRoot, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("Legacy migration does not follow symbolic links");
    if (!entry.isDirectory()) continue;
    const directory = path.join(episodeRoot, entry.name);
    const files = await fingerprints(directory);
    const raw: unknown = JSON.parse(await readFile(path.join(directory, "episode.json"), "utf8"));
    if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw)) {
      throw new Error("Legacy migration encountered an invalid Episode");
    }
    if (raw.schemaVersion === "stella.praxis-episode/v2") continue;
    await validateSchema("praxis-episode", raw);
    if (!("id" in raw) || typeof raw.id !== "string") throw new Error("Legacy Episode ID is invalid");
    records.push({
      directory: entry.name,
      id: raw.id,
      eligibility: "blocked",
      reasons: "actual" in raw && raw.actual
        ? ["origin_unverified", "action_evidence_unverified"] : ["origin_unverified"],
      files,
    });
  }
  return { schemaVersion: "stella.legacy-episode-quarantine/v1", records };
}

/** Explicit, resumable quarantine only. No v2 activation, commit, push, or source rewriting. */
export async function quarantineLegacyEpisodes(
  episodeRoot: string,
  plan: LegacyMigration,
): Promise<{ quarantinedCount: number; activatedCount: 0 }> {
  const root = await realpath(episodeRoot);
  if (root === path.parse(root).root || (await lstat(episodeRoot)).isSymbolicLink()) {
    throw new Error("Legacy migration requires a concrete Episode directory");
  }
  if (plan.schemaVersion !== "stella.legacy-episode-quarantine/v1") {
    throw new Error("Unsupported legacy migration plan");
  }
  const names = new Set<string>();
  for (const record of plan.records) {
    if (!/^praxis-[a-zA-Z0-9_-]+$/.test(record.directory) || names.has(record.directory) ||
        record.eligibility !== "blocked" || !record.reasons.includes("origin_unverified")) {
      throw new Error("Invalid legacy migration target");
    }
    names.add(record.directory);
  }
  const archive = path.join(root, ARCHIVE);
  if (await exists(archive)) {
    if ((await lstat(archive)).isSymbolicLink() || !(await lstat(archive)).isDirectory()) {
      throw new Error("Invalid legacy archive directory");
    }
  }
  const journal = path.join(root, JOURNAL);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (await exists(journal)) {
    if ((await lstat(journal)).isSymbolicLink() || await readFile(journal, "utf8") !== serialized) {
      throw new Error("Legacy migration journal conflicts with this plan");
    }
  } else {
    const current = await planLegacyEpisodeQuarantine(root);
    if (JSON.stringify(current) !== JSON.stringify(plan)) {
      throw new Error("Legacy migration source changed after planning");
    }
    const file = await open(journal, "wx", 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
  }
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const record of plan.records) {
    const source = path.join(root, record.directory);
    const target = path.join(archive, record.directory);
    const sourceExists = await exists(source);
    const targetExists = await exists(target);
    if (sourceExists === targetExists) throw new Error("Legacy migration has ambiguous record placement");
    const currentPath = sourceExists ? source : target;
    if ((await lstat(currentPath)).isSymbolicLink() ||
        !sameFiles(await fingerprints(currentPath), record.files)) {
      throw new Error("Legacy migration record integrity mismatch");
    }
    if (sourceExists) await rename(source, target);
  }
  return { quarantinedCount: plan.records.length, activatedCount: 0 };
}
