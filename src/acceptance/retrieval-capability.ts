import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogReader, parseMemoryCatalog } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../canghai/content-version.js";
import { prepareRepositorySource } from "../canghai/repository-source.js";
import { retrieve, resumeRetrieve, resolveTemporalPurpose } from "../canghai/retrieve.js";
import type { SemanticRetrievalConfig } from "../canghai/semantic-retrieval.js";
import { EpisodeEvidenceResolver } from "../praxis/episode-evidence.js";
import type { CapabilityAdapter } from "./capability-acceptance.js";

/** Constrained memory_access adapter: verifies authorized original discovery / fragment read surface without business admission. */
export function createMemoryAccessCapabilityAdapter(input: {
  verify: CapabilityAdapter["execute"];
}): CapabilityAdapter {
  return {
    capabilityId: "memory_access",
    adapterId: "stella.memory-access",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    execute: input.verify,
  };
}

/** Constrained semantic_retrieval adapter: verifies recall / counterevidence / temporal / failure semantics without business admission. */
export function createSemanticRetrievalCapabilityAdapter(input: {
  verify: CapabilityAdapter["execute"];
}): CapabilityAdapter {
  return {
    capabilityId: "semantic_retrieval",
    adapterId: "stella.semantic-retrieval",
    adapterVersion: "1",
    allowedEffects: ["observe", "verify"],
    execute: input.verify,
  };
}

export function syntheticRetrievalExecutionDigest(label: string): string {
  return bytesVersion(label);
}

const retrievalConfig: SemanticRetrievalConfig = {
  schemaVersion: "stella.semantic-retrieval/v1",
  pageSize: 16,
  maxRounds: 2,
  maxSelected: 4,
  maxOriginalChars: 96000,
};

/** Default constrained verify: load catalog and read one eligible evidence record. */
export function createDefaultMemoryAccessVerify(): CapabilityAdapter["execute"] {
  return async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-memory-access-verify-"));
    try {
      const put = async (file: string, bytes: string) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), bytes);
      };
      const policy = { schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner", readPurposes: ["read"], derivePurposes: ["derive"], deliveryScopes: ["direct"], retention: "retain", authorityEvidenceRefs: [] };
      const policyRef = { id: policy.id, version: objectVersion(policy) };
      const policyBytes = canonicalJson(policy);
      await put("policy.json", policyBytes);
      const catalog = parseMemoryCatalog({ schemaVersion: "stella.memory-catalog/v1", generationId: "verify", parentGenerationId: null,
        sources: [], evidence: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [],
        policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } }] });
      const bytes = "Readable original";
      await put("original.txt", bytes);
      const imported = await prepareRepositorySource({ root, collectionId: "verify", sourceId: "s1", relativePath: "original.txt",
        expectedSha256: bytesVersion(bytes), capturedAt: "2026-08-01T00:00:00Z", objectRoot: "objects", policyRef });
      for (const object of imported.objects) { await put(object.entry.locator.path, object.bytes); catalog[object.group].push(object.entry); }
      await put("catalog.json", canonicalJson(catalog));
      const reader = await CatalogReader.load(root, "catalog.json");
      const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
        evidenceCutoff: "2026-09-09T00:00:00Z", trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No judgment"); });
      const entry = reader.catalog.evidence[0]!;
      const original = await resolver.readEvidence({ id: entry.id, version: entry.version });
      return { outcome: "passed", executionDigest: bytesVersion(original.text) };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

/** Default constrained verify: retrieve + resumeRetrieve on synthetic catalog. */
export function createDefaultSemanticRetrievalVerify(): CapabilityAdapter["execute"] {
  return async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-semantic-retrieval-verify-"));
    try {
      const put = async (file: string, bytes: string) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), bytes);
      };
      const policy = { schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner", readPurposes: ["read"], derivePurposes: ["derive"], deliveryScopes: ["direct"], retention: "retain", authorityEvidenceRefs: [] };
      const policyRef = { id: policy.id, version: objectVersion(policy) };
      const policyBytes = canonicalJson(policy);
      await put("policy.json", policyBytes);
      const catalog = parseMemoryCatalog({ schemaVersion: "stella.memory-catalog/v1", generationId: "verify", parentGenerationId: null,
        sources: [], evidence: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [],
        policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } }] });
      for (const [id, text] of [["a", "Polite"], ["b", "Counter"]] as const) {
        await put(`original-${id}.txt`, text);
        const imported = await prepareRepositorySource({ root, collectionId: "verify", sourceId: id, relativePath: `original-${id}.txt`,
          expectedSha256: bytesVersion(text), capturedAt: "2026-08-01T00:00:00Z", objectRoot: "objects", policyRef });
        for (const object of imported.objects) { await put(object.entry.locator.path, object.bytes); catalog[object.group].push(object.entry); }
      }
      await put("catalog.json", canonicalJson(catalog));
      const reader = await CatalogReader.load(root, "catalog.json");
      const purpose = resolveTemporalPurpose({ readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct",
        trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, "current");
      const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new Error("No judgment"); });
      const descriptors = [{ sourceRef: { id: reader.catalog.sources[0]!.id, version: reader.catalog.sources[0]!.version }, policyRef, description: "d1" },
        { sourceRef: { id: reader.catalog.sources[1]!.id, version: reader.catalog.sources[1]!.version }, policyRef, description: "d2" }];
      const first = await retrieve({
        requestId: "verify", question: "Relationship?", revision: "a".repeat(40), generationId: reader.catalog.generationId,
        temporalScope: "current", purpose, requiredCapabilities: ["semantic_retrieval"],
        resourceBudget: { config: { ...retrievalConfig, maxRounds: 1 } },
        resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
        assertProcessingCurrent: async () => {},
        complete: async ({ prompt }) => {
          const data = JSON.parse(prompt.split("\n").at(-1)!);
          if (data.candidates) return { provider: "synthetic", model: "model", text: JSON.stringify({ selected: data.candidates[0] ? [data.candidates[0].handle] : [] }) };
          return { provider: "synthetic", model: "model", text: JSON.stringify({ stopped: false, nextIntents: ["Counter"], reason: "More" }) };
        },
      });
      if (first.status !== "resource_exhausted") throw new Error("semantic_retrieval_verify_expected_exhausted");
      const resumed = await resumeRetrieve({
        checkpoint: first.checkpoint, question: "Relationship?", purpose, resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model",
        resourceBudget: { config: retrievalConfig },
        assertProcessingCurrent: async () => {},
        complete: async ({ prompt }) => {
          const data = JSON.parse(prompt.split("\n").at(-1)!);
          if (data.candidates) return { provider: "synthetic", model: "model", text: JSON.stringify({ selected: data.candidates[1] ? [data.candidates[1].handle] : [] }) };
          return { provider: "synthetic", model: "model", text: JSON.stringify({ stopped: true, nextIntents: [], reason: "Done" }) };
        },
      });
      if (resumed.status !== "complete" || resumed.refs.length < 2) throw new Error("semantic_retrieval_verify_resume_failed");
      return { outcome: "passed", executionDigest: bytesVersion(String(resumed.refs.length)) };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}
