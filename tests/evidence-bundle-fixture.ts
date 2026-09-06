import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import type { EvidenceBundle } from "../src/praxis/evidence-bundle.js";

export function syntheticBundle(): EvidenceBundle {
  const value = { schemaVersion: "stella.evidence-bundle/v1" as const, id: "synthetic-bundle", version: "",
    requestId: "synthetic-request", revision: "a".repeat(40), generationId: "synthetic-generation",
    status: "material_unknown" as const, claims: [], searchedCoverageRefs: [], readEvidenceRefs: [],
    unresolvedLeads: [{ question: "What happened before this request?", material: true, reason: "No original history in this synthetic fixture" }],
    stopping: { reason: "Explicitly empty synthetic source scope", modelRef: "synthetic/injected", promptVersion: "synthetic/v1" },
    suggestedResponseKind: "clarification" as const };
  return { ...value, version: objectVersion(value) };
}

export async function bundleFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = syntheticBundle();
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: bundle.generationId, parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], coverage: [], views: [],
    bundles: [{ id: bundle.id, version: bundle.version, status: "current", dependencies: [],
      locator: { path: "bundle.json", sha256: bytesVersion(canonicalJson(bundle)) } }] };
  const save = async () => {
    bundle.version = objectVersion(bundle);
    catalog.bundles[0]!.version = bundle.version;
    catalog.bundles[0]!.locator.sha256 = bytesVersion(canonicalJson(bundle));
    await writeFile(path.join(root, "bundle.json"), canonicalJson(bundle));
    await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  };
  await save();
  const resolver = () => CatalogReader.load(root, "catalog.json").then((reader) => new EpisodeEvidenceResolver(reader,
    { readPurpose: "synthetic", derivePurpose: "synthetic", deliveryScope: "synthetic", evidenceCutoff: "2026-09-06T00:00:00Z",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No semantic action claim in this fixture"); }));
  const answer = (text: string) => ({ text, bundleRef: { id: bundle.id, version: bundle.version },
    requestId: bundle.requestId, revision: bundle.revision, generationId: bundle.generationId });
  return { root, bundle, catalog, save, resolver, answer };
}
