import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import {
  CapabilityReceiptError,
  admitBusinessCapability,
  type CapabilityHostBinding,
  type CapabilityReceipt,
  type CapabilityReceiptStore,
  type CapabilityVersionBinding,
} from "../acceptance/capability-receipt.js";
import { runConstrainedCapabilityAcceptance, type CapabilityAdapter } from "../acceptance/capability-acceptance.js";
import { isRecord } from "../shared/type-guards.js";

function check(value: unknown, category: string): asserts value {
  if (!value) throw new CapabilityReceiptError(category);
}

/** Persist capability receipts under the Host state root. Bodies are digests-only JSON. */
export function createFileCapabilityReceiptStore(stateRoot: string): CapabilityReceiptStore {
  const root = path.join(stateRoot, "capability-receipts");
  const fileFor = (id: string) => {
    check(/^cap_[a-f0-9-]{36}$/.test(id), "invalid_capability_receipt");
    return path.join(root, `${id}.json`);
  };
  return {
    async write(id, body) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const target = fileFor(id);
      const staging = `${target}.${process.pid}.staging`;
      await writeFile(staging, `${body}\n`, { mode: 0o600 });
      await rename(staging, target);
    },
    async read(id) {
      try { return (await readFile(fileFor(id), "utf8")).trimEnd(); }
      catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(id) {
      try { await unlink(fileFor(id)); }
      catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return;
        throw error;
      }
    },
  };
}

export async function listCapabilityReceiptIds(storeRoot: string): Promise<string[]> {
  const root = path.join(storeRoot, "capability-receipts");
  try {
    return (await readdir(root)).filter(name => /^cap_[a-f0-9-]{36}\.json$/.test(name)).map(name => name.slice(0, -".json".length));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Clear capability_acceptance_missing blockers only when a current stored receipt admits that capability.
 * Declared acceptance_ref passed strings never enter this path. Skill verification blockers stay separate.
 */
export async function evaluateRuntimeCapabilityBlockers(input: {
  compiledBlockers: readonly string[];
  store: CapabilityReceiptStore;
  receiptIds: readonly string[];
  captureBinding: () => Promise<CapabilityVersionBinding>;
  signal?: AbortSignal;
}): Promise<string[]> {
  const admitted = new Set<string>();
  for (const id of input.receiptIds) {
    const body = await input.store.read(id);
    if (!body) continue;
    let receipt: unknown;
    try { receipt = JSON.parse(body); } catch { continue; }
    if (!isRecord(receipt) || typeof receipt.capabilityId !== "string") continue;
    try {
      await admitBusinessCapability({
        capabilityId: receipt.capabilityId, receipt, captureBinding: input.captureBinding,
        store: input.store, signal: input.signal,
      });
      admitted.add(receipt.capabilityId);
    } catch { /* expired, forged, drifted, or failed receipts cannot clear blockers */ }
  }
  const blockers = new Set<string>();
  for (const blocker of input.compiledBlockers) {
    // Capability receipts clear acceptance gaps only. Skill verification remains a separate gate.
    const missing = /^capability_acceptance_missing:(.+)$/.exec(blocker);
    if (missing?.[1] && admitted.has(missing[1])) continue;
    blockers.add(blocker);
  }
  return [...blockers].sort();
}

/**
 * One real Host adapter: trusts Host-supplied identity/run/purpose, observes the installed bootstrap surface,
 * and never expands source-read or delivery permissions.
 */
export function createHostBootstrapCapabilityAdapter(ports: {
  assertTrustedIdentity(actorHash: string): void | Promise<void>;
  assertRunBound(runId: string): void | Promise<void>;
  verifyInstalledBootstrap(): Promise<{ operationId: string }>;
}): CapabilityAdapter {
  return {
    capabilityId: "host_initialization",
    adapterId: "stella.openclaw-host-bootstrap",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    async execute({ mode, host, signal }) {
      check(mode === "constrained_acceptance", "constrained_acceptance_required");
      check(!signal?.aborted, "operation_cancelled");
      await ports.assertTrustedIdentity(host.actorHash);
      await ports.assertRunBound(host.runId);
      check(host.purpose.kind === "adapter_verification" && host.purpose.capabilityId === "host_initialization",
        "capability_purpose_mismatch");
      check(!signal?.aborted, "operation_cancelled");
      const installed = await ports.verifyInstalledBootstrap();
      check(!signal?.aborted, "operation_cancelled");
      check(typeof installed.operationId === "string" && /^init_[a-f0-9-]{36}$/.test(installed.operationId),
        "host_bootstrap_verification_required");
      return {
        outcome: "passed",
        executionDigest: bytesVersion(canonicalJson({
          adapter: "stella.openclaw-host-bootstrap",
          operationId: installed.operationId,
          purpose: host.purpose,
          resourceScope: host.resourceScope,
        })),
      };
    },
  };
}

/** Constrained acceptance entry that reuses the Host bootstrap adapter and existing capability store. */
export async function acceptHostBootstrapCapability(input: {
  host: CapabilityHostBinding;
  captureBinding: () => Promise<CapabilityVersionBinding>;
  store: CapabilityReceiptStore;
  ports: Parameters<typeof createHostBootstrapCapabilityAdapter>[0];
  signal?: AbortSignal;
  ttlMs?: number;
}): Promise<CapabilityReceipt> {
  return runConstrainedCapabilityAcceptance({
    adapter: createHostBootstrapCapabilityAdapter(input.ports),
    host: input.host,
    captureBinding: input.captureBinding,
    store: input.store,
    signal: input.signal,
    ttlMs: input.ttlMs,
  });
}
