import assert from "node:assert/strict";
import test from "node:test";

const { inspectExactHostSourceTransition } = await import(new URL("../../scripts/lib/exact-host-gateway.mjs", import.meta.url).href);
const beforeRevision = "a".repeat(40), afterRevision = "b".repeat(40);

test("source transition inspects initialization only after the live pointer advances", async () => {
  let live = beforeRevision, reads = 0, statusReads = 0;
  const status = await inspectExactHostSourceTransition({ beforeRevision, afterRevision, timeoutMs: 200, intervalMs: 1,
    async readRevision() { if (++reads === 3) live = afterRevision; return live; },
    async readStatus() {
      statusReads++;
      return live === afterRevision ? { state: "ready", runtime: { blockers: ["capability_acceptance_missing:memory_access", "host_memory_consumption_unverifiable"] } }
        : { state: "blocked", category: "source_revision_mismatch" };
    },
  });
  assert.equal(status.state, "ready");
  assert.ok(status.runtime.blockers.includes("capability_acceptance_missing:memory_access"));
  assert.ok(status.runtime.blockers.includes("host_memory_consumption_unverifiable"));
  assert.equal(statusReads, 1);
});

test("source transition rejects malformed or unrelated live pointers", async () => {
  for (const observed of [undefined, "private-invalid-pointer", "c".repeat(40)]) {
    await assert.rejects(inspectExactHostSourceTransition({ beforeRevision, afterRevision, timeoutMs: 20, intervalMs: 1,
      async readRevision() { return observed; }, async readStatus() { throw new Error("Must not inspect an unbound source"); },
    }), /exact_host_source_(?:invalid|changed)/);
  }
});

test("source transition fails explicitly if the committed pointer never becomes live", async () => {
  await assert.rejects(inspectExactHostSourceTransition({ beforeRevision, afterRevision, timeoutMs: 10, intervalMs: 1,
    async readRevision() { return beforeRevision; }, async readStatus() { return { state: "ready" }; },
  }), /exact_host_source_transition_timeout/);
});

test("source transition preserves a genuine initialization failure after pointer convergence", async () => {
  const failed = { state: "blocked", category: "source_revision_mismatch" };
  assert.equal(await inspectExactHostSourceTransition({ beforeRevision, afterRevision,
    async readRevision() { return afterRevision; }, async readStatus() { return failed; },
  }), failed);
});
