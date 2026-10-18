import assert from "node:assert/strict";
import test from "node:test";
import { HOST_NATIVE_MEMORY_ENTRANCES, HOST_MEMORY_PLUGIN_IDS } from "../src/openclaw/host-memory-inventory.js";

type Probe = { flag: string; passed: boolean; coreRevision: string; artifactSha256: string; report: Record<string, unknown> };
type Input = { nativeEntrances: readonly string[]; pluginIds: readonly string[]; probes: Probe[]; coreRevision: string; artifactSha256: string };
// Plain Node acceptance tooling is outside the runtime TypeScript compilation.
const evidence = await import(new URL("../../scripts/lib/host-memory-evidence.mjs", import.meta.url).href) as {
  HOST_MEMORY_EVIDENCE_PROBES: readonly string[];
  HOST_MEMORY_ACCEPTANCE_MATRIX: ReadonlyArray<{ flag: string; scenario: string; provider: string; indexMode?: string }>;
  alignHostMemoryEvidence(input: Input): { aligned: boolean; complete: boolean; fullMemoryAccepted: boolean;
    issue23Complete: boolean; native: unknown[]; observedEntries: Array<{ kind: string; status: string; gaps?: string[] }> };
};
function fixture(): Input {
  const coreRevision = "a".repeat(40), artifactSha256 = "b".repeat(64);
  const probes = evidence.HOST_MEMORY_EVIDENCE_PROBES.map(flag => {
    const scenario = flag.startsWith("source-audience-") ? flag.slice("source-audience-".length) : undefined;
    const field = flag.startsWith("host-ingress-") ? flag.slice("host-ingress-".length) : undefined;
    const native = flag.startsWith("native-memory-") && flag !== "native-memory-producers" ? flag.slice("native-memory-".length).split("-") : undefined;
    const acceptanceCase = evidence.HOST_MEMORY_ACCEPTANCE_MATRIX.find(entry => entry.flag === flag);
    const acceptance = acceptanceCase?.scenario;
    return { flag, passed: true, coreRevision, artifactSha256, report: {
      schemaVersion: "stella.host-memory-boundary-probe/v1", evidenceDirectory: "/synthetic/evidence", dreamingEnabled: false,
      fullMemoryAccepted: false, realModelAccepted: false, unknownInputConsumed: false, dispatch: [{}], audienceScenario: scenario, ingressField: field,
      terminalStatus: scenario === "owner" ? "ok" : "error", providerRequests: scenario === "owner" ? 3 : scenario === "revoked" ? 2 : 0,
      finalAnswers: scenario === "owner" ? 1 : 0, authorizedFragmentConsumed: scenario === "owner", sourceAccessCalls: 1, outputChecks: 1,
      revokedBeforeContinuation: scenario === "revoked", modelRequestsAfterRevocation: 0, semanticCalls: 0,
      ...(flag === "native-memory-producers" ? { nativeSessionNewExecuted: true, nativeWikiCompileExecuted: true, nativeCompiledClaimRead: true } : {}),
      ...(acceptance ? { schemaVersion: "stella.host-memory-acceptance-probe/v1", scope: "native_fragment_guarded_direct", fullMemoryBindingValid: true,
        nativeIndexMode: acceptanceCase!.indexMode ?? "fts", nativeVectorQueryVerified: true, preparationEmbeddingRequests: 2,
        nativeProvider: acceptanceCase!.provider, nativeProducerVerified: true, wikiCompiledClaimRequired: acceptanceCase!.provider === "memory-wiki", modelRequestsAfterInvalidation: 0,
        consumerEmbeddingRequests: 0, capabilityPassed: ["success", "generation-changed"].includes(acceptance),
        finalCalls: ["success", "generation-changed"].includes(acceptance) ? 1 : 0,
        nativeReads: ["success", "generation-changed", "native-stale-before-model", "unbound-output"].includes(acceptance) || acceptanceCase!.provider === "memory-wiki" && acceptance === "native-cache-invalidated" ? 2 : ["native-mismatch", "source-deleted-before-model", "grant-revoked-before-model", "native-cache-invalidated", "vector-invalidated-before-model", "cache-invalidated-before-model", "vector-generation-changed-before-model"].includes(acceptance) || acceptanceCase!.provider === "memory-wiki" && acceptance === "index-missing" ? 1 : 0,
        modelCalls: ["grant-denied", "source-denied", "payload-transform", "unbound-source-verdict"].includes(acceptance) ? 0 : 1,
        receiptInvalidatedByGeneration: acceptance === "generation-changed", dreamingExecuted: false, privateMainAccepted: false, issue23Complete: false } : {}),
      ...(native ? { schemaVersion: "stella.native-memory-consumption/v1", nativeFamily: native[0], nativeState: native[1],
        terminalStatus: native[1] === "success" ? "ok" : "error", providerRequests: native[1] === "success" ? 3 : 2,
        finalAnswers: native[1] === "success" ? 1 : 0, actualNativeBytesConsumed: native[1] === "success",
        nativeReadExecuted: native[1] !== "missing", nativeReads: native[1] === "missing" ? [] : [{ result: native[1] === "mismatch" ? null : {} }],
        nativeConsumerEmbeddingRequests: 0, nativeLookupMode: native[0] === "wiki" ? "compiled-corpus" : "readonly-exact-fts-index", nativeIndexRemoved: native[1] === "missing", staleNativeArtifactRetained: native[1] === "stale",
        nativeFinalToolOriginalConsumed: native[1] === "success", wikiCompiledClaimCacheRequired: native[0] === "wiki",
        nativeSource: { claimId: "compiled-claim" }, nativeReadFailure: native[1] === "missing" ? "native_memory_index_unavailable" : native[1] === "mismatch" ? "native_memory_read_unverifiable" : undefined,
        changedNativeBytesRejected: native[1] === "mismatch", modelRequestsAfterInvalidation: 0,
        embeddingCacheReuseVerified: native[0] === "cache", embeddingRequests: 2,
        nativePreparation: { cold: { cache: { entries: 1 } }, warm: { cache: { entries: 1 } } } } : {}),
    } as Record<string, unknown> };
  });
  probes.find(probe => probe.flag === "capability-acceptance")!.report.memoryInventory = {
    complete: false, blockers: ["host_memory_consumption_unverifiable"], configurationHash: `sha256:${"c".repeat(64)}`,
    entries: [...HOST_NATIVE_MEMORY_ENTRANCES, "additional_plugin"].map((kind, index) => ({ kind, state: "unverifiable",
      identityHash: `sha256:${index.toString(16).padStart(64, "0")}` })),
  };
  return { nativeEntrances: HOST_NATIVE_MEMORY_ENTRANCES, pluginIds: HOST_MEMORY_PLUGIN_IDS, probes, coreRevision, artifactSha256 };
}

