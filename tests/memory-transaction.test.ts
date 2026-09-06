import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { canonicalJson } from "../src/canghai/content-version.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable, withMemoryMutationLock, type MemoryTransactionPlan } from "../src/canghai/memory-transaction.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-memory-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "before", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  const before = canonicalJson(catalog);
  const after = canonicalJson({ ...catalog, generationId: "after", parentGenerationId: "before" });
  await writeFile(path.join(root, "catalog.json"), before);
  const plan: MemoryTransactionPlan = { operationId: "outcome-test", journalPath: "operations/outcome-test.json", files: [
    { path: "learning/change.json", before: null, after: '{"synthetic":"learning"}' },
    { path: "episodes/closed.json", before: null, after: '{"synthetic":"closed"}' },
    { path: "catalog.json", before, after },
  ] };
  return { root, plan };
}

test("failed multi-file publication stays unreadable until exact retry synchronizes it", async (t) => {
  const { root, plan } = await fixture(t);
  let attempts = 0;
  const ports = {
    async validate() { await assertMemoryTransactionReadable(root); },
    async persist(paths: string[]) {
      attempts++;
      assert.deepEqual(paths, [...plan.files.map((file) => file.path), plan.journalPath]);
      if (attempts === 1) throw new Error("Synthetic remote failure");
    },
    async confirmPreviouslyCommitted() { assert.fail("Pending publication requires persistence retry"); },
  };
  await assert.rejects(applyMemoryTransaction(root, plan, ports), /Synthetic remote failure/);
  assert.equal(await readFile(path.join(root, "episodes/closed.json"), "utf8"), plan.files[1]!.after);
  const reader = await CatalogReader.load(root, "catalog.json");
  await assert.rejects(reader.assertCurrent(), /memory_transaction_pending/);
  await assert.rejects(withMemoryMutationLock(root, async () => {}), /memory_transaction_pending/);
  await assert.rejects(applyMemoryTransaction(root, { ...plan, operationId: "other-operation" }, ports), /memory_transaction_conflict/);
  assert.equal((await applyMemoryTransaction(root, plan, ports)).replayed, true);
  await reader.assertCurrent();
  assert.equal(attempts, 2);
  let confirmed = 0;
  await applyMemoryTransaction(root, plan, { ...ports, async confirmPreviouslyCommitted(file) { confirmed++; assert.equal(file, plan.journalPath); } });
  assert.equal(confirmed, 1);
  assert.equal(attempts, 2);
});

test("a validation failure before publication releases the fence and preserves all original bytes", async (t) => {
  const { root, plan } = await fixture(t);
  await assert.rejects(applyMemoryTransaction(root, plan, {
    async validate() { throw new Error("Synthetic invalid evidence"); },
    async persist() { assert.fail("Invalid plan must not commit"); }, async confirmPreviouslyCommitted() {},
  }), /Synthetic invalid evidence/);
  await assertMemoryTransactionReadable(root);
  assert.equal(await readFile(path.join(root, "catalog.json"), "utf8"), plan.files[2]!.before);
  await assert.rejects(readFile(path.join(root, "episodes/closed.json")), { code: "ENOENT" });
});

test("concurrent publications and ordinary mutations cannot cross the transaction fence", async (t) => {
  const { root, plan } = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const ports = { async validate() {}, async persist() { started(); await blocked; }, async confirmPreviouslyCommitted() {} };
  const pending = applyMemoryTransaction(root, plan, ports);
  await entered;
  try {
    await assert.rejects(applyMemoryTransaction(root, plan, ports), /memory_transaction_in_progress/);
    await assert.rejects(withMemoryMutationLock(root, async () => {}), /memory_transaction_pending/);
  } finally { release(); }
  await pending;
  await withMemoryMutationLock(root, async () => {});
});

test("file CAS and reserved transaction paths fail without publishing", async (t) => {
  const { root, plan } = await fixture(t);
  const ports = { async validate() {}, async persist() { assert.fail("Must not publish"); }, async confirmPreviouslyCommitted() {} };
  await assert.rejects(applyMemoryTransaction(root, { ...plan, files: [{ path: "catalog.json", before: "wrong", after: "wrong" }] }, ports), /transaction_version_conflict/);
  for (const file of ["../escape", ".git/config", ".stella-memory-transaction.json.lock"]) {
    await assert.rejects(applyMemoryTransaction(root, { ...plan, files: [{ path: file, before: null, after: "unsafe" }] }, ports), /unsafe_transaction_path|transaction_path_collision/);
  }
  await assertMemoryTransactionReadable(root);
});

