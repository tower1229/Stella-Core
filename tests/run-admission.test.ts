import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { bytesVersion } from "../src/canghai/content-version.js";
import {
  assertHostProfileIsolated,
  isolateHostProfile,
  releaseHostProfileIsolation,
  type HostAdmissionIsolationPorts,
} from "../src/openclaw/host-admission-isolation.js";
import { StellaInitializer, type InitializationPorts, type Materialization } from "../src/openclaw/initialization.js";
import { coordinateCompletion, CompletionError, completionDraftHash } from "../src/openclaw/completion.js";

const exec = promisify(execFile);

async function initFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-run-admission-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  await Promise.all([mkdir(source), mkdir(workspace), mkdir(state)]);
  const files: Materialization["files"] = [];
  for (const target of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "skills/stella-test/SKILL.md"]) {
    const content = target.endsWith("SKILL.md")
      ? "---\nname: stella-test\ndescription: Synthetic test\n---\nTest only.\n"
      : `# Synthetic ${target}\n`;
    const name = `${files.length}.txt`;
    await writeFile(path.join(source, name), content);
    files.push({ target, source: name, sha256: bytesVersion(content), executable: false });
  }
  await writeFile(path.join(source, "recipe.json"), JSON.stringify({
    schemaVersion: "stella.host-files/v1", agentId: "stella", hostVersion: "2026.8.2", files, skills: ["stella-test"],
  }));
  const git = async (args: string[]) => (await exec("git", ["-c", "core.fsmonitor=false", "-C", source, ...args])).stdout.trim();
  await git(["init"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Synthetic"]);
  let fenced = false;
  const ports: InitializationPorts = {
    fence: async () => { fenced = true; },
    verify: async () => undefined,
    release: async () => { fenced = false; },
  };
  const config = {
    root: source, revision: await git(["rev-parse", "HEAD"]), recipePath: "recipe.json",
    agentId: "stella", hostVersion: "2026.8.2",
  };
  return {
    workspace, state, ports, fenced: () => fenced, config,
    initializer: new StellaInitializer(workspace, state, config, ports),
    withSignal(signal: AbortSignal) {
      return new StellaInitializer(workspace, state, config, ports, signal);
    },
  };
}

test("retained revoke still works after registration shutdown abort", async (t) => {
  const f = await initFixture(t);
  const shutdown = new AbortController();
  const initializer = f.withSignal(shutdown.signal);
  await initializer.initialize();
  await initializer.bindRun("run-live");
  await initializer.bindRun("run-sibling");
  shutdown.abort();
  await initializer.revokeActiveRuns("correction_applied", { retainRunId: "run-live" });
  await initializer.assertRun("run-live");
  await assert.rejects(initializer.assertRun("run-sibling"), /stale_initialization_run/);
});

test("correction and capability revoke invalidate old runs; retained run can finish, late persist cannot", async (t) => {
  const f = await initFixture(t);
  await f.initializer.initialize();
  await f.initializer.bindRun("run-old");
  await f.initializer.assertRun("run-old");

  await f.initializer.revokeActiveRuns("correction_applied");
  await assert.rejects(f.initializer.assertRun("run-old"), /stale_initialization_run/);

  await f.initializer.bindRun("run-current");
  await f.initializer.revokeActiveRuns("capability_invalidated");
  await assert.rejects(f.initializer.assertRun("run-current"), /stale_initialization_run/);

  await f.initializer.bindRun("run-retained");
  await f.initializer.revokeActiveRuns("correction_applied", { retainRunId: "run-retained" });
  await f.initializer.assertRun("run-retained");

  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let enteredPersist!: () => void;
  const sawPersist = new Promise<void>((resolve) => { enteredPersist = resolve; });
  const delayed = coordinateCompletion({
    operationId: "op-late",
    runId: "run-late",
    timeoutMs: 5000,
  }, {
    async generateDraft() {
      await f.initializer.bindRun("run-late");
      events.push("generate");
      return {
        draftId: "draft-late", text: "Synthetic late draft", evidenceRef: "bundle-late",
        responseKind: "answer", requiresCriticalPersistence: true,
      };
    },
    async persist({ draft }) {
      enteredPersist();
      await blocked;
      await f.initializer.assertRun("run-late");
      events.push("persist");
      return {
        schemaVersion: "stella.completion-receipt/v1",
        operationId: "op-late",
        draftId: draft.draftId,
        draftHash: completionDraftHash(draft.text),
        responseKind: draft.responseKind,
        evidenceRef: draft.evidenceRef,
        writeOperationIds: ["write-late"],
        observedRevision: "a".repeat(40),
        generationId: "generation-late",
        persistenceStatus: "synchronized",
        checkedAt: "2026-09-10T00:00:00Z",
      };
    },
    async publishFinal() {
      events.push("publish");
      return { deliveryId: "delivery-late", status: "confirmed" };
    },
  });
  await sawPersist;
  await f.initializer.revokeActiveRuns("initialization_fence");
  release();
  await assert.rejects(delayed, (error: unknown) =>
    error instanceof CompletionError || (error instanceof Error && /stale_initialization_run/.test(String(error))));
  assert.equal(events.includes("publish"), false);
});

test("cancelled completion and revoked admission both prevent late persist without silent success", async (t) => {
  const f = await initFixture(t);
  await f.initializer.initialize();
  const controller = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const events: string[] = [];
  const pending = coordinateCompletion({
    operationId: "op-cancel-late",
    runId: "run-cancel-late",
    timeoutMs: 5000,
    abortSignal: controller.signal,
  }, {
    async generateDraft() {
      await f.initializer.bindRun("run-cancel-late");
      entered();
      await blocked;
      events.push("generate");
      return {
        draftId: "draft-cancel", text: "late", evidenceRef: "bundle",
        responseKind: "answer", requiresCriticalPersistence: false,
      };
    },
    async persist() {
      events.push("persist");
      throw new Error("Must not persist after cancel");
    },
    async publishFinal() {
      events.push("publish");
      throw new Error("Must not publish after cancel");
    },
  });
  await started;
  controller.abort();
  release();
  await assert.rejects(pending, CompletionError);
  assert.equal(events.includes("persist"), false);
  assert.equal(events.includes("publish"), false);
  await f.initializer.revokeActiveRuns("cancelled_turn");
  await assert.rejects(f.initializer.assertRun("run-cancel-late"), /stale_initialization_run/);
});

test("re-initialization that fences invalidates previously bound runs; idempotent verify does not", async (t) => {
  const f = await initFixture(t);
  await f.initializer.initialize();
  await f.initializer.bindRun("run-before-reinit");
  await f.initializer.assertRun("run-before-reinit");
  // Content-identical re-check keeps the projection and does not retire live permits.
  await f.initializer.initialize();
  await f.initializer.assertRun("run-before-reinit");
  // Explicit maintenance revoke (correction/capability/init fence) retires old permits.
  await f.initializer.revokeActiveRuns("initialization_fence");
  await assert.rejects(f.initializer.assertRun("run-before-reinit"), /stale_initialization_run/);
  await f.initializer.bindRun("run-after-reinit");
  await f.initializer.assertRun("run-after-reinit");
});

test("rollback keeps durable fence across restart and rejects cron-style bind while pending", async (t) => {
  const f = await initFixture(t);
  const receipt = await f.initializer.initialize();
  await f.initializer.bindRun("run-before-fence");
  await f.initializer.rollback(receipt.operationId);
  assert.equal(f.fenced(), true);
  await assert.rejects(f.initializer.assertCurrent(), /initialization_pending/);
  await assert.rejects(f.initializer.assertRun("run-before-fence"), /initialization_pending|stale_initialization_run/);
  await assert.rejects(f.initializer.bindRun("cron-wake"), /initialization_pending/);

  const restarted = new StellaInitializer(f.workspace, f.state, f.config, f.ports);
  await assert.rejects(restarted.assertCurrent(), /initialization_pending/);
  await assert.rejects(restarted.bindRun("cron-after-restart"), /initialization_pending/);
});

test("Host-layer isolation blocks a full profile without plugin hooks, prompt text, or Host private DB edits", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-host-isolation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentId = "stella";
  let config: {
    agents: { entries: Record<string, { tools?: { deny?: string[]; allow?: string[] }; identity?: { name: string } }> };
    bindings?: Array<{ agentId: string; match: { channel: string } }>;
  } = {
    agents: {
      entries: {
        stella: { tools: { allow: ["read"] }, identity: { name: "Synthetic Stella" } },
        other: { identity: { name: "Keep" } },
      },
    },
    bindings: [
      { agentId: "stella", match: { channel: "cron" } },
      { agentId: "other", match: { channel: "cron" } },
    ],
  };
  const journal: unknown[] = [];
  let delayIsolationVisibility = true;
  const ports: HostAdmissionIsolationPorts = {
    readConfig: () => structuredClone(config),
    async mutateConfig(mutate) {
      const draft = structuredClone(config);
      mutate(draft);
      journal.push(structuredClone(draft));
      if (delayIsolationVisibility) {
        delayIsolationVisibility = false;
        setTimeout(() => { config = draft; }, 150);
        return;
      }
      config = draft;
    },
  };

  assert.throws(() => assertHostProfileIsolated(config, agentId), /host_profile_not_isolated/);
  await isolateHostProfile(ports, agentId, "plugin_start_failed", root);
  assertHostProfileIsolated(config, agentId);
  assert.deepEqual(config.agents.entries.stella?.tools?.deny, ["*"]);
  assert.equal(config.agents.entries.other?.identity?.name, "Keep");
  assert.ok(!config.bindings?.some((row) => row.agentId === "stella"));
  assert.ok(config.bindings?.some((row) => row.agentId === "other"));
  // Plugin hooks are not registered: isolation is observed only from Host config.
  assertHostProfileIsolated(ports.readConfig(), agentId);
  // Simulate plugin unload: no hooks, read-only Host config still proves isolation.
  assertHostProfileIsolated(structuredClone(config), agentId);

  await releaseHostProfileIsolation(ports, agentId, root);
  assert.throws(() => assertHostProfileIsolated(config, agentId), /host_profile_not_isolated/);
  assert.deepEqual(config.agents.entries.stella?.tools?.allow, ["read"]);
  assert.ok(config.bindings?.some((row) => row.agentId === "stella" && row.match.channel === "cron"));
  assert.ok(!JSON.stringify(journal).includes("AGENTS.md"));
  assert.ok(!JSON.stringify(journal).includes("sqlite"));
});
