import { relative } from "node:path";
import { CatalogError } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { parseConsciousnessManifest, type LoadedConsciousness } from "../canghai/manifest.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { readPersonalContextAccessBinding } from "../canghai/personal-context-access.js";
import { type ProcessingAuthority } from "../openclaw/processing-authority.js";
import type { SemanticRoutingCandidates } from "../routing/router.js";
import { episodeContextRefs } from "./episode-evidence.js";
import { listSemanticRoutingCandidates } from "./packet.js";
import type { PraxisRuntimeMemory } from "./runtime-memory.js";
import { loadPraxisRuntimeBinding, type PraxisRuntimeBinding } from "./runtime-binding.js";

import { collectContextSources, type ContextSources } from "./context-sources.js";

type Binding = ContextSources & {
  memory: Awaited<ReturnType<PraxisRuntimeMemory["listMemory"]>>;
  runtime: PraxisRuntimeMemory; authority: ProcessingAuthority; candidates: SemanticRoutingCandidates;
  assertCurrent(): Promise<void>;
};
const bindings = new WeakMap<object, Binding>();
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
const cortexInputs = new WeakMap<object, { loaded: LoadedConsciousness; binding: PraxisRuntimeBinding }>();

export async function readPreparedRoutingCandidates(prepared: object): Promise<Binding> {
  const binding = bindings.get(prepared);
  check(binding, "routing_candidates_unbound");
  check("candidates" in prepared && canonicalJson(prepared.candidates) === canonicalJson(binding.candidates), "routing_candidates_changed");
  check("memory" in prepared && canonicalJson(prepared.memory) === canonicalJson(binding.memory), "routing_candidates_changed");
  await binding.assertCurrent();
  check("candidates" in prepared && canonicalJson(prepared.candidates) === canonicalJson(binding.candidates), "routing_candidates_changed");
  check("memory" in prepared && canonicalJson(prepared.memory) === canonicalJson(binding.memory), "routing_candidates_changed");
  const { runtime, assertCurrent, ...snapshot } = binding;
  return { ...structuredClone(snapshot), runtime, assertCurrent };
}

/** Compile the existing candidates from their actual repository inputs.
 * This records all candidates before selection, not just the eventual picks. */
export async function prepareRoutingCandidates(input: {
  loaded: LoadedConsciousness; runtime: PraxisRuntimeMemory; binding: PraxisRuntimeBinding;
  authority: ProcessingAuthority; processingGrant?: object; assertCurrent(): Promise<void>;
}) {
  const loaded = structuredClone(input.loaded), binding = structuredClone(input.binding), authority = structuredClone(input.authority);
  const { runtime } = input, resolver = runtime.evidence, reader = resolver.reader;
  check(reader.root === loaded.canghaiRoot && authority.privateContextAllowed && reader.catalog.generationId === authority.generationId,
    "routing_candidates_scope_mismatch");
  check(canonicalJson(binding.purpose) === canonicalJson(authority.purpose), "routing_candidates_scope_mismatch");
  check(loaded.praxisPlaybookItems.length === 0, "legacy_learning_migration_required");
  await input.assertCurrent();
  check(canonicalJson(await loadPraxisRuntimeBinding(loaded)) === canonicalJson(binding), "routing_binding_changed");
  const sources = collectContextSources(resolver, authority, input.assertCurrent);
  const pinFile = sources.pinFile;
  const manifest = await pinFile(relative(reader.root, loaded.manifestPath));
  let currentManifest;
  try { currentManifest = parseConsciousnessManifest(manifest.toString("utf8")); }
  catch { throw new CatalogError("routing_manifest_invalid"); }
  check(canonicalJson(currentManifest) === canonicalJson(loaded.manifest), "routing_input_changed");
  for (const path of [binding.configPath, ...binding.profileAuthorityPaths]) await pinFile(path);
  const profile = loaded.bootstrapDocuments.find(document => document.field === "identity.runtimeProfileRef");
  check(profile, "routing_profile_required");
  await pinFile(parseCangHaiRef(profile.ref).relativePath, profile.content);
  if (binding.personalContextAccessPath || resolver.purpose.sourceAccess) {
    check(input.processingGrant, "routing_processing_grant_required");
    const grant = await readPersonalContextAccessBinding(input.processingGrant);
    check(grant.root === reader.root && grant.path === binding.personalContextAccessPath && grant.config.ownerId === authority.ownerId &&
      grant.config.requesterIds.includes(authority.senderId ?? "") && grant.config.viewProcessingModelRefs?.includes(authority.modelRef) &&
      canonicalJson(grant.config.purpose) === canonicalJson(authority.purpose), "routing_processing_grant_mismatch");
    check(bytesVersion(await pinFile(grant.path)) === grant.sha256, "routing_processing_grant_mismatch");
  }
  for (const document of loaded.bootstrapDocuments.filter(document => document.category === "twin" || document.category === "framework")) {
    const sourceRef = binding.referenceBindings.find(item => item.routingRef === document.ref)?.sourceRef;
    check(sourceRef, "cognitive_source_binding_required");
    await sources.document(document.ref, document.content, sourceRef);
  }
  const captured = await resolver.captureReads(() => runtime.listMemory());
  const memory = captured.value;
  for (const ref of captured.metadata) await sources.visit(ref);
  for (const original of captured.originals) await sources.visit(original.ref);
  for (const item of memory.learningItems) {
    const ref = await runtime.selectedLearning(item.ref);
    await sources.visit(ref);
    const understanding = await reader.read(ref, "understandings");
    check(typeof understanding.originChangeId === "string", "invalid_learning_change");
    await sources.visit(reader.currentRef(understanding.originChangeId, "changes"));
  }
  for (const item of memory.openEpisodes) {
    const snapshot = await runtime.selectedEpisode(item.ref);
    await pinFile(runtime.repository.currentPath(snapshot.episode.id), canonicalJson(snapshot.episode));
    for (const ref of episodeContextRefs(snapshot.episode)) await sources.visit(ref);
  }
  const assertCurrent = sources.assertCurrent;
  const candidates = listSemanticRoutingCandidates({ ...loaded, praxisPlaybookItems: memory.learningItems }, memory.openEpisodes);
  await assertCurrent();
  const prepared = { candidates, memory, assertCurrent };
  bindings.set(prepared, { memory: structuredClone(memory), runtime, authority, candidates: structuredClone(candidates),
    ...sources.snapshot(), assertCurrent });
  cortexInputs.set(prepared, { loaded, binding });
  return prepared;
}

/** Expand only the selected renderer's additional inputs. Identity documents
 * are not candidate descriptions and therefore need their own source bindings. */
export async function readPreparedCortexSources(prepared: object, includeIdentity: boolean) {
  const base = await readPreparedRoutingCandidates(prepared);
  const stored = cortexInputs.get(prepared);
  check(stored, "routing_candidates_unbound");
  const { loaded, binding } = structuredClone(stored);
  const sources = collectContextSources(base.runtime.evidence, base.authority, base.assertCurrent, base);
  if (includeIdentity) for (const document of loaded.bootstrapDocuments.filter(document => document.category === "identity")) {
    const sourceRef = binding.referenceBindings.find(item => item.routingRef === document.ref)?.sourceRef;
    check(sourceRef, "cognitive_source_binding_required");
    await sources.document(document.ref, document.content, sourceRef);
  }
  await sources.assertCurrent();
  return { ...base, loaded: { ...loaded, praxisPlaybookItems: structuredClone(base.memory.learningItems) },
    ...sources.snapshot(), assertCurrent: sources.assertCurrent };
}
