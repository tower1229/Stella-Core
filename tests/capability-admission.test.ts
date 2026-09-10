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
  assertConstrainedToolSurface,
  createFileCapabilityReceiptStore,
  createHostBootstrapCapabilityAdapter,
  evaluateRuntimeCapabilityBlockers,
  listCapabilityReceiptIds,
} from "../src/openclaw/capability-admission.js";
import { CONSTRAINED_TOOL_EXECUTION_ALLOW } from "../src/openclaw/completion-adapter.js";
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
const ports = (overrides: Partial<Parameters<typeof createHostBootstrapCapabilityAdapter>[0]> = {}) => ({
  assertTrustedIdentity() {},
  assertRunBound() {},
  assertConstrainedToolSurface(allowlist: readonly string[]) { assertConstrainedToolSurface(allowlist); },
  async verifyInstalledBootstrap() { return { operationId: "init_11111111-1111-4111-8111-111111111111" }; },
  ...overrides,
});

test("host bootstrap adapter binds trusted identity, run, purpose and constrained tool surface", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const capture = async () => binding();
  let seenIdentity = "";
  let seenRun = "";
  let seenAllowlist: readonly string[] = [];
  const receipt = await acceptHostBootstrapCapability({
    host: host(),
    captureBinding: capture,
    store,
    ports: ports({
      assertTrustedIdentity(actorHash) { seenIdentity = actorHash; },
      assertRunBound(runId) { seenRun = runId; },
      assertConstrainedToolSurface(allowlist) {
        seenAllowlist = allowlist;
        assertConstrainedToolSurface(allowlist);
      },
    }),
  });
  assert.equal(seenIdentity, host().actorHash);
  assert.equal(seenRun, "run_host-bootstrap");
  assert.deepEqual(seenAllowlist, [...CONSTRAINED_TOOL_EXECUTION_ALLOW]);
  assert.equal(receipt.adapterId, "stella.openclaw-host-bootstrap");
  assert.equal(receipt.businessAdmission, false);
  await admitBusinessCapability({ capabilityId: "host_initialization", receipt, captureBinding: capture, store });
});

test("expanded tool allowlists cannot pass constrained acceptance", async () => {
  const store = createMemoryCapabilityReceiptStore();
  await assert.rejects(acceptHostBootstrapCapability({
    host: host("run_expand"),
    captureBinding: async () => binding(),
    store,
    ports: ports({
      assertConstrainedToolSurface() {
        assertConstrainedToolSurface(["read", "stella_initialize", "exec"]);
      },
    }),
  }), /constrained_acceptance_effect_forbidden/);
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
  assert.deepEqual((await evaluateRuntimeCapabilityBlockers({
    compiledBlockers: compiled, store, receiptIds: [], captureBinding: capture,
  })).blockers, compiled.sort());

  const receipt = await runConstrainedCapabilityAcceptance({
    adapter: createHostBootstrapCapabilityAdapter(ports({
      async verifyInstalledBootstrap() { return { operationId: "init_22222222-2222-4222-8222-222222222222" }; },
    })),
    host: host("run_clear-one"),
    captureBinding: capture,
    store,
  });
  const evaluated = await evaluateRuntimeCapabilityBlockers({
    compiledBlockers: compiled, store, receiptIds: [receipt.id], captureBinding: capture,
  });
  assert.deepEqual(evaluated.blockers, [
    "capability_acceptance_missing:memory_access",
    "full_memory_acceptance_unavailable",
    "skill_capability_unverified:host_initialization",
  ]);
  assert.equal(evaluated.receiptDiagnostics.length, 0);
  await assert.rejects(admitBusinessCapability({
    capabilityId: "memory_access",
    receipt: { ...receipt, capabilityId: "memory_access", host: { ...host(), purpose: { kind: "adapter_verification", capabilityId: "memory_access" } } },
    captureBinding: capture, store,
  }), /untrusted_capability_receipt|capability_purpose_mismatch|invalid_capability_receipt/);
});

test("unusable receipts keep diagnostic categories without clearing blockers", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const capture = async () => binding();
  await store.write("cap_11111111-1111-4111-8111-111111111111", "{not-json");
  const evaluated = await evaluateRuntimeCapabilityBlockers({
    compiledBlockers: ["capability_acceptance_missing:host_initialization"],
    store,
    receiptIds: ["cap_11111111-1111-4111-8111-111111111111"],
    captureBinding: capture,
  });
  assert.deepEqual(evaluated.blockers, ["capability_acceptance_missing:host_initialization"]);
  assert.deepEqual(evaluated.receiptDiagnostics, [
    { id: "cap_11111111-1111-4111-8111-111111111111", category: "invalid_capability_receipt" },
  ]);
});

test("file-backed receipt store survives list/read/invalidate without private fields in locators", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "capability-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileCapabilityReceiptStore(root);
  const receipt = await acceptHostBootstrapCapability({
    host: host("run_file-store"),
    captureBinding: async () => binding(),
    store,
    ports: ports({
      async verifyInstalledBootstrap() { return { operationId: "init_33333333-3333-4333-8333-333333333333" }; },
    }),
  });
  assert.deepEqual(await listCapabilityReceiptIds(root), [receipt.id]);
  assert.ok(!(await store.read(receipt.id))!.includes("/Users/"));
  assert.ok(!(await store.read(receipt.id))!.includes("private"));
});

test("cancelled acceptance leaves no business-admitting receipt", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(acceptHostBootstrapCapability({
    host: host("run_cancel"),
    captureBinding: async () => binding(),
    store,
    ports: ports(),
    signal: aborted.signal,
  }), /operation_cancelled/);
  await assert.rejects(admitBusinessCapability({
    capabilityId: "host_initialization", receipt: null, captureBinding: async () => binding(), store,
  }), /capability_receipt_required/);
  const evaluated = await evaluateRuntimeCapabilityBlockers({
    compiledBlockers: ["capability_acceptance_missing:host_initialization"],
    store, receiptIds: [], captureBinding: async () => binding(),
  });
  assert.deepEqual(evaluated.blockers, ["capability_acceptance_missing:host_initialization"]);
});
