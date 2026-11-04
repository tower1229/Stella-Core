import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { persistHostInputArchive } from "../src/canghai/archive-writer.js";
import { createFixture, prepareInitializationFixture } from "./consciousness-fixture.js";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { parseCangHaiRef } from "../src/canghai/ref.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { loadPraxisRuntimeBinding, createBoundPraxisRuntime } from "../src/praxis/runtime-binding.js";
import { prepareRoutingCandidates, readPreparedRoutingCandidates } from "../src/praxis/routing-context.js";
import { bindProcessingAuthority } from "../src/openclaw/processing-authority.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, includeIdentity = false,
  complete: Parameters<typeof createBoundPraxisRuntime>[2] = async () => { throw new Error("No model call expected"); }) {
  const root = await realpath(await createFixture());
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareInitializationFixture(root, "stella");
  const loaded = await loadConsciousness(root);
  const binding = await loadPraxisRuntimeBinding(loaded);
  const reader = await CatalogReader.load(root, binding.catalogPath);
  for (const document of loaded.bootstrapDocuments.filter(doc => includeIdentity || doc.category === "framework" || doc.category === "twin")) {
    const source = await prepareRepositorySource({ root, collectionId: "synthetic-routing", sourceId: document.ref,
      relativePath: parseCangHaiRef(document.ref).relativePath, expectedSha256: bytesVersion(document.content),
      capturedAt: "2026-09-06T00:00:00Z", policyRef: binding.archive.policyRef, objectRoot: "30_PersonalData/memory/objects" });
    for (const object of source.objects) {
      await mkdir(path.dirname(path.join(root, object.entry.locator.path)), { recursive: true });
      await writeFile(path.join(root, object.entry.locator.path), object.bytes);
      reader.catalog[object.group].push(object.entry);
    }
    binding.referenceBindings.push({ routingRef: document.ref, sourceRef: source.sourceRef });
  }
  await writeFile(path.join(root, "dependency-only.txt"), "Synthetic upstream independent of cognitive candidates");
  const dependencySource = await prepareRepositorySource({ root, collectionId: "synthetic-routing", sourceId: "direct-dependency",
    relativePath: "dependency-only.txt", expectedSha256: bytesVersion("Synthetic upstream independent of cognitive candidates"),
    capturedAt: "2026-09-06T00:00:00Z", policyRef: binding.archive.policyRef, objectRoot: "30_PersonalData/memory/objects" });
  for (const object of dependencySource.objects) {
    await mkdir(path.dirname(path.join(root, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(root, object.entry.locator.path), object.bytes);
    reader.catalog[object.group].push(object.entry);
  }
  await writeFile(path.join(root, binding.catalogPath), canonicalJson(reader.catalog));
  const config = JSON.parse(await readFile(path.join(root, binding.configPath), "utf8"));
  config.referenceBindings = binding.referenceBindings;
  await writeFile(path.join(root, binding.configPath), canonicalJson(config));
  const request = snapshotTurnRequest({ agentId: "stella", sessionId: "routing-session", sessionKey: "agent:stella:main",
    senderId: "owner-fixture", senderIsOwner: true, chatType: "direct", prompt: "Continue this discussion" }, "routing-run");
  const ingress = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2026-09-06T00:00:00Z" },
    { ...binding.archive, ownerId: "owner-fixture" });
  await persistHostInputArchive({ reader: await CatalogReader.load(root, binding.catalogPath), archive: ingress,
    operationId: "routing-ingress", purpose: binding.purpose }, { persist: async () => {}, confirmPreviouslyCommitted: async () => {} });
  const runtime = await createBoundPraxisRuntime(loaded, binding, complete, async () => {});
  const current = { request, purpose: binding.purpose, modelRef: "synthetic/synthetic", deployment: bytesVersion("synthetic-deployment"), generationId: runtime.evidence.reader.catalog.generationId };
  const authority = bindProcessingAuthority({ ...current, ownerId: "owner-fixture" });
  const input = { loaded, binding, runtime, authority, assertCurrent: () => runtime.evidence.reader.assertCurrent() };
  return { root, input, ingress, dependencySource, request };
}

test("routing candidates bind real repository documents and reject copied or mutated receipts", async t => {
  const f = await fixture(t);
  const prepared = await prepareRoutingCandidates(f.input);
  assert.ok(prepared.candidates.twin.length);
  assert.ok(prepared.candidates.frameworks.length);
  await readPreparedRoutingCandidates(prepared);
  await assert.rejects(readPreparedRoutingCandidates({ ...prepared }), /routing_candidates_unbound/);
  prepared.memory.learningItems.push({ ref: "unbound", content: "Unbound learning", domains: [] });
  await assert.rejects(readPreparedRoutingCandidates(prepared), /routing_candidates_changed/);
});

test("unselected cognitive source changes invalidate prepared routing data", async t => {
  const f = await fixture(t);
  const prepared = await prepareRoutingCandidates(f.input);
  const source = f.input.loaded.bootstrapDocuments.find(doc => doc.category === "twin")!;
  const file = path.join(f.root, parseCangHaiRef(source.ref).relativePath);
  await writeFile(file, source.content + "\nChanged after preparation\n");
  await assert.rejects(readPreparedRoutingCandidates(prepared), /routing_input_changed/);
});

test("missing cognitive bindings and changed profile configuration fail before route inference", async t => {
  const f = await fixture(t);
  const binding = structuredClone(f.input.binding);
  binding.referenceBindings = [];
  await assert.rejects(prepareRoutingCandidates({ ...f.input, binding }), /routing_binding_changed/);
  const prepared = await prepareRoutingCandidates(f.input);
  await writeFile(path.join(f.root, f.input.binding.configPath), "{}");
  await assert.rejects(readPreparedRoutingCandidates(prepared), /routing_input_changed/);
});

test("open Episode candidates retain current Episode bytes and their original ingress dependency", async t => {
  const f = await fixture(t), now = "2026-09-06T00:00:00Z";
  const episode = { schemaVersion: "stella.praxis-episode/v2" as const, id: "candidate-episode", status: "open" as const,
    createdAt: now, updatedAt: now, recoveryPriority: "important" as const, provenance: { messageRefs: ["synthetic-message"] },
    historicalInputRefs: f.ingress.evidenceRefs, situation: { summary: "Unselected ongoing discussion", domains: ["writing"], observations: ["Owner discussion"] } };
  await f.input.runtime.repository.apply({ operationId: "routing-episode", expectedVersion: null, episode });
  const prepared = await prepareRoutingCandidates(f.input);
  assert.equal(prepared.candidates.openEpisodes?.length, 1);
  const receipt = await readPreparedRoutingCandidates(prepared);
  const selected = await f.input.runtime.selectedEpisode(prepared.candidates.openEpisodes![0]!.ref);
  assert.ok(receipt.configurationInputs.some(input => input.path === f.input.runtime.repository.historicalPath(episode.id, selected.version)));
  assert.equal(receipt.configurationInputs.some(input => input.path === f.input.runtime.repository.currentPath(episode.id)), false);
  const file = path.join(f.root, f.input.runtime.repository.currentPath(episode.id));
  const previous = await readFile(file, "utf8");
  await writeFile(file, previous + " ");
  await assert.rejects(readPreparedRoutingCandidates(prepared), /routing_input_changed/);
  await writeFile(file, previous);
  await readPreparedRoutingCandidates(prepared);
  await writeFile(path.join(f.root, f.ingress.payload.path), "Changed original owner input");
  await assert.rejects(readPreparedRoutingCandidates(prepared), /payload_digest_mismatch/);
});

test("unselected learning candidates preserve the originals of their Learning Change", async t => {
  const f = await fixture(t), now = "2026-09-06T00:00:00Z";
  const reader = await CatalogReader.load(f.root, f.input.binding.catalogPath);
  const understanding = { schemaVersion: "stella.understanding/v1", id: "routing-learning", kind: "strategy", status: "active",
    statement: "Keep unresolved writing questions visible", scope: { workIds: [], contexts: [], domains: ["writing"], global: false },
    supportRefs: f.ingress.evidenceRefs, counterRefs: [], dependencyRefs: [f.dependencySource.sourceRef], originChangeId: "routing-change", createdAt: now, updatedAt: now };
  const ref = { id: understanding.id, version: objectVersion(understanding) };
  const change = { schemaVersion: "stella.learning-change/v1", id: "routing-change", inputRefs: f.ingress.evidenceRefs, targetRefs: [ref],
    operationId: "synthetic-learning", algorithmVersion: "synthetic", modelRef: "synthetic/synthetic", promptVersion: "synthetic",
    disposition: "update", rationale: "Synthetic fixture", changes: [{ kind: "create", before: null, after: ref, supportRefs: f.ingress.evidenceRefs, counterRefs: [] }] };
  for (const [group, object, dependencies] of [["understandings", understanding, [...f.ingress.evidenceRefs, f.dependencySource.sourceRef]], ["changes", change, [...f.ingress.evidenceRefs, ref]]] as const) {
    const version = objectVersion(object), bytes = canonicalJson({ ...object, version }), file = `${object.id}.json`;
    await writeFile(path.join(f.root, file), bytes);
    reader.catalog[group].push({ id: object.id, version, status: "current", dependencies: [...dependencies], locator: { path: file, sha256: bytesVersion(bytes) } });
  }
  await writeFile(path.join(f.root, f.input.binding.catalogPath), canonicalJson(reader.catalog));
  const runtime = await createBoundPraxisRuntime(f.input.loaded, f.input.binding, async () => { throw new Error("No model call expected"); }, async () => {});
  const prepared = await prepareRoutingCandidates({ ...f.input, runtime, assertCurrent: () => runtime.evidence.reader.assertCurrent() });
  assert.equal(prepared.candidates.personalPraxis.length, 1);
  const receipt = await readPreparedRoutingCandidates(prepared);
  assert.ok(receipt.originals.some(original => original.ref.id === f.ingress.evidenceRefs[0]!.id));
  await writeFile(path.join(f.root, "dependency-only.txt"), "Changed direct Source dependency");
  await assert.rejects(readPreparedRoutingCandidates(prepared), /payload_digest_mismatch/);
});


test("cached profile and manifest snapshots cannot certify replacement configuration", async t => {
  const f = await fixture(t);
  const profile = f.input.loaded.bootstrapDocuments.find(document => document.field === "identity.runtimeProfileRef")!;
  const file = path.join(f.root, parseCangHaiRef(profile.ref).relativePath);
  await writeFile(file, profile.content + "\n# Replaced since load\n");
  await assert.rejects(prepareRoutingCandidates(f.input), /routing_input_changed/);
});

test("a configuration change during the final authority recheck prevents candidate issuance", async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(prepareRoutingCandidates({ ...f.input, assertCurrent: async () => {
    await f.input.runtime.evidence.reader.assertCurrent();
    if (++calls === 3) await writeFile(path.join(f.root, f.input.binding.configPath), "{}");
  } }), /routing_input_changed/);
});


