import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CatalogReader, parseMemoryCatalog, CatalogError } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { retrieveCatalogEvidence, type SemanticRetrievalConfig } from "../src/canghai/semantic-retrieval.js";
import {
  parseRetrievalCheckpoint,
  retrieve,
  resumeRetrieve,
  resolveTemporalPurpose,
  toPublicRetrieveReport,
} from "../src/canghai/retrieve.js";
import type { SourceAccessDescriptor } from "../src/canghai/source-access.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import {
  createDefaultMemoryAccessVerify,
  createDefaultSemanticRetrievalVerify,
  createMemoryAccessCapabilityAdapter,
  createSemanticRetrievalCapabilityAdapter,
} from "../src/acceptance/retrieval-capability.js";
import {
  createMemoryCapabilityReceiptStore,
  type CapabilityHostBinding,
  type CapabilityVersionBinding,
} from "../src/acceptance/capability-receipt.js";
import { runConstrainedCapabilityAcceptance } from "../src/acceptance/capability-acceptance.js";

const config: SemanticRetrievalConfig = {
  schemaVersion: "stella.semantic-retrieval/v1",
  pageSize: 16,
  maxRounds: 2,
  maxSelected: 4,
  maxOriginalChars: 96000,
};

async function catalogFixture(t: { after(fn: () => Promise<void>): void }, entries: Array<{
  id: string; bytes: string; description: string;
  occurredAt: string | null; authoredAt: string | null; capturedAt: string;
}>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-retrieve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, bytes: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  };
  const policy = {
    schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner",
    readPurposes: ["read"], derivePurposes: ["derive"], deliveryScopes: ["direct"],
    retention: "retain", authorityEvidenceRefs: [],
  };
  const policyRef = { id: policy.id, version: objectVersion(policy) };
  const policyBytes = canonicalJson(policy);
  await put("policy.json", policyBytes);
  const catalog = parseMemoryCatalog({
    schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null,
    sources: [], evidence: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [],
    policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } }],
  });
  const descriptors: SourceAccessDescriptor[] = [];
  for (const entry of entries) {
    await put(`original-${entry.id}.txt`, entry.bytes);
    const imported = await prepareRepositorySource({
      root, collectionId: "fixture", sourceId: entry.id, relativePath: `original-${entry.id}.txt`,
      expectedSha256: bytesVersion(entry.bytes), capturedAt: entry.capturedAt, objectRoot: "objects", policyRef,
    });
    for (const object of imported.objects) {
      if (object.group === "evidence") {
        const rewritten: Record<string, unknown> = {
          ...(object.object as Record<string, unknown>),
          occurredAt: entry.occurredAt,
          authoredAt: entry.authoredAt,
          capturedAt: entry.capturedAt,
        };
        const ref = { id: String(rewritten.id), version: objectVersion(rewritten) };
        const bytes = canonicalJson({ ...rewritten, version: ref.version });
        object.ref = ref;
        object.object = { ...rewritten, version: ref.version };
        object.bytes = bytes;
        object.entry = { ...ref, status: "current", dependencies: object.entry.dependencies,
          locator: { path: object.entry.locator.path, sha256: bytesVersion(bytes) } };
      }
      await put(object.entry.locator.path, object.bytes);
      catalog[object.group].push(object.entry);
    }
    descriptors.push({ sourceRef: imported.sourceRef, policyRef, description: entry.description });
  }
  await put("catalog.json", canonicalJson(catalog));
  const reader = await CatalogReader.load(root, "catalog.json");
  return { root, catalog, descriptors, reader };
}

