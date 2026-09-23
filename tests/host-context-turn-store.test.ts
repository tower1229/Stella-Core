import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostContextTurnStore, type HostContextTurn } from "../src/openclaw/host-context-turn-store.js";
import { assertMemoryTransactionReadable } from "../src/canghai/memory-transaction.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-context-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const anchor = { agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
    storePath: "/synthetic/transcript.sqlite", generation: "generation", entryId: "user-entry",
    rawSeq: 1, activeMessagePosition: 0, effectiveParentId: null };
  const turn: HostContextTurn = { advancementKey: "accepted-turn", sessionId: anchor.sessionId, sessionKey: anchor.sessionKey,
    admission: { ...anchor, logicalTurnId: "old-run", role: "user" },
    terminal: { ...anchor, entryId: "terminal-entry", rawSeq: 2, activeMessagePosition: 1, effectiveParentId: anchor.entryId },
    messages: [{ role: "user", content: "Original user words", timestamp: 1 }] };
  let writes = 0, confirmations = 0, interrupted = false, authorized = true;
  const create = () => createHostContextTurnStore({ root, archiveRoot: "raw-context", ...anchor,
    async validate() { await assertMemoryTransactionReadable(root); if (!authorized) throw new Error("retention_changed"); },
    durability: {
      async syncCritical() { writes++; if (interrupted) throw new Error("sync_interrupted"); },
      async confirmPreviouslyCommitted() { confirmations++; },
    } });
  return { root, turn, create, counts: () => ({ writes, confirmations }),
    interrupt(value: boolean) { interrupted = value; }, revoke() { authorized = false; } };
}

test("accepted Host turns survive a recreated store and reject advancement-key collisions", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.create()(f.turn), { status: "committed" });
  assert.deepEqual(await f.create()(f.turn), { status: "duplicate" });
  assert.deepEqual(f.counts(), { writes: 1, confirmations: 1 });
  await assert.rejects(f.create()({ ...f.turn, messages: [{ role: "user", content: "Replacement", timestamp: 1 }] }), /transaction_operation_conflict/);
  const files = await readdir(path.join(f.root, "raw-context/turns"));
  const raw = JSON.parse(await readFile(path.join(f.root, "raw-context/turns", files[0]!), "utf8"));
  assert.deepEqual(raw.messages, f.turn.messages);
  assert.equal(raw.schemaVersion, "stella.host-context-turn/v1");
});

test("interrupted Host turn advancement stays fenced and recovers using exactly the original payload", async t => {
  const f = await fixture(t);
  f.interrupt(true);
  await assert.rejects(f.create()(f.turn), /sync_interrupted/);
  await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  await assert.rejects(f.create()({ ...f.turn, advancementKey: "other-turn" }), /memory_transaction_conflict/);
  f.interrupt(false);
  assert.deepEqual(await f.create()(f.turn), { status: "duplicate" });
  await assertMemoryTransactionReadable(f.root);
  assert.deepEqual(f.counts(), { writes: 2, confirmations: 0 });
});

test("replay never conceals lost archive bytes or changed retention", async t => {
  const f = await fixture(t);
  await f.create()(f.turn);
  const file = (await readdir(path.join(f.root, "raw-context/turns")))[0]!;
  await writeFile(path.join(f.root, "raw-context/turns", file), "changed");
  await assert.rejects(f.create()(f.turn), /host_context_archive_changed/);
  await rm(path.join(f.root, "raw-context/turns", file));
  await assert.rejects(f.create()(f.turn), error => error instanceof Error &&
    error.message.includes("host_context_archive_unavailable") && !error.message.includes(f.root));
});

test("completed advancement still revalidates retention", async t => {
  const f = await fixture(t);
  await f.create()(f.turn);
  f.revoke();
  await assert.rejects(f.create()(f.turn), /retention_changed/);
});

test("turn storage rejects another audience, session, and invalid transcript bounds before writing", async t => {
  const f = await fixture(t);
  for (const changed of [
    { ...f.turn, sessionKey: "agent:stella:group" },
    { ...f.turn, admission: { ...f.turn.admission, agentId: "other" } },
    { ...f.turn, terminal: { ...f.turn.terminal, generation: "other" } },
    { ...f.turn, terminal: { ...f.turn.terminal, rawSeq: 0 } },
  ]) await assert.rejects(f.create()(changed), /host_context_(session_mismatch|transcript_anchor_invalid|transcript_range_invalid)/);
  assert.deepEqual(f.counts(), { writes: 0, confirmations: 0 });
});
