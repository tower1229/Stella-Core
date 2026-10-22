import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/canghai/content-version.js";
import { createLegacyRecoveryAuthority, RecoveryBoundLoader } from "../src/canghai/recovery-bound-loader.js";
import { RecoveryAuthorityError, type RecoveryAuthorityResolver, type RecoveryAuthoritySnapshot } from "../src/canghai/recovery-authority-contract.js";
import { ConsciousnessLoader } from "../src/openclaw/consciousness-loader.js";

const revisionA = "a".repeat(40), revisionB = "b".repeat(40);
const binding = { agentId: "synthetic-agent", repositoryRoot: "/synthetic/canghai", manifestPath: "memory-manifest.json" };
function snapshot(revision = revisionA, token = "token-A"): RecoveryAuthoritySnapshot {
  return { mode: "core_checkpoint", binding: { ...binding }, revision, token };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function hasCategory(category: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RecoveryAuthorityError);
    assert.equal(error.category, category);
    return true;
  };
}
/** This synthetic port neither opens a store nor invokes a Host or mutation lock. */
function authority(initial = snapshot()) {
  let current = initial, reads = 0, checks = 0;
  let readFailure: Error | undefined, assertionFailure: Error | undefined;
  const port: RecoveryAuthorityResolver = {
    mode: "core_checkpoint",
    async read() { reads++; if (readFailure) throw readFailure; return current; },
    async assertCurrent(expected) {
      checks++;
      if (assertionFailure) throw assertionFailure;
      if (canonicalJson(expected) !== canonicalJson(current)) throw new RecoveryAuthorityError("recovery_authority_changed");
    },
  };
  return { port, set(value: RecoveryAuthoritySnapshot) { current = value; },
    failRead(error?: Error) { readFailure = error; }, failAssertion(error?: Error) { assertionFailure = error; },
    counts: () => ({ reads, checks }) };
}

test("late A rejects after B succeeds and cannot pollute or clear B's cache", async () => {
  const f = authority(), entered = deferred<void>(), late = deferred<string>();
  const seen: string[] = [];
  const loader = new RecoveryBoundLoader({ authority: f.port, async load(source) {
    seen.push(source.token);
    if (source.token === "token-A") { entered.resolve(undefined); return late.promise; }
    return "loaded-B";
  } });
  const old = assert.rejects(loader.load(), hasCategory("recovery_authority_changed"));
  await entered.promise;
  f.set(snapshot(revisionB, "token-B"));
  assert.equal(await loader.load(), "loaded-B");
  late.resolve("late-A"); await old;
  assert.equal(await loader.load(), "loaded-B");
  assert.deepEqual(seen, ["token-A", "token-B"]);
});

test("late A cleanup cannot remove a newer B inflight entry", async () => {
  const f = authority(), aEntered = deferred<void>(), bEntered = deferred<void>();
  const a = deferred<string>(), b = deferred<string>();
  let loads = 0;
  const loader = new RecoveryBoundLoader({ authority: f.port, async load(source) {
    loads++;
    if (source.token === "token-A") { aEntered.resolve(undefined); return a.promise; }
    bEntered.resolve(undefined); return b.promise;
  } });
  const old = assert.rejects(loader.load(), hasCategory("recovery_authority_changed"));
  await aEntered.promise; f.set(snapshot(revisionB, "token-B"));
  const firstB = loader.load(); await bEntered.promise;
  a.resolve("late-A"); await old;
  const secondB = loader.load(); b.resolve("loaded-B");
  assert.deepEqual(await Promise.all([firstB, secondB]), ["loaded-B", "loaded-B"]);
  assert.equal(loads, 2);
});

test("same revision with a new token requires a new load", async () => {
  const f = authority(); let loads = 0;
  const loader = new RecoveryBoundLoader({ authority: f.port, async load(source) { loads++; return source.token; } });
  assert.equal(await loader.load(), "token-A");
  f.set(snapshot(revisionA, "token-B"));
  assert.equal(await loader.load(), "token-B");
  assert.equal(await loader.load(), "token-B");
  assert.equal(loads, 2);
});

test("invalidate rejects an old same-SHA load after an authority ABA", async () => {
  const original = snapshot(), f = authority(original), entered = deferred<void>(), late = deferred<string>();
  let loads = 0;
  const loader = new RecoveryBoundLoader({ authority: f.port, async load() {
    if (++loads === 1) { entered.resolve(undefined); return late.promise; }
    return "fresh-A";
  } });
  const old = assert.rejects(loader.load(), hasCategory("recovery_loader_invalidated"));
  await entered.promise;
  f.set(snapshot(revisionB, "token-B")); loader.invalidate(); f.set(original);
  assert.equal(await loader.load(), "fresh-A");
  late.resolve("stale-A"); await old;
  assert.equal(await loader.load(), "fresh-A"); assert.equal(loads, 2);
});

