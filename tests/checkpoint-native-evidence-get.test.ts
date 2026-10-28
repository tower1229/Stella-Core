import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CatalogError, CatalogReader, type CatalogGroup } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";
import { evidenceNativeReference, learningChangeNativeReferences, registerCheckpointNativeReadback,
  type NativeReadbackOpen, type NativeReadbackReference } from "../src/openclaw/checkpoint-native-readback.js";
import { personalMemoryFixture } from "./personal-memory-fixture.js";

type Capability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];
type Runtime = NonNullable<Capability["providerRuntime"]>;
type Handle = NonNullable<Awaited<ReturnType<Runtime["open"]>>["provider"]>;
type Phase = "open" | "scope" | "authorization" | "source-policy" | "resolver" | "payload" | "metadata-policy";
const providerId = "stella-e1-evidence", refKey = (ref: VersionedRef) => canonicalJson([ref.id, ref.version]);
const reference = (ref: VersionedRef) => evidenceNativeReference({ providerId, evidenceRef: ref });
const version = `sha256:${"0".repeat(64)}`;
function barrier() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
  return { started, release, async wait() { entered(); await resumed; } };
}

/** Public registration/open/get contract with explicitly synthetic caller/current
 * fixtures. Real catalog, resolver and payload I/O; no Host, SDK-private loader or model. */
async function fixture(t: TestContext) {
  const memory = await personalMemoryFixture(t), initial = await memory.resolver();
  const baseEvidence = await initial.reader.read(memory.evidence, "evidence"), baseSource = await initial.reader.read(memory.source, "sources");
  const basePolicy = await initial.reader.read(baseEvidence.policyRef as VersionedRef, "policies");
  const control = { live: true, request: 1, deniedSources: new Set<string>(), gate: undefined as { phase: Phase; barrier: ReturnType<typeof barrier> } | undefined };
  const counts = { opened: 0, admissions: [] as string[][], payloads: [] as string[], unauthorizedPayloads: 0,
    evidenceReads: [] as string[], policies: [] as string[], released: 0 };
  const pause = async (phase: Phase) => { if (control.gate?.phase === phase) await control.gate.barrier.wait(); };
  async function open(authority: NativeReadbackOpen["context"]["authority"] = { kind: "operator", scopes: ["operator.admin"] }, signal?: AbortSignal) {
    const reader = await CatalogReader.load(memory.root, "catalog.json"), denied = new Set(control.deniedSources), request = control.request;
    const current = () => { if (!control.live || request !== control.request) throw new CatalogError("synthetic_request_stale"); };
    const readPayload = reader.readPayload.bind(reader);
    reader.readPayload = async (source, digest) => {
      counts.payloads.push(refKey(source)); if (denied.has(refKey(source))) counts.unauthorizedPayloads++;
      const result = await readPayload(source, digest); await pause("payload"); return result;
    };
    const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "synthetic/model",
      evidenceCutoff: "2026-09-08T00:00:00Z", signal,
      trustedAdapters: { user_report: ["synthetic"], tool_observation: [], system_event: [] },
      sourceAccess: async (_reader, input) => { counts.policies.push(refKey(input.policyRef)); return {
        judgment: { scenarios: ["writing"], trigger: "user_requested", topicRequested: true, topicExplicitlyNamed: true, presentation: "summary" }, quoteGrants: [],
      }; },
    }, async () => { throw new Error("E1 must not call a model"); });
    const readEvidence = resolver.readEvidence.bind(resolver);
    resolver.readEvidence = async ref => { counts.evidenceReads.push(refKey(ref)); const value = await readEvidence(ref); await pause("resolver"); return value; };
    const sourceAccess = resolver.assertSourceAccess.bind(resolver);
    resolver.assertSourceAccess = async (source, policy) => { await sourceAccess(source, policy); await pause("source-policy"); };
    const metadataAccess = resolver.assertSourceMetadataAccess.bind(resolver);
    resolver.assertSourceMetadataAccess = async (...args) => {
      await metadataAccess(...args); if (args[1].id === "metadata-policy") await pause("metadata-policy");
    };
    let runtime!: Runtime;
    registerCheckpointNativeReadback({ id: providerId, registerMemoryCapability(capability) {
      assert.deepEqual(Object.keys(capability), ["providerRuntime"]); runtime = capability.providerRuntime!;
    } }, { providerId, async openReadScope() {
      counts.opened++; await pause("open");
      return { reader, resolver, async assertCurrent() { current(); await pause("scope"); }, async authorizeSources(input) {
        counts.admissions.push(input.sourceRefs.map(refKey));
        if (input.sourceRefs.some(ref => denied.has(refKey(ref)))) throw new CatalogError("permission_denied");
        await pause("authorization"); return { assertCurrent: current };
      } };
    } });
    const opened = await runtime.open({ cfg: {}, agentId: "synthetic", context: { authority, assertCurrent: current, signal } });
    assert.ok(opened.provider); const raw = opened.provider.get.bind(opened.provider);
    opened.provider.get = async params => { const result = await raw(params); counts.released++; return result; };
    return { lease: opened.provider, reader };
  }
  const entry = (ref: VersionedRef, group: CatalogGroup) => memory.catalog[group].find(value => refKey(value) === refKey(ref))!;
  const evidence = (id: string, changes: Record<string, unknown> = {}, dependencies?: VersionedRef[]) => {
    const object: Record<string, unknown> = { ...baseEvidence, id, ...changes };
    return memory.put("evidence", object, dependencies ?? [object.source as VersionedRef, object.policyRef as VersionedRef, ...object.derivedFrom as VersionedRef[]]);
  };
  async function source(id: string, text: string) {
    const payload = canonicalJson({ report: text, unrelated: "SYNTHETIC_UNSELECTED_FULL_PAYLOAD" }), file = `${id}-payload.json`;
    await writeFile(path.join(memory.root, file), payload);
    const digest = bytesVersion(payload), ref = await memory.put("sources", { ...baseSource, id,
      payloads: [{ path: file, bytes: Buffer.byteLength(payload), sha256: digest, mediaType: "application/json" }],
      internalPath: "SYNTHETIC_INTERNAL_SOURCE_PATH" }, [baseSource.policyRef as VersionedRef, baseSource.coverageRef as VersionedRef]);
    return { ref, digest, payload };
  }
  return { memory, baseEvidence, baseSource, basePolicy, control, counts, open, entry, evidence, source };
}

