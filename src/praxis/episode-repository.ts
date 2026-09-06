import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { bytesVersion, canonicalJson as canonical } from "../canghai/content-version.js";
import {
  EpisodeV2Error, parseEpisodeV2, validateEpisodeV2References, validateEpisodeV2Transition,
  type EpisodeV2,
} from "./episode-v2.js";

type ReferencePorts = Parameters<typeof validateEpisodeV2References>[1];
export type EpisodeRepositoryPorts = ReferencePorts & {
  isCurrentlyEligible(episode: EpisodeV2): Promise<boolean>;
  persist(input: { operationId: string; paths: string[]; priority: "critical" | "normal" }): Promise<void>;
};
type Intent = {
  schemaVersion: "stella.episode-operation/v1";
  operationId: string;
  expectedVersion: string | null;
  nextVersion: string;
  episode: EpisodeV2;
};
export type EpisodeSnapshot = { episode: EpisodeV2; version: string };

export function episodeVersion(episode: EpisodeV2): string {
  return bytesVersion(canonical(episode));
}
function serialize(value: unknown): string { return canonical(value); }
function checkedId(id: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(id)) throw new EpisodeV2Error("unsafe_record_id");
  return id;
}
function versionHash(version: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(version)) throw new EpisodeV2Error("invalid_record_version");
  return version.slice(7);
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function fileText(file: string): Promise<string | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new EpisodeV2Error("unsafe_record_file");
    return await readFile(file, "utf8");
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
async function createFile(file: string, content: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** v2 only. Ports must resolve exact historical refs separately from current-use eligibility. */
export class EpisodeRepository {
  readonly #root: string;
  readonly #relativeRoot: string;
  constructor(root: string, relativeRoot: string, readonly ports: EpisodeRepositoryPorts) {
    this.#root = path.resolve(root);
    const relative = relativeRoot.replaceAll("\\", "/");
    if (!relative || path.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
      throw new EpisodeV2Error("unsafe_episode_root");
    }
    this.#relativeRoot = relative;
  }

  async #directory(relative: string, create = false): Promise<string> {
    let current = this.#root;
    for (const part of ["", ...relative.split("/")]) {
      if (part) current = path.join(current, part);
      if (create && part) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EpisodeV2Error("unsafe_record_directory");
    }
    return current;
  }

  async #record(id: string): Promise<EpisodeSnapshot | undefined> {
    const relative = `${this.#relativeRoot}/${checkedId(id)}`;
    let directory: string;
    try { directory = await this.#directory(relative); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    const text = await fileText(path.join(directory, "episode.json"));
    if (text === undefined) return undefined;
    const episode = await parseEpisodeV2(JSON.parse(text));
    if (episode.id !== id) throw new EpisodeV2Error("record_identity_mismatch");
    const version = episodeVersion(episode);
    const versions = await this.#directory(`${relative}/.versions`);
    const archived = await fileText(path.join(versions, `${versionHash(version)}.json`));
    if (archived === undefined || canonical(JSON.parse(archived)) !== canonical(episode)) throw new EpisodeV2Error("record_version_mismatch");
    const prediction = await fileText(path.join(directory, "prediction.json"));
    if (episode.twin?.prediction) {
      if (prediction === undefined || canonical(JSON.parse(prediction)) !== canonical(episode.twin.prediction)) throw new EpisodeV2Error("sealed_prediction_changed");
    } else if (prediction !== undefined) throw new EpisodeV2Error("unexpected_prediction");
    return { episode, version };
  }

  async read(id: string): Promise<EpisodeSnapshot> {
    const record = await this.#record(id);
    if (!record) throw new EpisodeV2Error("record_not_found");
    await validateEpisodeV2References(record.episode, this.ports);
    return record;
  }

  async readHistorical(id: string, version: string): Promise<EpisodeSnapshot> {
    const directory = await this.#directory(`${this.#relativeRoot}/${checkedId(id)}/.versions`);
    const text = await fileText(path.join(directory, `${versionHash(version)}.json`));
    if (text === undefined) throw new EpisodeV2Error("historical_version_unavailable");
    const episode = await parseEpisodeV2(JSON.parse(text));
    if (episode.id !== id || episodeVersion(episode) !== version) throw new EpisodeV2Error("record_version_mismatch");
    await validateEpisodeV2References(episode, this.ports);
    return { episode, version };
  }

  async listEligible(): Promise<EpisodeSnapshot[]> {
    const root = await this.#directory(this.#relativeRoot);
    const result: EpisodeSnapshot[] = [];
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) throw new EpisodeV2Error("unsafe_record_directory");
      if (!entry.isDirectory()) continue;
      const snapshot = await this.read(entry.name);
      if (await this.ports.isCurrentlyEligible(snapshot.episode)) result.push(snapshot);
    }
    return result;
  }

  async #immutable(file: string, content: string): Promise<void> {
    const existing = await fileText(file);
    if (existing !== undefined) {
      if (existing !== content) throw new EpisodeV2Error("immutable_record_conflict");
      return;
    }
    const staging = path.join(path.dirname(file), `.immutable-${randomUUID()}.staging`);
    try {
      await createFile(staging, content);
      // Publish only fully written immutable content, without overwriting an existing object.
      await link(staging, file);
    } finally { try { await unlink(staging); } catch (error) { if (!missing(error)) throw error; } }
  }

  async apply(input: { operationId: string; expectedVersion: string | null; episode: EpisodeV2 }): Promise<EpisodeSnapshot> {
    checkedId(input.operationId);
    checkedId(input.episode.id);
    if (input.expectedVersion !== null) versionHash(input.expectedVersion);
    // Freeze caller-owned data before asynchronous validation and persistence.
    const episode = await parseEpisodeV2(JSON.parse(serialize(input.episode)));
    const nextVersion = episodeVersion(episode);
    const intent: Intent = { schemaVersion: "stella.episode-operation/v1", operationId: input.operationId,
      expectedVersion: input.expectedVersion, nextVersion, episode };
    const root = await this.#directory(this.#relativeRoot, true);
    const lockFile = path.join(root, ".write-lock");
    let lock;
    try { lock = await open(lockFile, "wx", 0o600); }
    catch (error) { throw new EpisodeV2Error(error instanceof Error && "code" in error && error.code === "EEXIST" ? "write_in_progress" : "lock_unavailable"); }
    try {
      const operations = await this.#directory(`${this.#relativeRoot}/.operations`, true);
      const operationFile = path.join(operations, `${input.operationId}.json`);
      const appliedFile = path.join(operations, `${input.operationId}.applied.json`);
      const appliedContent = serialize({ operationId: input.operationId, episodeId: episode.id, nextVersion });
      const recorded = await fileText(operationFile);
      if (recorded !== undefined && recorded !== serialize(intent)) throw new EpisodeV2Error("operation_id_conflict");
      const applied = await fileText(appliedFile);
      if (applied !== undefined && (recorded === undefined || applied !== appliedContent)) throw new EpisodeV2Error("operation_journal_invalid");
      const previous = await this.#record(episode.id);
      const relative = `${this.#relativeRoot}/${episode.id}`;
      const persistence = { operationId: input.operationId,
        paths: [`${relative}/episode.json`, `${relative}/.versions/${versionHash(nextVersion)}.json`,
          ...(episode.twin?.prediction ? [`${relative}/prediction.json`] : []),
          `${this.#relativeRoot}/.operations/${input.operationId}.json`, `${this.#relativeRoot}/.operations/${input.operationId}.applied.json`],
        priority: episode.status === "closed" || episode.status === "abandoned" || episode.status === "expired" ? "normal" as const : "critical" as const };
      if (applied !== undefined) {
        const original = await this.readHistorical(episode.id, nextVersion);
        await this.ports.persist(persistence);
        return original;
      }
      const replay = recorded !== undefined && previous?.version === nextVersion;
      if (!replay && (previous?.version ?? null) !== input.expectedVersion) throw new EpisodeV2Error("version_conflict");
      if (!replay) {
        if (previous) await validateEpisodeV2Transition(previous.episode, episode);
        else if (episode.status !== "open") throw new EpisodeV2Error("initial_state_not_open");
      }
      await validateEpisodeV2References(episode, this.ports);
      if (!await this.ports.isCurrentlyEligible(episode)) throw new EpisodeV2Error("evidence_not_currently_eligible");
      await this.#immutable(operationFile, serialize(intent));
      const directory = await this.#directory(relative, true);
      const versions = await this.#directory(`${relative}/.versions`, true);
      await this.#immutable(path.join(versions, `${versionHash(nextVersion)}.json`), serialize(episode));
      if (episode.twin?.prediction) await this.#immutable(path.join(directory, "prediction.json"), serialize(episode.twin.prediction));
      if (!replay) {
        const staging = path.join(directory, `.episode-${randomUUID()}.staging`);
        try { await createFile(staging, serialize(episode)); await rename(staging, path.join(directory, "episode.json")); }
        finally { try { await unlink(staging); } catch (error) { if (!missing(error)) throw error; } }
      }
      await this.#immutable(appliedFile, appliedContent);
      await this.ports.persist(persistence);
      return { episode, version: nextVersion };
    } finally { await lock.close(); await unlink(lockFile); }
  }
}