test("invalidate rejects a pending authority read before invoking its loader", async () => {
  const read = deferred<RecoveryAuthoritySnapshot>(); let loads = 0;
  const port: RecoveryAuthorityResolver = { mode: "core_checkpoint", read: () => read.promise, async assertCurrent() {} };
  const loader = new RecoveryBoundLoader({ authority: port, async load() { loads++; return "unexpected"; } });
  const rejected = assert.rejects(loader.load(), hasCategory("recovery_loader_invalidated"));
  loader.invalidate(); read.resolve(snapshot()); await rejected;
  assert.equal(loads, 0);
});

test("every cache hit reads and confirms authority, respecting the exact TTL boundary", async () => {
  const f = authority(); let now = 100, loads = 0;
  const loader = new RecoveryBoundLoader({ authority: f.port, ttlMs: 1_000, now: () => now,
    async load() { return ++loads; } });
  assert.equal(await loader.load(), 1);
  now = 1_100; assert.equal(await loader.load(), 1);
  assert.deepEqual(f.counts(), { reads: 2, checks: 2 });
  now = 1_101; assert.equal(await loader.load(), 2);
  assert.deepEqual(f.counts(), { reads: 3, checks: 3 });
  loader.invalidate(); assert.equal(await loader.load(), 3);
});

test("missing or mismatched authority errors propagate instead of returning cached values", async () => {
  const f = authority(); let loads = 0;
  const loader = new RecoveryBoundLoader({ authority: f.port, async load() { return ++loads; } });
  assert.equal(await loader.load(), 1);
  const missing = new RecoveryAuthorityError("checkpoint_missing");
  f.failRead(missing); await assert.rejects(loader.load(), error => error === missing);
  assert.equal(loads, 1);
  f.failRead();
  const mismatch = new RecoveryAuthorityError("checkpoint_binding_mismatch");
  f.failAssertion(mismatch); await assert.rejects(loader.load(), error => error === mismatch);
  assert.equal(loads, 1); assert.deepEqual(f.counts(), { reads: 3, checks: 2 });
});

test("same authority inflight work is shared and a failed load does not become a cache entry", async () => {
  const f = authority(), entered = deferred<void>(), gate = deferred<string>(); let loads = 0;
  const loader = new RecoveryBoundLoader({ authority: f.port, async load(source) {
    loads++; assert.ok(Object.isFrozen(source) && Object.isFrozen(source.binding));
    if (loads === 1) { entered.resolve(undefined); return gate.promise; }
    return "retry";
  } });
  const first = loader.load(); await entered.promise; const second = loader.load();
  gate.resolve("shared"); assert.deepEqual(await Promise.all([first, second]), ["shared", "shared"]);
  assert.equal(loads, 1); assert.deepEqual(f.counts(), { reads: 2, checks: 1 });
  const boom = new Error("synthetic load failure"); let attempts = 0;
  const retry = new RecoveryBoundLoader({ authority: f.port, async load() { if (++attempts === 1) throw boom; return "retry"; } });
  await assert.rejects(retry.load(), error => error === boom);
  assert.equal(await retry.load(), "retry"); assert.equal(attempts, 2);
});

test("invalid TTL values fail at construction", () => {
  for (const ttlMs of [-1, NaN, Infinity]) {
    assert.throws(() => new RecoveryBoundLoader({ authority: authority().port, ttlMs, async load() {} }), hasCategory("recovery_loader_invalid_ttl"));
  }
});

test("legacy authority preserves the explicit config revision and never discovers checkpoint mode", async () => {
  const owner = { ...binding }, config = { recoveryRevision: revisionA, legacyField: "retained" };
  const legacy = createLegacyRecoveryAuthority(owner, () => config.recoveryRevision);
  owner.agentId = "changed-after-construction";
  const first = await legacy.read();
  assert.equal(legacy.mode, "legacy_config");
  assert.deepEqual(first, { mode: "legacy_config", binding, revision: revisionA, token: `legacy:${revisionA}` });
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.binding));
  assert.deepEqual(config, { recoveryRevision: revisionA, legacyField: "retained" });
  config.recoveryRevision = revisionB;
  await assert.rejects(legacy.assertCurrent(first), hasCategory("recovery_authority_changed"));
  assert.equal((await legacy.read()).revision, revisionB);
  config.recoveryRevision = "";
  await assert.rejects(legacy.read(), hasCategory("recovery_authority_invalid_revision"));
});

test("ConsciousnessLoader legacy setter remains compatible; checkpoint setter is forbidden without loading files", () => {
  const config = { canghaiRoot: binding.repositoryRoot, manifestPath: binding.manifestPath, agentId: binding.agentId,
    recoveryRevision: revisionA, dataMode: "read_only" as const };
  new ConsciousnessLoader(config, "synthetic-host").setRecoveryRevision(revisionB);
  assert.equal(config.recoveryRevision, revisionB);
  const coreConfig = { ...config, recoveryRevision: revisionA };
  const core = new ConsciousnessLoader(coreConfig, "synthetic-host", 1_000, authority().port);
  assert.throws(() => core.setRecoveryRevision(revisionB), hasCategory("recovery_checkpoint_setter_forbidden"));
  assert.equal(coreConfig.recoveryRevision, revisionA);
});