test("one Git commit contains the full transaction and pointer failure retries without another commit", async (t) => {
  const { root, plan } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "stella-transaction-remote-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const run = promisify(execFile);
  const remote = path.join(external, "remote.git");
  await run("git", ["init", "--quiet", "--initial-branch=main", root]);
  await run("git", ["-C", root, "config", "user.name", "Synthetic Test"]);
  await run("git", ["-C", root, "config", "user.email", "synthetic@example.invalid"]);
  await run("git", ["-C", root, "add", "catalog.json"]);
  await run("git", ["-C", root, "commit", "--quiet", "-m", "Synthetic baseline"]);
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["-C", root, "remote", "add", "origin", remote]);
  await run("git", ["-C", root, "push", "origin", "main"]);
  const initial = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const pointer = path.join(external, "pointer.txt");
  await writeFile(pointer, initial);
  let fail = true;
  const durability = new GitCangHaiDurability({ root, remote: "origin", branch: "main", criticalWritePolicy: "sync_immediately",
    normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
    onRevision: async (revision) => { if (fail) throw new Error("Synthetic pointer failure"); await writeFile(pointer, revision); } });
  const ports = { async validate() {}, async persist(paths: string[], id: string) { await durability.syncCritical(paths, `transaction ${id}`); },
    confirmPreviouslyCommitted: (file: string) => durability.confirmPreviouslyCommitted(file) };
  await assert.rejects(applyMemoryTransaction(root, plan, ports), /Synthetic pointer failure/);
  await assert.rejects(assertMemoryTransactionReadable(root), /memory_transaction_pending/);
  assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), initial);
  const committed = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(committed, initial);
  fail = false;
  await applyMemoryTransaction(root, plan, ports);
  await applyMemoryTransaction(root, plan, ports);
  assert.equal((await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(), committed);
  assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), committed);
  assert.equal(await readFile(pointer, "utf8"), committed);
  assert.equal((await run("git", ["-C", root, "status", "--porcelain"])).stdout.trim(), "");
  const clone = path.join(external, "restored");
  await run("git", ["clone", "--quiet", "--branch", "main", remote, clone]);
  for (const file of plan.files) assert.equal(await readFile(path.join(clone, file.path), "utf8"), file.after);
  await (await CatalogReader.load(clone, "catalog.json")).assertCurrent();
});

test("a killed process leaves its transaction fenced but the exact intent can reclaim the dead owner's lock", { timeout: 30_000 }, async (t) => {
  const { root, plan } = await fixture(t);
  const moduleUrl = new URL("../src/canghai/memory-transaction.js", import.meta.url).href;
  const code = `import { applyMemoryTransaction } from ${JSON.stringify(moduleUrl)};
    await applyMemoryTransaction(${JSON.stringify(root)}, ${JSON.stringify(plan)}, {
      async validate() {}, async confirmPreviouslyCommitted() {},
      async persist() { setInterval(() => {}, 1000); process.stdout.write('LOCK_READY\\n'); await new Promise(() => {}); }
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic child lock acquisition timed out")), 15_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("LOCK_READY")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Synthetic child exited before lock admission")); });
  });
  const lockFile = path.join(root, ".stella-memory-transaction.json.lock");
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).pid, child.pid);
  const ports = { async validate() {}, async persist() {}, async confirmPreviouslyCommitted() {} };
  await assert.rejects(applyMemoryTransaction(root, plan, ports), /memory_transaction_in_progress/);
  child.kill("SIGKILL");
  await exited;
  await assert.rejects(assertMemoryTransactionReadable(root), /memory_transaction_pending/);
  assert.equal((await applyMemoryTransaction(root, plan, ports)).replayed, true);
  await assertMemoryTransactionReadable(root);
  await assert.rejects(readFile(lockFile), { code: "ENOENT" });
});

test("expired timestamps never authorize stealing a live or unknown owner's lock", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, ".stella-memory-transaction.json.lock");
  for (const owner of [{ pid: process.pid, createdAt: "1900-01-01T00:00:00Z" }, { createdAt: "1900-01-01T00:00:00Z" }]) {
    const bytes = JSON.stringify(owner);
    await writeFile(file, bytes);
    await assert.rejects(withMemoryMutationLock(root, async () => { assert.fail("Unproven owner death must not admit a writer"); }),
      /memory_transaction_in_progress/);
    assert.equal(await readFile(file, "utf8"), bytes);
  }
});
