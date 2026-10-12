import assert from "node:assert/strict";
import test from "node:test";
import { HOST_NATIVE_MEMORY_ENTRANCES, HOST_MEMORY_PLUGIN_IDS } from "../src/openclaw/host-memory-inventory.js";

type Probe = { flag: string; passed: boolean; coreRevision: string; artifactSha256: string; report: Record<string, unknown> };
type Input = { nativeEntrances: readonly string[]; pluginIds: readonly string[]; probes: Probe[]; coreRevision: string; artifactSha256: string };
// Plain Node acceptance tooling is outside the runtime TypeScript compilation.
const evidence = await import(new URL("../../scripts/lib/host-memory-evidence.mjs", import.meta.url).href) as {
  HOST_MEMORY_EVIDENCE_PROBES: readonly string[];
  alignHostMemoryEvidence(input: Input): { aligned: boolean; complete: boolean; fullMemoryAccepted: boolean;
    issue23Complete: boolean; native: unknown[]; observedEntries: Array<{ kind: string; status: string; gaps?: string[] }> };
};
function fixture(): Input {
  const coreRevision = "a".repeat(40), artifactSha256 = "b".repeat(64);
  const probes = evidence.HOST_MEMORY_EVIDENCE_PROBES.map(flag => {
    const scenario = flag.startsWith("source-audience-") ? flag.slice("source-audience-".length) : undefined;
    const field = flag.startsWith("host-ingress-") ? flag.slice("host-ingress-".length) : undefined;
    return { flag, passed: true, coreRevision, artifactSha256, report: {
      schemaVersion: "stella.host-memory-boundary-probe/v1", evidenceDirectory: "/synthetic/evidence", dreamingEnabled: false,
      fullMemoryAccepted: false, realModelAccepted: false, unknownInputConsumed: false, dispatch: [{}], audienceScenario: scenario, ingressField: field,
      terminalStatus: scenario === "owner" ? "ok" : "error", providerRequests: scenario === "owner" ? 3 : scenario === "revoked" ? 2 : 0,
      finalAnswers: scenario === "owner" ? 1 : 0, authorizedFragmentConsumed: scenario === "owner", sourceAccessCalls: 1, outputChecks: 1,
      revokedBeforeContinuation: scenario === "revoked", modelRequestsAfterRevocation: 0, semanticCalls: 0,
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