async function rejected(f: Awaited<ReturnType<typeof fixture>>, lease: Handle, ref: NativeReadbackReference, category: RegExp,
  extra: Record<string, unknown> = {}) {
  const released = f.counts.released;
  await assert.rejects(lease.get({ reference: ref, ...extra }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, category);
    for (const field of ["text", "evidence", "sourceRef", "speakerId", "selector", "reference", "payloadSha256"]) assert.equal(field in error, false);
    assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_(SPEAKER|UNSELECTED|INTERNAL|DEPENDENCY_BODY)/);
    return true;
  });
  assert.equal(f.counts.released, released, "failure releases neither body nor a metadata wrapper");
  assert.equal(f.counts.unauthorizedPayloads, 0);
}

async function document(lease: Handle, ref: VersionedRef) {
  const result = await lease.get({ reference: reference(ref) });
  assert.equal(result.status, "ok"); if (result.status !== "ok") assert.fail("expected exact Evidence");
  assert.deepEqual(result.reference, reference(ref)); assert.equal(result.truncated, false);
  return { result, value: JSON.parse(result.text) };
}

test("Evidence get returns a whitelisted exact JSON-selected fragment and keeps receipt mapping narrow", async t => {
  const f = await fixture(t), text = "合成引文\n保留疑问，先核对原意。", source = await f.source(f.memory.source.id, text);
  f.entry(f.memory.evidence, "evidence").status = "superseded";
  f.entry(f.memory.source, "sources").status = "superseded";
  const target = await f.evidence(f.memory.evidence.id, { source: source.ref, payloadSha256: source.digest,
    speakerId: "SYNTHETIC_SPEAKER_METADATA", role: "external_author", kind: "quotation", internalLocator: "SYNTHETIC_INTERNAL_EVIDENCE_PATH" });
  await f.memory.save(); const { lease, reader } = await f.open();
  const { result, value } = await document(lease, target);
  assert.deepEqual(Object.keys(value).sort(), ["dependencyUsageConstraints", "derivedFrom", "evidence", "fragmentSha256", "payloadSha256", "selector", "sourceRef", "speakerId"].sort());
  assert.deepEqual(Object.keys(value.evidence).sort(), ["ref", "text", "role", "kind", "independentOriginId", "sourceAdapterId", "occurredAt", "authoredAt", "capturedAt", "coverageComplete"].sort());
  assert.equal(value.evidence.text, text); assert.equal(value.evidence.role, "external_author"); assert.equal(value.evidence.kind, "quotation");
  assert.equal(value.speakerId, "SYNTHETIC_SPEAKER_METADATA"); assert.deepEqual(value.sourceRef, source.ref);
  assert.deepEqual(value.evidence.ref, target); assert.deepEqual(value.selector, { kind: "json_pointer", value: "/report" });
  assert.equal(value.fragmentSha256, bytesVersion(Buffer.from(text, "utf8"))); assert.notEqual(value.fragmentSha256, source.digest);
  assert.equal(value.payloadSha256, source.digest); assert.equal(value.evidence.coverageComplete, true);
  assert.doesNotMatch(result.text, /SYNTHETIC_(UNSELECTED|INTERNAL)/);
  const inventedExcerpt = "UNRELATED_CANDIDATE_EXCERPT";
  const again = await lease.get({ reference: reference(target), excerpt: inventedExcerpt } as Parameters<Handle["get"]>[0]);
  assert.equal(again.status, "ok"); if (again.status === "ok") assert.equal(again.text, result.text);
  await rejected(f, lease, reference(f.memory.evidence), /eligible/);
  await rejected(f, lease, { ...reference(target), revision: version }, /unavailable/);
  const { revision: _revision, ...missing } = reference(target); await rejected(f, lease, missing, /reference_invalid/);
  const changeRef = await f.memory.put("changes", { schemaVersion: "stella.learning-change/v1", id: "evidence-change", operationId: "synthetic-e1",
    algorithmVersion: "synthetic", modelRef: "synthetic/no-model", promptVersion: "one", inputRefs: [target], targetRefs: [target],
    disposition: "update", rationale: "Cannot write Evidence through a view receipt", changes: [{ kind: "create", before: null, after: target, supportRefs: [target], counterRefs: [] }] }, [target]);
  await f.memory.save(); const current = await CatalogReader.load(f.memory.root, "catalog.json");
  await assert.rejects(learningChangeNativeReferences({ providerId, reader: current, changeRef }), /target_unsupported/);
  assert.notStrictEqual(reader, current); await assert.rejects(lease.search({ query: "not a discovery test" }), /search_unsupported/);
});

