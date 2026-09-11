import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { acquireFileLock, reclaimDefinitelyStaleFileLock } from "openclaw/plugin-sdk/file-lock";
import { isLiveMemoryMutationDirt, ownsMemoryMutationLock } from "../canghai/memory-transaction.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { compileInitializationSource, InitializationSourceError } from "./initialization-source.js";
import type { HostIdentity } from "./initialization-templates.js";
import {
  assertRunAdmissionBinding,
  bumpAdmissionEpoch,
  readAdmissionEpoch,
  writeRunAdmissionBinding,
  RunAdmissionError,
} from "./run-admission.js";

const run = promisify(execFile);
const bootstrap = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
export class InitializationError extends Error {
  constructor(readonly category: string) { super(`Stella initialization: ${category}`); }
}
function check(value: unknown, category: string): asserts value {
  if (!value) throw new InitializationError(category);
}
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const managedTarget = (value: string): boolean => bootstrap.includes(value) || /^skills\/[a-z0-9][a-z0-9-]*\/.+/.test(value);
function relative(value: unknown): asserts value is string {
  check(typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !/[\x00-\x1f\x7f]/.test(value) && !value.includes("\\") && !value.includes(":") && value.split("/").every((part) =>
      part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"), "unsafe_path");
}
export type Materialization = {
  schemaVersion: "stella.host-files/v1";
  agentId: string;
  hostVersion: string;
  files: Array<{ target: string; source: string; sha256: string; executable: boolean }>;
  skills: string[];
};
/** Consumes reviewed source bytes. Initialization never invents or rewrites owner behavior. */
export function parseMaterialization(value: unknown): Materialization {
  check(isRecord(value) && value.schemaVersion === "stella.host-files/v1", "materialization_migration_required");
  check(Object.keys(value).every((key) => ["schemaVersion", "agentId", "hostVersion", "files", "skills"].includes(key)), "unknown_materialization_field");
  check(typeof value.agentId === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value.agentId) &&
    typeof value.hostVersion === "string", "invalid_materialization_identity");
  check(Array.isArray(value.skills) && value.skills.every((name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name)) &&
    new Set(value.skills).size === value.skills.length, "invalid_skill_bindings");
  check(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 512, "invalid_materialization_files");
  const targets = new Set<string>();
  for (const file of value.files) {
    check(isRecord(file) && Object.keys(file).every((key) => ["target", "source", "sha256", "executable"].includes(key)), "invalid_materialization_file");
    relative(file.target); relative(file.source);
    check(digest(file.sha256) && typeof file.executable === "boolean", "invalid_materialization_file");
    const skill = file.target.split("/")[1];
    check(managedTarget(file.target) && (bootstrap.includes(file.target) || value.skills.includes(skill)), "unmanaged_target");
    check(!targets.has(file.target.toLowerCase()), "duplicate_target");
    targets.add(file.target.toLowerCase());
  }
  check(bootstrap.every((name) => targets.has(name.toLowerCase())), "required_bootstrap_missing");
  check(value.skills.every((name) => targets.has(`skills/${name}/skill.md`)), "required_skill_missing");
  return structuredClone(value) as Materialization;
}

async function safeFile(root: string, name: string, createParents = false): Promise<string> {
  relative(name);
  check(await realpath(root) === path.resolve(root), "unsafe_root");
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = path.join(current, part);
    if (createParents) await mkdir(current, { recursive: false, mode: 0o700 }).then(() => syncDirectory(path.dirname(current))).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    });
    try { const stat = await lstat(current); check(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_path"); }
    catch (error) { if (isRecord(error) && error.code === "ENOENT" && !createParents) return path.join(root, name); throw error; }
  }
  const result = path.join(root, name);
  try { const stat = await lstat(result); check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024, "unsafe_file"); }
  catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
  return result;
}
async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}
async function read(root: string, name: string): Promise<string | null> {
  try { return (await readFile(await safeFile(root, name))).toString("base64"); }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return null; throw error; }
}
async function mode(root: string, name: string): Promise<number | null> {
  try { return (await lstat(await safeFile(root, name))).mode & 0o777; }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return null; throw error; }
}
async function write(root: string, name: string, data: string, executable = false, permissions?: number): Promise<void> {
  const target = await safeFile(root, name, true);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", permissions ?? (executable ? 0o700 : 0o600));
  try { await file.writeFile(Buffer.from(data, "base64")); await file.chmod(permissions ?? (executable ? 0o700 : 0o600)); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, target); await syncDirectory(path.dirname(target)); }
  finally { await unlink(temporary).catch(() => undefined); }
}