test("alignment accounts for opaque installed plugins without granting full-memory admission", () => {
  const result = evidence.alignHostMemoryEvidence(fixture());
  assert.equal(result.aligned, true);
  assert.equal(result.native.length, HOST_NATIVE_MEMORY_ENTRANCES.length);
  const unknown = result.observedEntries.find(row => row.kind === "additional_plugin")!;
  assert.equal(unknown.status, "observed_only");
  assert.ok(unknown.gaps?.length);
  assert.equal(result.complete, false);
  assert.equal(result.fullMemoryAccepted, false);
  assert.equal(result.issue23Complete, false);
});

test("native evidence requires real reads, cache reuse and zero continuation after invalidation", () => {
  for (const [flag, patch] of [
    ["native-memory-fts-success", { nativeReadExecuted: false }],
    ["native-memory-wiki-success", { nativeReads: [] }],
    ["native-memory-session-stale", { modelRequestsAfterInvalidation: 1 }],
    ["native-memory-fts-mismatch", { changedNativeBytesRejected: false }],
    ["native-memory-cache-success", { embeddingCacheReuseVerified: false }],
    ["native-memory-cache-success", { nativeConsumerEmbeddingRequests: 1 }],
    ["native-memory-cache-success", { nativeLookupMode: "semantic-search" }],
    ["native-memory-cache-missing", { nativeReadExecuted: true }],
    ["native-memory-cache-missing", { nativeIndexRemoved: false }],
    ["native-memory-cache-missing", { nativeReadFailure: undefined }],
    ["native-memory-wiki-success", { wikiCompiledClaimCacheRequired: false }],
    ["native-memory-wiki-success", { nativeFinalToolOriginalConsumed: false }],
    ["native-memory-wiki-mismatch", { nativeReads: [{ result: { content: "old page" } }] }],
    ["native-memory-producers", { nativeSessionNewExecuted: false }],
    ["native-memory-producers", { nativeCompiledClaimRead: false }],
  ] as const) {
    const input = fixture(); Object.assign(input.probes.find(probe => probe.flag === flag)!.report, patch);
    assert.throws(() => evidence.alignHostMemoryEvidence(input));
  }
});