test("invalid references and caller authority cannot open an Evidence data scope", async t => {
  const f = await fixture(t), { lease } = await f.open(), ref = reference(f.memory.evidence);
  for (const bad of [{ ...ref, providerId: "foreign" }, { ...ref, fragment: "0:999" }, { ...ref, id: '[ "evidence", "evidence" ]' },
    { ...ref, id: canonicalJson(["sources", "evidence"]) }, { ...ref, revision: "latest" }]) await rejected(f, lease, bad, /unsupported|reference_invalid/);
  for (const range of [{ from: 1 }, { lines: 2 }]) await rejected(f, lease, ref, /unsupported/, range);
  for (const authority of [{ kind: "host", operation: "status" }, { kind: "operator", scopes: [] },
    { kind: "session", sessionKey: "synthetic", sandboxed: false },
    { kind: "session", sessionKey: "synthetic", sandboxed: false, audience: { kind: "owner-private", agentId: "other" } }] as const) {
    const opened = await f.open(authority); await rejected(f, opened.lease, ref, /caller_forbidden/, { senderIsOwner: true, authority: { kind: "operator", scopes: ["operator.admin"] } });
  }
  const controller = new AbortController(), cancelled = await f.open(undefined, controller.signal); controller.abort();
  await rejected(f, cancelled.lease, ref, /aborted/);
  f.control.live = false; await rejected(f, lease, ref, /request_stale/);
  assert.equal(f.counts.opened, 0); assert.equal(f.counts.payloads.length, 0);
});