type Change = { target: string; before: string | null; beforeMode: number | null; after: string | null; executable: boolean };
export type InitializationPlan = {
  schemaVersion: "stella.initialization-plan/v1";
  operationId: string;
  sourceRevision: string;
  agentId: string;
  recipeHash: string;
  workspace: string;
  changes: Change[];
  previousReceipt: Receipt | null;
  hostIdentity?: { before: HostIdentity | null; after: HostIdentity };
  planHash: string;
};
type Receipt = { schemaVersion: "stella.initialization-receipt/v1"; scope: "host_files_and_skills" | "host_bootstrap"; operationId: string; sourceRevision: string; workspace: string;
  recipeHash: string; files: Array<{ target: string; hash: string }>; checkedAt: string; identityHash?: string };
export type InitializationVerificationBinding = {
  core: string; artifact: string; host: string; harness: string; source: string;
  profile: string; policy: string; configuration: string; model: string; cases: string;
  deployment: string; generation: string;
};
type VerificationReceipt = {
  schemaVersion: "stella.initialization-verification/v1"; id: string;
  scope: "host_bootstrap"; runtimeAdmission: false; operationId: string;
  purpose: "verify_installed_bootstrap"; actorHash: string;
  binding: InitializationVerificationBinding; checkedAt: string; expiresAt: string;
};
export type InitializationSource = { root: string; revision: string; recipePath: string; agentId: string; hostVersion: string;
  skillRegistryRef?: string; contractProfile?: "alpha_praxis" | "full_memory"; requiredCapabilities?: readonly string[] };
export type InitializationPorts = {
  /** Must fence all target runs, including after restart, until verify succeeds. */
  fence(): Promise<void>;
  verify(recipe: Materialization, host?: { setup: true }): Promise<void>;
  readIdentity?(): Promise<HostIdentity | null>;
  applyIdentity?(before: HostIdentity | null, after: HostIdentity | null, allowAlreadyApplied: boolean): Promise<void>;
  release(): Promise<void>;
};

export class StellaInitializer {
  private compiledContents: Map<string, Buffer> | undefined;
  private compiledIdentity: HostIdentity | undefined;
  private compiledRuntimeBlockers: string[] = [];
  get runtimeBlockers(): readonly string[] { return [...this.compiledRuntimeBlockers]; }
  constructor(readonly workspace: string, readonly stateRoot: string, readonly source: InitializationSource, readonly ports: InitializationPorts,
    readonly signal?: AbortSignal) {}

  private active(): void { check(!this.signal?.aborted, "operation_cancelled"); }
  private async fence(): Promise<void> {
    await write(this.stateRoot, "fenced", Buffer.from("initialization pending\n").toString("base64"));
    await bumpAdmissionEpoch(this.stateRoot, "initialization_fence");
    // Keep the durable fence if Host drain/isolation fails: active turns must remain gated
    // (active_turn_drain_required) until the operator retries after the turn settles.
    await this.ports.fence();
  }

  private async acquire(): Promise<{ release(): Promise<void> }> {
    const target = path.join(this.stateRoot, "initialization");
    const options = { stale: 0, retries: { retries: 0 }, staleRecovery: "fail-closed" as const };
    try { return await acquireFileLock(target, options); }
    catch (error) {
      if (isRecord(error) && error.code === "file_lock_stale" && await reclaimDefinitelyStaleFileLock(`${target}.lock`) !== "retained") {
        try { return await acquireFileLock(target, options); } catch { /* Another live owner won the lock. */ }
      }
      throw new InitializationError("initialization_in_progress");
    }
  }

