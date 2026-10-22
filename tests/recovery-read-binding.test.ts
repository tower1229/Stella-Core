import { createLegacyRecoveryAuthority } from "../src/canghai/recovery-bound-loader.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { canonicalJson } from "../src/canghai/content-version.js";
import { RecoveryAuthorityError, type RecoveryAuthorityResolver, type RecoveryAuthoritySnapshot } from "../src/canghai/recovery-authority-contract.js";
import { captureRecoveryReadBinding, assertRecoveryReadBinding, createRecoveryReadScope } from "../src/canghai/recovery-read-binding.js";
import { hostContextExecutionHash } from "../src/openclaw/host-memory-inventory.js";
import { createHostMemoryAcceptance } from "../src/openclaw/host-memory-acceptance.js";
import { loadOutcomeRecoveryBinding } from "../src/praxis/outcome-recovery-binding.js";

const revisionA = "a".repeat(40), revisionB = "b".repeat(40);
const scope = { agentId: "synthetic", canghaiRoot: "/synthetic/repository", manifestPath: "manifest.json" };
function snapshot(revision = revisionA, token = "token-A"): RecoveryAuthoritySnapshot { return { mode: "core_checkpoint", binding: { agentId: scope.agentId, repositoryRoot: scope.canghaiRoot, manifestPath: scope.manifestPath }, revision, token }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function authority() {
  let current = snapshot(), reads = 0, assertions = 0;
  const resolver: RecoveryAuthorityResolver = { mode: "core_checkpoint", async read() { reads++; return current; },
    async assertCurrent(expected) { assertions++; if (canonicalJson(current) !== canonicalJson(expected)) throw new RecoveryAuthorityError("recovery_authority_changed"); } };
  return { resolver, set(value: RecoveryAuthoritySnapshot) { current = value; }, counts: () => ({ reads, assertions }) };
}
function category(expected: string) { return (error: unknown): boolean => { assert.ok(error && typeof error === "object" && "category" in error); assert.equal(error.category, expected); return true; }; }
test("read binding captures once and old assertions never adopt B or a rotated same-SHA token", async () => {
  for (const next of [snapshot(revisionB, "token-B"), snapshot(revisionA, "token-B")]) {
    const f = authority(), binding = await captureRecoveryReadBinding(scope, f.resolver);
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.expected) && Object.isFrozen(binding.expected.binding));
    f.set(next); await assert.rejects(assertRecoveryReadBinding(binding, scope), category("recovery_authority_changed"));
    assert.equal(binding.expected.revision, revisionA); assert.equal(binding.expected.token, "token-A"); assert.equal(f.counts().reads, 1);
  }
});
test("caller scope is frozen before asynchronous authority read", async () => {
  const owner = { ...scope }, gate = deferred<RecoveryAuthoritySnapshot>(), f = authority();
  const resolver = { ...f.resolver, read: () => gate.promise };
  const pending = captureRecoveryReadBinding(owner, resolver); owner.canghaiRoot = "/synthetic/changed"; gate.resolve(snapshot());
  assert.equal((await pending).expected.binding.repositoryRoot, scope.canghaiRoot);
});
test("closed registration scope rejects old and in-flight read/assert callbacks", async () => {
  const f = authority(), closed = createRecoveryReadScope(scope, f.resolver), binding = await closed.capture();
  closed.close(); await assert.rejects(closed.capture(), category("recovery_scope_closed"));
  await assert.rejects(binding.resolver.assertCurrent(binding.expected), category("recovery_scope_closed"));
  const read = deferred<RecoveryAuthoritySnapshot>(), pendingScope = createRecoveryReadScope(scope, { ...f.resolver, read: () => read.promise });
  const pending = assert.rejects(pendingScope.capture(), category("recovery_scope_closed"));
  pendingScope.close(); read.resolve(snapshot()); await pending;
  const checked = deferred<void>(), inAssertion = deferred<void>();
  const assertingScope = createRecoveryReadScope(scope, { ...f.resolver, async assertCurrent() { inAssertion.resolve(); await checked.promise; } });
  const assertion = assert.rejects(assertingScope.resolver.assertCurrent(snapshot()), category("recovery_scope_closed"));
  await inAssertion.promise; assertingScope.close(); checked.resolve(); await assertion;
});
test("missing/corrupt authority and wrong scope reject without fallback", async () => {
  for (const reason of ["checkpoint_missing", "checkpoint_corrupt"]) {
    const failure = new RecoveryAuthorityError(reason), f = authority();
    await assert.rejects(captureRecoveryReadBinding(scope, { ...f.resolver, async read() { throw failure; } }), error => error === failure);
  }
  const f = authority();
  for (const changed of [{ ...scope, agentId: "another" }, { ...scope, canghaiRoot: "/synthetic/another" }, { ...scope, manifestPath: "other.json" }])
    await assert.rejects(captureRecoveryReadBinding(changed, f.resolver), category("recovery_read_binding_mismatch"));
});
function hostConfig() { return { plugins: { entries: { "stella-core": { enabled: true, config: { ...scope, dataMode: "managed_durable_write", recoveryRevision: revisionA } } } } }; }
test("execution hash explicitly binds Core snapshot while legacy pointer gate remains", () => {
  const config = hostConfig(), expected = { ...scope, recoveryRevision: revisionB }, authorityB = snapshot(revisionB, "token-B");
  assert.throws(() => hostContextExecutionHash(config, expected), category("host_context_recovery_binding_changed"));
  const hash = hostContextExecutionHash(config, expected, authorityB);
  assert.notEqual(hash, hostContextExecutionHash(config, expected, snapshot(revisionB, "token-C")));
  const changed = structuredClone(config); changed.plugins.entries["stella-core"].config.dataMode = "read_only";
  assert.throws(() => hostContextExecutionHash(changed, expected, authorityB), category("host_context_configuration_scope_mismatch"));
  for (const binding of [{ ...authorityB.binding, agentId: "other" }, { ...authorityB.binding, repositoryRoot: "/synthetic/other" }, { ...authorityB.binding, manifestPath: "other.json" }])
    assert.throws(() => hostContextExecutionHash(config, expected, { ...authorityB, binding }), category("host_context_recovery_binding_changed"));
  const legacy = { ...scope, recoveryRevision: revisionA };
  assert.equal(hostContextExecutionHash(config, legacy), hostContextExecutionHash(structuredClone(config), legacy));
});
test("acceptance missing authority fails before config or any model call", async () => {
  const missing = new RecoveryAuthorityError("checkpoint_missing"); let configReads = 0, modelCalls = 0;
  const api = { runtime: { config: { current() { configReads++; assert.fail("Config should not be read after missing authority"); } },
    llm: { complete() { modelCalls++; assert.fail("No model calls allowed"); } } } } as unknown as OpenClawPluginApi;
  const f = authority(), acceptance = createHostMemoryAcceptance(api, { ...scope, recoveryRevision: revisionA }, { ...f.resolver, async read() { throw missing; } });
  await assert.rejects(acceptance.captureDependencies(), error => error === missing);
  assert.equal(configReads, 0); assert.equal(modelCalls, 0);
});
test("outcome recovery cannot replace frozen revision or use a different repository scope", async () => {
  const f = authority(), binding = await captureRecoveryReadBinding(scope, f.resolver);
  await assert.rejects(loadOutcomeRecoveryBinding(scope.canghaiRoot, scope.manifestPath, revisionB, binding), category("recovery_binding_changed"));
  await assert.rejects(loadOutcomeRecoveryBinding("/synthetic/other", scope.manifestPath, revisionA, binding), category("recovery_read_binding_mismatch"));
  f.set(snapshot(revisionB, "token-B"));
  await assert.rejects(loadOutcomeRecoveryBinding(scope.canghaiRoot, scope.manifestPath, revisionA, binding), category("recovery_authority_changed"));
  assert.equal(f.counts().reads, 1);
});