test("valid Host admin still needs source read; independent Evidence and segment policy deny before payload", async t => {
  for (const mode of ["source", "evidence-policy", "segment", "segment-policy"] as const) await t.test(mode, async t => {
    const f = await fixture(t); let target = f.memory.evidence;
    if (mode === "source") f.control.deniedSources.add(refKey(f.memory.source));
    else {
      const policy = await f.memory.put("policies", { ...f.basePolicy, id: "narrow-denied", readPurposes: ["not-granted"] });
      if (mode === "segment" || mode === "segment-policy") {
        const digest = f.baseEvidence.payloadSha256 as string, size = (f.baseSource.payloads as Array<{ bytes: number }>)[0]!.bytes;
        const source = await f.memory.put("sources", { ...f.baseSource, id: "segmented", schemaVersion: "stella.memory-source/v2",
          accessSegments: [{ payloadSha256: digest, start: 0, end: 1, policyRef: policy },
            { payloadSha256: digest, start: 1, end: size, policyRef: f.baseSource.policyRef }] },
        [f.baseSource.policyRef as VersionedRef, f.baseSource.coverageRef as VersionedRef, policy]);
        target = await f.evidence("out-of-segment", { source, policyRef: policy, selector: { kind: "utf8_bytes", value: mode === "segment" ? "0:2" : "0:1" } });
      } else target = await f.evidence("narrow-evidence", { policyRef: policy });
      await f.memory.save();
    }
    const { lease } = await f.open(); await rejected(f, lease, reference(target), /permission_denied|evidence_segment/);
    assert.equal(f.counts.admissions.length, 1); assert.equal(f.counts.payloads.length, 0);
  });
});

test("derived Evidence preserves all dependency constraints without disclosing their text or merging narrow policies", async t => {
  const f = await fixture(t), dependency = await f.source("dependency", "SYNTHETIC_DEPENDENCY_BODY");
  const policy = await f.memory.put("policies", { ...f.basePolicy, id: "dependency-policy", schemaVersion: "stella.source-policy/v3",
    restrictions: { sensitivity: "private", quotePolicy: "never_quote", allowedScenarios: ["writing"], forbiddenScenarios: [] },
    usageRules: { access: [], interpretation: [{ id: "retain_uncertainty", requirement: "Preserve the dependency's unresolved alternatives." }] } });
  const first = await f.evidence("dependency-one", { source: dependency.ref, policyRef: policy, payloadSha256: dependency.digest });
  const secondPolicy = await f.memory.put("policies", { ...f.basePolicy, id: "second-policy", schemaVersion: "stella.source-policy/v2",
    restrictions: { sensitivity: "private", quotePolicy: "summarize_only", allowedScenarios: ["writing"], forbiddenScenarios: [] } });
  const second = await f.evidence("dependency-two", { source: dependency.ref, policyRef: secondPolicy, payloadSha256: dependency.digest, derivedFrom: [first] });
  const metadataPolicy = await f.memory.put("policies", { ...f.basePolicy, id: "metadata-policy", schemaVersion: "stella.source-policy/v3",
    restrictions: { sensitivity: "private", quotePolicy: "never_quote", allowedScenarios: ["writing"], forbiddenScenarios: [] },
    usageRules: { access: [], interpretation: [{ id: "metadata_context", requirement: "Keep this metadata dependency's context." }] } });
  const target = await f.evidence("derived-target", { derivedFrom: [second] }); f.entry(target, "evidence").metadataRef = metadataPolicy;
  await f.memory.save(); const { lease } = await f.open(), { result, value } = await document(lease, target);
  assert.equal(f.counts.admissions.length, 1); assert.deepEqual(new Set(f.counts.admissions[0]), new Set([refKey(f.memory.source), refKey(dependency.ref)]));
  assert.ok(f.counts.evidenceReads.includes(refKey(first))); assert.ok(f.counts.evidenceReads.includes(refKey(second)));
  assert.ok(f.counts.policies.includes(refKey(policy))); assert.ok(f.counts.policies.includes(refKey(secondPolicy)));
  assert.deepEqual(value.dependencyUsageConstraints.appliesTo, target);
  assert.deepEqual(value.dependencyUsageConstraints.policies, [
    { policyRef: secondPolicy, rules: [], quotePolicy: "summarize_only" },
    { policyRef: policy, rules: [{ id: "retain_uncertainty", requirement: "Preserve the dependency's unresolved alternatives." }], quotePolicy: "never_quote" },
    { policyRef: metadataPolicy, rules: [{ id: "metadata_context", requirement: "Keep this metadata dependency's context." }], quotePolicy: "never_quote" },
  ]);
  assert.doesNotMatch(result.text, /SYNTHETIC_DEPENDENCY_BODY|SYNTHETIC_UNSELECTED|SYNTHETIC_INTERNAL/);
  assert.equal(f.counts.unauthorizedPayloads, 0);
});