  private async recipe(): Promise<Materialization> {
    check(/^[a-f0-9]{40}$/.test(this.source.revision), "invalid_source_revision");
    const git = async (args: string[]) => (await run("git", ["-c", "core.fsmonitor=false", "-C", this.source.root, ...args])).stdout.trim();
    check(await git(["rev-parse", "HEAD"]) === this.source.revision, "source_revision_mismatch");
    const status = await git(["status", "--porcelain"]);
    check(status === "" || (isLiveMemoryMutationDirt(status) &&
      await ownsMemoryMutationLock(this.source.root)), "source_dirty");
    const content = await read(this.source.root, this.source.recipePath);
    check(content, "materialization_required");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(content, "base64").toString("utf8")); }
    catch { throw new InitializationError("invalid_materialization_json"); }
    let recipe: Materialization;
    this.compiledContents = undefined;
    this.compiledIdentity = undefined;
    this.compiledRuntimeBlockers = [];
    if (isRecord(value) && value.schema_version === "stella.host-materialization/v1") {
      try {
        const compiled = await compileInitializationSource(this.source.root, value, this.source);
        recipe = parseMaterialization(compiled.materialization);
        this.compiledContents = compiled.contents;
        this.compiledIdentity = compiled.identity;
        this.compiledRuntimeBlockers = compiled.runtimeBlockers;
      } catch (error) {
        if (error instanceof InitializationSourceError) throw new InitializationError(error.category);
        throw error;
      }
    } else recipe = parseMaterialization(value);
    check(recipe.agentId === this.source.agentId && recipe.hostVersion === this.source.hostVersion, "host_identity_mismatch");
    return recipe;
  }

  private async sourceContent(file: Materialization["files"][number]): Promise<string | null> {
    if (!this.compiledContents) return read(this.source.root, file.source);
    const bytes = this.compiledContents.get(file.target);
    check(bytes, "compiled_projection_missing");
    return bytes.toString("base64");
  }

  async plan(): Promise<InitializationPlan> {
    const recipe = await this.recipe();
    const changes: Change[] = [];
    for (const file of recipe.files) {
      const after = await this.sourceContent(file);
      check(after && bytesVersion(Buffer.from(after, "base64")) === file.sha256, "source_content_mismatch");
      check(Buffer.from(after, "base64").length <= 2 * 1024 * 1024, "materialization_resource_exhausted");
      const content = Buffer.from(after, "base64").toString("utf8");
      if (bootstrap.includes(file.target)) check(content.length <= (file.target === "USER.md" ? 4000 : 20000), "bootstrap_truncated");
      changes.push({ target: file.target, before: await read(this.workspace, file.target), beforeMode: await mode(this.workspace, file.target), after, executable: file.executable });
    }
    check(changes.filter((file) => bootstrap.includes(file.target)).reduce((sum, file) => sum + Buffer.from(file.after!, "base64").toString("utf8").length, 0) <= 60000, "bootstrap_truncated");
    const previous = await this.receipt();
    if (previous) for (const file of previous.files) {
      const current = await read(this.workspace, file.target);
      check(current !== null && bytesVersion(Buffer.from(current, "base64")) === file.hash, "projection_drift");
      if (!recipe.files.some((entry) => entry.target === file.target)) changes.push({ target: file.target, before: current, beforeMode: await mode(this.workspace, file.target), after: null, executable: false });
    }
    let hostIdentity: InitializationPlan["hostIdentity"];
    if (this.compiledIdentity) {
      check(this.ports.readIdentity && this.ports.applyIdentity, "host_identity_adapter_unavailable");
      hostIdentity = { before: await this.ports.readIdentity(), after: structuredClone(this.compiledIdentity) };
    }
    const plan = { schemaVersion: "stella.initialization-plan/v1" as const, operationId: `init_${randomUUID()}`,
      sourceRevision: this.source.revision, agentId: recipe.agentId, recipeHash: bytesVersion(canonicalJson(recipe)), workspace: this.workspace, changes,
      previousReceipt: previous, ...(hostIdentity ? { hostIdentity } : {}) };
    check(Buffer.byteLength(canonicalJson(plan)) <= 24 * 1024 * 1024, "materialization_resource_exhausted");
    return { ...plan, planHash: bytesVersion(canonicalJson(plan)) };
  }

  private async receipt(): Promise<Receipt | null> {
    const data = await read(this.stateRoot, "receipt.json");
    if (!data) return null;
    const value: unknown = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    check(isRecord(value) && value.schemaVersion === "stella.initialization-receipt/v1" && ["host_files_and_skills", "host_bootstrap"].includes(String(value.scope)) &&
      typeof value.workspace === "string" && path.isAbsolute(value.workspace) && digest(value.recipeHash) &&
      typeof value.operationId === "string" && /^init_[a-f0-9-]{36}$/.test(value.operationId) &&
      typeof value.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(value.sourceRevision) && Array.isArray(value.files) &&
      value.files.length <= 512 && value.files.every((file) => isRecord(file) && typeof file.target === "string" && managedTarget(file.target) && digest(file.hash)), "invalid_receipt");
    check(value.identityHash === undefined || digest(value.identityHash), "invalid_receipt");
    for (const file of value.files) relative(file.target);
    check(new Set(value.files.map((file) => file.target.toLowerCase())).size === value.files.length, "invalid_receipt");
    return value as Receipt;
  }

  async assertCurrent(): Promise<Receipt> {
    check(await read(this.stateRoot, "pending.json") === null, "initialization_pending");
    check(await read(this.stateRoot, "fenced") === null, "initialization_pending");
    check(await read(this.stateRoot, "rollback-pending.json") === null, "rollback_pending");
    const recipe = await this.recipe();
    const receipt = await this.receipt();
    check(receipt && receipt.workspace === this.workspace && receipt.recipeHash === bytesVersion(canonicalJson(recipe)), "initialization_required");
    check(receipt.files.length === recipe.files.length && recipe.files.every((file) =>
      receipt.files.some((entry) => entry.target === file.target && entry.hash === file.sha256)), "invalid_receipt");
    for (const file of receipt.files) {
      const data = await read(this.workspace, file.target);
      check(data && bytesVersion(Buffer.from(data, "base64")) === file.hash, "projection_drift");
    }
    for (const file of recipe.files) check(await mode(this.workspace, file.target) === (file.executable ? 0o700 : 0o600), "projection_mode_drift");
    if (this.compiledIdentity) {
      const expected = bytesVersion(canonicalJson(this.compiledIdentity));
      check(receipt.identityHash === expected && this.ports.readIdentity, "host_identity_verification_required");
      check(bytesVersion(canonicalJson(await this.ports.readIdentity())) === expected, "host_identity_drift");
    }
    return receipt;
  }

  /** Recheck installed Host consumption without installation effects or runtime admission. */
  async verifyInstalled(): Promise<Receipt> {
    this.active();
    const before = await this.assertCurrent();
    const recipe = await this.recipe();
    await this.ports.verify(recipe);
    this.active();
    const after = await this.assertCurrent();
    check(canonicalJson(before) === canonicalJson(after), "initialization_changed_during_verification");
    return after;
  }

  /** The authenticated Host supplies identity and dependencies, never model tool arguments. */
  async verifyCapability(actorHash: string, capture: () => Promise<InitializationVerificationBinding>, signal?: AbortSignal): Promise<VerificationReceipt> {
    check(digest(actorHash), "verification_actor_required");
    const active = () => { this.active(); check(!signal?.aborted, "operation_cancelled"); };
    active();
    const started = Date.now();
    const before = await capture();
    active();
    check(Object.keys(before).length === 12 && Object.values(before).every(digest), "invalid_verification_binding");
    const installed = await this.verifyInstalled();
    check(installed.scope === "host_bootstrap", "host_bootstrap_verification_required");
    check(canonicalJson(await capture()) === canonicalJson(before), "verification_dependencies_changed");
    active();
    check(Date.now() - started < 60_000, "verification_expired");
    const receipt: VerificationReceipt = { schemaVersion: "stella.initialization-verification/v1", id: `verify_${randomUUID()}`,
      scope: "host_bootstrap", runtimeAdmission: false, operationId: installed.operationId,
      purpose: "verify_installed_bootstrap", actorHash, binding: before,
      checkedAt: new Date().toISOString(), expiresAt: new Date(started + 60_000).toISOString() };
    await write(this.stateRoot, `verifications/${receipt.id}.json`, Buffer.from(canonicalJson(receipt)).toString("base64"));
    try { active(); check(Date.now() < Date.parse(receipt.expiresAt), "verification_expired"); }
    catch (error) { await unlink(await safeFile(this.stateRoot, `verifications/${receipt.id}.json`)); throw error; }
    return receipt;
  }

  async assertCapabilityVerification(receipt: unknown, capture: () => Promise<InitializationVerificationBinding>, signal?: AbortSignal): Promise<void> {
    check(isRecord(receipt) && typeof receipt.id === "string" && /^verify_[a-f0-9-]{36}$/.test(receipt.id), "invalid_verification_receipt");
    const stored = await read(this.stateRoot, `verifications/${receipt.id}.json`);
    check(stored && Buffer.from(stored, "base64").toString("utf8") === canonicalJson(receipt), "untrusted_verification_receipt");
    const active = () => {
      this.active(); check(!signal?.aborted, "operation_cancelled");
      check(typeof receipt.expiresAt === "string" && Date.parse(receipt.expiresAt) > Date.now(), "verification_expired");
    };
    try {
      active();
      check(canonicalJson(receipt.binding) === canonicalJson(await capture()), "verification_dependencies_changed");
      const installed = await this.assertCurrent();
      check(receipt.operationId === installed.operationId, "verification_initialization_changed");
      active();
    } catch (error) {
      await unlink(await safeFile(this.stateRoot, `verifications/${receipt.id}.json`));
      throw error;
    }
  }

  async assertSkillRead(input: unknown): Promise<void> {
    check(isRecord(input), "skill_read_forbidden");
    const requested = input.path ?? input.file_path;
    check(typeof requested === "string" && requested.length > 0, "skill_read_forbidden");
    // Host paths can use macOS /var aliases while the receipt uses /private/var.
    // Compare canonical destinations, then require an exact owned receipt entry.
    const target = path.relative(this.workspace, await realpath(path.resolve(this.workspace, requested)));
    relative(target);
    const receipt = await this.assertCurrent();
    check(target.startsWith("skills/") && receipt.files.some((file) => file.target === target), "skill_read_forbidden");
    // assertCurrent reads through the same no-symlink/no-hardlink file boundary.
  }

  async apply(plan: InitializationPlan): Promise<Receipt> {
    this.active();
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const lock = await this.acquire();
    try {
      check(await read(this.stateRoot, "rollback-pending.json") === null, "rollback_pending");
      const { planHash, ...body } = plan;
      check(bytesVersion(canonicalJson(body)) === planHash && plan.agentId === this.source.agentId && plan.workspace === this.workspace && plan.sourceRevision === this.source.revision, "stale_plan");
      const recipe = await this.recipe();
      check(bytesVersion(canonicalJson(recipe)) === plan.recipeHash, "stale_plan");
      const previous = await this.receipt();
      const intent = Buffer.from(canonicalJson(plan)).toString("base64");
      const pending = await read(this.stateRoot, "pending.json");
      check(pending === null || pending === intent, "initialization_pending");
      check(canonicalJson(plan.hostIdentity?.after ?? null) === canonicalJson(this.compiledIdentity ?? null), "plan_identity_mismatch");
      if (plan.hostIdentity) {
        check(this.ports.readIdentity && this.ports.applyIdentity, "host_identity_adapter_unavailable");
        const current = canonicalJson(await this.ports.readIdentity());
        check(current === canonicalJson(plan.hostIdentity.before) || pending === intent && current === canonicalJson(plan.hostIdentity.after), "host_identity_conflict");
      }
      check(plan.schemaVersion === "stella.initialization-plan/v1" && /^init_[a-f0-9-]{36}$/.test(plan.operationId) &&
        Array.isArray(plan.changes) && plan.changes.length <= 1024 && new Set(plan.changes.map((file) => file.target.toLowerCase())).size === plan.changes.length,
      "invalid_plan");
      for (const file of recipe.files) {
        const change = plan.changes.find((change) => change.target === file.target);
        check(change && typeof change.after === "string" && bytesVersion(Buffer.from(change.after, "base64")) === file.sha256 &&
          change.executable === file.executable && await this.sourceContent(file) === change.after, "plan_source_mismatch");
      }
      for (const change of plan.changes) {
        check(recipe.files.some((file) => file.target === change.target) ||
          (change.after === null && (previous?.files.some((file) => file.target === change.target) ||
            pending === intent && plan.previousReceipt?.files.some((file) => file.target === change.target))), "unmanaged_target");
      }
      for (const change of plan.changes) {
        relative(change.target);
        const current = await read(this.workspace, change.target);
        check(current === change.before || (pending === intent && current === change.after), "host_file_conflict");
        const currentMode = await mode(this.workspace, change.target);
        check(currentMode === change.beforeMode || (pending === intent && currentMode === (change.after === null ? null : change.executable ? 0o700 : 0o600)), "host_mode_conflict");
      }
      await this.fence();
      // Retain each operation's original bytes across retries and later reinitializations.
      const archive = `operations/${plan.operationId}.json`;
      const existingArchive = await read(this.stateRoot, archive);
      check(existingArchive === null || existingArchive === intent, "operation_conflict");
      if (existingArchive === null) await write(this.stateRoot, archive, intent);
      await write(this.stateRoot, "pending.json", intent);
      for (const change of plan.changes) {
        this.active();
        const current = await read(this.workspace, change.target);
        if (current === change.after && await mode(this.workspace, change.target) === (change.after === null ? null : change.executable ? 0o700 : 0o600)) continue;
        check(current === change.before, "host_file_conflict");
        check(await mode(this.workspace, change.target) === change.beforeMode, "host_mode_conflict");
        if (change.after === null) {
          await unlink(await safeFile(this.workspace, change.target));
          await syncDirectory(path.dirname(path.join(this.workspace, change.target)));
        }
        else await write(this.workspace, change.target, change.after, change.executable);
      }
      await this.recipe();
      for (const change of plan.changes) check(await read(this.workspace, change.target) === change.after, "projection_drift");
      if (plan.hostIdentity) await this.ports.applyIdentity!(plan.hostIdentity.before, plan.hostIdentity.after, pending === intent);
      await this.ports.verify(recipe, this.compiledIdentity ? { setup: true } : undefined);
      if (plan.hostIdentity) check(canonicalJson(await this.ports.readIdentity!()) === canonicalJson(plan.hostIdentity.after), "host_identity_drift");
      this.active();
      const receipt: Receipt = { schemaVersion: "stella.initialization-receipt/v1", scope: plan.hostIdentity ? "host_bootstrap" : "host_files_and_skills", operationId: plan.operationId,
        sourceRevision: plan.sourceRevision, workspace: this.workspace, recipeHash: plan.recipeHash, checkedAt: new Date().toISOString(),
        files: plan.changes.flatMap((file) => file.after === null ? [] : [{ target: file.target, hash: bytesVersion(Buffer.from(file.after, "base64")) }]),
        ...(plan.hostIdentity ? { identityHash: bytesVersion(canonicalJson(plan.hostIdentity.after)) } : {}) };
      await write(this.stateRoot, "receipt.json", Buffer.from(canonicalJson(receipt)).toString("base64"));
      await write(this.stateRoot, "last-plan.json", intent);
      await this.ports.release();
      await unlink(await safeFile(this.stateRoot, "fenced"));
      await unlink(await safeFile(this.stateRoot, "pending.json"));
      await syncDirectory(this.stateRoot);
      return receipt;
    } finally { await lock.release(); }
  }

  /** Restores original bytes and modes, but leaves admission fenced until a new source is verified. */
  async rollback(operationId: string): Promise<void> {
    this.active();
    check(/^init_[a-f0-9-]{36}$/.test(operationId), "invalid_operation");
    const lock = await this.acquire();
    try {
      const archived = await read(this.stateRoot, `operations/${operationId}.json`);
      check(archived, "operation_not_found");
      const plan = JSON.parse(Buffer.from(archived, "base64").toString("utf8")) as InitializationPlan;
      const { planHash, ...body } = plan;
      check(plan.operationId === operationId && plan.agentId === this.source.agentId && plan.workspace === this.workspace &&
        bytesVersion(canonicalJson(body)) === planHash && Array.isArray(plan.changes) && plan.changes.length <= 1024, "invalid_plan");
      const pending = await read(this.stateRoot, "pending.json");
      const rollbackPending = await read(this.stateRoot, "rollback-pending.json");
      const currentReceipt = await this.receipt();
      check(rollbackPending === null || rollbackPending === archived, "rollback_pending");
      check(pending === archived || (pending === null && currentReceipt?.operationId === operationId) || rollbackPending === archived, "rollback_not_current");
      if (plan.hostIdentity) {
        check(this.ports.readIdentity && this.ports.applyIdentity, "host_identity_adapter_unavailable");
        const current = canonicalJson(await this.ports.readIdentity());
        check(current === canonicalJson(plan.hostIdentity.after) || rollbackPending === archived && current === canonicalJson(plan.hostIdentity.before), "host_identity_conflict");
      }
      for (const change of plan.changes) {
        relative(change.target);
        check(managedTarget(change.target) && (change.before === null || typeof change.before === "string") &&
          (change.beforeMode === null || Number.isInteger(change.beforeMode) && change.beforeMode >= 0 && change.beforeMode <= 0o777), "invalid_plan");
        const data = await read(this.workspace, change.target);
        check(data === change.after || data === change.before, "host_file_conflict");
        const observedMode = await mode(this.workspace, change.target);
        check(observedMode === change.beforeMode || observedMode === (change.after === null ? null : change.executable ? 0o700 : 0o600), "host_mode_conflict");
      }
      await this.fence();
      await write(this.stateRoot, "rollback-pending.json", archived);
      for (const change of [...plan.changes].reverse()) {
        this.active();
        const data = await read(this.workspace, change.target);
        check(data === change.after || data === change.before, "host_file_conflict");
        const observedMode = await mode(this.workspace, change.target);
        check(observedMode === change.beforeMode || observedMode === (change.after === null ? null : change.executable ? 0o700 : 0o600), "host_mode_conflict");
        if (change.before === null) {
          if (data !== null) {
            await unlink(await safeFile(this.workspace, change.target));
            await syncDirectory(path.dirname(path.join(this.workspace, change.target)));
          }
        } else await write(this.workspace, change.target, change.before, false, change.beforeMode ?? 0o600);
      }
      for (const change of plan.changes) check(await read(this.workspace, change.target) === change.before &&
        await mode(this.workspace, change.target) === change.beforeMode, "rollback_conflict");
      if (plan.hostIdentity) await this.ports.applyIdentity!(plan.hostIdentity.after, plan.hostIdentity.before, rollbackPending === archived);
      if (plan.previousReceipt) await write(this.stateRoot, "receipt.json", Buffer.from(canonicalJson(plan.previousReceipt)).toString("base64"));
      else if (await read(this.stateRoot, "receipt.json") !== null) await unlink(await safeFile(this.stateRoot, "receipt.json"));
      if (pending !== null) await unlink(await safeFile(this.stateRoot, "pending.json"));
      await write(this.stateRoot, `operations/${operationId}.rolled-back`, Buffer.from("rolled back; initialization required\n").toString("base64"));
      await unlink(await safeFile(this.stateRoot, "rollback-pending.json"));
      await syncDirectory(this.stateRoot);
    } finally { await lock.release(); }
  }

  async bindRun(runId: string): Promise<void> {
    const receipt = await this.assertCurrent();
    try {
      await writeRunAdmissionBinding(this.stateRoot, runId, {
        schemaVersion: "stella.run-admission/v1",
        operationId: receipt.operationId,
        admissionEpoch: await readAdmissionEpoch(this.stateRoot),
      });
    } catch (error) {
      if (error instanceof RunAdmissionError) throw new InitializationError(error.category);
      throw error;
    }
  }

  /** Invalidate every bound run. Optionally re-bind the live correcting run to the new epoch. */
  async revokeActiveRuns(reason: string, options?: { retainRunId?: string }): Promise<void> {
    // Do not gate on this.signal: advancing the recovery pointer reloads Host config and can
    // abort the registration shutdown while the live correcting turn still must retire siblings.
    try {
      const epoch = await bumpAdmissionEpoch(this.stateRoot, reason);
      if (options?.retainRunId) {
        // Do not re-enter recipe()/source cleanliness here: correction may still hold
        // transient workspace state while retiring sibling runs.
        check(await read(this.stateRoot, "fenced") === null, "initialization_pending");
        check(await read(this.stateRoot, "pending.json") === null, "initialization_pending");
        check(await read(this.stateRoot, "rollback-pending.json") === null, "rollback_pending");
        const receipt = await this.receipt();
        check(receipt, "initialization_required");
        await writeRunAdmissionBinding(this.stateRoot, options.retainRunId, {
          schemaVersion: "stella.run-admission/v1",
          operationId: receipt.operationId,
          admissionEpoch: epoch,
        }, "replace");
      }
    } catch (error) {
      if (error instanceof RunAdmissionError) throw new InitializationError(error.category);
      throw error;
    }
  }

  async pendingOperationId(): Promise<string | undefined> {
    const data = await read(this.stateRoot, "rollback-pending.json") ?? await read(this.stateRoot, "pending.json");
    if (!data) return undefined;
    const value: unknown = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    check(isRecord(value) && typeof value.operationId === "string" && /^init_[a-f0-9-]{36}$/.test(value.operationId), "invalid_plan");
    return value.operationId;
  }

  async assertRun(runId: string): Promise<void> {
    const receipt = await this.assertCurrent();
    try {
      await assertRunAdmissionBinding(this.stateRoot, runId, {
        schemaVersion: "stella.run-admission/v1",
        operationId: receipt.operationId,
        admissionEpoch: await readAdmissionEpoch(this.stateRoot),
      });
    } catch (error) {
      if (error instanceof RunAdmissionError) throw new InitializationError(error.category);
      throw error;
    }
  }

  async initialize(): Promise<Receipt> {
    check(await read(this.stateRoot, "rollback-pending.json") === null, "rollback_pending");
    const pending = await read(this.stateRoot, "pending.json");
    if (pending) return this.apply(JSON.parse(Buffer.from(pending, "base64").toString("utf8")) as InitializationPlan);
    const previous = await this.receipt();
    const recipe = await this.recipe();
    const identityHash = this.compiledIdentity ? bytesVersion(canonicalJson(this.compiledIdentity)) : undefined;
    if (previous?.recipeHash === bytesVersion(canonicalJson(recipe)) && previous.identityHash === identityHash && await read(this.stateRoot, "fenced") === null) {
      await this.assertCurrent();
      try { await this.ports.verify(recipe, this.compiledIdentity ? { setup: true } : undefined); }
      catch (error) { await this.fence(); throw error; }
      this.active();
      return previous;
    }
    return this.apply(await this.plan());
  }
}