test("alignment refuses mixed versions, incomplete evidence and newly unmapped entrances", () => {
  for (const mutate of [
    (input: Input) => { input.probes[0]!.coreRevision = "d".repeat(40); },
    (input: Input) => { input.probes[0]!.artifactSha256 = "d".repeat(64); },
    (input: Input) => { input.probes[0]!.passed = false; },
    (input: Input) => { input.probes.splice(0, 1); },
    (input: Input) => { input.probes.push(input.probes[0]!); },
    (input: Input) => { input.nativeEntrances = [...input.nativeEntrances, "unknown_native_entry"]; },
    (input: Input) => { input.pluginIds = [...input.pluginIds, "new-memory-plugin"]; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => evidence.alignHostMemoryEvidence(input));
  }
});

test("audience evidence requires actual consumption and rejects disclosure after revocation", () => {
  for (const [flag, patch] of [
    ["source-audience-owner", { sourceAccessCalls: 0 }],
    ["source-audience-owner", { authorizedFragmentConsumed: false }],
    ["source-audience-group", { semanticCalls: 1 }],
    ["source-audience-visitor", { providerRequests: 1 }],
    ["source-audience-revoked", { modelRequestsAfterRevocation: 1 }],
    ["host-ingress-prependContext", { unknownInputConsumed: true }],
    ["host-ingress-bootstrap", { fullMemoryAccepted: true }],
  ] as const) {
    const input = fixture(); Object.assign(input.probes.find(probe => probe.flag === flag)!.report, patch);
    assert.throws(() => evidence.alignHostMemoryEvidence(input));
  }
});

test("backend certification requires native producer, claim cache and zero calls after invalidation", () => {
  for (const [flag, patch] of [
    ["memory-access-success", { nativeIndexMode: "vector" }],
    ["memory-access-session-memory-success", { nativeProducerVerified: false }],
    ["memory-access-memory-wiki-success", { wikiCompiledClaimRequired: false }],
    ["memory-access-memory-wiki-success", { nativeProvider: "memory-core" }],
    ["memory-access-session-memory-source-deleted-before-model", { finalCalls: 1 }],
    ["memory-access-memory-wiki-grant-revoked-before-model", { modelRequestsAfterInvalidation: 1 }],
    ["memory-access-memory-wiki-native-cache-invalidated", { capabilityPassed: true }],
  ] as const) {
    const input = fixture(); Object.assign(input.probes.find(probe => probe.flag === flag)!.report, patch);
    assert.throws(() => evidence.alignHostMemoryEvidence(input));
  }
});


test("vector evidence requires actual native query preparation and forbids consumer embedding calls", () => {
  for (const [flag, patch] of [
    ["memory-access-vector-success", { nativeVectorQueryVerified: false }],
    ["memory-access-vector-success", { preparationEmbeddingRequests: 0 }],
    ["memory-access-vector-success", { nativeIndexMode: "fts" }],
    ["memory-access-vector-success", { consumerEmbeddingRequests: 1 }],
    ["memory-access-vector-vector-invalidated-before-model", { modelRequestsAfterInvalidation: 1 }],
    ["memory-access-vector-cache-invalidated-before-model", { capabilityPassed: true }],
  ] as const) {
    const input = fixture(); Object.assign(input.probes.find(probe => probe.flag === flag)!.report, patch);
    assert.throws(() => evidence.alignHostMemoryEvidence(input));
  }
});