test("segment structure alone neither discloses adjacent policy metadata nor hides genuine dependency constraints", async t => {
  for (const mode of ["unselected", "derived", "metadata", "metadata-denied", "structural-neighbor"] as const) await t.test(mode, async t => {
    const f = await fixture(t), allowed = "SYNTHETIC_ALLOWED_FRAGMENT", adjacent = "SYNTHETIC_ADJACENT_PRIVATE_BODY";
    const rule = { id: "private_context", requirement: "SYNTHETIC_UNAUTHORIZED_ADJACENT_POLICY_METADATA" };
    const canRead = mode === "derived" || mode === "metadata";
    const policy = await f.memory.put("policies", { ...f.basePolicy, id: "adjacent-private-policy", schemaVersion: "stella.source-policy/v3",
      readPurposes: canRead ? ["retrieve"] : [],
      restrictions: { sensitivity: "private", quotePolicy: "never_quote", allowedScenarios: canRead ? ["writing"] : [], forbiddenScenarios: canRead ? [] : ["writing"] },
      usageRules: { access: [], interpretation: [rule] } });
    const payload = allowed + adjacent, digest = bytesVersion(payload), boundary = Buffer.byteLength(allowed), size = Buffer.byteLength(payload);
    await writeFile(path.join(f.memory.root, "segmented.txt"), payload);
    const source = await f.memory.put("sources", { ...f.baseSource, id: "segmented", schemaVersion: "stella.memory-source/v2",
      payloads: [{ path: "segmented.txt", bytes: size, sha256: digest, mediaType: "text/plain" }],
      accessSegments: [{ payloadSha256: digest, start: 0, end: boundary, policyRef: f.baseEvidence.policyRef },
        { payloadSha256: digest, start: boundary, end: size, policyRef: policy }] },
    [f.baseEvidence.policyRef as VersionedRef, f.baseSource.coverageRef as VersionedRef, policy]);
    const dependency = await f.evidence("adjacent-evidence", { source, payloadSha256: digest, policyRef: policy,
      selector: { kind: "utf8_bytes", value: `${boundary}:${size}` } });
    const target = await f.evidence("selected-evidence", { source, payloadSha256: digest,
      selector: { kind: "utf8_bytes", value: `0:${boundary}` }, derivedFrom: mode === "derived" ? [dependency] : [] });
    if (mode === "metadata" || mode === "metadata-denied") f.entry(target, "evidence").metadataRef = policy;
    await f.memory.save();
    if (mode === "structural-neighbor") await unlink(path.join(f.memory.root, f.entry(policy, "policies").locator.path));
    const { lease } = await f.open();
    if (mode === "metadata-denied" || mode === "structural-neighbor") {
      await rejected(f, lease, reference(target), mode === "metadata-denied" ? /permission_denied/ : /object_unavailable/);
      assert.equal(f.counts.payloads.length, mode === "metadata-denied" ? 1 : 0);
    } else {
      const { result, value } = await document(lease, target);
      assert.equal(value.evidence.text, allowed); assert.equal(value.fragmentSha256, bytesVersion(allowed));
      assert.equal(f.counts.payloads.length, mode === "derived" ? 2 : 1);
      assert.doesNotMatch(result.text, /SYNTHETIC_ADJACENT_PRIVATE_BODY/);
      if (mode === "unselected") {
        assert.doesNotMatch(result.text, /SYNTHETIC_UNAUTHORIZED_ADJACENT_POLICY_METADATA|adjacent-private-policy|never_quote/);
        assert.deepEqual(value.dependencyUsageConstraints.policies, []);
        assert.equal(f.counts.policies.includes(refKey(policy)), false, "unselected neighbor is not an applicable policy judgment");
      } else {
        assert.deepEqual(value.dependencyUsageConstraints.policies, [{ policyRef: policy, rules: [rule], quotePolicy: "never_quote" }]);
        assert.ok(f.counts.policies.includes(refKey(policy)), "genuine metadata/derived policy must actually be authorized");
        assert.equal(f.counts.evidenceReads.includes(refKey(dependency)), mode === "derived");
      }
    }
    assert.equal(f.counts.admissions.length, 1); assert.equal(f.counts.unauthorizedPayloads, 0);
  });
});

