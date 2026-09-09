import assert from "node:assert/strict";
import test from "node:test";
import { bytesVersion } from "../src/canghai/content-version.js";
import {
  admitBusinessCapability,
  createMemoryCapabilityReceiptStore,
  invalidateCapabilityReceipt,
  issueCapabilityReceipt,
  validateCapabilityReceipt,
  type CapabilityHostBinding,
  type CapabilityVersionBinding,
} from "../src/acceptance/capability-receipt.js";
import {
  runConstrainedCapabilityAcceptance,
  type CapabilityAdapter,
} from "../src/acceptance/capability-acceptance.js";

const binding = (): CapabilityVersionBinding => ({
  core: bytesVersion("core"), artifact: bytesVersion("artifact"), host: bytesVersion("host"),
  harness: bytesVersion("harness"), source: bytesVersion("source"), profile: bytesVersion("profile"),
  policy: bytesVersion("policy"), configuration: bytesVersion("configuration"),
  model: bytesVersion("model"), cases: bytesVersion("cases"),
});
const host = (): CapabilityHostBinding => ({
  actorHash: bytesVersion("authenticated-operator"),
  runId: "run_synthetic-acceptance",
  purpose: { kind: "adapter_verification", capabilityId: "host_initialization" },
  resourceScope: bytesVersion("synthetic-resource-scope"),
});

test("a constrained adapter run issues a version-bound receipt that never self-admits business", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const capture = async () => binding();
  const adapter: CapabilityAdapter = {
    capabilityId: "host_initialization",
    adapterId: "stella.openclaw-completion",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    async execute({ mode, host: bound, signal }) {
      assert.equal(mode, "constrained_acceptance");
      assert.equal(bound.runId, "run_synthetic-acceptance");
      assert.ok(!signal?.aborted);
      return { outcome: "passed", executionDigest: bytesVersion("host-verify-observed") };
    },
  };
  const receipt = await runConstrainedCapabilityAcceptance({ adapter, host: host(), captureBinding: capture, store });
  assert.equal(receipt.schemaVersion, "stella.capability-receipt/v1");
  assert.equal(receipt.businessAdmission, false);
  assert.equal(receipt.mode, "constrained_acceptance");
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.capabilityId, "host_initialization");
  assert.deepEqual(receipt.binding, binding());
  await validateCapabilityReceipt(receipt, capture, store);
  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization", receipt: { ...receipt, businessAdmission: true },
    captureBinding: capture, store,
  }), /invalid_capability_receipt|untrusted_capability_receipt/);
});

test("forged passed declarations, expired permits, dependency drift and cancellation cannot admit business", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const current = binding();
  const capture = async () => structuredClone(current);
  const receipt = await issueCapabilityReceipt({
    capabilityId: "host_initialization", adapterId: "stella.openclaw-completion", adapterVersion: "1",
    host: host(), binding: current, result: "passed", executionDigest: bytesVersion("ok"), store,
  });
  await validateCapabilityReceipt(receipt, capture, store);
  await admitBusinessCapability({ capabilityId: "host_initialization", receipt, captureBinding: capture, store });

  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization",
    receipt: { ...receipt, executionDigest: bytesVersion("forged-passed-declaration") },
    captureBinding: capture, store,
  }), /untrusted_capability_receipt/);

  const expired = await issueCapabilityReceipt({
    capabilityId: "host_initialization", adapterId: "stella.openclaw-completion", adapterVersion: "1",
    host: host(), binding: current, result: "passed", executionDigest: bytesVersion("later"), store,
  });
  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization", receipt: expired, captureBinding: async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { ...current, host: bytesVersion("drifted-host") };
    }, store,
  }), /capability_dependencies_changed/);

  const short = await issueCapabilityReceipt({
    capabilityId: "host_initialization", adapterId: "stella.openclaw-completion", adapterVersion: "1",
    host: host(), binding: current, result: "passed", executionDigest: bytesVersion("ttl"), store,
    ttlMs: 5,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization", receipt: short, captureBinding: capture, store,
  }), /capability_receipt_expired/);

  const live = await issueCapabilityReceipt({
    capabilityId: "host_initialization", adapterId: "stella.openclaw-completion", adapterVersion: "1",
    host: host(), binding: current, result: "passed", executionDigest: bytesVersion("cancel"), store,
  });
  await invalidateCapabilityReceipt(live, store);
  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization", receipt: live, captureBinding: capture, store,
  }), /untrusted_capability_receipt|capability_receipt_invalidated/);
});

test("constrained acceptance rejects adapters that expand data or side-effect permissions", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const adapter: CapabilityAdapter = {
    capabilityId: "host_initialization",
    adapterId: "stella.openclaw-completion",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify", "source_read"] as CapabilityAdapter["allowedEffects"],
    async execute() { return { outcome: "passed", executionDigest: bytesVersion("expanded") }; },
  };
  await assert.rejects(runConstrainedCapabilityAcceptance({
    adapter, host: host(), captureBinding: async () => binding(), store,
  }), /constrained_acceptance_effect_forbidden/);
});

test("missing capability receipts still block ordinary business while constrained verification remains available", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const capture = async () => binding();
  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization",
    receipt: null,
    captureBinding: capture,
    store,
  }), /capability_receipt_required/);
  const adapter: CapabilityAdapter = {
    capabilityId: "host_initialization",
    adapterId: "stella.openclaw-completion",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    async execute() { return { outcome: "passed", executionDigest: bytesVersion("verify-only") }; },
  };
  const receipt = await runConstrainedCapabilityAcceptance({
    adapter, host: host(), captureBinding: capture, store,
  });
  assert.equal(receipt.businessAdmission, false);
  await admitBusinessCapability({ capabilityId: "host_initialization", receipt, captureBinding: capture, store });
});