test("a direct Episode Source dependency cannot survive payload deletion without a catalog edit", async t => {
  const f = await fixture(t), now = "2026-09-06T00:00:00Z";
  await f.input.runtime.repository.apply({ operationId: "direct-source-episode", expectedVersion: null, episode: {
    schemaVersion: "stella.praxis-episode/v2", id: "direct-source-episode", status: "open", createdAt: now, updatedAt: now,
    recoveryPriority: "important", provenance: { messageRefs: ["synthetic-source"] }, historicalInputRefs: [f.dependencySource.sourceRef],
    situation: { summary: "Derived from an independently retained source", domains: ["writing"], observations: [] },
  } });
  const prepared = await prepareRoutingCandidates(f.input);
  await readPreparedRoutingCandidates(prepared);
  await rm(path.join(f.root, "dependency-only.txt"));
  await assert.rejects(readPreparedRoutingCandidates(prepared), /source_unavailable/);
});

test("malformed manifest replacements never expose private YAML in diagnostics", async t => {
  const f = await fixture(t);
  await writeFile(f.input.loaded.manifestPath, "private_marker: [PRIVATE_MANIFEST_TOKEN");
  await assert.rejects(prepareRoutingCandidates(f.input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /routing_manifest_invalid/);
    assert.doesNotMatch(error.message, /PRIVATE_MANIFEST_TOKEN/);
    return true;
  });
});


