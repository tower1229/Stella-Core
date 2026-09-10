import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CangHaiDurabilityDiagnostics } from "./durability.js";
import { GitCangHaiDurability } from "./durability.js";
import type { StellaConsciousnessManifest } from "./manifest.js";
import {
  applyMemoryTransaction,
  type MemoryTransactionPlan,
} from "./memory-transaction.js";
import type { RuntimeProfile } from "./runtime-profile.js";
import type { PersistenceStatus } from "../openclaw/completion.js";
import { isRecord } from "../shared/type-guards.js";

export type DurableWriteStage = "commit" | "recovery_pointer_cas" | "synchronize" | "view_publish";

export type ManagedDurabilityBinding = {
  remote: string;
  branch: string;
  criticalWritePolicy: "sync_immediately";
  normalWritePolicy: "sync_immediately" | "bounded_batch";
  maxNormalRpoSeconds: number;
  archiveMaxRpoSeconds: number;
  operatorIdentity: { agentId: string; recoveryRevision: string };
  secretRefs: readonly string[];
};

export type ManagedDurabilityBindingInput = {
  dataMode: "managed_durable_write";
  durabilityRemote: string;
  durabilityBranch: string;
  agentId: string;
  recoveryRevision: string;
  manifest: StellaConsciousnessManifest;
  profile: RuntimeProfile;
  /** Synthetic materials inspected before durable write; never a Host secret value. */
  materialPreview?: unknown;
};

export class ManagedDurableWriteError extends Error {
  constructor(readonly category: string, options?: ErrorOptions) {
    super(`Managed durable write failed: ${category}`, options);
    this.name = "ManagedDurableWriteError";
  }
}

const SHA = /^[0-9a-f]{40}$/i;
const SECRETISH = /(?:sk-|api[_-]?key|bearer\s+[a-z0-9._\-]+|password\s*[:=])/i;

function check(value: unknown, category: string): asserts value {
  if (!value) throw new ManagedDurableWriteError(category);
}

function collectSecretRefs(manifest: StellaConsciousnessManifest, profile: RuntimeProfile): string[] {
  const refs = new Set<string>();
  for (const ref of manifest.secrets?.refs ?? []) {
    check(typeof ref === "string" && ref.startsWith("path:"), "invalid_secret_ref");
    refs.add(ref);
  }
  for (const capability of profile.capabilities) {
    for (const ref of capability.required_secret_refs) {
      check(typeof ref === "string" && ref.startsWith("path:"), "invalid_secret_ref");
      refs.add(ref);
    }
  }
  return [...refs].sort();
}

function assertNoCredentialsInMaterials(value: unknown, secretRefs: readonly string[]): void {
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      check(!SECRETISH.test(node), "credentials_in_materials");
      check(!secretRefs.some((ref) => node.includes(ref.slice("path:".length)) && /[=:].+/.test(node) && SECRETISH.test(node)),
        "credentials_in_materials");
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (isRecord(node)) {
      for (const [key, item] of Object.entries(node)) {
        check(!/secret|password|token|credential/i.test(key) || typeof item === "string" && item.startsWith("path:"),
          "credentials_in_materials");
        visit(item);
      }
    }
  };
  visit(value);
}

/** Resolve complete managed durability config from Host binding, manifest and profile. */
export function resolveManagedDurabilityBinding(input: ManagedDurabilityBindingInput): ManagedDurabilityBinding {
  check(input.dataMode === "managed_durable_write", "managed_mode_required");
  check(input.durabilityRemote.trim() && input.durabilityBranch.trim(), "durability_remote_required");
  check(input.agentId.trim(), "operator_identity_required");
  check(SHA.test(input.recoveryRevision), "operator_identity_required");
  const durability = input.manifest.durability;
  check(durability?.criticalWritePolicy === "sync_immediately", "critical_policy_required");
  check(durability.normalWritePolicy === "sync_immediately" || durability.normalWritePolicy === "bounded_batch",
    "normal_policy_required");
  check(Number.isInteger(durability.maxNormalRpoSeconds) && (durability.maxNormalRpoSeconds ?? -1) >= 0,
    "rpo_required");
  check(input.profile.memory && Number.isInteger(input.profile.memory.archive_max_rpo_seconds) &&
    input.profile.memory.archive_max_rpo_seconds >= 0, "archive_rpo_required");
  const archiveMaxRpoSeconds = input.profile.memory.archive_max_rpo_seconds;
  const maxNormalRpoSeconds = durability.maxNormalRpoSeconds!;
  if (maxNormalRpoSeconds > archiveMaxRpoSeconds) throw new ManagedDurableWriteError("archive_rpo_exceeded");
  const secretRefs = collectSecretRefs(input.manifest, input.profile);
  if (input.materialPreview !== undefined) assertNoCredentialsInMaterials(input.materialPreview, secretRefs);
  return {
    remote: input.durabilityRemote,
    branch: input.durabilityBranch,
    criticalWritePolicy: "sync_immediately",
    normalWritePolicy: durability.normalWritePolicy,
    maxNormalRpoSeconds,
    archiveMaxRpoSeconds,
    operatorIdentity: { agentId: input.agentId, recoveryRevision: input.recoveryRevision },
    secretRefs,
  };
}

