import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";

export class HostAdmissionIsolationError extends Error {
  constructor(readonly category: string) {
    super(`Stella host admission isolation: ${category}`);
  }
}

function check(value: unknown, category: string): asserts value {
  if (!value) throw new HostAdmissionIsolationError(category);
}

export type HostAdmissionConfig = {
  agents?: {
    entries?: Record<string, {
      tools?: { deny?: string[]; allow?: string[] };
      identity?: { name?: string };
      [key: string]: unknown;
    }>;
  };
  bindings?: Array<{ agentId: string; match: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
};

export type HostAdmissionIsolationPorts = {
  readConfig(): HostAdmissionConfig;
  mutateConfig(mutate: (draft: HostAdmissionConfig) => void): Promise<void>;
};

export type HostIsolationJournal = {
  schemaVersion: "stella.host-admission-isolation/v1";
  agentId: string;
  reason: string;
  previousTools: { deny?: string[]; allow?: string[] } | null;
  removedBindings: Array<{ agentId: string; match: Record<string, unknown>; [key: string]: unknown }>;
};

async function safeFile(root: string, name: string, createParents = false): Promise<string> {
  check(typeof name === "string" && name.length > 0 && !path.isAbsolute(name) &&
    !name.includes("\\") && !name.includes(":") && name.split("/").every((part) =>
      part !== "" && part !== "." && part !== ".."), "unsafe_path");
  check(await realpath(root) === path.resolve(root), "unsafe_root");
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = path.join(current, part);
    if (createParents) {
      await mkdir(current, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
      });
    }
    try {
      const stat = await lstat(current);
      check(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_path");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT" && !createParents) return path.join(root, name);
      throw error;
    }
  }
  const result = path.join(root, name);
  try {
    const stat = await lstat(result);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024, "unsafe_file");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return result;
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

async function readJournal(stateRoot: string): Promise<HostIsolationJournal | null> {
  try {
    const data = await readFile(await safeFile(stateRoot, "host-isolation.json"), "utf8");
    const value: unknown = JSON.parse(data);
    check(isRecord(value) && value.schemaVersion === "stella.host-admission-isolation/v1" &&
      typeof value.agentId === "string" && typeof value.reason === "string" &&
      (value.previousTools === null || isRecord(value.previousTools)) &&
      Array.isArray(value.removedBindings), "invalid_host_isolation_journal");
    return value as HostIsolationJournal;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJournal(stateRoot: string, journal: HostIsolationJournal): Promise<void> {
  const target = await safeFile(stateRoot, "host-isolation.json", true);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(canonicalJson(journal));
    await file.chmod(0o600);
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function agentEntry(config: HostAdmissionConfig, agentId: string) {
  const entry = config.agents?.entries?.[agentId];
  check(entry, "explicit_agent_configuration_required");
  return entry;
}

/** Host-config isolation for a full profile. Does not use prompt text or Host private databases. */
export async function isolateHostProfile(
  ports: HostAdmissionIsolationPorts,
  agentId: string,
  reason: string,
  stateRoot: string,
): Promise<void> {
  check(typeof agentId === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(agentId), "invalid_agent_id");
  check(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 128, "invalid_isolation_reason");
  check(typeof stateRoot === "string" && path.isAbsolute(stateRoot), "invalid_isolation_state");
  const existing = await readJournal(stateRoot);
  if (existing) {
    assertHostProfileIsolated(ports.readConfig(), agentId);
    check(existing.agentId === agentId, "host_isolation_agent_conflict");
    return;
  }
  const before = ports.readConfig();
  const entry = agentEntry(before, agentId);
  const previousTools = entry.tools ? structuredClone(entry.tools) : null;
  const removedBindings = (before.bindings ?? []).filter((row) => row.agentId === agentId).map((row) => structuredClone(row));
  const journal: HostIsolationJournal = {
    schemaVersion: "stella.host-admission-isolation/v1",
    agentId,
    reason,
    previousTools,
    removedBindings,
  };
  await writeJournal(stateRoot, journal);
  await ports.mutateConfig((draft) => {
    const target = agentEntry(draft, agentId);
    target.tools = { deny: ["*"] };
    if (Array.isArray(draft.bindings)) {
      draft.bindings = draft.bindings.filter((row) => row.agentId !== agentId);
    }
  });
  assertHostProfileIsolated(ports.readConfig(), agentId);
}

export function assertHostProfileIsolated(config: HostAdmissionConfig, agentId: string): void {
  check(typeof agentId === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(agentId), "invalid_agent_id");
  const entry = agentEntry(config, agentId);
  const deny = entry.tools?.deny;
  check(Array.isArray(deny) && deny.length === 1 && deny[0] === "*", "host_profile_not_isolated");
  check(!(config.bindings ?? []).some((row) => row.agentId === agentId), "host_profile_not_isolated");
}

export async function releaseHostProfileIsolation(
  ports: HostAdmissionIsolationPorts,
  agentId: string,
  stateRoot: string,
): Promise<void> {
  check(typeof agentId === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(agentId), "invalid_agent_id");
  check(typeof stateRoot === "string" && path.isAbsolute(stateRoot), "invalid_isolation_state");
  const journal = await readJournal(stateRoot);
  check(journal && journal.schemaVersion === "stella.host-admission-isolation/v1" && journal.agentId === agentId,
    "host_isolation_journal_required");
  await ports.mutateConfig((draft) => {
    const target = agentEntry(draft, agentId);
    if (journal.previousTools === null) delete target.tools;
    else target.tools = structuredClone(journal.previousTools);
    const restored = journal.removedBindings.map((row) => structuredClone(row));
    draft.bindings = [...(draft.bindings ?? []).filter((row) => row.agentId !== agentId), ...restored];
  });
  await unlink(await safeFile(stateRoot, "host-isolation.json"));
  const after = ports.readConfig();
  check(canonicalJson(agentEntry(after, agentId).tools ?? null) === canonicalJson(journal.previousTools),
    "host_isolation_release_conflict");
  for (const binding of journal.removedBindings) {
    check((after.bindings ?? []).some((row) => canonicalJson(row) === canonicalJson(binding)),
      "host_isolation_release_conflict");
  }
}