test("budget exhaustion keeps a resumable checkpoint and resume revalidates authority", async (t) => {
  const { descriptors, reader } = await catalogFixture(t, [
    { id: "1", bytes: "Polite reply only", description: "courtesy signal",
      occurredAt: "2026-08-01T00:00:00Z", authoredAt: "2026-08-01T00:00:00Z", capturedAt: "2026-08-01T00:00:00Z" },
    { id: "2", bytes: "Long-term reciprocity counterevidence", description: "counterevidence",
      occurredAt: "2026-08-10T00:00:00Z", authoredAt: "2026-08-10T00:00:00Z", capturedAt: "2026-08-10T00:00:00Z" },
  ]);
  const purpose = resolveTemporalPurpose(
    { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
    "current",
  );
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("No action judgment"); });
  let reviews = 0;
  const first = await retrieve({
    requestId: "req-1", question: "Calibrate relationship investment", revision: "a".repeat(40),
    generationId: reader.catalog.generationId, temporalScope: "current",
    purpose, requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: { config: { ...config, maxRounds: 1 } },
    resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    assertProcessingCurrent: async () => {},
    complete: async ({ prompt }) => {
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      if (data.candidates) {
        return { provider: "synthetic", model: "model", text: JSON.stringify({
          selected: data.candidates.some((c: { handle: string }) => c.handle === "E1") ? ["E1"] : [],
        }) };
      }
      reviews++;
      return { provider: "synthetic", model: "model", text: JSON.stringify({
        stopped: false, nextIntents: ["Read reciprocity counterevidence"], reason: "Need counterevidence",
      }) };
    },
  });
  assert.equal(first.status, "resource_exhausted");
  if (first.status !== "resource_exhausted") return;
  assert.equal(first.checkpoint.schemaVersion, "stella.retrieval-checkpoint/v1");
  assert.equal(first.checkpoint.roundsCompleted, 1);
  assert.deepEqual(first.checkpoint.nextIntents, ["Read reciprocity counterevidence"]);
  assert.equal(first.refs.length, 1);
  parseRetrievalCheckpoint(first.checkpoint);
  const publicReport = toPublicRetrieveReport(first);
  assert.equal(publicReport.status, "resource_exhausted");
  assert.ok(!JSON.stringify(publicReport).includes("Polite reply only"));
  assert.ok(!JSON.stringify(publicReport).includes("Long-term reciprocity"));

  let authorityChecks = 0;
  const resumed = await resumeRetrieve({
    checkpoint: first.checkpoint,
    question: "Calibrate relationship investment",
    purpose, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    resourceBudget: { config: { ...config, maxRounds: 2 } },
    assertProcessingCurrent: async () => { authorityChecks++; },
    complete: async ({ prompt }) => {
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      if (data.candidates) {
        return { provider: "synthetic", model: "model", text: JSON.stringify({
          selected: data.candidates.some((c: { handle: string }) => c.handle === "E2") ? ["E2"] : [],
        }) };
      }
      assert.ok(data.intents.includes("Read reciprocity counterevidence"));
      assert.equal(data.originals.length, 2);
      return { provider: "synthetic", model: "model", text: JSON.stringify({
        stopped: true, nextIntents: [], reason: "Courtesy and counterevidence both read",
      }) };
    },
  });
  assert.equal(resumed.status, "complete");
  if (resumed.status !== "complete") return;
  assert.equal(resumed.refs.length, 2);
  assert.ok(authorityChecks >= 1);
  assert.equal(reviews, 1);
});

