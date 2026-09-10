import { randomUUID } from "node:crypto";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";

export class CapabilityReceiptError extends Error {
  constructor(readonly category: string) { super(`Stella capability receipt: ${category}`); }
}
function check(value: unknown, category: string): asserts value {
  if (!value) throw new CapabilityReceiptError(category);
}
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const capabilityId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);

export type CapabilityVersionBinding = {
  core: string; artifact: string; host: string; harness: string; source: string;
  profile: string; policy: string; configuration: string; model: string; cases: string;
};
export type CapabilityHostBinding = {
  actorHash: string;
  runId: string;
  purpose: { kind: "adapter_verification"; capabilityId: string };
  resourceScope: string;
};
export type CapabilityReceipt = {
  schemaVersion: "stella.capability-receipt/v1";
  id: string;
  capabilityId: string;
  adapterId: string;
  adapterVersion: string;
  mode: "constrained_acceptance";
  /** Constrained receipts never authorize ordinary business by field value alone. */
  businessAdmission: false;
  result: "passed" | "failed";
  binding: CapabilityVersionBinding;
  host: CapabilityHostBinding;
  executionDigest: string;
  checkedAt: string;
  expiresAt: string;
};

export type CapabilityReceiptStore = {
  write(id: string, body: string): Promise<void>;
  read(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
};

const bindingKeys = ["core", "artifact", "host", "harness", "source", "profile", "policy", "configuration", "model", "cases"] as const;

export function createMemoryCapabilityReceiptStore(): CapabilityReceiptStore {
  const entries = new Map<string, string>();
  return {
    async write(id, body) { entries.set(id, body); },
    async read(id) { return entries.get(id) ?? null; },
    async remove(id) { entries.delete(id); },
  };
}

function assertBinding(value: unknown): asserts value is CapabilityVersionBinding {
  check(isRecord(value) && Object.keys(value).length === bindingKeys.length &&
    bindingKeys.every(key => digest(value[key])), "invalid_capability_binding");
}

function assertHost(value: unknown): asserts value is CapabilityHostBinding {
  check(isRecord(value) && digest(value.actorHash) && typeof value.runId === "string" && value.runId.trim().length > 0 &&
    digest(value.resourceScope) && isRecord(value.purpose) && value.purpose.kind === "adapter_verification" &&
    capabilityId(value.purpose.capabilityId), "invalid_capability_host_binding");
}

function assertReceiptShape(value: unknown): asserts value is CapabilityReceipt {
  check(isRecord(value) && value.schemaVersion === "stella.capability-receipt/v1" &&
    typeof value.id === "string" && /^cap_[a-f0-9-]{36}$/.test(value.id) &&
    capabilityId(value.capabilityId) && typeof value.adapterId === "string" && value.adapterId.trim().length > 0 &&
    typeof value.adapterVersion === "string" && value.adapterVersion.trim().length > 0 &&
    value.mode === "constrained_acceptance" && value.businessAdmission === false &&
    (value.result === "passed" || value.result === "failed") && digest(value.executionDigest) &&
    typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)) &&
    typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.parse(value.checkedAt), "invalid_capability_receipt");
  assertBinding(value.binding);
  assertHost(value.host);
  check(value.host.purpose.capabilityId === value.capabilityId, "capability_purpose_mismatch");
}

/** Issue a stored capability receipt. The receipt never carries businessAdmission true. */
export async function issueCapabilityReceipt(input: {
  capabilityId: string; adapterId: string; adapterVersion: string;
  host: CapabilityHostBinding; binding: CapabilityVersionBinding;
  result: "passed" | "failed"; executionDigest: string; store: CapabilityReceiptStore;
  ttlMs?: number; now?: number;
}): Promise<CapabilityReceipt> {
  check(capabilityId(input.capabilityId), "invalid_capability_id");
  assertHost(input.host);
  assertBinding(input.binding);
  check(input.host.purpose.capabilityId === input.capabilityId, "capability_purpose_mismatch");
  check(digest(input.executionDigest), "invalid_execution_digest");
  check(typeof input.adapterId === "string" && input.adapterId.trim().length > 0, "invalid_adapter_id");
  check(typeof input.adapterVersion === "string" && input.adapterVersion.trim().length > 0, "invalid_adapter_version");
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 86_400_000;
  check(Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= 7 * 86_400_000, "invalid_capability_ttl");
  const receipt: CapabilityReceipt = {
    schemaVersion: "stella.capability-receipt/v1",
    id: `cap_${randomUUID()}`,
    capabilityId: input.capabilityId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    mode: "constrained_acceptance",
    businessAdmission: false,
    result: input.result,
    binding: structuredClone(input.binding),
    host: structuredClone(input.host),
    executionDigest: input.executionDigest,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  assertReceiptShape(receipt);
  await input.store.write(receipt.id, canonicalJson(receipt));
  return receipt;
}

export async function validateCapabilityReceipt(receipt: unknown,
  captureBinding: () => Promise<CapabilityVersionBinding>, store: CapabilityReceiptStore,
  signal?: AbortSignal): Promise<CapabilityReceipt> {
  assertReceiptShape(receipt);
  check(!signal?.aborted, "operation_cancelled");
  const stored = await store.read(receipt.id);
  check(stored === canonicalJson(receipt), "untrusted_capability_receipt");
  check(Date.parse(receipt.expiresAt) > Date.now(), "capability_receipt_expired");
  check(canonicalJson(receipt.binding) === canonicalJson(await captureBinding()), "capability_dependencies_changed");
  check(!signal?.aborted, "operation_cancelled");
  return receipt;
}

export async function invalidateCapabilityReceipt(receipt: unknown, store: CapabilityReceiptStore): Promise<void> {
  assertReceiptShape(receipt);
  const stored = await store.read(receipt.id);
  check(stored === canonicalJson(receipt), "untrusted_capability_receipt");
  await store.remove(receipt.id);
}

/**
 * Business admission requires an authentic stored passed receipt on the current binding.
 * Forging businessAdmission, writing acceptance_ref passed, or inventing a receipt body cannot pass.
 */
export async function admitBusinessCapability(input: {
  capabilityId: string;
  receipt: unknown;
  captureBinding: () => Promise<CapabilityVersionBinding>;
  store: CapabilityReceiptStore;
  signal?: AbortSignal;
}): Promise<CapabilityReceipt> {
  check(capabilityId(input.capabilityId), "invalid_capability_id");
  check(input.receipt !== null && input.receipt !== undefined, "capability_receipt_required");
  const receipt = await validateCapabilityReceipt(input.receipt, input.captureBinding, input.store, input.signal);
  check(receipt.capabilityId === input.capabilityId, "capability_receipt_mismatch");
  check(receipt.result === "passed", "capability_acceptance_failed");
  check(receipt.businessAdmission === false, "untrusted_capability_receipt");
  // Re-read after validation so a concurrent invalidate cannot leave a live permit.
  const stored = await input.store.read(receipt.id);
  check(stored === canonicalJson(receipt), "capability_receipt_invalidated");
  return receipt;
}

/** Digest-only public locator; never includes private path, account, or model text. */
export function capabilityReceiptLocator(receipt: CapabilityReceipt): string {
  assertReceiptShape(receipt);
  return bytesVersion(canonicalJson({ id: receipt.id, capabilityId: receipt.capabilityId, result: receipt.result,
    binding: receipt.binding, executionDigest: receipt.executionDigest }));
}
