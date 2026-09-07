import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { declarePublicEvaluationSource } from "../src/acceptance/public-evaluation-source.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { parseCangHaiRef } from "../src/canghai/ref.js";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { loadPraxisRuntimeBinding } from "../src/praxis/runtime-binding.js";
import { createFixture } from "./consciousness-fixture.js";

/** Public standalone cases have no pre-existing owner persona or case history. */
export async function createPublicEvaluationFixture(): Promise<string> {
  const root = await realpath(await createFixture({ ownerProfile: "case_only" }));
  // Source and payload identities bind exact bytes, including line endings across Git clients.
  await writeFile(path.join(root, ".gitattributes"), "* -text\n", { flag: "wx" });
  const loaded = await loadConsciousness(root);
  const binding = await loadPraxisRuntimeBinding(loaded);
  const reader = await CatalogReader.load(root, binding.catalogPath);
  const references = new Set(loaded.bootstrapDocuments
    .filter(document => document.field !== "identity.runtimeProfileRef").map(document => document.ref));
  for (const reference of loaded.requiredReferences) {
    if (reference.field.startsWith("frameworks.sources[")) references.add(reference.ref);
  }
  for (const ref of references) {
    const parsed = parseCangHaiRef(ref);
    if (parsed.fragment) throw new Error("public_source_fragment_adapter_required");
    const bytes = await readFile(path.join(root, parsed.relativePath));
    const prepared = await prepareRepositorySource({ root, collectionId: "public-evaluation-fixture",
      sourceId: `public:${parsed.relativePath}`, relativePath: parsed.relativePath, expectedSha256: bytesVersion(bytes),
      capturedAt: "2026-09-07T00:00:00Z", policyRef: binding.archive.policyRef, objectRoot: binding.archive.objectRoot });
    for (const object of prepared.objects) {
      const file = path.join(root, object.entry.locator.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, object.bytes, { flag: "wx" });
      reader.catalog[object.group].push(object.entry);
    }
    binding.referenceBindings.push({ routingRef: ref, sourceRef: prepared.sourceRef });
  }
  await writeFile(path.join(root, binding.catalogPath), canonicalJson(reader.catalog));
  const config = JSON.parse(await readFile(path.join(root, binding.configPath), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(root, binding.configPath), canonicalJson({ ...config, referenceBindings: binding.referenceBindings }));
  await declarePublicEvaluationSource(root);
  return root;
}