test("explicit metadata policy authorization cannot release constraints after stale, cancel or close", async t => {
  for (const failure of ["stale", "cancel", "close"] as const) await t.test(failure, async t => {
    const f = await fixture(t), controller = new AbortController(), gate = barrier();
    const policy = await f.memory.put("policies", { ...f.basePolicy, id: "metadata-policy", schemaVersion: "stella.source-policy/v3",
      restrictions: { sensitivity: "private", quotePolicy: "never_quote", allowedScenarios: ["writing"], forbiddenScenarios: [] },
      usageRules: { access: [], interpretation: [{ id: "metadata_context", requirement: "SYNTHETIC_UNAUTHORIZED_ADJACENT_POLICY_METADATA" }] } });
    f.entry(f.memory.evidence, "evidence").metadataRef = policy; await f.memory.save();
    const { lease } = await f.open(undefined, controller.signal); f.control.gate = { phase: "metadata-policy", barrier: gate };
    const pending = rejected(f, lease, reference(f.memory.evidence), /request_stale|aborted|lease_closed/);
    await Promise.race([gate.started, pending.then(() => assert.fail("expected metadata authorization await"))]);
    if (failure === "stale") f.control.live = false; else if (failure === "cancel") controller.abort(); else await lease.close();
    gate.release(); await pending;
    assert.equal(f.counts.payloads.length, 1); assert.ok(f.counts.policies.includes(refKey(policy)));
  });
});

test("dependency denial never reads unauthorized payloads; same-source Evidence policy is not deduplicated", async t => {
  for (const mode of ["source", "same-source-policy", "undeclared-body-source"] as const) await t.test(mode, async t => {
    const f = await fixture(t), other = await f.source("forbidden-dependency", "SYNTHETIC_DEPENDENCY_BODY");
    const policy = await f.memory.put("policies", { ...f.basePolicy, id: "deny-evidence", readPurposes: ["not-granted"] });
    let dependency: VersionedRef;
    if (mode === "same-source-policy") dependency = await f.evidence("same-source-narrow", { policyRef: policy });
    else if (mode === "undeclared-body-source") dependency = await f.evidence("hidden-source", { source: other.ref, payloadSha256: other.digest }, [f.memory.source, f.baseEvidence.policyRef as VersionedRef]);
    else { dependency = await f.evidence("other-source", { source: other.ref, payloadSha256: other.digest }); f.control.deniedSources.add(refKey(other.ref)); }
    const target = await f.evidence("derived", { derivedFrom: [dependency] }); await f.memory.save();
    const { lease } = await f.open(); await rejected(f, lease, reference(target), /permission_denied|undeclared_object_dependency/);
    assert.equal(f.counts.payloads.filter(key => key === refKey(other.ref)).length, 0);
    if (mode === "same-source-policy") assert.ok(f.counts.payloads.length > 0, "an authorized target may be read before the later dependency refuses; nothing is released");
    else assert.equal(f.counts.payloads.length, 0);
  });
});

test("derivedFrom and metadataRef closure reject cycles, missing references/objects, unknown types and node overflow", async t => {
  for (const mode of ["derived-cycle", "metadata-cycle", "missing-reference", "missing-object", "unknown-type", "wrong-derived-kind", "limit", "overflow"] as const) await t.test(mode, async t => {
    const f = await fixture(t); let target = f.memory.evidence;
    if (mode === "derived-cycle") {
      const dep = await f.evidence("dep"); target = await f.evidence("target", { derivedFrom: [dep] });
      f.entry(dep, "evidence").dependencies.push(target);
    } else if (mode === "metadata-cycle") f.entry(target, "evidence").metadataRef = target;
    else if (mode === "wrong-derived-kind") target = await f.evidence("wrong-derived-kind", { derivedFrom: [f.baseEvidence.policyRef] });
    else if (mode === "missing-reference") f.entry(target, "evidence").metadataRef = { id: "absent", version };
    else if (mode === "missing-object" || mode === "unknown-type") {
      const dep = await f.memory.put("policies", { ...f.basePolicy, id: "metadata", ...(mode === "unknown-type" ? { schemaVersion: "synthetic.unknown/v1" } : {}) });
      f.entry(target, "evidence").metadataRef = dep;
      if (mode === "missing-object") await unlink(path.join(f.memory.root, f.entry(dep, "policies").locator.path));
    } else {
      let previous = f.entry(target, "evidence");
      for (let index = 0; index < (mode === "limit" ? 508 : 509); index++) {
        const dep = await f.memory.put("policies", { ...f.basePolicy, id: `metadata-${index}` });
        previous.metadataRef = dep; previous = f.entry(dep, "policies");
      }
    }
    await f.memory.save(); const { lease } = await f.open();
    if (mode === "limit") { await document(lease, target); assert.equal(f.counts.payloads.length, 1); }
    else {
      const category = { "derived-cycle": /dependency_cycle/, "metadata-cycle": /dependency_cycle/, "missing-reference": /reference_unavailable/,
        "missing-object": /object_unavailable/, "unknown-type": /dependency_unsupported/, "wrong-derived-kind": /reference_unavailable/,
        overflow: /dependency_budget_exhausted/ }[mode];
      await rejected(f, lease, reference(target), category); assert.equal(f.counts.payloads.length, 0);
    }
  });
});