test("segment Evidence retains its authorized slice while a direct Source cannot broaden that grant", async t => {
  const f = await fixture(t), now = "2026-09-06T00:00:00Z";
  const text = await readFile(path.join(f.root, "dependency-only.txt"), "utf8");
  const source = await prepareRepositorySource({ root: f.root, collectionId: "synthetic-routing", sourceId: "direct-dependency",
    relativePath: "dependency-only.txt", expectedSha256: bytesVersion(text), capturedAt: now,
    policyRef: f.input.binding.archive.policyRef, objectRoot: "30_PersonalData/memory/objects",
    reviewedSegments: [ { start: 0, end: 9, policyRef: f.input.binding.archive.policyRef },
      { start: 9, end: Buffer.byteLength(text), policyRef: f.input.binding.archive.policyRef } ] });
  const reader = await CatalogReader.load(f.root, f.input.binding.catalogPath);
  for (const object of source.objects) {
    if (reader.catalog[object.group].some(entry => entry.id === object.ref.id && entry.version === object.ref.version)) continue;
    for (const entry of reader.catalog[object.group]) if (entry.id === object.ref.id) entry.status = "superseded";
    await mkdir(path.dirname(path.join(f.root, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(f.root, object.entry.locator.path), object.bytes);
    reader.catalog[object.group].push(object.entry);
  }
  await writeFile(path.join(f.root, f.input.binding.catalogPath), canonicalJson(reader.catalog));
  const grantPath = "50_PersonalAgent/stella/routing-access.json";
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner-fixture", requesterIds: ["owner-fixture"],
    modelRefs: ["synthetic/synthetic"], viewProcessingModelRefs: ["synthetic/synthetic"], purpose: f.input.binding.purpose,
    descriptors: [{ sourceRef: source.sourceRef, policyRef: f.input.binding.archive.policyRef,
      segment: { payloadSha256: bytesVersion(text), start: 0, end: 9 }, description: "Synthetic permitted fragment" }] };
  await writeFile(path.join(f.root, grantPath), canonicalJson(grant));
  const profileFile = path.join(f.root, "50_PersonalAgent/stella/runtime-profile.yaml");
  const profile = parse(await readFile(profileFile, "utf8"));
  profile.capabilities.push({ id: "source_access_context", required: true, adapter_id: "stella.personal-context-access", adapter_version: "1",
    config_ref: `path:${grantPath}`, acceptance_ref: "path:50_PersonalAgent/stella/capability-acceptance.json", required_secret_refs: [] });
  await writeFile(profileFile, stringify(profile));
  const loaded = await loadConsciousness(f.root), binding = await loadPraxisRuntimeBinding(loaded);
  const processingGrant = await loadPersonalContextAccess(f.root, grantPath);
  const access = createPersonalContextAccess({ request: f.request, modelRef: "synthetic/synthetic", binding: processingGrant,
    assertRequestCurrent: () => {}, complete: async ({ prompt }) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      return { text: canonicalJson({ requestHash: input.requestHash, sourceRef: input.sourceRef, policyRef: input.policyRef,
        segment: input.segment, applicable: true, scenarios: ["writing"], topicRequested: true, topicExplicitlyNamed: true }) };
    } });
  const runtime = await createBoundPraxisRuntime(loaded, binding, async () => { throw new Error("Unexpected action inference"); }, async () => {}, access);
  await runtime.repository.apply({ operationId: "segment-episode", expectedVersion: null, episode: {
    schemaVersion: "stella.praxis-episode/v2", id: "a-segment", status: "open", createdAt: now, updatedAt: now, recoveryPriority: "important",
    provenance: { messageRefs: ["synthetic-fragment"] }, historicalInputRefs: [source.evidenceRefs[0]!],
    situation: { summary: "Only the selected fragment", domains: ["writing"], observations: [] },
  } });
  const input = { loaded, binding, runtime, authority: f.input.authority, processingGrant, assertCurrent: () => runtime.evidence.reader.assertCurrent() };
  const prepared = await prepareRoutingCandidates(input);
  const receipt = await readPreparedRoutingCandidates(prepared);
  assert.equal(receipt.originals.find(original => original.ref.id === source.evidenceRefs[0]!.id)?.text, "Synthetic");
  assert.equal(receipt.payloads.some(payload => payload.source.id === source.sourceRef.id), false);
  await writeFile(path.join(f.root, grantPath), canonicalJson({ ...grant, requesterIds: ["another-owner"] }));
  await assert.rejects(readPreparedRoutingCandidates(prepared), /routing_input_changed|personal_context_access_changed/);
  await writeFile(path.join(f.root, grantPath), canonicalJson(grant));
  await runtime.repository.apply({ operationId: "whole-source-episode", expectedVersion: null, episode: {
    schemaVersion: "stella.praxis-episode/v2", id: "z-whole", status: "open", createdAt: now, updatedAt: now, recoveryPriority: "important",
    provenance: { messageRefs: ["synthetic-unbound-whole-source"] }, historicalInputRefs: [source.sourceRef],
    situation: { summary: "Cannot claim adjacent source content", domains: ["writing"], observations: [] },
  } });
  await assert.rejects(prepareRoutingCandidates(input), /segmented_source_requires_evidence/);
});