test("historical knownBy rejects post-hoc capture while eventWindow keeps fact-validity distinct", async (t) => {
  const { descriptors, reader } = await catalogFixture(t, [
    { id: "past", bytes: "Event happened in July", description: "july event known then",
      occurredAt: "2026-07-01T00:00:00Z", authoredAt: "2026-07-02T00:00:00Z", capturedAt: "2026-07-02T00:00:00Z" },
    { id: "later-report", bytes: "August report of the July event", description: "post-hoc report",
      occurredAt: "2026-07-01T00:00:00Z", authoredAt: "2026-08-15T00:00:00Z", capturedAt: "2026-08-15T00:00:00Z" },
    { id: "out-of-window", bytes: "September event", description: "later event",
      occurredAt: "2026-09-01T00:00:00Z", authoredAt: "2026-09-01T00:00:00Z", capturedAt: "2026-09-01T00:00:00Z" },
  ]);
  const temporalScope = {
    knownBy: "2026-07-31T00:00:00Z",
    eventWindow: { from: "2026-07-01T00:00:00Z", to: "2026-07-31T23:59:59Z" },
  };
  const purpose = resolveTemporalPurpose(
    { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
    temporalScope,
  );
  assert.equal(purpose.evidenceCutoff, temporalScope.knownBy);
  assert.deepEqual(purpose.eventWindow, temporalScope.eventWindow);
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("No action judgment"); });
  const readable: string[] = [];
  for (const entry of reader.catalog.evidence.filter(e => e.status === "current")) {
    try {
      readable.push((await resolver.readEvidence({ id: entry.id, version: entry.version })).text);
    } catch (error) {
      assert.ok(error instanceof CatalogError);
      assert.ok(error.category === "evidence_after_cutoff" || error.category === "evidence_outside_event_window");
    }
  }
  assert.deepEqual(readable, ["Event happened in July"]);

  const result = await retrieveCatalogEvidence({
    question: "What was known in July?",
    resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model", config,
    assertProcessingCurrent: async () => {},
    complete: async ({ prompt }) => {
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      if (data.candidates) {
        return { provider: "synthetic", model: "model", text: JSON.stringify({
          selected: data.candidates.map((c: { handle: string }) => c.handle),
        }) };
      }
      return { provider: "synthetic", model: "model", text: JSON.stringify({
        stopped: true, nextIntents: [], reason: "Historical stop",
      }) };
    },
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.refs.length, 1);
});

test("retrieve distinguishes empty coverage gap, not-ready and source fault", async (t) => {
  const { descriptors, reader } = await catalogFixture(t, []);
  const purpose = resolveTemporalPurpose(
    { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
    "current",
  );
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("No action judgment"); });
  const empty = await retrieve({
    requestId: "empty", question: "Anything?", revision: "a".repeat(40), generationId: "one",
    temporalScope: "current", purpose, requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: { config }, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    assertProcessingCurrent: async () => {},
    complete: async () => { throw new Error("Must not call model for empty catalog"); },
  });
  assert.equal(empty.status, "coverage_gap");
  assert.equal(toPublicRetrieveReport(empty).status, "coverage_gap");

  const notReady = await retrieve({
    requestId: "nr", question: "Anything?", revision: "a".repeat(40), generationId: "one",
    temporalScope: "current", purpose, requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: { config }, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    assertProcessingCurrent: async () => {},
    complete: async () => { throw new Error("Must not call model while not ready"); },
    readiness: async () => ({ status: "not_ready", category: "index_not_ready" }),
  });
  assert.equal(notReady.status, "not_ready");
  if (notReady.status !== "not_ready") return;
  assert.equal(notReady.category, "index_not_ready");

  const fault = await retrieve({
    requestId: "fault", question: "Anything?", revision: "a".repeat(40), generationId: "one",
    temporalScope: "current", purpose, requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: { config }, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    assertProcessingCurrent: async () => {},
    complete: async () => { throw new Error("Must not call model on fault"); },
    readiness: async () => ({ status: "fault", category: "source_unavailable" }),
  });
  assert.equal(fault.status, "fault");
  if (fault.status !== "fault") return;
  assert.equal(fault.category, "source_unavailable");
});

test("retrieve maps stale_generation to generation_mismatch fault", async (t) => {
  const { descriptors, reader } = await catalogFixture(t, [
    { id: "1", bytes: "One fact", description: "fact",
      occurredAt: "2026-08-01T00:00:00Z", authoredAt: "2026-08-01T00:00:00Z", capturedAt: "2026-08-01T00:00:00Z" },
  ]);
  const purpose = resolveTemporalPurpose(
    { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
    "current",
  );
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("No action judgment"); });
  const assertCurrent = reader.assertCurrent.bind(reader);
  reader.assertCurrent = async () => { throw new CatalogError("stale_generation"); };
  const fault = await retrieve({
    requestId: "stale", question: "Anything?", revision: "a".repeat(40), generationId: reader.catalog.generationId,
    temporalScope: "current", purpose, requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: { config }, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    assertProcessingCurrent: async () => {},
    complete: async () => { throw new Error("Must not call model"); },
  });
  reader.assertCurrent = assertCurrent;
  assert.equal(fault.status, "fault");
  if (fault.status !== "fault") return;
  assert.equal(fault.category, "generation_mismatch");
});

