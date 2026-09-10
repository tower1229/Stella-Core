import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { canonicalJson } from "../src/canghai/content-version.js";
import {
  ManagedDurableWriteError,
  persistenceStatusFromDiagnostics,
  resolveManagedDurabilityBinding,
  runManagedDurableRecord,
  type ManagedDurabilityBindingInput,
} from "../src/canghai/managed-durable-write.js";
import {
  applyMemoryTransaction,
  assertMemoryTransactionReadable,
  type MemoryTransactionPlan,
} from "../src/canghai/memory-transaction.js";
import type { RuntimeProfile } from "../src/canghai/runtime-profile.js";
import type { StellaConsciousnessManifest } from "../src/canghai/manifest.js";

const execFileAsync = promisify(execFile);

async function gitRepo(): Promise<{ root: string; remote: string; branch: string; revision: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-managed-durable-"));
  const root = path.join(parent, "work");
  const remote = path.join(parent, "remote.git");
  const branch = "stella-alpha";
  await execFileAsync("git", ["init", "--bare", "--quiet", remote]);
  await execFileAsync("git", ["init", "--quiet", "-b", branch, root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  await execFileAsync("git", ["-C", root, "remote", "add", "origin", remote]);
  await writeFile(path.join(root, "catalog.json"), canonicalJson({
    schemaVersion: "stella.memory-catalog/v1", generationId: "gen-0", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [],
  }));
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  await execFileAsync("git", ["-C", root, "push", "--quiet", "-u", "origin", branch]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return { root, remote, branch, revision: stdout.trim() };
}

function profile(archiveMaxRpoSeconds = 300): RuntimeProfile {
  return {
    schema_version: "stella.runtime-profile/v1",
    contract_profile: "full_memory",
    agent_id: "main",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    models: {
      main: { provider: "synthetic", model: "main", required_capabilities: ["memory_lifecycle"] },
      router: { provider: "synthetic", model: "router", required_capabilities: ["memory_lifecycle"] },
      learning: { provider: "synthetic", model: "learning", required_capabilities: ["memory_lifecycle"] },
      framework_compiler: { provider: "synthetic", model: "framework", required_capabilities: ["memory_lifecycle"] },
    },
    capabilities: [{
      id: "memory_lifecycle", required: true, adapter_id: "stella.memory-lifecycle", adapter_version: "1",
      config_ref: "path:50_PersonalAgent/stella/memory-runtime.json",
      acceptance_ref: "path:50_PersonalAgent/stella/acceptance/memory-lifecycle.json",
      required_secret_refs: ["path:50_PersonalAgent/stella/secrets/host-token.ref"],
    }],
    source_policies_ref: "path:50_PersonalAgent/stella/source-policies.yaml",
    memory: {
      catalog_ref: "path:catalog.json",
      semantic_provider: "stella-structured-llm",
      required_views: ["current_understanding", "ongoing_work"],
      archive_max_rpo_seconds: archiveMaxRpoSeconds,
    },
    autonomy: {
      research_enabled: false,
      proactive_delivery_enabled: false,
      delivery_policy_ref: "path:50_PersonalAgent/stella/delivery-policy.yaml",
      delegation_registry_ref: "path:50_PersonalAgent/stella/delegations.yaml",
    },
  };
}

function manifest(maxNormalRpoSeconds = 300): StellaConsciousnessManifest {
  return {
    schemaVersion: "stella.consciousness-manifest/v1",
    sourceBaseline: { repository: "tower1229/CangHai", commit: "1".repeat(40) },
    instance: { id: "stella", ownerRef: "path:owner.yaml" },
    compatibility: { stellaCore: ">=3.0.0-alpha <4.0.0", openclaw: ">=2026.8.1", modelPolicyRef: "path:policy.json" },
    identity: { soulRef: "path:SOUL.md", runtimeProfileRef: "path:profile.yaml" },
    twin: { hypothesisRegistryRef: "path:twin.yaml" },
    frameworks: { sourceRegistryRef: "path:fw-source.yaml", activeIrRegistryRef: "path:fw-ir.yaml" },
    praxis: { episodeRootRef: "path:episodes", playbookRegistryRef: "path:playbook.yaml" },
    experience: { corpusRegistryRef: "path:corpus.yaml" },
    derived: { rebuild: [] },
    runtimeState: { activationStatus: "active" },
    durability: {
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds,
    },
    secrets: { refs: ["path:50_PersonalAgent/stella/secrets/host-token.ref"] },
  } as StellaConsciousnessManifest;
}

function bindingInput(overrides: Partial<ManagedDurabilityBindingInput> = {}): ManagedDurabilityBindingInput {
  return {
    dataMode: "managed_durable_write",
    durabilityRemote: "origin",
    durabilityBranch: "stella-alpha",
    agentId: "main",
    recoveryRevision: "a".repeat(40),
    manifest: manifest(),
    profile: profile(),
    ...overrides,
  };
}

test("managed binding requires complete durable write config and binds archive_max_rpo_seconds", () => {
  const binding = resolveManagedDurabilityBinding(bindingInput());
  assert.equal(binding.maxNormalRpoSeconds, 300);
  assert.equal(binding.archiveMaxRpoSeconds, 300);
  assert.equal(binding.criticalWritePolicy, "sync_immediately");
  assert.equal(binding.normalWritePolicy, "bounded_batch");
  assert.deepEqual(binding.operatorIdentity, { agentId: "main", recoveryRevision: "a".repeat(40) });
  assert.deepEqual(binding.secretRefs, ["path:50_PersonalAgent/stella/secrets/host-token.ref"]);
});

test("managed binding rejects RPO that quietly exceeds the declared archive_max_rpo_seconds", () => {
  assert.throws(
    () => resolveManagedDurabilityBinding(bindingInput({
      manifest: manifest(600),
      profile: profile(300),
    })),
    (error: unknown) => error instanceof ManagedDurableWriteError && error.category === "archive_rpo_exceeded",
  );
  const tighter = resolveManagedDurabilityBinding(bindingInput({
    manifest: manifest(100),
    profile: profile(300),
  }));
  assert.equal(tighter.maxNormalRpoSeconds, 100);
  assert.equal(tighter.archiveMaxRpoSeconds, 300);
});

test("managed binding keeps secret refs only and rejects credential material payloads", () => {
  const binding = resolveManagedDurabilityBinding(bindingInput());
  assert.ok(binding.secretRefs.every((ref) => ref.startsWith("path:")));
  assert.throws(
    () => resolveManagedDurabilityBinding(bindingInput({
      materialPreview: { token: "sk-live-secret-value", note: "must not land in archive" },
    })),
    (error: unknown) => error instanceof ManagedDurableWriteError && error.category === "credentials_in_materials",
  );
});

test("diagnostics map critical success to synchronized and normal pending to remote_pending", () => {
  assert.equal(persistenceStatusFromDiagnostics({
    criticalWritePolicy: "sync_immediately",
    criticalSynchronized: true,
    normalWritePolicy: "bounded_batch",
    maxNormalRpoSeconds: 300,
    observedNormalRpoSeconds: 0,
    normalState: "current",
    localRevision: "b".repeat(40),
    synchronizedRevision: "b".repeat(40),
  }, "critical"), "synchronized");
  assert.equal(persistenceStatusFromDiagnostics({
    criticalWritePolicy: "sync_immediately",
    criticalSynchronized: true,
    normalWritePolicy: "bounded_batch",
    maxNormalRpoSeconds: 300,
    observedNormalRpoSeconds: 12,
    normalState: "pending",
    localRevision: "c".repeat(40),
    synchronizedRevision: "b".repeat(40),
  }, "normal"), "remote_pending");
  assert.throws(
    () => persistenceStatusFromDiagnostics({
      criticalWritePolicy: "sync_immediately",
      criticalSynchronized: true,
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
      observedNormalRpoSeconds: 301,
      normalState: "breached",
      localRevision: "c".repeat(40),
      synchronizedRevision: "b".repeat(40),
    }, "normal"),
    (error: unknown) => error instanceof ManagedDurableWriteError && error.category === "archive_rpo_breached",
  );
  assert.throws(
    () => persistenceStatusFromDiagnostics({
      criticalWritePolicy: "sync_immediately",
      criticalSynchronized: false,
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
      observedNormalRpoSeconds: 0,
      normalState: "current",
      localRevision: "d".repeat(40),
      lastErrorCategory: "stella_critical_sync_failed",
    }, "critical"),
    (error: unknown) => error instanceof ManagedDurableWriteError && error.category === "critical_sync_failed",
  );
});

test("authorized record survives scoped commit, pointer CAS, sync, read and restart with stable operator identity", async () => {
  const { root, branch, revision } = await gitRepo();
  try {
    const binding = resolveManagedDurabilityBinding(bindingInput({
      durabilityBranch: branch,
      recoveryRevision: revision,
      agentId: "main",
    }));
    const stages: string[] = [];
    const first = await runManagedDurableRecord({
      binding,
      root,
      priority: "critical",
      operationId: "record-owner-1",
      message: "owner explicit record",
      paths: ["records/owner-1.json"],
      writeFiles: { "records/owner-1.json": canonicalJson({
        schemaVersion: "stella.synthetic-record/v1",
        id: "owner-1",
        operatorAgentId: "main",
        body: "explicit owner note",
      }) },
      onStage: async (stage) => { stages.push(stage); },
    });
    assert.deepEqual(stages, ["commit", "recovery_pointer_cas", "synchronize", "view_publish"]);
    assert.equal(first.persistenceStatus, "synchronized");
    assert.equal(first.operatorIdentity.agentId, "main");
    assert.equal(first.operatorIdentity.recoveryRevision, first.observedRevision);

    const restarted = await runManagedDurableRecord({
      binding: { ...binding, operatorIdentity: { ...binding.operatorIdentity, recoveryRevision: first.observedRevision } },
      root,
      priority: "critical",
      operationId: "record-owner-1",
      message: "owner explicit record",
      paths: ["records/owner-1.json"],
      writeFiles: {},
      onStage: async () => {},
    });
    assert.equal(restarted.replayed, true);
    assert.equal(restarted.persistenceStatus, "synchronized");
    assert.equal(restarted.observedRevision, first.observedRevision);
    assert.equal(JSON.parse(await readFile(path.join(root, "records/owner-1.json"), "utf8")).operatorAgentId, "main");
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test("normal updates report remote_pending within the declared archive_max_rpo_seconds", async () => {
  const { root, branch, revision } = await gitRepo();
  let now = Date.now();
  try {
    const binding = resolveManagedDurabilityBinding(bindingInput({
      durabilityBranch: branch,
      recoveryRevision: revision,
    }));
    const pending = await runManagedDurableRecord({
      binding,
      root,
      priority: "normal",
      operationId: "learn-1",
      message: "ordinary learning",
      paths: ["records/learn-1.json"],
      writeFiles: { "records/learn-1.json": '{"id":"learn-1"}\n' },
      now: () => now,
      schedule() {},
      onStage: async () => {},
    });
    assert.equal(pending.persistenceStatus, "remote_pending");
    assert.equal(pending.diagnostics.normalState, "pending");
    assert.equal(pending.diagnostics.maxNormalRpoSeconds, binding.archiveMaxRpoSeconds);
    assert.ok(pending.diagnostics.observedNormalRpoSeconds <= binding.archiveMaxRpoSeconds);
    now += 120_000;
    assert.ok((await pending.refresh()).observedNormalRpoSeconds <= binding.archiveMaxRpoSeconds);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test("critical sync failure does not report completion", async () => {
  const { root, branch, revision } = await gitRepo();
  try {
    const binding = resolveManagedDurabilityBinding(bindingInput({
      durabilityBranch: branch,
      recoveryRevision: revision,
    }));
    await assert.rejects(runManagedDurableRecord({
      binding,
      root,
      priority: "critical",
      operationId: "critical-fail",
      message: "must not complete",
      paths: ["records/critical-fail.json"],
      writeFiles: { "records/critical-fail.json": '{"id":"critical-fail"}\n' },
      onStage: async (stage) => {
        if (stage === "synchronize") throw new Error("synthetic remote unavailable");
      },
    }), (error: unknown) => error instanceof ManagedDurableWriteError && error.category === "critical_sync_failed");
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test("faults at commit, CAS, sync and view publish recover without overwrite or duplicate learning", async () => {
  for (const stage of ["commit", "recovery_pointer_cas", "synchronize", "view_publish"] as const) {
    const { root, branch, revision } = await gitRepo();
    try {
      const binding = resolveManagedDurabilityBinding(bindingInput({
        durabilityBranch: branch,
        recoveryRevision: revision,
      }));
      const catalogBefore = await readFile(path.join(root, "catalog.json"), "utf8");
      const afterCatalog = canonicalJson({
        ...JSON.parse(catalogBefore),
        generationId: `gen-${stage}`,
        parentGenerationId: "gen-0",
      });
      const plan: MemoryTransactionPlan = {
        operationId: `learn_fault_${stage}`,
        journalPath: `operations/learn_fault_${stage}.json`,
        files: [
          { path: "learning/change.json", before: null, after: canonicalJson({ id: "change-1", learning: "once" }) },
          { path: "catalog.json", before: catalogBefore, after: afterCatalog },
        ],
      };

      let attempts = 0;
      await assert.rejects(runManagedDurableRecord({
        binding,
        root,
        priority: "critical",
        operationId: plan.operationId,
        message: `${plan.operationId}: fault at ${stage}`,
        paths: [...plan.files.map((file) => file.path), plan.journalPath],
        transaction: plan,
        onStage: async (current) => {
          if (current === stage && attempts++ === 0) throw new Error(`synthetic ${stage} failure`);
        },
      }), new RegExp(`synthetic ${stage} failure|critical_sync_failed|view_publish_failed|commit_failed|pointer_conflict`));

      if (stage === "view_publish") {
        const reader = await CatalogReader.load(root, "catalog.json");
        await assert.rejects(reader.assertCurrent(), /memory_transaction_pending/);
      }

      const recovered = await runManagedDurableRecord({
        binding: {
          ...binding,
          operatorIdentity: {
            ...binding.operatorIdentity,
            recoveryRevision: (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(),
          },
        },
        root,
        priority: "critical",
        operationId: plan.operationId,
        message: `${plan.operationId}: fault at ${stage}`,
        paths: [...plan.files.map((file) => file.path), plan.journalPath],
        transaction: plan,
        onStage: async () => {},
      });
      assert.equal(recovered.persistenceStatus, "synchronized");
      await assertMemoryTransactionReadable(root);
      const learning = JSON.parse(await readFile(path.join(root, "learning/change.json"), "utf8"));
      assert.equal(learning.id, "change-1");
      assert.equal(learning.learning, "once");
      const { stdout: log } = await execFileAsync("git", [
        "-C", root, "log", "--grep", plan.operationId, "--format=%H",
      ]);
      assert.equal(log.trim().split("\n").filter(Boolean).length, 1);

      await assert.rejects(applyMemoryTransaction(root, {
        ...plan,
        operationId: `${plan.operationId}_overwrite`,
        journalPath: `operations/${plan.operationId}_overwrite.json`,
        files: [{
          path: "learning/change.json",
          before: null,
          after: canonicalJson({ id: "change-1", learning: "duplicate" }),
        }],
      }, {
        async validate() {},
        async persist() { assert.fail("must not overwrite concurrent material"); },
        async confirmPreviouslyCommitted() {},
      }), /transaction_version_conflict/);
    } finally {
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }
});
