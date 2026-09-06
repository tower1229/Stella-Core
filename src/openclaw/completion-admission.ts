import { canonicalJson } from "../canghai/content-version.js";
import { CompletionError, completionDraftHash } from "./completion.js";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export type CompletionAdmission = {
  schemaVersion: "stella.completion-admission/v1";
  runId: string; agentId: string; sessionHash: string; resourceHash: string; requestHash: string;
};
type AdmissionStore = {
  registerIfAbsent(key: string, value: CompletionAdmission): Promise<boolean>;
  lookup(key: string): Promise<CompletionAdmission | undefined>;
};

/** Local-package adapter: does not access the Host's trusted-plugin database. */
export async function openCompletionAdmissionJournal(stateRoot: string): Promise<AdmissionStore> {
  let directory = path.resolve(stateRoot);
  const ensureDirectory = async (value: string) => {
    const details = await lstat(value);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe admission directory");
  };
  await ensureDirectory(directory);
  for (const segment of ["plugins", "stella-core", "completion-admissions"]) {
    directory = path.join(directory, segment);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    await ensureDirectory(directory);
  }
  const location = (key: string) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(key)) throw new Error("Invalid admission key");
    return path.join(directory, `${key.slice(7)}.json`);
  };
  return {
    async registerIfAbsent(key, value) {
      let file;
      try { file = await open(location(key), "wx", 0o600); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return false; throw error; }
      // A partial file after interruption stays reserved, never deleted to enable retry.
      try { await file.writeFile(canonicalJson(value)); await file.sync(); }
      finally { await file.close(); }
      return true;
    },
    async lookup(key) {
      const file = location(key);
      const details = await lstat(file);
      if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) throw new Error("Invalid admission record");
      return JSON.parse(await readFile(file, "utf8")) as CompletionAdmission;
    },
  };
}

/** An uncertain/failed prior admission requires explicit recovery, never regeneration. */
export async function admitCompletionOnce(store: AdmissionStore, input: {
  runId: string; agentId: string; sessionKey: string; resourceScope: string; prompt: string;
}): Promise<void> {
  if (Object.values(input).some((value) => !value.trim())) throw new CompletionError("invalid_input", "admission");
  const record: CompletionAdmission = { schemaVersion: "stella.completion-admission/v1", runId: input.runId, agentId: input.agentId,
    sessionHash: completionDraftHash(input.sessionKey), resourceHash: completionDraftHash(input.resourceScope), requestHash: completionDraftHash(input.prompt) };
  const key = completionDraftHash(canonicalJson([input.agentId, input.runId]));
  try {
    if (await store.registerIfAbsent(key, record)) return;
    const prior = await store.lookup(key);
    if (!prior || canonicalJson(prior) !== canonicalJson(record)) throw new CompletionError("run_identity_conflict", "admission");
    throw new CompletionError("run_recovery_required", "admission");
  } catch (error) {
    if (error instanceof CompletionError) throw error;
    throw new CompletionError("admission_store_unavailable", "admission");
  }
}