test("retrieve reports coverage_gap when temporal scope filters all candidates", async (t) => {
  const { descriptors, reader } = await catalogFixture(t, [
    { id: "later", bytes: "September only", description: "later",
      occurredAt: "2026-09-01T00:00:00Z", authoredAt: "2026-09-01T00:00:00Z", capturedAt: "2026-09-01T00:00:00Z" },
  ]);
  const temporalScope = { knownBy: "2026-07-31T00:00:00Z" };
  const purpose = resolveTemporalPurpose(
    { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
    temporalScope,
  );
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("No action judgment"); });
  const gap = await retrieve({
    requestId: "gap", question: "July?", revision: "a".repeat(40), generationId: reader.catalog.generationId,
    temporalScope, purpose, requiredCapabilities: ["semantic_retrieval"],
    resourceBudget: { config }, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
    assertProcessingCurrent: async () => {},
    complete: async () => { throw new Error("Must not call model"); },
  });
  assert.equal(gap.status, "coverage_gap");
});

test("memory_access and semantic_retrieval constrained adapters issue passed and failed version receipts", async () => {
  const store = createMemoryCapabilityReceiptStore();
  const binding = (): CapabilityVersionBinding => ({
    core: bytesVersion("core"), artifact: bytesVersion("artifact"), host: bytesVersion("host"),
    harness: bytesVersion("harness"), source: bytesVersion("source"), profile: bytesVersion("profile"),
    policy: bytesVersion("policy"), configuration: bytesVersion("configuration"),
    model: bytesVersion("model"), cases: bytesVersion("cases"),
  });
  const hostFor = (capabilityId: string): CapabilityHostBinding => ({
    actorHash: bytesVersion("operator"), runId: "run_retrieve",
    purpose: { kind: "adapter_verification", capabilityId },
    resourceScope: bytesVersion("scope"),
  });
  const memoryReceipt = await runConstrainedCapabilityAcceptance({
    adapter: createMemoryAccessCapabilityAdapter({
      verify: async () => ({ outcome: "passed", executionDigest: bytesVersion("memory-access-ok") }),
    }),
    host: hostFor("memory_access"), captureBinding: async () => binding(), store,
  });
  assert.equal(memoryReceipt.capabilityId, "memory_access");
  assert.equal(memoryReceipt.result, "passed");
  assert.equal(memoryReceipt.businessAdmission, false);

  const failed = await runConstrainedCapabilityAcceptance({
    adapter: createSemanticRetrievalCapabilityAdapter({
      verify: async () => ({ outcome: "failed", executionDigest: bytesVersion("semantic-retrieval-denied") }),
    }),
    host: hostFor("semantic_retrieval"), captureBinding: async () => binding(), store,
  });
  assert.equal(failed.capabilityId, "semantic_retrieval");
  assert.equal(failed.result, "failed");
});

test("default constrained capability verify hooks run retrieve and read slices", async () => {
  const host = (capabilityId: string) => ({
    actorHash: bytesVersion("operator"), runId: "verify_run",
    purpose: { kind: "adapter_verification" as const, capabilityId },
    resourceScope: bytesVersion("scope"),
  });
  const memory = await createDefaultMemoryAccessVerify()({ mode: "constrained_acceptance", host: host("memory_access") });
  assert.equal(memory.outcome, "passed");
  const semantic = await createDefaultSemanticRetrievalVerify()({ mode: "constrained_acceptance", host: host("semantic_retrieval") });
  assert.equal(semantic.outcome, "passed");
});