/** Map durability diagnostics to the public completion persistence status. Critical failure and RPO breach throw. */
export function persistenceStatusFromDiagnostics(
  diagnostics: CangHaiDurabilityDiagnostics,
  priority: "critical" | "normal",
): PersistenceStatus {
  if (priority === "critical") {
    // criticalSynchronized is cleared before a critical commit and set only after push confirmation.
    // Later normal commits may advance HEAD without clearing that flag; they must not rewrite a
    // confirmed critical completion into a false sync failure.
    if (!diagnostics.criticalSynchronized || diagnostics.lastErrorCategory === "stella_critical_sync_failed") {
      throw new ManagedDurableWriteError("critical_sync_failed");
    }
    return "synchronized";
  }
  if (diagnostics.normalState === "breached" ||
    diagnostics.observedNormalRpoSeconds > diagnostics.maxNormalRpoSeconds) {
    throw new ManagedDurableWriteError("archive_rpo_breached");
  }
  if (diagnostics.normalState === "pending") return "remote_pending";
  if (diagnostics.localRevision === diagnostics.synchronizedRevision) return "synchronized";
  return "local_committed";
}

export type ManagedDurableRecordInput = {
  binding: ManagedDurabilityBinding;
  root: string;
  priority: "critical" | "normal";
  operationId: string;
  message: string;
  paths: string[];
  writeFiles?: Record<string, string>;
  transaction?: MemoryTransactionPlan;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  onStage?: (stage: DurableWriteStage) => void | Promise<void>;
  onRevision?: (expectedRevision: string, nextRevision: string) => void | Promise<void>;
};

export type ManagedDurableRecordResult = {
  persistenceStatus: PersistenceStatus;
  observedRevision: string;
  diagnostics: CangHaiDurabilityDiagnostics;
  operatorIdentity: ManagedDurabilityBinding["operatorIdentity"];
  replayed: boolean;
  refresh: () => Promise<CangHaiDurabilityDiagnostics>;
};

async function createDurability(
  input: ManagedDurableRecordInput,
  expectedRevision: { current: string },
): Promise<GitCangHaiDurability> {
  return new GitCangHaiDurability({
    root: input.root,
    remote: input.binding.remote,
    branch: input.binding.branch,
    criticalWritePolicy: input.binding.criticalWritePolicy,
    normalWritePolicy: input.binding.normalWritePolicy,
    maxNormalRpoSeconds: input.binding.maxNormalRpoSeconds,
    ...(input.now ? { now: input.now } : {}),
    ...(input.schedule ? { schedule: input.schedule } : {}),
    onStage: input.onStage,
    onRevision: async (revision) => {
      await input.onRevision?.(expectedRevision.current, revision);
      expectedRevision.current = revision;
    },
  });
}

async function publishView(onStage?: (stage: DurableWriteStage) => void | Promise<void>): Promise<void> {
  try { await onStage?.("view_publish"); }
  catch (error) {
    throw new ManagedDurableWriteError("view_publish_failed", { cause: error });
  }
}

/**
 * Public managed durable write seam: scoped commit → recovery pointer CAS → sync → view publish.
 * Reuses GitCangHaiDurability and MemoryTransaction; reports honest persistence status.
 */
export async function runManagedDurableRecord(input: ManagedDurableRecordInput): Promise<ManagedDurableRecordResult> {
  check(input.operationId.trim() && input.message.trim() && input.paths.length > 0, "invalid_durable_record");
  assertNoCredentialsInMaterials(input.writeFiles ?? {}, input.binding.secretRefs);
  if (input.transaction) assertNoCredentialsInMaterials(input.transaction, input.binding.secretRefs);
  const expectedRevision = { current: input.binding.operatorIdentity.recoveryRevision };
  const durability = await createDurability(input, expectedRevision);
  let replayed = false;

  const persistPaths = async (paths: string[]) => {
    try {
      if (input.priority === "critical") await durability.syncCritical(paths, input.message);
      else await durability.recordNormal(paths, input.message);
    } catch (error) {
      if (error instanceof ManagedDurableWriteError) throw error;
      const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : "";
      const category = /pointer|recovery pointer|recovery_pointer/i.test(message) ? "pointer_conflict"
        : /commit/i.test(message) ? "commit_failed"
          : input.priority === "critical" ? "critical_sync_failed"
            : "sync_failed";
      throw new ManagedDurableWriteError(category, { cause: error });
    }
  };

  try {
    if (input.transaction) {
      const result = await applyMemoryTransaction(input.root, input.transaction, {
        async validate() {},
        async persist(paths) { await persistPaths(paths); },
        async confirmPreviouslyCommitted(file) {
          replayed = true;
          await durability.confirmPreviouslyCommitted(file);
        },
        async publishView() { await publishView(input.onStage); },
      });
      replayed = result.replayed || replayed;
    } else {
      for (const [relative, content] of Object.entries(input.writeFiles ?? {})) {
        const absolute = path.join(input.root, relative);
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await writeFile(absolute, content, "utf8");
      }
      const alreadyCurrent = Object.keys(input.writeFiles ?? {}).length === 0;
      if (alreadyCurrent) {
        replayed = true;
        for (const relative of input.paths) await durability.confirmPreviouslyCommitted(relative);
        await publishView(input.onStage);
      } else {
        await persistPaths(input.paths);
        await publishView(input.onStage);
      }
    }
  } catch (error) {
    if (error instanceof ManagedDurableWriteError) throw error;
    throw new ManagedDurableWriteError("durable_write_failed", { cause: error });
  }

  const diagnostics = await durability.diagnostics();
  const persistenceStatus = persistenceStatusFromDiagnostics(diagnostics, input.priority);
  return {
    persistenceStatus,
    observedRevision: diagnostics.localRevision,
    diagnostics,
    operatorIdentity: {
      agentId: input.binding.operatorIdentity.agentId,
      recoveryRevision: diagnostics.localRevision,
    },
    replayed,
    refresh: () => durability.diagnostics(),
  };
}