test("payload, locator, selector and source eligibility failures are explicit rather than history/latest fallback", async t => {
  for (const mode of ["payload", "locator", "selector", "utf8", "removed", "superseded"] as const) await t.test(mode, async t => {
    const f = await fixture(t); let target = f.memory.evidence;
    if (mode === "payload") await writeFile(path.join(f.memory.root, "payload.json"), "TAMPERED_SYNTHETIC_PAYLOAD");
    else if (mode === "locator") await writeFile(path.join(f.memory.root, f.entry(target, "evidence").locator.path), "{}");
    else if (mode === "selector") target = await f.evidence("invalid-selector", { selector: { kind: "json_pointer", value: "/absent" } });
    else if (mode === "utf8") target = await f.evidence("invalid-utf8", { selector: { kind: "utf8_bytes", value: "12:13" } });
    else f.entry(f.memory.source, "sources").status = mode;
    await f.memory.save(); const { lease } = await f.open();
    const category = { payload: /payload_digest_mismatch/, locator: /locator_digest_mismatch/, selector: /selector_unavailable/,
      utf8: /invalid_utf8_or_json/, removed: /not_currently_eligible/, superseded: /not_currently_eligible/ }[mode];
    await rejected(f, lease, reference(target), category);
  });
});

test("await boundaries cannot release body or metadata after request invalidation, cancellation or lease close", async t => {
  for (const phase of ["open", "scope", "authorization", "source-policy", "resolver", "payload"] as const) for (const failure of ["stale", "cancel", "close"] as const)
    await t.test(`${phase}/${failure}`, async t => {
      const f = await fixture(t), controller = new AbortController(), { lease } = await f.open(undefined, controller.signal), gate = barrier();
      f.control.gate = { phase, barrier: gate };
      const pending = rejected(f, lease, reference(f.memory.evidence), /request_stale|AbortError|aborted|lease_closed/);
      await Promise.race([gate.started, pending.then(() => assert.fail("expected await barrier"))]);
      if (failure === "stale") f.control.live = false;
      else if (failure === "cancel") controller.abort(); else await lease.close();
      gate.release(); await pending;
      assert.equal(f.counts.payloads.length, phase === "resolver" || phase === "payload" ? 1 : 0);
    });
});

test("new request reloads read permission and version; retired requests and old readers stay stale", async t => {
  const f = await fixture(t), old = await f.open(); await document(old.lease, f.memory.evidence);
  f.control.request++; f.control.deniedSources.add(refKey(f.memory.source)); const next = await f.open(), before = f.counts.payloads.length;
  await rejected(f, next.lease, reference(f.memory.evidence), /permission_denied/); assert.equal(f.counts.payloads.length, before);
  await rejected(f, old.lease, reference(f.memory.evidence), /request_stale/);
  f.control.deniedSources.clear(); const readerBound = await f.open();
  f.entry(f.memory.evidence, "evidence").status = "superseded";
  const target = await f.evidence(f.memory.evidence.id, { role: "assistant", kind: "inference" }); await f.memory.save();
  await rejected(f, readerBound.lease, reference(f.memory.evidence), /stale_generation/);
  f.control.request++; const fresh = await f.open(); const { value } = await document(fresh.lease, target);
  assert.equal(value.evidence.role, "assistant"); assert.equal(value.evidence.kind, "inference");
  await rejected(f, fresh.lease, reference(f.memory.evidence), /eligible/); assert.notStrictEqual(fresh.reader, readerBound.reader);
});
