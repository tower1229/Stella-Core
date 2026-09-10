import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class RunAdmissionError extends Error {
  constructor(readonly category: string) {
    super(`Stella run admission: ${category}`);
  }
}

function check(value: unknown, category: string): asserts value {
  if (!value) throw new RunAdmissionError(category);
}

export type RunAdmissionBinding = {
  schemaVersion: "stella.run-admission/v1";
  operationId: string;
  admissionEpoch: number;
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
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4096, "unsafe_file");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return result;
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

async function readBase64(root: string, name: string): Promise<string | null> {
  try { return (await readFile(await safeFile(root, name))).toString("base64"); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeBase64(root: string, name: string, data: string): Promise<void> {
  const target = await safeFile(root, name, true);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(Buffer.from(data, "base64"));
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

/** Durable epoch that survives restart; bumped on init fence, correction, and revoke. */
export async function readAdmissionEpoch(stateRoot: string): Promise<number> {
  const data = await readBase64(stateRoot, "admission-epoch.json");
  if (!data) return 0;
  const value: unknown = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  check(isRecord(value) && value.schemaVersion === "stella.admission-epoch/v1" &&
    typeof value.epoch === "number" && Number.isSafeInteger(value.epoch) && value.epoch >= 0, "invalid_admission_epoch");
  return value.epoch;
}

export async function bumpAdmissionEpoch(stateRoot: string, reason: string): Promise<number> {
  check(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 128, "invalid_admission_reason");
  const epoch = await readAdmissionEpoch(stateRoot) + 1;
  await writeBase64(stateRoot, "admission-epoch.json", Buffer.from(canonicalJson({
    schemaVersion: "stella.admission-epoch/v1",
    epoch,
    reason,
    bumpedAt: new Date().toISOString(),
  })).toString("base64"));
  return epoch;
}

export async function writeRunAdmissionBinding(
  stateRoot: string,
  runId: string,
  binding: RunAdmissionBinding,
  mode: "create" | "replace" = "create",
): Promise<void> {
  check(typeof runId === "string" && runId.trim().length > 0, "invalid_run_id");
  check(binding.schemaVersion === "stella.run-admission/v1" &&
    typeof binding.operationId === "string" && /^init_[a-f0-9-]{36}$/.test(binding.operationId) &&
    Number.isSafeInteger(binding.admissionEpoch) && binding.admissionEpoch >= 0, "invalid_run_admission");
  const target = `runs/${bytesVersion(runId).slice(7)}.json`;
  const value = Buffer.from(canonicalJson(binding)).toString("base64");
  if (mode === "replace") {
    await writeBase64(stateRoot, target, value);
    return;
  }
  const location = await safeFile(stateRoot, target, true);
  try {
    const file = await open(location, "wx", 0o600);
    try {
      await file.writeFile(Buffer.from(value, "base64"));
      await file.sync();
    } finally { await file.close(); }
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    const prior = await readBase64(stateRoot, target);
    check(prior === value, "stale_initialization_run");
  }
}

export async function assertRunAdmissionBinding(
  stateRoot: string,
  runId: string,
  expected: RunAdmissionBinding,
): Promise<void> {
  check(typeof runId === "string" && runId.trim().length > 0, "invalid_run_id");
  const value = Buffer.from(canonicalJson(expected)).toString("base64");
  check(await readBase64(stateRoot, `runs/${bytesVersion(runId).slice(7)}.json`) === value, "stale_initialization_run");
}
