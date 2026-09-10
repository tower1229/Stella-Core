import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CangHaiDurabilityDiagnostics, CangHaiDurabilityStage } from "./durability.js";
import { GitCangHaiDurability } from "./durability.js";
import type { StellaConsciousnessManifest } from "./manifest.js";
import {
  applyMemoryTransaction,
  assertMemoryTransactionReadable,
  type MemoryTransactionPlan,
} from "./memory-transaction.js";
import type { RuntimeProfile } from "./runtime-profile.js";
import type { PersistenceStatus } from "../openclaw/completion.js";
import { isRecord } from "../shared/type-guards.js";

export type DurableWriteStage = CangHaiDurabilityStage | "view_publish";

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
const SENSITIVE_KEY = /secret|password|token|credential/i;

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

/** Materials may only carry Host secret *refs* (`path:`), never secret values under sensitive keys. */
export function assertNoCredentialsInMaterials(value: unknown): void {
  const visit = (node: unknown): void => {
    if (typeof node === "string" || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (isRecord(node)) {
      for (const [key, item] of Object.entries(node)) {
        check(!SENSITIVE_KEY.test(key) || typeof item === "string" && item.startsWith("path:"),
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
  if (input.materialPreview !== undefined) assertNoCredentialsInMaterials(input.materialPreview);
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

/**
 * Map durability diagnostics to the public completion persistence status.
 * Critical must already be confirmed when required; normal may remain remote_pending within RPO.
 */
export function persistenceStatusFromDiagnostics(
  diagnostics: CangHaiDurabilityDiagnostics,
  priority: "critical" | "normal",
): PersistenceStatus {
  if (priority === "critical") {
    if (!diagnostics.criticalSynchronized || diagnostics.lastErrorCategory === "stella_critical_sync_failed") {
      throw new ManagedDurableWriteError("critical_sync_failed");
    }
  }
  if (diagnostics.normalState === "breached" ||
    diagnostics.observedNormalRpoSeconds > diagnostics.maxNormalRpoSeconds) {
    throw new ManagedDurableWriteError("archive_rpo_breached");
  }
  if (diagnostics.normalState === "pending") return "remote_pending";
  if (diagnostics.localRevision === diagnostics.synchronizedRevision) return "synchronized";
  if (priority === "critical" && diagnostics.criticalSynchronized) return "synchronized";
  return "local_committed";
}

/** After durable persist succeeds, confirm the generation fence is released before readers proceed. */
export async function afterDurablePersistPublishView(root: string): Promise<void> {
  try {
    await assertMemoryTransactionReadable(root);
  } catch (error) {
    throw new ManagedDurableWriteError("view_publish_failed", { cause: error });
  }
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
    onStage: async (stage) => {
      try {
        await input.onStage?.(stage);
      } catch (error) {
        if (error instanceof ManagedDurableWriteError) throw error;
        const category = stage === "commit" ? "commit_failed"
          : stage === "recovery_pointer_cas" ? "pointer_conflict"
            : "sync_failed";
        throw new ManagedDurableWriteError(category, { cause: error });
      }
    },
    onRevision: async (revision) => {
      await input.onRevision?.(expectedRevision.current, revision);
      expectedRevision.current = revision;
    },
  });
}

async function invokeViewPublish(
  root: string,
  onStage?: (stage: DurableWriteStage) => void | Promise<void>,
): Promise<void> {
  try {
    await onStage?.("view_publish");
    await afterDurablePersistPublishView(root);
  } catch (error) {
    if (error instanceof ManagedDurableWriteError) throw error;
    throw new ManagedDurableWriteError("view_publish_failed", { cause: error });
  }
}

/**
 * Synthetic acceptance harness: scoped commit → recovery pointer CAS → sync → view publish.
 * Host business writes continue to use GitCangHaiDurability + MemoryTransaction directly.
 */
export async function runManagedDurableRecord(input: ManagedDurableRecordInput): Promise<ManagedDurableRecordResult> {
  check(input.operationId.trim() && input.message.trim() && input.paths.length > 0, "invalid_durable_record");
  assertNoCredentialsInMaterials(input.writeFiles ?? {});
  if (input.transaction) assertNoCredentialsInMaterials(input.transaction);
  const expectedRevision = { current: input.binding.operatorIdentity.recoveryRevision };
  const durability = await createDurability(input, expectedRevision);
  let replayed = false;

  const persistPaths = async (paths: string[]) => {
    try {
      if (input.priority === "critical") await durability.syncCritical(paths, input.message);
      else await durability.recordNormal(paths, input.message);
    } catch (error) {
      if (error instanceof ManagedDurableWriteError) throw error;
      throw new ManagedDurableWriteError(
        input.priority === "critical" ? "critical_sync_failed" : "sync_failed",
        { cause: error },
      );
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
        async publishView() { await invokeViewPublish(input.root, input.onStage); },
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
        await invokeViewPublish(input.root, input.onStage);
      } else {
        await persistPaths(input.paths);
        await invokeViewPublish(input.root, input.onStage);
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
