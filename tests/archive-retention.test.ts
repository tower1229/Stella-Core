import assert from "node:assert/strict";
import test from "node:test";
import { inspectArchiveRetention } from "../src/openclaw/archive-retention.js";

test("Host retention fails closed when native maintenance can prune before archive", async () => {
  let reads = 0;
  const result = await inspectArchiveRetention({ hostVersion: "2026.8.2", maintenanceMode: "enforce",
    observe: async () => { reads++; return []; }, archived: async () => new Set<string>() });
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.blockers, ["host_early_cleanup_enabled"]);
  assert.equal(reads, 0);
  assert.equal(result.fullRetention, false);
});

test("maintenance hold preserves lost-original backlog across monitor restart and rejects archive read failures", async () => {
  let remembered: string[] = [];
  const input = { hostVersion: "2026.8.2", maintenanceMode: "warn", previous: remembered,
    remember: async (values: string[]) => { remembered = values; },
    observe: async () => ["first", "second"], archived: async () => new Set(["first"]) };
  const first = await inspectArchiveRetention(input);
  assert.equal(first.state, "held");
  assert.equal(first.observedEvents, 2);
  assert.equal(first.backlogEvents, 1);
  assert.equal(first.originalUnavailableEvents, 0);
  const restarted = await inspectArchiveRetention({ ...input, previous: remembered, observe: async () => ["first"] });
  assert.equal(restarted.backlogEvents, 1);
  assert.equal(restarted.originalUnavailableEvents, 1);
  assert.equal(restarted.fullRetention, false);
  await assert.rejects(inspectArchiveRetention({ ...input, archived: async () => { throw new Error("sync pending"); } }), /sync pending/);
});

test("Host service restart on the same registration resumes continuous archive inspection", { timeout: 5000 }, async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { registerArchiveRetention } = await import("../src/openclaw/archive-retention-registration.js");
  const { CatalogError } = await import("../src/canghai/catalog-reader.js");
  const stateDir = await mkdtemp(join(tmpdir(), "stella-retention-service-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  type Api = import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginApi;
  let service: Parameters<Api["registerService"]>[0] | undefined;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  let completion = deferred();
  let reads = 0;
  const api = { runtime: { version: "2026.8.2", config: { current: () => ({ session: { maintenance: { mode: "warn" }, store: join(stateDir, "sessions", "sessions.json") } }) } },
    registerGatewayMethod() {}, registerService(value: NonNullable<typeof service>) { service = value; } };
  registerArchiveRetention(api as unknown as Api, { agentId: "probe", canghaiRoot: stateDir,
    archiveRetention: "hold_and_monitor", dataMode: "managed_durable_write", durabilityRemote: "origin", durabilityBranch: "main" },
  async () => { reads++; throw new CatalogError("synthetic_archive_unavailable"); });
  assert.ok(service);
  const ctx = { stateDir, serviceHealth: { reportFailure() { completion.resolve(); }, clearFailure() { completion.resolve(); } } } as unknown as Parameters<typeof service.start>[0];
  await service.start(ctx);
  await Promise.race([completion.promise, new Promise<void>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("service did not report status")), 1000); timer.unref(); })]);
  await service.stop?.(ctx);
  assert.equal(reads, 1);
  completion = deferred();
  await service.start(ctx);
  await Promise.race([completion.promise, new Promise<void>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("service did not report status")), 1000); timer.unref(); })]);
  await service.stop?.(ctx);
  assert.equal(reads, 2);
});
