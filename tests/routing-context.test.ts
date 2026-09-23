import { readContextInputTrace, type ContextInputTrace } from "../src/openclaw/host-context-graph.js";
import { prepareEvidenceBoundOutcome, readPreparedOutcomeContext } from "../src/praxis/outcome-preparation.js";
import { prepareOutcomeTransaction } from "../src/praxis/outcome-transaction.js";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { generateKeyPairSync } from "node:crypto";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { persistHostInputArchive } from "../src/canghai/archive-writer.js";
import { persistContextHistory, loadContextHistory } from "../src/openclaw/host-context-history.js";
import { createFixture, prepareInitializationFixture } from "./consciousness-fixture.js";
import { loadConsciousness } from "../src/canghai/manifest.js";
import { parseCangHaiRef } from "../src/canghai/ref.js";
import { CatalogReader } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { loadPraxisRuntimeBinding, createBoundPraxisRuntime } from "../src/praxis/runtime-binding.js";
import { createSemanticRouter } from "../src/routing/semantic-router.js";
import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";
import { renderSelectedCortexContext } from "../src/praxis/cortex-context.js";
import { prepareRoutingCandidates, readPreparedRoutingCandidates } from "../src/praxis/routing-context.js";
import { bindProcessingAuthority } from "../src/openclaw/processing-authority.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { compileInitializationSource } from "../src/openclaw/initialization-source.js";
import { HostContextAuthority } from "../src/openclaw/host-context-authority.js";

function assertProducerParents(graph: ContextInputTrace, content: string, expected: string[]) {
  const node = graph.nodes.find(node => node.producer === "derived" && node.content === content);
  assert.ok(node, "The actual producer output must be present in the signed graph");
  assert.deepEqual(node.parents.map(id => graph.nodes.find(parent => parent.id === id)!.content), expected);
}
async function graphFor(gate: HostContextAuthority, consumption: Parameters<HostContextAuthority["historySnapshot"]>[0]) {
  const snapshot = await gate.historySnapshot(consumption);
  return readContextInputTrace(snapshot.graph, snapshot.input, snapshot);
}

async function fixture(t: { after(fn: () => Promise<void>): void }, includeIdentity = false,
  complete: Parameters<typeof createBoundPraxisRuntime>[2] = async () => { throw new Error("No model call expected"); }) {
  const root = await realpath(await createFixture());
  t.after(() => rm(root, { recursive: true, force: true }));
  const recipe = await prepareInitializationFixture(root, "stella");
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
  const compilation = await compileInitializationSource(root, recipe, { agentId: "stella", hostVersion: "2026.8.2" });
  const configurationHash = bytesVersion("synthetic-configuration");
  const keys = generateKeyPairSync("ed25519");
  const createGate = () => new HostContextAuthority(runtime.evidence, request, { authority, compilation, configurationHash,
    historyVerificationKey: keys.publicKey, captureCurrent: async () => ({ ...current, compilation, configurationHash }) });
  const gate = createGate();
  const input = { loaded, binding, runtime, authority, assertCurrent: () => runtime.evidence.reader.assertCurrent() };
  return { root, input, gate, createGate, keys, ingress, dependencySource, request };
}

test("routing candidates bind real repository documents and reject copied or mutated receipts", async t => {
  const f = await fixture(t);
  const prepared = await prepareRoutingCandidates(f.input);
  assert.ok(prepared.candidates.twin.length);
  assert.ok(prepared.candidates.frameworks.length);
  const fragment = await f.gate.routingCandidates(prepared);
  assert.equal(await f.gate.renderContext([fragment]), canonicalJson(prepared.candidates));
  await assert.rejects(readPreparedRoutingCandidates({ ...prepared }), /routing_candidates_unbound/);
  prepared.memory.learningItems.push({ ref: "unbound", content: "Unbound learning", domains: [] });
  await assert.rejects(f.gate.routingCandidates(prepared), /routing_candidates_changed/);
});

