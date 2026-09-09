import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bytesVersion } from "../src/canghai/content-version.js";
import {
  admitBusinessCapability,
  createMemoryCapabilityReceiptStore,
  type CapabilityHostBinding,
  type CapabilityVersionBinding,
} from "../src/acceptance/capability-receipt.js";
import {
  acceptHostBootstrapCapability,
  createFileCapabilityReceiptStore,
  createHostBootstrapCapabilityAdapter,
  evaluateRuntimeCapabilityBlockers,
  listCapabilityReceiptIds,
} from "../src/openclaw/capability-admission.js";
import { runConstrainedCapabilityAcceptance } from "../src/acceptance/capability-acceptance.js";

const binding = (): CapabilityVersionBinding => ({
  core: bytesVersion("core"), artifact: bytesVersion("artifact"), host: bytesVersion("host"),
  harness: bytesVersion("harness"), source: bytesVersion("source"), profile: bytesVersion("profile"),
  policy: bytesVersion("policy"), configuration: bytesVersion("configuration"),
  model: bytesVersion("model"), cases: bytesVersion("cases"),
});
const host = (runId = "run_host-bootstrap"): CapabilityHostBinding => ({
  actorHash: bytesVersion("authenticated-operator"),
  runId,
  purpose: { kind: "adapter_verification", capabilityId: "host_initialization" },
  resourceScope: bytesVersion("resource"),
});

test("host bootstrap adapter binds trusted identity, run and purpose into a versioned receipt", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const capture = async () => binding();
  let seenIdentity = "";
  let seenRun = "";
  const receipt = await acceptHostBootstrapCapability({
    host: host(),
    captureBinding: capture,
    store,
    ports: {
      assertTrustedIdentity(actorHash) { seenIdentity = actorHash; },
      assertRunBound(runId) { seenRun = runId; },
      async verifyInstalledBootstrap() { return { operationId: "init_11111111-1111-4111-8111-111111111111" }; },
    },
  });
  assert.equal(seenIdentity, host().actorHash);
  assert.equal(seenRun, "run_host-bootstrap");
  assert.equal(receipt.adapterId, "stella.openclaw-host-bootstrap");
  assert.equal(receipt.businessAdmission, false);
  await admitBusinessCapability({ capabilityId: "host_initialization", receipt, captureBinding: capture, store });
});

test("validated receipts clear only matching acceptance blockers; skill gates stay separate", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const current = binding();
  const capture = async () => structuredClone(current);
  const compiled = [
    "capability_acceptance_missing:host_initialization",
    "capability_acceptance_missing:memory_access",
    "skill_capability_unverified:host_initialization",
    "full_memory_acceptance_unavailable",
  ];
  assert.deepEqual(await evaluateRuntimeCapabilityBlockers({
    compiledBlockers: compiled, store, receiptIds: [], captureBinding: capture,
  }), compiled.sort());

  const receipt = await runConstrainedCapabilityAcceptance({
    adapter: createHostBootstrapCapabilityAdapter({
      assertTrustedIdentity() {},
      assertRunBound() {},
      async verifyInstalledBootstrap() { return { operationId: "init_22222222-2222-4222-8222-222222222222" }; },
    }),
    host: host("run_clear-one"),
    captureBinding: capture,
    store,
  });
  const remaining = await evaluateRuntimeCapabilityBlockers({
    compiledBlockers: compiled, store, receiptIds: [receipt.id], captureBinding: capture,
  });
  assert.deepEqual(remaining, [
    "capability_acceptance_missing:memory_access",
    "full_memory_acceptance_unavailable",
    "skill_capability_unverified:host_initialization",
  ]);
  await assert.rejects(admitBusinessCapability({
    capabilityId: "memory_access",
    receipt: { ...receipt, capabilityId: "memory_access", host: { ...host(), purpose: { kind: "adapter_verification", capabilityId: "memory_access" } } },
    captureBinding: capture, store,
  }), /untrusted_capability_receipt|capability_purpose_mismatch|invalid_capability_receipt/);
});

test("file-backed receipt store survives list/read/invalidate without private fields in locators", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "capability-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileCapabilityReceiptStore(root);
  const receipt = await acceptHostBootstrapCapability({
    host: host("run_file-store"),
    captureBinding: async () => binding(),
    store,
    ports: {
      assertTrustedIdentity() {},
      assertRunBound() {},
      async verifyInstalledBootstrap() { return { operationId: "init_33333333-3333-4333-8333-333333333333" }; },
    },
  });
  assert.deepEqual(await listCapabilityReceiptIds(root), [receipt.id]);
  assert.ok(!(await store.read(receipt.id))!.includes("/Users/"));
  assert.ok(!(await store.read(receipt.id))!.includes("private"));
});