test("mutable expected aliases cannot upgrade token while a read assertion awaits", async () => {
  for (const endpoint of ["assert", "outcome"] as const) {
    const external = { ...snapshot(), binding: { ...snapshot().binding } }, entered = deferred<void>(), gate = deferred<void>();
    let current = snapshot();
    const resolver: RecoveryAuthorityResolver = { mode: "core_checkpoint", async read() { return current; }, async assertCurrent(expected) {
      entered.resolve(); await gate.promise;
      if (canonicalJson(expected) !== canonicalJson(current)) throw new RecoveryAuthorityError("recovery_authority_changed");
    } };
    const binding = { resolver, expected: external };
    const pending = assert.rejects(endpoint === "assert" ? assertRecoveryReadBinding(binding, scope)
      : loadOutcomeRecoveryBinding(scope.canghaiRoot, scope.manifestPath, revisionA, binding), category("recovery_authority_changed"));
    await entered.promise; external.token = "token-B"; current = snapshot(revisionA, "token-B"); gate.resolve(); await pending;
  }
});
test("explicit legacy resolver still requires the live Host pointer to match", async () => {
  const resolver = createLegacyRecoveryAuthority(snapshot().binding, () => revisionA);
  const api = { runtime: { config: { current() { return { plugins: { entries: { "stella-core": { enabled: true, config: { ...scope, recoveryRevision: revisionB } } } } }; } } } } as unknown as OpenClawPluginApi;
  const acceptance = createHostMemoryAcceptance(api, { ...scope, recoveryRevision: revisionA }, resolver);
  await assert.rejects(acceptance.captureDependencies(), category("host_memory_acceptance_configuration_changed"));
});


test("direct scoped assertion freezes the original expected object before awaiting", async () => {
  const external = { ...snapshot(), binding: { ...snapshot().binding } }, entered = deferred<void>(), gate = deferred<void>();
  let current = snapshot();
  const resolver: RecoveryAuthorityResolver = { mode: "core_checkpoint", async read() { return current; }, async assertCurrent(expected) {
    entered.resolve(); await gate.promise;
    if (canonicalJson(expected) !== canonicalJson(current)) throw new RecoveryAuthorityError("recovery_authority_changed");
  } };
  const scoped = createRecoveryReadScope(scope, resolver);
  const pending = assert.rejects(scoped.resolver.assertCurrent(external), category("recovery_authority_changed"));
  await entered.promise; external.token = "token-B"; current = snapshot(revisionA, "token-B"); gate.resolve(); await pending;
});
test("read snapshots reject coercible revision arrays before assertion", async () => {
  let assertions = 0;
  const resolver: RecoveryAuthorityResolver = { mode: "core_checkpoint", async read() {
    return { ...snapshot(), revision: [revisionA] } as unknown as RecoveryAuthoritySnapshot;
  }, async assertCurrent() { assertions++; } };
  await assert.rejects(captureRecoveryReadBinding(scope, resolver), category("recovery_read_binding_mismatch"));
  assert.equal(assertions, 0);
});