test("unselected cognitive source changes invalidate an already minted routing fragment and derived summary", async t => {
  const f = await fixture(t);
  const prepared = await prepareRoutingCandidates(f.input);
  const fragment = await f.gate.routingCandidates(prepared);
  const summary = await f.gate.summarize([fragment], async () => ({ text: '{"summary":"Synthetic route summary"}', modelRef: "synthetic/synthetic" }));
  const source = f.input.loaded.bootstrapDocuments.find(doc => doc.category === "twin")!;
  const file = path.join(f.root, parseCangHaiRef(source.ref).relativePath);
  await writeFile(file, source.content + "\nChanged after preparation\n");
  await assert.rejects(f.gate.renderContext([fragment]), /host_context_configuration_input_changed|payload_digest_mismatch/);
  await assert.rejects(f.gate.renderContext([summary]), /host_context_configuration_input_changed|payload_digest_mismatch/);
  await assert.rejects(readPreparedRoutingCandidates(prepared), /routing_input_changed/);
});

test("missing cognitive bindings and changed profile configuration fail before route inference", async t => {
  const f = await fixture(t);
  const binding = structuredClone(f.input.binding);
  binding.referenceBindings = [];
  await assert.rejects(prepareRoutingCandidates({ ...f.input, binding }), /routing_binding_changed/);
  const prepared = await prepareRoutingCandidates(f.input);
  await writeFile(path.join(f.root, f.input.binding.configPath), "{}");
  await assert.rejects(f.gate.routingCandidates(prepared), /routing_input_changed/);
});


test("candidate provenance survives signed archival and rejects source deletion on fresh authority restore", async t => {
  const f = await fixture(t);
  await f.gate.bindArchivedInput(f.ingress.evidenceRefs[0]!);
  const candidates = await f.gate.routingCandidates(await prepareRoutingCandidates(f.input));
  const sealed = await f.gate.seal({ system: f.gate.publicRules(), messages: [
    { role: "user", fragment: candidates }, { role: "user", fragment: f.gate.currentInput() },
  ] });
  // Synthetic durability ports: this tests signed provenance restoration, not remote persistence.
  const retained = await persistContextHistory(f.gate, sealed.consumption, { archiveRoot: "synthetic-history", signingKey: f.keys.privateKey,
    durability: { syncCritical: async () => ({ state: "synchronized", localRevision: "a".repeat(40) }), confirmPreviouslyCommitted: async () => {} } });
  const archive = await loadContextHistory(f.root, { archiveRoot: "synthetic-history", digest: retained.locator.sha256 }, f.keys.publicKey);
  const fresh = f.createGate();
  await fresh.renderContext([await fresh.restoreHistory(archive)]);
  const document = f.input.loaded.bootstrapDocuments.find(doc => doc.category === "framework")!;
  await rm(path.join(f.root, parseCangHaiRef(document.ref).relativePath));
  await assert.rejects(fresh.restoreHistory(archive), /host_context_configuration_input_unavailable/);
});

test("open Episode candidates retain current Episode bytes and their original ingress dependency", async t => {
  const f = await fixture(t), now = "2026-09-06T00:00:00Z";
  const episode = { schemaVersion: "stella.praxis-episode/v2" as const, id: "candidate-episode", status: "open" as const,
    createdAt: now, updatedAt: now, recoveryPriority: "important" as const, provenance: { messageRefs: ["synthetic-message"] },
    historicalInputRefs: f.ingress.evidenceRefs, situation: { summary: "Unselected ongoing discussion", domains: ["writing"], observations: ["Owner discussion"] } };
  await f.input.runtime.repository.apply({ operationId: "routing-episode", expectedVersion: null, episode });
  const prepared = await prepareRoutingCandidates(f.input);
  assert.equal(prepared.candidates.openEpisodes?.length, 1);
  const fragment = await f.gate.routingCandidates(prepared);
  const file = path.join(f.root, f.input.runtime.repository.currentPath(episode.id));
  const previous = await readFile(file, "utf8");
  await writeFile(file, previous + " ");
  await assert.rejects(f.gate.renderContext([fragment]), /host_context_configuration_input_changed/);
  await writeFile(file, previous);
  await f.gate.renderContext([fragment]);
  await writeFile(path.join(f.root, f.ingress.payload.path), "Changed original owner input");
  await assert.rejects(f.gate.renderContext([fragment]), /payload_digest_mismatch/);
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
  await f.gate.bindArchivedInput(f.ingress.evidenceRefs[0]!);
  const fragment = await f.gate.routingCandidates(await prepareRoutingCandidates(f.input));
  await f.gate.renderContext([fragment]);
  const sealed = await f.gate.seal({ system: f.gate.publicRules(), messages: [
    { role: "user", fragment }, { role: "user", fragment: f.gate.currentInput() },
  ] });
  const retained = await persistContextHistory(f.gate, sealed.consumption, { archiveRoot: "synthetic-direct-history", signingKey: f.keys.privateKey,
    durability: { syncCritical: async () => ({ state: "synchronized", localRevision: "a".repeat(40) }), confirmPreviouslyCommitted: async () => {} } });
  const archive = await loadContextHistory(f.root, { archiveRoot: "synthetic-direct-history", digest: retained.locator.sha256 }, f.keys.publicKey);
  await f.createGate().restoreHistory(archive);
  await rm(path.join(f.root, "dependency-only.txt"));
  await assert.rejects(f.gate.renderContext([fragment]), /source_unavailable/);
  await assert.rejects(f.createGate().restoreHistory(archive), /source_unavailable/);
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


async function prepareCortex(f: Awaited<ReturnType<typeof fixture>>, mode: "ordinary" | "twin" | "praxis") {
  const prepared = await prepareRoutingCandidates(f.input);
  const route = await createSemanticRouter(async () => ({ provider: "synthetic", model: "synthetic", text: canonicalJson({
    mode, responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["writing"],
    needsTwin: mode !== "ordinary", needsFramework: mode === "praxis", needsReality: mode === "praxis", needsExternalResearch: false,
    candidateTwinRefs: prepared.candidates.twin.slice(0, 1).map(candidate => candidate.ref),
    candidateFrameworks: prepared.candidates.frameworks.slice(0, 1).map(candidate => candidate.ref), candidatePraxisRefs: [],
    stakes: "low", reversibility: "high", situation: { actors: ["owner"], observations: ["A writing question"], interpretations: [],
      unknowns: [], userGoals: ["Continue thinking"], constraints: [] },
  }) }))(f.request.prompt, prepared.candidates);
  const candidates = await f.gate.routingCandidates(prepared);
  const routeFragment = await f.gate.semanticRoute(route, candidates);
  return { prepared, route, routeFragment, dataMode: "read_only" as const };
}

test("the fixed Cortex compiler requires genuine routing and binds actual identity documents only for Twin", async t => {
  const missing = await fixture(t);
  const input = await prepareCortex(missing, "twin");
  await assert.rejects(missing.gate.cortexContext(input), /cognitive_source_binding_required/);
  const f = await fixture(t, true);
  await f.gate.bindArchivedInput(f.ingress.evidenceRefs[0]!);
  const ordinary = await f.gate.cortexContext(await prepareCortex(f, "ordinary"));
  const twinInput = await prepareCortex(f, "twin");
  await assert.rejects(f.gate.cortexContext({ ...twinInput, route: { ...twinInput.route } }), /semantic_route_context_unbound/);
  await assert.rejects(f.gate.cortexContext({ ...twinInput, routeFragment: ordinary.context }), /host_context_route_scope_mismatch/);
  const twin = await f.gate.cortexContext(twinInput);
  const rendered = await f.gate.renderContext([twin.context]);
  assert.equal(rendered, renderSelectedCortexContext({ loaded: f.input.loaded, route: twinInput.route, question: f.request.prompt,
    openEpisodes: [], dataMode: "read_only" }));
  const identity = f.input.loaded.bootstrapDocuments.find(document => document.field === "identity.soulRef")!;
  assert.ok(rendered.includes(identity.content));
  const sealed = await f.gate.seal({ system: f.gate.publicRules(), messages: [{ role: "user", fragment: twin.context },
    { role: "user", fragment: f.gate.currentInput() }] });
  const graph = await graphFor(f.gate, sealed.consumption);
  assertProducerParents(graph, canonicalJson(twinInput.route), [f.request.prompt, canonicalJson(twinInput.prepared.candidates)]);
  assertProducerParents(graph, rendered, [canonicalJson(twinInput.route)]);
  const retained = await persistContextHistory(f.gate, sealed.consumption, { archiveRoot: "synthetic-twin-history", signingKey: f.keys.privateKey,
    durability: { syncCritical: async () => ({ state: "synchronized", localRevision: "a".repeat(40) }), confirmPreviouslyCommitted: async () => {} } });
  const history = await loadContextHistory(f.root, { archiveRoot: "synthetic-twin-history", digest: retained.locator.sha256 }, f.keys.publicKey);
  await f.createGate().restoreHistory(history);
  await writeFile(path.join(f.root, parseCangHaiRef(identity.ref).relativePath), "Changed owner identity after compilation");
  await f.gate.renderContext([ordinary.context]);
  await assert.rejects(f.gate.renderContext([twin.context, twin.responseContract]), /host_context_configuration_input_changed|payload_digest_mismatch/);
  await assert.rejects(f.createGate().restoreHistory(history), /host_context_configuration_input_changed|payload_digest_mismatch/);
});

test("question refinement re-renders Praxis and its response contract from the bound assessment", async t => {
  const f = await fixture(t);
  await f.gate.bindArchivedInput(f.ingress.evidenceRefs[0]!);
  const input = await prepareCortex(f, "praxis");
  const first = await f.gate.cortexContext(input);
  const priorContext = await f.gate.renderContext([first.context]);
  const assessed = await prepareQuestionEvidence({ requestId: f.request.runId, question: f.request.prompt,
    revision: "a".repeat(40), route: input.route, priorContext, resolver: f.input.runtime.evidence,
    complete: async () => ({ provider: "synthetic", model: "synthetic", text: canonicalJson({ status: "material_unknown", claims: [],
      unresolvedLeads: [{ question: "Which premise remains unresolved?", material: true, reason: "The owner has not settled it" }],
      suggestedResponseKind: "clarification", stoppingReason: "Known material limit" }) }) });
  const assessment = await f.gate.questionEvidence(assessed, { route: input.routeFragment, prior: [first.context] });
  const revised = await f.gate.cortexContext({ ...input, assessment: { prepared: assessed, fragment: assessment } });
  const context = await f.gate.renderContext([revised.context]);
  const packet = JSON.parse(context.split("\n").at(-2)!);
  assert.equal(packet.responseKind, "clarification");
  assert.equal(packet.evidenceStatus, "material_unknown");
  assert.deepEqual(packet.materialUnknowns, ["Which premise remains unresolved?"]);
  const contract = await f.gate.renderContext([revised.responseContract]);
  assert.deepEqual(JSON.parse(contract.slice("response_contract: ".length)), {
    responseKind: "clarification", evidenceStatus: "material_unknown", materialUnknowns: ["Which premise remains unresolved?"],
  });
  const sealed = await f.gate.seal({ system: f.gate.publicRules(), messages: [{ role: "user", fragment: revised.context }] });
  const graph = await graphFor(f.gate, sealed.consumption);
  const assessedText = await f.gate.renderContext([assessment]);
  assertProducerParents(graph, assessedText, [canonicalJson(input.route), priorContext]);
  assertProducerParents(graph, context, [canonicalJson(input.route), assessedText]);
  assert.equal(input.route.responseKind, "answer", "The genuine router receipt remains unchanged");
  await assert.rejects(f.gate.cortexContext({ ...input, assessment: { prepared: { ...assessed }, fragment: assessment } }), /host_context_question_producer_required/);
  await assert.rejects(f.gate.cortexContext({ ...input, assessment: { prepared: assessed, fragment: first.context } }), /host_context_question_producer_required/);
  const copiedAssessment = await f.gate.summarize([first.context], async () => ({
    text: canonicalJson({ summary: canonicalJson(assessed) }), modelRef: "synthetic/synthetic",
  }));
  assert.equal(await f.gate.renderContext([copiedAssessment]), canonicalJson(assessed));
  await assert.rejects(f.gate.cortexContext({ ...input, assessment: { prepared: assessed, fragment: copiedAssessment } }),
    /host_context_question_producer_required/, "Matching model-generated bytes cannot mint a question producer credential");
  await writeFile(path.join(f.root, "dependency-only.txt"), "An assessed original was edited");
  await assert.rejects(f.gate.renderContext([revised.context]), /payload_digest_mismatch/);
});


for (const disposition of ["ready", "needs_clarification"] as const) test(`outcome context binds the real selection, computation and transaction (${disposition})`, async t => {
  const now = "2026-09-06T00:00:00Z";
  let refs: Array<{ id: string; version: string }> = [];
  const actual = { action: "Discussed the writing question", occurredAt: null, source: "user_report", evidenceRefs: refs };
  const outcome = { observations: ["The question is still open"], result: "More evidence is needed", observedAt: now, evidenceRefs: refs };
  let verifierModel = "synthetic";
  const f = await fixture(t, false, async ({ prompt }) => ({ provider: "synthetic", model: verifierModel, text: canonicalJson(
    prompt.includes("reported-outcome evidence verifier") ? { supported: true, outcome, rationale: "Synthetic verification" }
      : { ...actual, supported: true, rationale: "Synthetic verification" }) }));
  refs = f.ingress.evidenceRefs;
  actual.evidenceRefs = refs; outcome.evidenceRefs = refs;
  await f.input.runtime.recommend({ operationId: "outcome-context-advice", recordedAt: now, decision: { recommendation: "Discuss the question", rationale: [] },
    episode: { schemaVersion: "stella.praxis-episode/v2", id: "outcome-context", status: "open", createdAt: now, updatedAt: now,
      recoveryPriority: "normal", provenance: {}, historicalInputRefs: refs,
      situation: { summary: "An unresolved writing discussion", domains: ["writing"], observations: [] } } });
  await f.gate.bindArchivedInput(refs[0]!);
  const routing = await prepareRoutingCandidates(f.input);
  const ref = routing.candidates.openEpisodes![0]!.ref;
  const route = await createSemanticRouter(async params => ({ provider: "synthetic", model: "synthetic", text: canonicalJson(params.purpose === "stella-core-open-episode-selection" ? { openEpisodeRef: null } : { mode: "outcome",
    responseKind: "outcome_ack", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["writing"],
    needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false, outcome: { openEpisodeRef: ref } }) }))(
      f.request.prompt, routing.candidates);
  const routeFragment = await f.gate.semanticRoute(route, await f.gate.routingCandidates(routing));
  const selected = await f.input.runtime.selectedEpisode(ref);
  const prepareOutcome = () => prepareEvidenceBoundOutcome({ request: f.request.prompt, selected, recordedAt: now, resolver: f.input.runtime.evidence,
    complete: async () => ({ provider: "synthetic", model: "synthetic", text: canonicalJson(disposition === "ready" ? {
      disposition, actual, outcome, predictionAssessment: "unresolved", learning: { disposition: "no_change", evidenceRefs: refs,
        rationale: "An unresolved question does not establish a reusable strategy" } } : { disposition, question: "Which discussion does this result refer to?" }) }) });
  const prepared = await prepareOutcome();
  assert.equal(prepared.disposition, disposition);
  const receipt = await readPreparedOutcomeContext(prepared);
  assert.equal(receipt.missingModelReceipt, false);
  assert.deepEqual(receipt.modelRefs, ["synthetic/synthetic"]);
  if (prepared.disposition === "ready") {
    const original = prepared.learning.rationale;
    prepared.learning.rationale = "Temporary unbound explanation to be restored after transaction construction";
    const rejected = prepareOutcomeTransaction({ operationId: f.request.runId, requestId: f.request.runId, revision: "a".repeat(40),
      runtime: f.input.runtime, objectRoot: f.input.binding.archive.objectRoot, prepared });
    prepared.learning.rationale = original;
    await assert.rejects(rejected, /outcome_context_changed/);
  }
  const transaction = prepared.disposition === "ready" ? await prepareOutcomeTransaction({ operationId: f.request.runId,
    requestId: f.request.runId, revision: "a".repeat(40), runtime: f.input.runtime, objectRoot: f.input.binding.archive.objectRoot, prepared }) : undefined;
  const input = { routing, route, routeFragment, prepared, transaction };
  await assert.rejects(f.gate.outcomeContext({ ...input, prepared: { ...prepared } }), /outcome_context_unbound/);
  if (transaction) {
    await assert.rejects(f.gate.outcomeContext({ ...input, transaction: undefined }), /host_context_outcome_transaction_mismatch/);
    await assert.rejects(f.gate.outcomeContext({ ...input, transaction: { ...transaction } }), /outcome_transaction_unbound/);
  }
  if (transaction) {
    const originalRationale = transaction.episode.decision!.recommendation;
    transaction.episode.decision!.recommendation = "Unbound transaction projection";
    await assert.rejects(f.gate.outcomeContext(input), /outcome_transaction_changed/);
    transaction.episode.decision!.recommendation = originalRationale;
    verifierModel = "unauthorized-verifier";
    const mismatched = await prepareOutcome();
    assert.ok(mismatched.disposition === "ready");
    const mismatchedTransaction = await prepareOutcomeTransaction({ operationId: f.request.runId, requestId: f.request.runId,
      revision: "a".repeat(40), runtime: f.input.runtime, objectRoot: f.input.binding.archive.objectRoot, prepared: mismatched });
    await assert.rejects(f.gate.outcomeContext({ ...input, prepared: mismatched, transaction: mismatchedTransaction }), /host_context_outcome_scope_mismatch/);
    verifierModel = "synthetic";
  }
  const rendered = await f.gate.outcomeContext(input);
  const content = JSON.parse(await f.gate.renderContext([rendered.context]));
  assert.equal(content.mode, "outcome");
  if (transaction) {
    assert.deepEqual(content.episode, transaction.episode);
    assert.deepEqual(content.changeRef, transaction.changeRef);
    assert.equal(content.strategyStatus, null);
  } else assert.equal(content.clarification, prepared.disposition === "needs_clarification" ? prepared.question : undefined);
  const contract = JSON.parse((await f.gate.renderContext([rendered.responseContract])).slice("response_contract: ".length));
  assert.equal(contract.responseKind, disposition === "ready" ? "outcome_ack" : "clarification");
  const sealed = await f.gate.seal({ system: f.gate.publicRules(), messages: [{ role: "user", fragment: rendered.context }] });
  await f.gate.assertConsumption(sealed.consumption, sealed.input);
  const graph = await graphFor(f.gate, sealed.consumption);
  assertProducerParents(graph, canonicalJson(route), [f.request.prompt, canonicalJson(routing.candidates)]);
  assertProducerParents(graph, await f.gate.renderContext([rendered.context]), [canonicalJson(route)]);
  const retained = await persistContextHistory(f.gate, sealed.consumption, { archiveRoot: "synthetic-outcome-history", signingKey: f.keys.privateKey,
    durability: { syncCritical: async () => ({ state: "synchronized", localRevision: "a".repeat(40) }), confirmPreviouslyCommitted: async () => {} } });
  const archive = await loadContextHistory(f.root, { archiveRoot: "synthetic-outcome-history", digest: retained.locator.sha256 }, f.keys.publicKey);
  await f.createGate().restoreHistory(archive);
  await writeFile(path.join(f.root, "dependency-only.txt"), "Changed an unselected original read during outcome assessment");
  await assert.rejects(f.createGate().restoreHistory(archive), /payload_digest_mismatch/);
  await assert.rejects(f.gate.assertConsumption(sealed.consumption, sealed.input), /payload_digest_mismatch/);
  await assert.rejects(readPreparedOutcomeContext(prepared), /payload_digest_mismatch/);
});
