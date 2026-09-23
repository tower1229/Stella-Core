import { readContextInputTrace, readContextArchiveGraph } from "../src/openclaw/host-context-graph.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { preparePersonalViews } from "../src/praxis/personal-views.js";
import assert from "node:assert/strict";
import { writeFile, readFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { generateKeyPairSync, sign, createPublicKey } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CatalogReader, type CatalogGroup } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { createFragmentReadTool, readFragmentToolDefinition, readFragmentToolResult, type FragmentToolResultReceipt } from "../src/openclaw/fragment-read-tool.js";
import { ManagedHostContextEngine, registerManagedHostContextEngine, withStellaContextEngine, STELLA_CONTEXT_ENGINE } from "../src/openclaw/host-context-engine.js";
import { HostContextAuthority } from "../src/openclaw/host-context-authority.js";
import { assembleManagedSystemPrompt, projectManagedMessages } from "../src/openclaw/host-context-prompt.js";
import { bindProcessingAuthority, resolveDeploymentDigest } from "../src/openclaw/processing-authority.js";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { coordinateCompletion, completionDraftHash, readActiveCompletionRequest } from "../src/openclaw/completion.js";
import { registerHostMemoryProvider, readHostModelOutput } from "../src/openclaw/host-memory-provider.js";
import { snapshotTurnRequest, type BoundTurnRequest } from "../src/openclaw/turn-request.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";
import { compileInitializationSource } from "../src/openclaw/initialization-source.js";
import { createFixture, prepareInitializationFixture } from "./consciousness-fixture.js";
import { bundleFixture } from "./evidence-bundle-fixture.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { persistHostInputArchive } from "../src/canghai/archive-writer.js";
import { loadContextHistory, readContextHistory, persistContextHistory, recoverContextHistory } from "../src/openclaw/host-context-history.js";
import { applyMemoryTransaction, assertMemoryTransactionReadable } from "../src/canghai/memory-transaction.js";
import {
  loadPublishedHistoryView, publishPreparedHistoryView, readPublishedHistoryView, recoverHistoryView,
  restorePublishedHistoryView,
} from "../src/openclaw/host-context-view.js";
import { viewRecipePath } from "../src/canghai/view-recipe.js";
import { loadContextHistoryHead, publishContextHistoryHead, publishCompletedContextHistoryHead } from "../src/openclaw/host-context-head.js";
import { loadPersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";
import type { RetrievalCheckpoint } from "../src/canghai/retrieve.js";
import { createSemanticRouter } from "../src/routing/semantic-router.js";
import type { CortexRoute } from "../src/routing/router.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, segmented = false) {
  const archiveKeys = generateKeyPairSync("ed25519");
  const base = await bundleFixture(t);
  const initializationRoot = await realpath(await createFixture());
  t.after(() => rm(initializationRoot, { recursive: true, force: true }));
  const recipe = await prepareInitializationFixture(initializationRoot, "stella");
  const compilation = await compileInitializationSource(initializationRoot,
    recipe, { agentId: "stella", hostVersion: "2026.8.2" });
  const now = "2026-09-06T00:00:00Z";
  const put = async (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[] = []) => {
    const ref = { id: String(object.id), version: objectVersion(object) };
    const bytes = canonicalJson({ ...object, version: ref.version });
    const file = `${ref.id}-${ref.version.slice(7)}.json`;
    await writeFile(path.join(base.root, file), bytes);
    for (const entry of base.catalog[group]) if (entry.id === ref.id) entry.status = "superseded";
    base.catalog[group].push({ ...ref, status: "current", dependencies, locator: { path: file, sha256: bytesVersion(bytes) } });
    return ref;
  };
  const policy = await put("policies", { schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner",
    readPurposes: ["synthetic"], derivePurposes: ["synthetic"], deliveryScopes: ["synthetic"], retention: "retain", authorityEvidenceRefs: [] });
  const coverage = await put("coverage", { schemaVersion: "stella.archive-coverage/v1", id: "coverage", adapterId: "synthetic", collectionId: "history",
    scope: { agentIds: ["stella"], roots: [], branchPolicy: "declared_subset", declaredBranches: ["main"] },
    upstreamSnapshot: "synthetic", fromCursor: null, toCursor: "1", expectedCount: 1, retainedCount: 1,
    excludedByPolicyCount: 0, missingItems: [], checkedAt: now, completeForDeclaredScope: true });
  const update = async (text: string) => {
    await writeFile(path.join(base.root, "current.txt"), text);
    const source = await put("sources", { schemaVersion: segmented ? "stella.memory-source/v2" : "stella.memory-source/v1", id: "source",
      ...(segmented ? { accessSegments: [{ payloadSha256: bytesVersion(text), start: 0, end: Buffer.byteLength(text), policyRef: policy }] } : {}),
      origin: { adapterId: "synthetic", collectionId: "history", upstreamId: "1" }, capturedAt: now, policyRef: policy, coverageRef: coverage,
      payloads: [{ path: "current.txt", mediaType: "text/plain", bytes: Buffer.byteLength(text), sha256: bytesVersion(text) }] }, [policy, coverage]);
    const ref = await put("evidence", { schemaVersion: "stella.memory-evidence/v1", id: "evidence", source,
      payloadSha256: bytesVersion(text), selector: { kind: "utf8_bytes", value: `0:${Buffer.byteLength(text)}` },
      speakerId: "owner", role: "owner", kind: "reported", independentOriginId: "source", derivedFrom: [],
      occurredAt: null, authoredAt: now, capturedAt: now, policyRef: policy }, [source, policy]);
    await base.save();
    return ref;
  };
  const evidence = await update("Old interpretation");
  let configurationHash = bytesVersion("reviewed configuration");
  let recoveryRevision = "a".repeat(40);
  const request = snapshotTurnRequest({ agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
    prompt: "Continue this discussion", senderId: "owner", senderIsOwner: true, chatType: "direct" }, "run");
  const createdTools = new WeakMap<HostContextAuthority, ReturnType<typeof createFragmentReadTool>>();
  const create = async (chatType: "direct" | "group" = "direct", withTool = false, currentRequest?: BoundTurnRequest, observeResult?: Parameters<typeof createFragmentReadTool>[0]["observeResult"]) => {
    const boundRequest = currentRequest ?? (chatType === "direct" ? request : snapshotTurnRequest({ ...request, chatType }, request.runId));
    const baseResolver = await base.resolver();
    const resolver = segmented ? new EpisodeEvidenceResolver(baseResolver.reader, { ...baseResolver.purpose,
      sourceAccess: async (_reader, target) => {
        assert.ok(target.segment, "Only the explicitly selected Evidence segment is authorized");
        return { judgment: { scenarios: ["synthetic"], trigger: "user_requested", topicRequested: true,
          topicExplicitlyNamed: true, presentation: "summary" }, quoteGrants: [] };
      } }, baseResolver.complete) : baseResolver;
    const binding = { request: boundRequest, modelRef: "stella-guarded/model", deployment: resolveDeploymentDigest({
      agentId: boundRequest.agentId, recoveryRevision, pluginSource: "synthetic-fixed-plugin" }),
      generationId: resolver.reader.catalog.generationId, purpose: { readPurpose: "synthetic", derivePurpose: "synthetic", deliveryScope: "synthetic" } };
    const processingAuthority = bindProcessingAuthority({ ...binding, ownerId: "owner" });
    const fragmentTool = withTool ? createFragmentReadTool({ resolver, descriptors: [], originals: [], processingAuthority, observeResult,
      assertCurrent: () => resolver.reader.assertCurrent() }) : undefined;
    const authority = new HostContextAuthority(resolver, boundRequest, { authority: processingAuthority, fragmentTool,
      historyVerificationKey: archiveKeys.publicKey,
      configurationHash, compilation,
      captureCurrent: async () => ({ ...binding, configurationHash, compilation,
        generationId: (await CatalogReader.load(base.root, "catalog.json")).catalog.generationId }),
    });
    if (fragmentTool) createdTools.set(authority, fragmentTool);
    return authority;
  };
  return { ...base, archiveKeys, evidence, request, create, update, put, initializationRoot, recipe, toolFor: (authority: HostContextAuthority) => createdTools.get(authority)!,
    advanceRecoveryRevision() { recoveryRevision = "b".repeat(40); },
    changeConfiguration() { configurationHash = bytesVersion("different configuration"); } };
}

async function archivedHeadFixture(t: Parameters<typeof fixture>[0], segmented = false) {
  const f = await fixture(t, segmented);
  const resolver = await f.resolver();
  const evidence = await resolver.reader.read(f.evidence, "evidence");
  const ingress = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request: f.request,
    capturedAt: "2026-09-06T00:00:00Z" }, { policyRef: evidence.policyRef as VersionedRef,
    objectRoot: "objects", payloadRoot: "ingress", ownerId: "owner" });
  await persistHostInputArchive({ reader: resolver.reader, archive: ingress, operationId: "head_ingress", purpose: resolver.purpose }, {
    persist: async () => {}, confirmPreviouslyCommitted: async () => {},
  });
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", f.root, ...args])).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.name", "Synthetic Context Test");
  await git("config", "user.email", "context@example.invalid");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Synthetic ingress");
  const authority = await f.create();
  await authority.bindArchivedInput(ingress.evidenceRefs[0]!);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: authority.currentInput() }] });
  const durability = {
    async syncCritical(paths: string[]) {
      await git("add", "--", ...paths);
      await git("commit", "--quiet", "-m", "Synthetic context transaction");
      return { state: "synchronized" as const, localRevision: await git("rev-parse", "HEAD") };
    },
    async confirmPreviouslyCommitted(file: string) { await git("cat-file", "blob", `HEAD:${file}`); },
  };
  const retained = await persistContextHistory(authority, sealed.consumption, {
    archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability,
  });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  const readHead = async (revision = "", request = f.request) => loadContextHistoryHead({ root: f.root, archiveRoot: "retained-context",
    revision: revision || await git("rev-parse", "HEAD"), request, verificationKey: f.archiveKeys.publicKey });
  return { ...f, authority, sealed, archive, durability, readHead, git, ingress, ingressRef: ingress.evidenceRefs[0]! };
}

async function recoverHeadInFreshProcess(f: Awaited<ReturnType<typeof archivedHeadFixture>>, request: BoundTurnRequest, revision: string) {
  const resolver = await f.resolver();
  const moduleUrl = (file: string) => new URL(`../src/${file}.js`, import.meta.url).href;
  const childSource = `
    import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
    import { createPublicKey } from 'node:crypto';
    import { CatalogReader } from ${JSON.stringify(moduleUrl("canghai/catalog-reader"))};
    import { bytesVersion } from ${JSON.stringify(moduleUrl("canghai/content-version"))};
    import { EpisodeEvidenceResolver } from ${JSON.stringify(moduleUrl("praxis/episode-evidence"))};
    import { compileInitializationSource } from ${JSON.stringify(moduleUrl("openclaw/initialization-source"))};
    import { snapshotTurnRequest } from ${JSON.stringify(moduleUrl("openclaw/turn-request"))};
    import { bindProcessingAuthority, resolveDeploymentDigest } from ${JSON.stringify(moduleUrl("openclaw/processing-authority"))};
    import { HostContextAuthority } from ${JSON.stringify(moduleUrl("openclaw/host-context-authority"))};
    import { recoverContextHistoryHead, loadContextHistoryHead } from ${JSON.stringify(moduleUrl("openclaw/host-context-head"))};
    const data = JSON.parse(process.argv[1]);
    const verificationKey = createPublicKey(data.verificationKey);
    const git = async (...args) => (await promisify(execFile)('git', ['-C',data.root,...args])).stdout.trim();
    const request = snapshotTurnRequest(data.request, 'fresh-recovery-run');
    const reader = await CatalogReader.load(data.root, 'catalog.json');
    const resolver = new EpisodeEvidenceResolver(reader, data.purpose, async () => { throw new Error('Unexpected model'); });
    const compilation = await compileInitializationSource(data.initializationRoot, data.recipe, {agentId:'stella',hostVersion:'2026.8.2'});
    const binding = {request, modelRef:'stella-guarded/model', deployment:resolveDeploymentDigest({agentId:'stella',
      recoveryRevision:'a'.repeat(40),pluginSource:'synthetic-fixed-plugin'}), generationId:reader.catalog.generationId,
      purpose:{readPurpose:'synthetic',derivePurpose:'synthetic',deliveryScope:'synthetic'}};
    const authority = new HostContextAuthority(resolver, request, {authority:bindProcessingAuthority({...binding,ownerId:'owner'}),
      historyVerificationKey:verificationKey, configurationHash:bytesVersion('reviewed configuration'),compilation,
      captureCurrent:async()=>({...binding,configurationHash:bytesVersion('reviewed configuration'),compilation})});
    const receipt = await recoverContextHistoryHead(authority, {request,revision:data.revision,archiveRoot:'retained-context',verificationKey,
      durability:{async syncCritical(paths){await git('add','--',...paths);await git('commit','--quiet','-m','Recover synthetic head');},
        async confirmPreviouslyCommitted(file){await git('cat-file','blob','HEAD:'+file);}}});
    const head = await loadContextHistoryHead({root:data.root,archiveRoot:'retained-context',request,revision:await git('rev-parse','HEAD'),verificationKey});
    process.stdout.write(JSON.stringify({...receipt,digest:head.archive.digest}));`;
  const childInput = JSON.stringify({ root: f.root, request, revision,
    initializationRoot: f.initializationRoot, recipe: f.recipe, purpose: resolver.purpose,
    verificationKey: f.archiveKeys.publicKey.export({ type: "spki", format: "pem" }) });
  return promisify(execFile)(process.execPath, ["--input-type=module", "-e", childSource, childInput]);
}

test("durable history heads bind the selected revision, reject cache rollback, and survive process restart", async t => {
  const f = await archivedHeadFixture(t);
  const before = await f.git("rev-parse", "HEAD");
  assert.equal(await f.readHead(), undefined, "An orphan archive is not automatically selected");
  const receipt = await publishContextHistoryHead(f.authority, f.sealed.consumption, { request: f.request, archive: f.archive, durability: f.durability });
  const head = await f.readHead();
  assert.equal(head?.archive.digest, f.archive.digest);
  await assert.rejects(loadContextHistoryHead({ root: f.root, archiveRoot: "retained-context", revision: await f.git("rev-parse", "HEAD"),
    request: f.request, verificationKey: f.archiveKeys.publicKey, requireBusinessCommit: true }), /host_context_business_commit_required/);
  await f.authority.restoreHistory(head!.archive);
  await assert.rejects(f.readHead(before), /host_context_history_head_changed/);
  assert.equal(await f.readHead("", snapshotTurnRequest({ ...f.request, sessionId: "new-session" }, "new-run")), undefined);
  const bytes = await readFile(path.join(f.root, receipt.headPath), "utf8");
  await writeFile(path.join(f.root, receipt.headPath), bytes.replace(f.archive.digest, bytesVersion("replayed cache")));
  await assert.rejects(f.readHead(), /host_context_history_head_changed/);
  await rm(path.join(f.root, receipt.headPath));
  await assert.rejects(f.readHead(), /host_context_history_head_changed/);
  await writeFile(path.join(f.root, receipt.headPath), bytes);
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import { createPublicKey } from 'node:crypto';
     import { loadContextHistoryHead } from ${JSON.stringify(new URL("../src/openclaw/host-context-head.js", import.meta.url).href)};
     const input = JSON.parse(process.argv[1]); input.verificationKey = createPublicKey(input.verificationKey);
     process.stdout.write((await loadContextHistoryHead(input)).archive.digest);`,
    JSON.stringify({ root: f.root, archiveRoot: "retained-context", revision: await f.git("rev-parse", "HEAD"),
      request: f.request, verificationKey: f.archiveKeys.publicKey.export({ type: "spki", format: "pem" }) })]);
  assert.equal(child.stdout, f.archive.digest);
  await assert.rejects(publishContextHistoryHead(f.authority, f.sealed.consumption, {
    request: f.request, archive: f.archive, previous: { ...head! }, durability: f.durability,
  }), /host_context_history_head_unbound/);
  await assert.rejects(publishContextHistoryHead(f.authority, f.sealed.consumption, {
    request: f.request, archive: f.archive, previous: head, durability: f.durability,
  }), /host_context_history_parent_missing/);
  await assertMemoryTransactionReadable(f.root);
  await f.update("Corrected source");
  await assert.rejects(f.authority.restoreHistory(head!.archive), /processing_generation_mismatch/);
});

test("signed history graphs keep independent source inputs and summary dependencies distinct", async t => {
  const f = await archivedHeadFixture(t);
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const evidence = await authority.evidence(f.evidence), current = authority.currentInput();
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [evidence, current].map(fragment => ({ role: "user", fragment })) });
  const snapshot = await authority.historySnapshot(sealed.consumption);
  assert.equal(snapshot.schemaVersion, "stella.host-context-archive/v2");
  const graph = readContextInputTrace(snapshot.graph, snapshot.input, snapshot);
  const first = graph.nodes.find(node => node.id === graph.messages[0])!;
  const second = graph.nodes.find(node => node.id === graph.messages[1])!;
  assert.ok(first.sources.originals.some(entry => entry.ref.id === f.evidence.id));
  assert.ok(!first.sources.originals.some(entry => entry.ref.id === f.ingressRef.id));
  assert.ok(second.sources.originals.some(entry => entry.ref.id === f.ingressRef.id));
  assert.ok(!second.sources.originals.some(entry => entry.ref.id === f.evidence.id));
  const summary = await authority.summarize([evidence, current], async () => ({
    modelRef: "stella-guarded/model", text: JSON.stringify({ summary: "A structured summary of the two independent inputs" }),
  }));
  const compacted = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: summary }] });
  const summarized = await authority.historySnapshot(compacted.consumption);
  const summaryGraph = readContextInputTrace(summarized.graph, summarized.input, summarized);
  const summaryNode = summaryGraph.nodes.find(node => node.producer === "summary")!;
  assert.equal(summaryNode.parents.length, 2);
  assert.ok(summaryNode.sources.originals.some(entry => entry.ref.id === f.evidence.id));
  assert.ok(summaryNode.sources.originals.some(entry => entry.ref.id === f.ingressRef.id));
  const forged = structuredClone(summaryGraph);
  forged.messages = [graph.messages[0]!];
  assert.throws(() => readContextInputTrace(forged, summarized.input, summarized), /host_context_graph_invalid/);
});

test("archive graph integrity is checked independently before current source eligibility", async t => {
  const f = await archivedHeadFixture(t);
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [
    { role: "user", fragment: await authority.evidence(f.evidence) }, { role: "user", fragment: authority.currentInput() },
  ] });
  const snapshot = await authority.historySnapshot(sealed.consumption);
  const retained = await persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context",
    signingKey: f.archiveKeys.privateKey, durability: f.durability });
  await writeFile(path.join(f.root, "current.txt"), "Changed source awaiting synchronization");
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  const graph = readContextArchiveGraph(await readContextHistory(archive, f.root));
  assert.equal(graph.messages.length, 2, "Structural validation preserves all nodes regardless of current eligibility");
  await assert.rejects(authority.restoreHistory(archive), /payload_digest_mismatch/);
  const malformed = structuredClone(snapshot);
  malformed.graph.messages[0] = malformed.graph.system;
  const bytes = canonicalJson(malformed), digest = bytesVersion(bytes);
  const signature = sign(null, Buffer.from(bytes), f.archiveKeys.privateKey).toString("base64");
  await assert.rejects(authority.assertHistoricalArchive({ bytes, signature, archiveRoot: "retained-context", verificationKey: f.archiveKeys.publicKey }),
    /host_context_graph_invalid/, "A structural failure must not be classified as a stale source to rebuild");
  const operationId = `context_archive_${digest.slice(7)}`, journalPath = `retained-context/operations/${operationId}.json`;
  const file = `retained-context/contexts/${digest.slice(7)}.json`;
  const plan = { operationId, journalPath, files: [{ path: file, before: null, after: bytes },
    { path: `${file}.sig`, before: null, after: signature }] };
  for (const item of plan.files) await writeFile(path.join(f.root, item.path), item.after);
  await writeFile(path.join(f.root, journalPath), canonicalJson({ schemaVersion: "stella.memory-transaction/v1", ...plan,
    planHash: bytesVersion(canonicalJson(plan)) }));
  await assert.rejects(loadContextHistory(f.root, { archiveRoot: "retained-context", digest }, f.archiveKeys.publicKey), /host_context_graph_invalid/);
  const duplicate = structuredClone(snapshot);
  duplicate.dependencies.push(duplicate.dependencies[0]!);
  assert.throws(() => readContextArchiveGraph(duplicate), /host_context_graph_invalid/);
});

test("history qualification preserves independent ingress and public rules after source supersession", async t => {
  const f = await archivedHeadFixture(t);
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const evidence = await authority.evidence(f.evidence), current = authority.currentInput();
  const summary = await authority.summarize([evidence, current], async () => ({
    text: JSON.stringify({ summary: "A summary influenced by the old interpretation" }), modelRef: "stella-guarded/model",
  }));
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [
    { role: "user", fragment: evidence }, { role: "user", fragment: current }, { role: "user", fragment: summary },
  ] });
  const retained = await persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context",
    signingKey: f.archiveKeys.privateKey, durability: f.durability });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  const graph = readContextArchiveGraph(await readContextHistory(archive, f.root));
  const before = await authority.assessHistoryForRebuild(archive);
  assert.ok(before.nodes.every(node => node.eligible));
  Object.assign(f.catalog, (await CatalogReader.load(f.root, "catalog.json")).catalog);
  f.catalog.parentGenerationId = f.catalog.generationId;
  f.catalog.generationId = "updated-source-generation";
  const freshRef = await f.update("Corrected understanding");
  const fresh = await f.create();
  const assessed = await fresh.assessHistoryForRebuild(archive);
  const eligible = new Map(assessed.nodes.map(node => [node.id, node.eligible]));
  assert.equal(assessed.generationId, "updated-source-generation");
  assert.equal(eligible.get(graph.system), true);
  assert.deepEqual(graph.messages.map(id => eligible.get(id)), [false, true, false]);
  assert.ok(assessed.nodes.some(node => node.reason === "source_not_current"));
  assert.ok(assessed.nodes.some(node => node.reason === "parent_ineligible"));
  assert.ok(!JSON.stringify(assessed).includes("Old interpretation"));
  assert.ok(!JSON.stringify(assessed).includes(f.request.prompt));
  await assert.rejects(fresh.restoreHistory(archive), /evidence_not_currently_eligible/);
  await assert.rejects(fresh.seal({ system: fresh.publicRules(), messages: [{ role: "user", fragment: assessed as never }] }),
    /host_context_fragment_unbound/, "Qualification metadata must not be a consumption credential");
  const corrected = await fresh.evidence(freshRef);
  assert.match(await fresh.renderContext([corrected]), /Corrected understanding/);
  await assert.rejects((await f.create("group")).assessHistoryForRebuild(archive), /private_context_audience_forbidden/);
  const otherSession = snapshotTurnRequest({ ...f.request, sessionId: "other-session" }, "other-run");
  await assert.rejects((await f.create("direct", false, otherSession)).assessHistoryForRebuild(archive), /host_context_history_scope_mismatch/);
  // A missing declaration is corruption, even in an already-invalid branch.
  f.catalog.sources = f.catalog.sources.filter(entry => entry.status === "current");
  await f.save();
  await assert.rejects((await f.create()).assessHistoryForRebuild(archive), /reference_unavailable/);
});

for (const segmented of [false, true]) test(`an invalid parent cannot hide corruption in a current source (segmented=${segmented})`, async t => {
  const f = await archivedHeadFixture(t, segmented);
  Object.assign(f.catalog, (await CatalogReader.load(f.root, "catalog.json")).catalog);
  const reader = await CatalogReader.load(f.root, "catalog.json");
  const original = await reader.read(f.evidence, "evidence");
  const source = await reader.read(original.source as VersionedRef, "sources");
  const text = "Independent current source";
  await writeFile(path.join(f.root, "independent.txt"), text);
  const secondSource = await f.put("sources", { ...source, id: "independent-source",
    ...(segmented ? { accessSegments: [{ payloadSha256: bytesVersion(text), start: 0, end: Buffer.byteLength(text), policyRef: source.policyRef }] } : {}),
    origin: { adapterId: "synthetic", collectionId: "history", upstreamId: "independent" },
    payloads: [{ path: "independent.txt", mediaType: "text/plain", bytes: Buffer.byteLength(text), sha256: bytesVersion(text) }],
  }, [source.policyRef as VersionedRef, source.coverageRef as VersionedRef]);
  const combined = await f.put("evidence", { ...original, id: "combined-evidence", source: secondSource,
    payloadSha256: bytesVersion(text), selector: { kind: "utf8_bytes", value: `0:${Buffer.byteLength(text)}` },
    independentOriginId: "independent-source", derivedFrom: [f.evidence],
  }, [secondSource, original.policyRef as VersionedRef, f.evidence]);
  await f.save();
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [
    { role: "user", fragment: await authority.evidence(combined) }, { role: "user", fragment: authority.currentInput() },
  ] });
  const retained = await persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context",
    signingKey: f.archiveKeys.privateKey, durability: f.durability });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  await f.update("Corrected upstream source");
  await writeFile(path.join(f.root, "independent.txt"), "Uncommitted damage");
  await assert.rejects((await f.create()).assessHistoryForRebuild(archive), /payload_digest_mismatch/);
});

test("history qualification rejects unsynchronized corruption and changes during assessment", async t => {
  const f = await archivedHeadFixture(t);
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [
    { role: "user", fragment: await authority.evidence(f.evidence) }, { role: "user", fragment: authority.currentInput() },
  ] });
  const retained = await persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context",
    signingKey: f.archiveKeys.privateKey, durability: f.durability });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  await writeFile(path.join(f.root, "current.txt"), "Changed without synchronization");
  await assert.rejects(authority.assessHistoryForRebuild(archive), /payload_digest_mismatch/);
  await writeFile(path.join(f.root, "current.txt"), "Old interpretation");
  const fresh = await f.create(), originalRead = fresh.resolver.readEvidence.bind(fresh.resolver);
  let changed = false;
  fresh.resolver.readEvidence = async ref => {
    const result = await originalRead(ref);
    if (!changed) {
      changed = true;
      const catalog = (await CatalogReader.load(f.root, "catalog.json")).catalog;
      catalog.generationId = "concurrent-generation";
      await writeFile(path.join(f.root, "catalog.json"), canonicalJson(catalog));
    }
    return result;
  };
  await assert.rejects(fresh.assessHistoryForRebuild(archive), /generation|catalog_changed/);
});

test("structured history reconstruction receives fresh evidence and preserves independent history without stale summary text", async t => {
  const f = await archivedHeadFixture(t);
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const current = authority.currentInput();
  const summary = await authority.summarize([await authority.evidence(f.evidence), current], async () => ({
    text: JSON.stringify({ summary: "OLD_DERIVED_SUMMARY" }), modelRef: "stella-guarded/model",
  }));
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [
    { role: "user", fragment: current }, { role: "user", fragment: summary },
  ] });
  const retained = await persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context",
    signingKey: f.archiveKeys.privateKey, durability: f.durability });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  Object.assign(f.catalog, (await CatalogReader.load(f.root, "catalog.json")).catalog);
  f.catalog.parentGenerationId = f.catalog.generationId;
  f.catalog.generationId = "reconstruction-generation";
  const freshRef = await f.update("NEW_AUTHOR_UNDERSTANDING");
  const fresh = await f.create();
  const replacement = await fresh.evidence(freshRef);
  let calls = 0, promptDigest = "";
  const view = await fresh.prepareHistoryRebuild({ viewId: "session-current-view", archive, current: [replacement],
    complete: async ({ prompt }) => {
      calls++;
      assert.ok(!prompt.includes("Old interpretation") && !prompt.includes("OLD_DERIVED_SUMMARY"));
      assert.ok(prompt.includes("NEW_AUTHOR_UNDERSTANDING") && prompt.includes(f.request.prompt));
      promptDigest = bytesVersion(prompt);
      return { text: JSON.stringify({ summary: "NEW_AUTHOR_UNDERSTANDING; continue the existing discussion" }), modelRef: "stella-guarded/model" };
    } });
  assert.equal(calls, 1);
  const snapshot = await fresh.historyViewSnapshot(view);
  assert.equal(snapshot.authority.generationId, "reconstruction-generation");
  assert.equal(snapshot.sourceArchive.digest, archive.digest);
  assert.equal(snapshot.promptDigest, promptDigest);
  assert.ok(snapshot.assessment.nodes.some(node => !node.eligible));
  assert.ok(snapshot.sources.dependencies.some(({ ref }) => canonicalJson(ref) === canonicalJson(freshRef)));
  assert.ok(!snapshot.sources.dependencies.some(({ ref }) => canonicalJson(ref) === canonicalJson(f.evidence)));
  assert.ok(snapshot.sources.dependencies.some(({ ref }) => canonicalJson(ref) === canonicalJson(f.ingressRef)));
  assert.ok(!canonicalJson(snapshot.trace).includes("OLD_DERIVED_SUMMARY"));
  assert.equal(snapshot.trace.nodes.at(-1)!.producer, "summary");
  assert.equal(bytesVersion(canonicalJson(snapshot)), view.digest);
  await assert.rejects(fresh.historyViewSnapshot({ ...view }), /host_context_view_unbound/);
  await assert.rejects((await f.create()).historyViewSnapshot(view), /host_context_view_unbound/);
  await assert.rejects(fresh.seal({ system: fresh.publicRules(), messages: [{ role: "user", fragment: view as never }] }),
    /host_context_fragment_unbound/, "An unpublished reconstruction cannot enter the provider");
  snapshot.text = "tampered returned copy";
  assert.ok((await fresh.historyViewSnapshot(view)).text.includes("NEW_AUTHOR_UNDERSTANDING"));
  await writeFile(path.join(f.root, "current.txt"), "Changed before view publication");
  await assert.rejects(fresh.historyViewSnapshot(view), /payload_digest_mismatch/);
});

test("history reconstruction rejects malformed models, changed sources and forged fragments without publishing", async t => {
  const f = await archivedHeadFixture(t);
  const authority = await f.create();
  const input = { viewId: "test-view", archive: f.archive, current: [await authority.evidence(f.evidence)] };
  const bad = [
    { text: "not JSON", modelRef: "stella-guarded/model" },
    { text: JSON.stringify({ summary: "" }), modelRef: "stella-guarded/model" },
    { text: JSON.stringify({ summary: "x", sources: [] }), modelRef: "stella-guarded/model" },
    { text: JSON.stringify({ summary: "x" }), modelRef: "different/model" },
  ];
  for (const result of bad) await assert.rejects(authority.prepareHistoryRebuild({ ...input, complete: async () => result }),
    /host_context_rebuild_(invalid|model_mismatch)/);
  await assert.rejects(authority.prepareHistoryRebuild({ ...input, complete: async () => { throw new Error("provider failed"); } }),
    /host_context_rebuild_model_failed/);
  let called = false;
  await assert.rejects(authority.prepareHistoryRebuild({ ...input, current: [{ kind: "evidence" }], complete: async () => {
    called = true; return { text: "{}", modelRef: "stella-guarded/model" };
  } }), /host_context_fragment_unbound/);
  assert.equal(called, false);
  const unarchived = authority.currentInput();
  const indirect = await authority.summarize([unarchived], async () => ({ text: JSON.stringify({ summary: "Unarchived summary" }), modelRef: "stella-guarded/model" }));
  for (const fragment of [unarchived, indirect]) {
    await assert.rejects(authority.prepareHistoryRebuild({ ...input, current: [fragment], complete: async () => {
      called = true; return { text: "{}", modelRef: "stella-guarded/model" };
    } }), /host_context_input_archive_required/);
  }
  assert.equal(called, false);
  await assert.rejects(authority.prepareHistoryRebuild({ ...input, complete: async () => {
    await writeFile(path.join(f.root, "current.txt"), "Changed during reconstruction");
    return { text: JSON.stringify({ summary: "must never be published" }), modelRef: "stella-guarded/model" };
  } }), /payload_digest_mismatch/);
});

test("completed history publication requires the exact successful request and fresh authority", async t => {
  const f = await archivedHeadFixture(t);
  const publish = async (request = f.request, assertCompletionCurrent = async () => {}) =>
    publishCompletedContextHistoryHead(await f.create(), { request, archive: f.archive,
      durability: f.durability, assertCompletionCurrent,
      business: { revision: await f.git("rev-parse", "HEAD"), generationId: f.authority.resolver.reader.catalog.generationId, catalogPath: "catalog.json",
        draftHash: bytesVersion("uncompleted draft"), businessRequired: false, journals: [], signingKey: f.archiveKeys.privateKey } });
  await assert.rejects(publish(f.request, async () => { throw new Error("business persistence failed"); }), /business persistence failed/);
  assert.equal(await f.readHead(), undefined, "An archived draft cannot become current history when business persistence failed");
  await assertMemoryTransactionReadable(f.root);
  await assert.rejects(publish(snapshotTurnRequest({ ...f.request }, "another-run")), /host_context_completion_mismatch/);
  assert.equal(await f.readHead(), undefined);
  f.advanceRecoveryRevision();
  await assert.rejects(publish(), /host_context_business_commit_invalid/, "An input-only archive cannot be certified as a completed assistant answer");
  assert.equal(await f.readHead(), undefined);
});

test("signed business binding survives a failed head commit and rejects a replaced draft binding", async t => {
  const f = await archivedHeadFixture(t);
  let authority!: HostContextAuthority;
  let sealed!: Awaited<ReturnType<HostContextAuthority["seal"]>>;
  let archive!: Awaited<ReturnType<typeof loadContextHistory>>;
  let businessRevision = "";
  const finalText = "A source-bound completed answer";
  const execution = coordinateCompletion({ operationId: f.request.runId, runId: f.request.runId, request: f.request, timeoutMs: 20_000 }, {
    async generateDraft() {
      const request = readActiveCompletionRequest("stella");
      authority = await f.create("direct", false, request);
      await authority.bindArchivedInput(f.ingressRef);
      sealed = await authority.seal({ system: authority.publicRules(), messages: [await authority.evidence(f.evidence), authority.currentInput()].map(fragment => ({ role: "user", fragment })) });
      sealed = await authority.projectBoundary(sealed.consumption, sealed.input, "UTC");
      assert.ok(sealed.input.messages.every(message => message.role === "user" && typeof message.content === "string"));
      let provider!: ProviderPlugin;
      registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
        "stella", async (_request, _model, context) => authority.assertConsumption(sealed.consumption, context),
        async receipt => { sealed = await authority.extendAssistant(sealed.consumption, receipt); });
      type Stream = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;
      type Response = Awaited<ReturnType<Awaited<ReturnType<Stream>>["result"]>>;
      const response: Response = { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop",
        api: "openai-completions", provider: "stella-guarded", model: "model", timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = provider.wrapStreamFn!({ provider: "stella-guarded", modelId: "model", agentId: "stella", streamFn: () => ({
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: response }; }, async result() { return response; },
      }) })!;
      const result = await stream({ provider: "stella-guarded", id: "model" } as Parameters<Stream>[0], sealed.input, { sessionId: request.sessionId });
      assert.equal((await result.result()).stopReason, "stop");
      return { draftId: "completed-draft", text: finalText, responseKind: "answer", evidenceRef: "synthetic", requiresCriticalPersistence: true };
    },
    async persist() {
      const snapshot = await authority.historySnapshot(sealed.consumption);
      const trace = readContextInputTrace(snapshot.graph, snapshot.input, snapshot);
      const output = trace.nodes.find(node => node.id === trace.messages.at(-1))!;
      assert.equal(output.producer, "assistant");
      assert.deepEqual(output.parents, [trace.system, ...trace.messages.slice(0, -1)]);
      assert.ok(output.sources.originals.some(entry => entry.ref.id === f.evidence.id));
      assert.ok(output.sources.originals.some(entry => entry.ref.id === f.ingressRef.id));
      // Keep a well-formed node hash while lying about one actual model input.
      const forged = structuredClone(trace), altered = forged.nodes.find(node => node.id === output.id)!;
      altered.parents.splice(1, 1);
      const { id: _id, ...body } = altered;
      altered.id = bytesVersion(canonicalJson(body));
      forged.messages[forged.messages.length - 1] = altered.id;
      assert.throws(() => readContextInputTrace(forged, snapshot.input, snapshot), /host_context_graph_invalid/);
      const retained = await persistContextHistory(authority, sealed.consumption, {
        archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: f.durability,
      });
      archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
      await (await f.create()).restoreHistory(archive);
      const before = await readFile(path.join(f.root, "catalog.json"), "utf8");
      const catalog = JSON.parse(before);
      catalog.parentGenerationId = catalog.generationId;
      catalog.generationId = "business-result-generation";
      await applyMemoryTransaction(f.root, { operationId: "completed_business", journalPath: "business.transaction.json",
        files: [{ path: "catalog.json", before, after: canonicalJson(catalog) }] }, {
        validate: async () => {}, persist: paths => f.durability.syncCritical(paths).then(() => undefined),
        confirmPreviouslyCommitted: f.durability.confirmPreviouslyCommitted,
      });
      businessRevision = await f.git("rev-parse", "HEAD");
      await publishCompletedContextHistoryHead(await f.create(), { request: f.request, archive,
        durability: { ...f.durability, async syncCritical() { throw new Error("Interrupted head commit after successful business"); } },
        assertCompletionCurrent: async () => {}, business: { revision: businessRevision, generationId: catalog.generationId,
          catalogPath: "catalog.json", draftHash: bytesVersion(finalText), businessRequired: true,
          journals: [{ operationId: "completed_business", path: "business.transaction.json" }], signingKey: f.archiveKeys.privateKey },
      });
      throw new Error("Unreachable failed head publication");
    },
    async publishFinal() { assert.fail("The interrupted head cannot deliver a draft"); },
  });
  await assert.rejects(execution, error => error instanceof Error && error.cause instanceof Error && /Interrupted head commit/.test(error.cause.message));
  await assert.rejects(f.readHead(), /memory_transaction_pending/);
  await writeFile(path.join(f.root, f.ingress.payload.path), "Changed source while recovery was pending");
  await assert.rejects(recoverHeadInFreshProcess(f, f.request, businessRevision), /payload_digest_mismatch/);
  await assert.rejects(f.readHead(), /memory_transaction_pending/);
  await writeFile(path.join(f.root, f.ingress.payload.path), f.ingress.payload.bytes);
  const recovered = JSON.parse((await recoverHeadInFreshProcess(f, f.request, businessRevision)).stdout);
  assert.equal((await f.git("log", "--format=%H", "--", "business.transaction.json")).split("\n").length, 1,
    "The restarted process publishes history without repeating the business transaction");
  assert.equal(recovered.replayed, true);
  assert.equal((await f.readHead())?.archive.digest, archive.digest);
  const file = path.join(f.root, recovered.headPath);
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.equal(value.schemaVersion, "stella.host-context-head/v2");
  assert.equal(value.business.body.generationId, "business-result-generation");
  value.business.body.draftHash = bytesVersion("Replaced draft");
  await writeFile(file, canonicalJson(value));
  await f.git("add", "--", recovered.headPath);
  await f.git("commit", "--quiet", "-m", "Tampered synthetic history binding");
  await assert.rejects(f.readHead(), /host_context_business_commit_invalid/);
});

test("failed history head persistence remains fenced and cannot look like an empty session", async t => {
  const f = await archivedHeadFixture(t);
  await assert.rejects(publishContextHistoryHead(f.authority, f.sealed.consumption, {
    request: f.request, archive: f.archive, durability: { ...f.durability, async syncCritical() { throw new Error("head storage unavailable"); } },
  }), /head storage unavailable/);
  await assert.rejects(f.readHead(), /memory_transaction_pending/);
  await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  const retried = await publishContextHistoryHead(f.authority, f.sealed.consumption, { request: f.request, archive: f.archive, durability: f.durability });
  assert.equal(retried.replayed, true);
  assert.equal((await f.readHead())?.archive.digest, f.archive.digest);
});

test("a restarted process reauthorizes a pending second history head without old consumption credentials", async t => {
  const f = await archivedHeadFixture(t);
  await publishContextHistoryHead(f.authority, f.sealed.consumption, { request: f.request, archive: f.archive, durability: f.durability });
  const previous = (await f.readHead())!;
  const request = snapshotTurnRequest({ ...f.request, prompt: "Continue in the next turn" }, "next-run");
  const resolver = await f.resolver();
  const original = await resolver.reader.read(f.evidence, "evidence");
  const ingress = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request,
    capturedAt: "2026-09-06T00:00:00Z" }, { policyRef: original.policyRef as VersionedRef,
    objectRoot: "objects", payloadRoot: "ingress", ownerId: "owner" });
  await persistHostInputArchive({ reader: resolver.reader, archive: ingress, operationId: "next_ingress", purpose: resolver.purpose }, {
    persist: async paths => { await f.durability.syncCritical(paths); },
    confirmPreviouslyCommitted: f.durability.confirmPreviouslyCommitted,
  });
  const authority = await f.create("direct", false, request);
  await authority.bindArchivedInput(ingress.evidenceRefs[0]!);
  const history = await authority.restoreHistory(previous.archive);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [history, authority.currentInput()]
    .map(fragment => ({ role: "user", fragment })) });
  const retained = await persistContextHistory(authority, sealed.consumption, {
    archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: f.durability,
  });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  await assert.rejects(publishContextHistoryHead(authority, sealed.consumption, { request, archive, previous,
    durability: { ...f.durability, async syncCritical() { throw new Error("process interrupted before head commit"); } },
  }), /process interrupted before head commit/);
  const runRecovery = async () => recoverHeadInFreshProcess(f, request, await f.git("rev-parse", "HEAD"));
  await writeFile(path.join(f.root, ingress.payload.path), "Changed original after the process stopped");
  await assert.rejects(runRecovery(), /payload_digest_mismatch/);
  await assert.rejects(f.readHead(), /memory_transaction_pending/);
  await writeFile(path.join(f.root, ingress.payload.path), ingress.payload.bytes);
  const recovered = JSON.parse((await runRecovery()).stdout);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.digest, archive.digest);
  assert.notEqual(recovered.digest, previous.archive.digest);
  await assertMemoryTransactionReadable(f.root);
  assert.equal((await f.readHead())?.archive.digest, archive.digest);
  const competing = await authority.seal({ system: authority.publicRules(), messages: [history, authority.currentInput(),
    await authority.evidence(f.evidence)].map(fragment => ({ role: "user", fragment })) });
  const competingSaved = await persistContextHistory(authority, competing.consumption, {
    archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: f.durability,
  });
  const competingArchive = await loadContextHistory(f.root, {
    archiveRoot: "retained-context", digest: competingSaved.locator.sha256,
  }, f.archiveKeys.publicKey);
  await assert.rejects(publishContextHistoryHead(authority, competing.consumption, {
    request, archive: competingArchive, previous, durability: f.durability,
  }), /transaction_version_conflict/);
  await assertMemoryTransactionReadable(f.root);
  assert.equal((await f.readHead())?.archive.digest, archive.digest, "A competing writer cannot replace the newer session head");
});

test("a fresh process recovers a partially written signed archive without resurrecting an old consumption permit", async t => {
  const f = await archivedHeadFixture(t);
  const sealed = await f.authority.seal({ system: f.authority.publicRules(), messages: [f.authority.currentInput(),
    await f.authority.evidence(f.evidence)].map(fragment => ({ role: "user", fragment })) });
  const bytes = canonicalJson(await f.authority.historySnapshot(sealed.consumption));
  const digest = bytesVersion(bytes);
  const archivePath = `retained-context/contexts/${digest.slice(7)}.json`;
  const journalPath = `retained-context/operations/context_archive_${digest.slice(7)}.json`;
  await assert.rejects(persistContextHistory(f.authority, sealed.consumption, { archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey,
    durability: { ...f.durability, async syncCritical() { throw new Error("Stopped before archive commit"); } },
  }), /Stopped before archive commit/);
  const signature = await readFile(path.join(f.root, `${archivePath}.sig`), "utf8");
  await assert.rejects(f.authority.assertHistoricalArchive({ bytes: bytes + " ", signature, archiveRoot: "retained-context",
    verificationKey: f.archiveKeys.publicKey }), /host_context_archive_signature_invalid/);
  await assert.rejects(recoverContextHistory(f.authority, { archiveRoot: "other-context", verificationKey: f.archiveKeys.publicKey,
    durability: f.durability }), /host_context_archive_recovery_plan_invalid/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(recoverContextHistory(f.authority, { archiveRoot: "retained-context", verificationKey: f.archiveKeys.publicKey,
    durability: f.durability, signal: cancelled.signal }), /operation_cancelled/);
  await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  // Keep the real pending plan and one written file, as after interruption
  // between payload and signature writes. Recovery must complete this plan.
  await rm(path.join(f.root, `${archivePath}.sig`));
  await rm(path.join(f.root, journalPath));
  await assert.rejects(loadContextHistory(f.root, { archiveRoot: "retained-context", digest }, f.archiveKeys.publicKey), /memory_transaction_pending/);
  const moduleUrl = (file: string) => new URL(`../src/${file}.js`, import.meta.url).href;
  const childSource = `
    import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { createPublicKey } from 'node:crypto';
    import { CatalogReader } from ${JSON.stringify(moduleUrl("canghai/catalog-reader"))};
    import { bytesVersion } from ${JSON.stringify(moduleUrl("canghai/content-version"))};
    import { EpisodeEvidenceResolver } from ${JSON.stringify(moduleUrl("praxis/episode-evidence"))};
    import { compileInitializationSource } from ${JSON.stringify(moduleUrl("openclaw/initialization-source"))};
    import { snapshotTurnRequest } from ${JSON.stringify(moduleUrl("openclaw/turn-request"))};
    import { bindProcessingAuthority, resolveDeploymentDigest } from ${JSON.stringify(moduleUrl("openclaw/processing-authority"))};
    import { HostContextAuthority } from ${JSON.stringify(moduleUrl("openclaw/host-context-authority"))};
    import { recoverContextHistory, loadContextHistory } from ${JSON.stringify(moduleUrl("openclaw/host-context-history"))};
    const data = JSON.parse(process.argv[1]);
    const verificationKey = createPublicKey(data.verificationKey);
    const git = async (...args) => (await promisify(execFile)('git', ['-C',data.root,...args])).stdout.trim();
    const request = snapshotTurnRequest(data.request, 'fresh-archive-recovery');
    const reader = await CatalogReader.load(data.root, 'catalog.json');
    const resolver = new EpisodeEvidenceResolver(reader, data.purpose, async () => { throw new Error('Unexpected model'); });
    const compilation = await compileInitializationSource(data.initializationRoot, data.recipe, {agentId:'stella',hostVersion:'2026.8.2'});
    const binding = {request, modelRef:'stella-guarded/model', deployment:resolveDeploymentDigest({agentId:'stella',
      recoveryRevision:'a'.repeat(40),pluginSource:'synthetic-fixed-plugin'}), generationId:reader.catalog.generationId,
      purpose:{readPurpose:'synthetic',derivePurpose:'synthetic',deliveryScope:'synthetic'}};
    const authority = new HostContextAuthority(resolver, request, {authority:bindProcessingAuthority({...binding,ownerId:'owner'}),
      historyVerificationKey:verificationKey, configurationHash:bytesVersion('reviewed configuration'),compilation,
      captureCurrent:async()=>({...binding,configurationHash:bytesVersion('reviewed configuration'),compilation})});
    const receipt = await recoverContextHistory(authority, {archiveRoot:'retained-context',verificationKey,
      durability:{async syncCritical(paths){await git('add','--',...paths);await git('commit','--quiet','-m','Recover synthetic archive');},
        async confirmPreviouslyCommitted(file){await git('cat-file','blob','HEAD:'+file);}}});
    const archive = await loadContextHistory(data.root,{archiveRoot:'retained-context',digest:receipt.locator.sha256},verificationKey);
    const history = await authority.restoreHistory(archive);
    const context = await authority.seal({system:authority.publicRules(),messages:[{role:'user',fragment:history}]});
    await authority.assertConsumption(context.consumption, context.input);
    let oldPermitRejected = false;
    try { await authority.assertConsumption({digest:data.oldConsumptionDigest},context.input); }
    catch(error) { oldPermitRejected = error.category === 'host_context_consumption_unbound'; }
    process.stdout.write(JSON.stringify({replayed:receipt.replayed,digest:archive.digest,oldPermitRejected}));`;
  const childInput = { root: f.root, request: f.request, initializationRoot: f.initializationRoot, recipe: f.recipe,
    purpose: f.authority.resolver.purpose, oldConsumptionDigest: sealed.consumption.digest,
    verificationKey: f.archiveKeys.publicKey.export({ type: "spki", format: "pem" }) };
  const runRecovery = (request = f.request) => promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", childSource, JSON.stringify({ ...childInput, request })]);
  await assert.rejects(runRecovery(snapshotTurnRequest({ ...f.request, sessionId: "another-session" }, "wrong-session")), /host_context_history_scope_mismatch/);
  const original = await readFile(path.join(f.root, "current.txt"));
  await writeFile(path.join(f.root, "current.txt"), "Source changed after interruption");
  await assert.rejects(runRecovery(), /payload_digest_mismatch/);
  await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  await writeFile(path.join(f.root, "current.txt"), original);
  const recovered = JSON.parse((await runRecovery()).stdout);
  assert.deepEqual(recovered, { replayed: true, digest, oldPermitRejected: true });
  await assertMemoryTransactionReadable(f.root);
  assert.equal(await f.readHead(), undefined, "Archive retention recovery does not select an orphan as the session head");
  assert.equal(await readFile(path.join(f.root, archivePath), "utf8"), bytes);
});

test("issued context consumes current evidence and rejects forged credentials and unknown Host additions", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const evidence = await authority.evidence(f.evidence);
  const sealed = await authority.seal({ system: [authority.rule("AGENTS.md")],
    messages: [{ role: "user", fragment: evidence }, { role: "user", fragment: authority.currentInput() }] });
  await authority.assertConsumption(sealed.consumption, sealed.input);
  const hookPrompt = await authority.systemPrompt([authority.rule("AGENTS.md")]);
  assert.equal(sealed.input.systemPrompt, `${hookPrompt}\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n\nCurrent model identity: stella-guarded/model. If asked what model you are, answer with this value for the current run.`);
  await assert.rejects(authority.assertConsumption(sealed.consumption, { ...sealed.input, systemPrompt: hookPrompt }), /host_context_input_changed/);
  await assert.rejects(authority.systemPrompt([authority.currentInput()]), /host_context_system_role_forbidden/);
  assert.match(await authority.systemPrompt(authority.publicRules()), /No private data/);
  await assert.rejects(authority.assertConsumption({ ...sealed.consumption }, sealed.input), /host_context_consumption_unbound/);
  await assert.rejects(authority.seal({ system: [{ kind: "public_rule" }], messages: [] }), /host_context_fragment_unbound/);
  await assert.rejects(authority.assertConsumption(sealed.consumption, { ...sealed.input, systemPrompt: `${sealed.input.systemPrompt}\nUnbound native memory` }), /host_context_input_changed/);
  f.changeConfiguration();
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /host_context_configuration_changed/);
});

test("real route computation requires all bound candidates and inherits unselected source revocation", async t => {
  const f = await fixture(t), authority = await f.create();
  const candidates = { frameworks: [], twin: [{ ref: "path:synthetic-twin.yaml", purpose: "Source-derived candidate" }], personalPraxis: [],
    openEpisodes: [{ ref: "path:synthetic-episode.json", purpose: "Source-derived open episode" }] };
  const candidateFragment = await authority.summarize([await authority.evidence(f.evidence)], async () => ({
    text: JSON.stringify({ summary: canonicalJson(candidates) }), modelRef: "stella-guarded/model",
  }));
  const decision = { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [],
    domains: ["general"], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false };
  const compute = (question = f.request.prompt, selectorProvider = "stella-guarded") => createSemanticRouter(async params => ({
    text: params.purpose === "stella-core-open-episode-selection" ? '{"openEpisodeRef":null}' : JSON.stringify(decision),
    provider: params.purpose === "stella-core-open-episode-selection" ? selectorProvider : "stella-guarded", model: "model",
  }))(question, candidates);
  const route = await compute();
  await assert.rejects(authority.semanticRoute({ ...route }, candidateFragment), /semantic_route_context_unbound/);
  await assert.rejects(authority.semanticRoute(route, { ...candidateFragment }), /host_context_fragment_unbound/);
  await assert.rejects(authority.semanticRoute(route, authority.currentInput()), /host_context_route_candidates_unbound/);
  await assert.rejects(authority.semanticRoute(await compute("Another request"), candidateFragment), /host_context_route_scope_mismatch/);
  await assert.rejects(authority.semanticRoute(await compute(f.request.prompt, "other-model-provider"), candidateFragment), /host_context_route_scope_mismatch/);
  const bound = await authority.semanticRoute(route, candidateFragment);
  assert.equal(await authority.renderContext([bound]), canonicalJson(route));
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: bound }] });
  await authority.assertConsumption(sealed.consumption, sealed.input);
  await writeFile(path.join(f.root, "current.txt"), "Unselected candidate source changed");
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /payload_digest_mismatch/);
});

test("question assessments require bound upstream route and context and retain all original dependencies", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const route: CortexRoute = { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [],
    domains: ["general"], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false };
  const routeFragment = await authority.summarize([authority.currentInput()], async () => ({
    text: JSON.stringify({ summary: canonicalJson(route) }), modelRef: "stella-guarded/model",
  }));
  const rule = authority.rule("AGENTS.md");
  const priorContext = await authority.renderContext([rule]);
  const prepared = await prepareQuestionEvidence({ requestId: f.request.runId, revision: "a".repeat(40), question: f.request.prompt,
    route, priorContext, resolver: authority.resolver, complete: async () => ({ provider: "stella-guarded", model: "model", text: JSON.stringify({
      status: "material_unknown", claims: [], unresolvedLeads: [{ question: "Which details?", material: true, reason: "A material limit remains" }],
      stoppingReason: "The configured scope leaves a material question", suggestedResponseKind: "clarification",
    }) }) });
  await assert.rejects(authority.questionEvidence(prepared, { route: { ...routeFragment }, prior: [rule] }), /host_context_fragment_unbound/);
  await assert.rejects(authority.questionEvidence(prepared, { route: routeFragment, prior: [] }), /host_context_question_upstream_unbound/);
  const fragment = await authority.questionEvidence(prepared, { route: routeFragment, prior: [rule] });
  const sealed = await authority.seal({ system: [rule], messages: [{ role: "user", fragment }] });
  await authority.assertConsumption(sealed.consumption, sealed.input);
  assert.match(JSON.stringify(sealed.input), /A material limit remains/);
  await writeFile(path.join(f.root, "current.txt"), "Source edited after assessment");
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /payload_digest_mismatch/);
});

test("descriptor grant bytes remain bound through assessment, summary, archive and fresh authority restoration", async t => {
  const f = await archivedHeadFixture(t);
  const authority = f.authority;
  const object = await authority.resolver.reader.read(f.evidence, "evidence");
  const config = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["owner"],
    modelRefs: ["stella-guarded/model"], viewProcessingModelRefs: ["stella-guarded/model"], purpose: { readPurpose: "synthetic", derivePurpose: "synthetic", deliveryScope: "synthetic" },
    descriptors: [{ sourceRef: object.source as VersionedRef, policyRef: object.policyRef as VersionedRef, description: "Reviewed topic metadata" }] };
  const grantPath = "descriptor-grant.json";
  await writeFile(path.join(f.root, grantPath), canonicalJson(config));
  const grant = await loadPersonalContextAccess(f.root, grantPath);
  const route: CortexRoute = { mode: "ordinary", responseKind: "clarification", evidenceStatus: "material_unknown", materialUnknowns: ["Missing original"],
    domains: ["general"], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false };
  const routeFragment = await authority.summarize([authority.currentInput()], async () => ({
    text: JSON.stringify({ summary: canonicalJson(route) }), modelRef: "stella-guarded/model",
  }));
  const prepare = (processingGrant?: object, checkpoint?: RetrievalCheckpoint) => prepareQuestionEvidence({ requestId: f.request.runId, question: f.request.prompt,
    revision: "a".repeat(40), resolver: authority.resolver, route, priorContext: "", ...(checkpoint ? { checkpoint } : {}),
    retrieval: { descriptors: config.descriptors, modelRef: "stella-guarded/model", ownerId: "owner", processingGrant,
      config: { schemaVersion: "stella.semantic-retrieval/v1", pageSize: 16, maxRounds: checkpoint ? 2 : 1, maxSelected: 4, maxOriginalChars: 96000 },
      assertProcessingCurrent: grant.assertCurrent }, complete: async ({ prompt }) => {
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      return { provider: "stella-guarded", model: "model", text: JSON.stringify(data.candidates ? { selected: [] } :
        prompt.startsWith("Review") ? { stopped: true, nextIntents: [], reason: "No selected original" } :
        { status: "material_unknown", claims: [], unresolvedLeads: [{ question: "Which original?", material: true, reason: "No selected original" }],
          stoppingReason: "Descriptors are not original support", suggestedResponseKind: "clarification" }) };
    } });
  await assert.rejects(authority.questionEvidence(await prepare(), { route: routeFragment, prior: [] }), /host_context_descriptor_grant_required/);
  await assert.rejects(authority.questionEvidence(await prepare({ ...grant }), { route: routeFragment, prior: [] }), /personal_context_binding_unbound/);
  const { viewProcessingModelRefs: _viewGrant, ...withoutViewGrant } = config;
  for (const [index, denied] of [withoutViewGrant, { ...config, modelRefs: ["stella-guarded/model", "other/model"],
    viewProcessingModelRefs: ["other/model"] }].entries()) {
    await writeFile(path.join(f.root, `denied-grant-${index}.json`), canonicalJson(denied));
    const deniedGrant = await loadPersonalContextAccess(f.root, `denied-grant-${index}.json`);
    await assert.rejects(authority.questionEvidence(await prepare(deniedGrant), { route: routeFragment, prior: [] }), /host_context_descriptor_grant_mismatch/);
  }
  const checkpoint: RetrievalCheckpoint = { schemaVersion: "stella.retrieval-checkpoint/v1", requestId: f.request.runId,
    revision: "a".repeat(40), generationId: authority.resolver.reader.catalog.generationId, questionDigest: f.request.requestHash,
    nextIntents: ["Check the unresolved background"], selectedRefs: [], deniedRefKeys: [], roundsCompleted: 1, pagesReviewed: 1,
    modelRef: "stella-guarded/model", temporalScope: "current", exclusions: {},
    config: { schemaVersion: "stella.semantic-retrieval/v1", pageSize: 16, maxRounds: 1, maxSelected: 4, maxOriginalChars: 96000 } };
  const resumedAssessment = await prepare(grant, checkpoint);
  await assert.rejects(authority.questionEvidence(resumedAssessment, { route: routeFragment, prior: [] }), /host_context_question_checkpoint_unbound/);
  const checkpointFragment = await authority.summarize([authority.currentInput(), await authority.evidence(f.evidence)], async () => ({
    text: JSON.stringify({ summary: canonicalJson(checkpoint) }), modelRef: "stella-guarded/model",
  }));
  await assert.rejects(authority.questionEvidence(resumedAssessment, { route: routeFragment, prior: [], checkpoint: { ...checkpointFragment } }),
    /host_context_fragment_unbound/);
  await assert.rejects(authority.questionEvidence(resumedAssessment, { route: routeFragment, prior: [], checkpoint: routeFragment }),
    /host_context_question_checkpoint_unbound/);
  const resumedFragment = await authority.questionEvidence(resumedAssessment, { route: routeFragment, prior: [], checkpoint: checkpointFragment });
  const resumedInput = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: resumedFragment }] });
  const previousSource = await readFile(path.join(f.root, "current.txt"));
  await writeFile(path.join(f.root, "current.txt"), "Checkpoint's source was changed");
  await assert.rejects(authority.assertConsumption(resumedInput.consumption, resumedInput.input), /payload_digest_mismatch/);
  await writeFile(path.join(f.root, "current.txt"), previousSource);
  const fragment = await authority.questionEvidence(await prepare(grant), { route: routeFragment, prior: [] });
  const summary = await authority.summarize([fragment], async () => ({ text: '{"summary":"Original support is still unresolved"}', modelRef: "stella-guarded/model" }));
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: summary }] });
  const saved = await persistContextHistory(authority, sealed.consumption, {
    archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: f.durability,
  });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: saved.locator.sha256 }, f.archiveKeys.publicKey);
  const next = await f.create();
  const restored = await next.restoreHistory(archive);
  const resumed = await next.seal({ system: next.publicRules(), messages: [{ role: "user", fragment: restored }] });
  const altered = structuredClone(config);
  altered.descriptors[0]!.description = "Changed topic metadata";
  await writeFile(path.join(f.root, grantPath), canonicalJson(altered));
  await assert.rejects(authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment }] }), /host_context_configuration_input_changed/);
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /host_context_configuration_input_changed/);
  await assert.rejects(next.assertConsumption(resumed.consumption, resumed.input), /host_context_configuration_input_changed/);
  await assert.rejects((await f.create()).restoreHistory(archive), /host_context_configuration_input_changed/);
});

test("fixed Host system formatting preserves reviewed bytes and replaces standalone model identity lines", () => {
  const identity = "Current model identity: stella-guarded/model. If asked what model you are, answer with this value for the current run.";
  const source = "Rules\r\n  Current model identity: previous.\r\nCurrent model identity: duplicate.\r\nEnd";
  assert.equal(assembleManagedSystemPrompt(source, "stella-guarded/model"), `Rules\n${identity}\nEnd\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n`);
  const quoted = "Rules quote Current model identity: previous.";
  assert.equal(assembleManagedSystemPrompt(quoted, "stella-guarded/model"), `${quoted}\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n\n${identity}`);
  const existingBoundary = "Rules\n<!-- OPENCLAW_CACHE_BOUNDARY -->\nReviewed suffix";
  assert.equal(assembleManagedSystemPrompt(existingBoundary, "stella-guarded/model"), `${existingBoundary}\n\n${identity}`);
});

test("Host wire timestamps are compiled only from already bound text and stay fixed across continuation", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const system = authority.publicRules();
  const sealed = await authority.seal({ system, messages: [{ role: "user", fragment: authority.currentInput() }] });
  const raw = { ...sealed.input, messages: sealed.input.messages.map(message => ({ ...message, timestamp: Date.parse("2026-09-23T00:00:00Z") })) };
  const wire = projectManagedMessages(raw, "UTC");
  assert.equal(wire.messages[0]?.content, `[Wed 2026-09-23 00:00 UTC] ${f.request.prompt}`);
  const projected = await authority.projectBoundary(sealed.consumption, raw, "UTC");
  await authority.assertConsumption(projected.consumption, wire);
  await assert.rejects(authority.assertConsumption(projected.consumption, raw), /host_context_input_changed/);
  const altered = structuredClone(raw);
  altered.messages[0]!.content = "Unknown remembered content";
  await assert.rejects(authority.projectBoundary(sealed.consumption, altered, "UTC"), /host_context_input_changed/);
  await assert.rejects(authority.projectBoundary(sealed.consumption, raw, "UTC"), /host_context_continuation_replayed/);

  const engine = new ManagedHostContextEngine(f.request, authority, { system, history: [], hostTimezone: "UTC",
    archive: async () => {}, persistSummary: async () => {}, complete: async () => { throw new Error("unexpected compaction"); } });
  await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    prompt: f.request.prompt, messages: [], availableTools: new Set(), tokenBudget: 100_000 });
  const continuation = { sessionId: f.request.sessionId, sessionKey: f.request.sessionKey, messages: raw.messages, tokenBudget: 100_000 };
  assert.deepEqual((await engine.assemble(continuation)).messages, raw.messages);
  await engine.assertConsumption(wire);
  assert.deepEqual((await engine.assemble(continuation)).messages, raw.messages);
  const changedTime = raw.messages.map(message => ({ ...message, timestamp: message.timestamp + 60_000 }));
  await assert.rejects(engine.assemble({ ...continuation, messages: changedTime }), /host_context_input_changed/);
  await assert.rejects(engine.assertConsumption(wire), /host_context_input_changed/);
});

test("current input binds the authenticated ingress archive and retains its deletion dependency", async t => {
  const f = await fixture(t);
  const resolver = await f.resolver();
  const evidence = await resolver.reader.read(f.evidence, "evidence");
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request: f.request,
    capturedAt: "2026-09-06T00:00:00Z" }, { policyRef: evidence.policyRef as VersionedRef,
    objectRoot: "objects", payloadRoot: "ingress", ownerId: "owner" });
  await persistHostInputArchive({ reader: resolver.reader, archive, operationId: "archive_ingress", purpose: resolver.purpose }, {
    persist: async () => {}, confirmPreviouslyCommitted: async () => {},
  });
  const authority = await f.create();
  await assert.rejects(authority.bindArchivedInput(f.evidence), /host_context_input_archive_mismatch/);
  await authority.bindArchivedInput(archive.evidenceRefs[0]!);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: authority.currentInput() }] });
  assert.deepEqual(sealed.input.messages[0]?.content, [{ type: "text", text: f.request.prompt }]);
  await authority.assertConsumption(sealed.consumption, sealed.input);
  const other = await f.create("direct", false, snapshotTurnRequest({ ...f.request, sessionId: "another-session" }, f.request.runId));
  await assert.rejects(other.bindArchivedInput(archive.evidenceRefs[0]!), /host_context_input_archive_mismatch/);
  const late = await f.create();
  const unbound = await late.seal({ system: late.publicRules(), messages: [{ role: "user", fragment: late.currentInput() }] });
  await assert.rejects(late.historySnapshot(unbound.consumption), /host_context_input_archive_required/);
  let writes = 0, confirmed = 0;
  const retention = { archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: {
    async syncCritical(paths: string[]) { writes++; assert.equal(paths.length, 3); },
    async confirmPreviouslyCommitted() { confirmed++; },
  } };
  await assert.rejects(persistContextHistory(authority, { ...sealed.consumption }, retention), /host_context_continuation_unbound/);
  const retained = await persistContextHistory(authority, sealed.consumption, retention);
  const stored = await readFile(path.join(f.root, retained.locator.path), "utf8");
  assert.equal(bytesVersion(stored), retained.locator.sha256);
  const snapshot = await authority.historySnapshot(sealed.consumption);
  assert.equal(stored, canonicalJson(snapshot));
  assert.ok(snapshot.dependencies.some(dependency => canonicalJson(dependency.ref) === canonicalJson(archive.evidenceRefs[0])));
  assert.equal(snapshot.authority.sessionKey, f.request.sessionKey);
  snapshot.input.messages.length = 0;
  assert.notEqual((await authority.historySnapshot(sealed.consumption)).input.messages.length, 0);
  assert.equal((await persistContextHistory(authority, sealed.consumption, retention)).replayed, true);
  assert.equal(writes, 1);
  assert.equal(confirmed, 1);
  const signaturePath = path.join(f.root, `${retained.locator.path}.sig`);
  const signatureBytes = await readFile(signaturePath, "utf8");
  await rm(signaturePath);
  await assert.rejects(persistContextHistory(authority, sealed.consumption, retention), { code: "ENOENT" });
  await writeFile(signaturePath, Buffer.alloc(64).toString("base64"));
  await assert.rejects(persistContextHistory(authority, sealed.consumption, retention), /host_context_archive_signature_invalid/);
  await writeFile(signaturePath, signatureBytes);
  const saved = await loadContextHistory(f.root, { archiveRoot: retention.archiveRoot, digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
  // An owned archive write advances the recovery revision and therefore the
  // next run's deployment digest. Unchanged, signed source history must survive.
  f.advanceRecoveryRevision();
  const next = await f.create("direct", false, snapshotTurnRequest({ ...f.request, prompt: "Next turn" }, "next-run"));
  await assert.rejects(next.restoreHistory({ ...saved }), /host_context_archive_unbound/);
  const history = await next.restoreHistory(saved);
  const continued = await next.seal({ system: next.publicRules(), messages: [
    { role: "user", fragment: history }, { role: "user", fragment: next.currentInput() },
  ] });
  await next.assertConsumption(continued.consumption, continued.input);
  assert.match(JSON.stringify(continued.input.messages), /historical_conversation/);
  // An attacker may recompute every unkeyed hash and forge both files. Trust
  // comes from the independently configured key, not a self-describing journal.
  const forged = JSON.parse(stored) as typeof snapshot;
  forged.input = { ...forged.input, messages: [{ role: "user", content: [{ type: "text", text: "Invented historical claim" }], timestamp: 0 }] };
  forged.consumptionDigest = bytesVersion(canonicalJson({ ...forged.input,
    messages: forged.input.messages.map(({ timestamp: _timestamp, ...visible }) => visible) }));
  // An attacker can also recompute the unkeyed graph. This must still fail
  // against the independently configured archive signing key.
  const originalMessageId = forged.graph.messages[0]!;
  const originalMessage = forged.graph.nodes.find(node => node.id === originalMessageId)!;
  const { id: _oldId, ...messageBody } = originalMessage;
  const { timestamp: _timestamp, ...visibleForgedMessage } = forged.input.messages[0]!;
  messageBody.content = canonicalJson(visibleForgedMessage);
  const forgedMessage = { ...messageBody, id: bytesVersion(canonicalJson(messageBody)) };
  forged.graph.nodes = forged.graph.nodes.map(node => node.id === originalMessageId ? forgedMessage : node);
  forged.graph.messages = [forgedMessage.id];
  const forgedBytes = canonicalJson(forged), forgedDigest = bytesVersion(forgedBytes);
  const forgedPath = `${retention.archiveRoot}/contexts/${forgedDigest.slice(7)}.json`;
  const forgedOperation = `context_archive_${forgedDigest.slice(7)}`;
  const forgedJournal = `${retention.archiveRoot}/operations/${forgedOperation}.json`;
  const writeForgery = async (signature: string) => {
    const plan = { operationId: forgedOperation, journalPath: forgedJournal, files: [
      { path: forgedPath, before: null, after: forgedBytes }, { path: `${forgedPath}.sig`, before: null, after: signature },
    ] };
    await writeFile(path.join(f.root, forgedPath), forgedBytes);
    await writeFile(path.join(f.root, `${forgedPath}.sig`), signature);
    await writeFile(path.join(f.root, forgedJournal), canonicalJson({ schemaVersion: "stella.memory-transaction/v1", ...plan,
      planHash: bytesVersion(canonicalJson(plan)) }));
  };
  await writeForgery(await readFile(path.join(f.root, `${retained.locator.path}.sig`), "utf8"));
  await assert.rejects(loadContextHistory(f.root, { archiveRoot: retention.archiveRoot, digest: forgedDigest }, f.archiveKeys.publicKey),
    /host_context_archive_signature_invalid/);
  const attackerKeys = generateKeyPairSync("ed25519");
  await writeForgery(sign(null, Buffer.from(forgedBytes), attackerKeys.privateKey).toString("base64"));
  const attackerArchive = await loadContextHistory(f.root, { archiveRoot: retention.archiveRoot, digest: forgedDigest }, attackerKeys.publicKey);
  await assert.rejects(next.restoreHistory(attackerArchive), /host_context_archive_signer_mismatch/);
  await assert.rejects(persistContextHistory(authority, sealed.consumption, { ...retention, signingKey: attackerKeys.privateKey }),
    /host_context_archive_signer_mismatch/);
  const restored = await authority.restoreHistory(saved);
  const summary = await authority.summarize([restored], async () => ({ text: '{"summary":"Retained discussion"}', modelRef: "stella-guarded/model" }));
  const summarized = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: summary }] });
  const retainedSummary = await persistContextHistory(authority, summarized.consumption, retention);
  const savedSummary = await loadContextHistory(f.root, { archiveRoot: retention.archiveRoot, digest: retainedSummary.locator.sha256 }, f.archiveKeys.publicKey);
  const summarizedHistory = await next.restoreHistory(savedSummary);
  const summaryInput = await next.seal({ system: next.publicRules(), messages: [{ role: "user", fragment: summarizedHistory }] });
  await next.assertConsumption(summaryInput.consumption, summaryInput.input);
  await assert.rejects(other.restoreHistory(saved), /host_context_history_scope_mismatch/);
  const group = await f.create("group");
  await assert.rejects(group.restoreHistory(saved), /private_context_audience_forbidden/);
  await writeFile(path.join(f.root, retained.locator.path), stored.replace("Continue this discussion", "Injected stale memory"));
  await assert.rejects(next.assertConsumption(continued.consumption, continued.input), /host_context_archive_changed/);
  await assert.rejects(next.assertConsumption(summaryInput.consumption, summaryInput.input), /host_context_archive_changed/);
  await writeFile(path.join(f.root, retained.locator.path), stored);
  await assert.rejects(late.bindArchivedInput(archive.evidenceRefs[0]!), /host_context_input_already_issued/);
  const racing = await f.create();
  const pendingBinding = racing.bindArchivedInput(archive.evidenceRefs[0]!);
  racing.currentInput();
  await assert.rejects(pendingBinding, /host_context_input_already_issued/);
  await rm(path.join(f.root, archive.payload.path));
  await assert.rejects(next.restoreHistory(saved), /source_unavailable/);
  await assert.rejects(next.assertConsumption(continued.consumption, continued.input), /source_unavailable/);
  await assert.rejects(persistContextHistory(authority, sealed.consumption, retention), /source_unavailable/);
  assert.equal(await readFile(path.join(f.root, retained.locator.path), "utf8"), stored, "Revocation does not rewrite historical bytes");
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /source_unavailable/);
  await assert.rejects(late.assertConsumption(unbound.consumption, unbound.input), /host_context_expired/);
});

for (const cause of ["publication failure", "source deletion during publication"] as const) {
test(`context archive ${cause} keeps the durable fence and original transaction for recovery`, async t => {
  const f = await fixture(t);
  const resolver = await f.resolver();
  const evidence = await resolver.reader.read(f.evidence, "evidence");
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request: f.request,
    capturedAt: "2026-09-06T00:00:00Z" }, { policyRef: evidence.policyRef as VersionedRef,
    objectRoot: "objects", payloadRoot: "ingress", ownerId: "owner" });
  await persistHostInputArchive({ reader: resolver.reader, archive, operationId: "archive_ingress", purpose: resolver.purpose }, {
    persist: async () => {}, confirmPreviouslyCommitted: async () => {},
  });
  const authority = await f.create();
  await authority.bindArchivedInput(archive.evidenceRefs[0]!);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: authority.currentInput() }] });
  const failure = new Error("Synthetic durable publication failure");
  await assert.rejects(persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: {
    async syncCritical() {
      if (cause === "publication failure") throw failure;
      await rm(path.join(f.root, archive.payload.path));
    }, async confirmPreviouslyCommitted() { throw new Error("Unexpected replay"); },
  } }), error => cause === "publication failure" ? error === failure : error instanceof Error && /source_unavailable/.test(error.message));
  const pending = JSON.parse(await readFile(path.join(f.root, ".stella-memory-transaction.json"), "utf8"));
  assert.equal(pending.files.length, 2);
  assert.equal(await readFile(path.join(f.root, pending.files[0].path), "utf8"), pending.files[0].after);
  assert.equal(await readFile(path.join(f.root, pending.journalPath), "utf8"), canonicalJson(pending));
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /memory_transaction_pending/);
});
}

test("derived archive consumption rechecks upstream payload bytes even when its own catalog and content are unchanged", async t => {
  const f = await fixture(t);
  const reader = (await f.resolver()).reader;
  const parent = await reader.read(f.evidence, "evidence");
  const source = await reader.read(parent.source as VersionedRef, "sources");
  const text = "Archived derived interpretation";
  await writeFile(path.join(f.root, "derived.txt"), text);
  const childSource = await f.put("sources", { ...source, id: "derived-source", payloads: [
    { path: "derived.txt", mediaType: "text/plain", bytes: Buffer.byteLength(text), sha256: bytesVersion(text) },
  ] }, [source.policyRef as VersionedRef, source.coverageRef as VersionedRef]);
  const derived = await f.put("evidence", { ...parent, id: "derived-evidence", source: childSource,
    role: "assistant", kind: "inference", payloadSha256: bytesVersion(text),
    selector: { kind: "utf8_bytes", value: `0:${Buffer.byteLength(text)}` }, derivedFrom: [f.evidence],
  }, [childSource, parent.policyRef as VersionedRef, f.evidence]);
  await f.save();
  const authority = await f.create();
  const fragment = await authority.evidence(derived);
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment }] });
  await authority.assertConsumption(sealed.consumption, sealed.input);
  await writeFile(path.join(f.root, "current.txt"), "Changed source bytes, before synchronization");
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /payload_digest_mismatch/);
  await assert.rejects(authority.evidence(derived), /payload_digest_mismatch/);
});

test("a summary inherits every source dependency and fresh evidence remains consumable after source replacement", async t => {
  const f = await fixture(t);
  const old = await f.create();
  const summary = await old.summarize([await old.evidence(f.evidence)], async () => ({ text: '{"summary":"Old derived understanding"}', modelRef: "stella-guarded/model" }));
  const prior = await old.seal({ system: [old.rule("AGENTS.md")], messages: [{ role: "user", fragment: summary }] });
  await old.assertConsumption(prior.consumption, prior.input);
  const changed = await f.update("Corrected interpretation");
  await assert.rejects(old.assertConsumption(prior.consumption, prior.input), /stale_generation/);
  const fresh = await f.create();
  const next = await fresh.seal({ system: [fresh.rule("AGENTS.md")], messages: [{ role: "user", fragment: await fresh.evidence(changed) }] });
  await fresh.assertConsumption(next.consumption, next.input);
  assert.match(JSON.stringify(next.input), /Corrected interpretation/);
  assert.doesNotMatch(JSON.stringify(next.input), /Old derived understanding/);
  await assert.rejects(fresh.assertConsumption(prior.consumption, prior.input), /host_context_consumption_unbound/);
  assert.match(JSON.stringify(prior.input), /Old derived understanding/, "Historical bytes remain intact; eligibility changes");
});

test("editing a source during compression cannot sign the model output", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const evidence = await authority.evidence(f.evidence);
  await assert.rejects(authority.summarize([evidence], async () => {
    await writeFile(path.join(f.root, "current.txt"), "Edited during model call");
    return { text: '{"summary":"Stale compressed understanding"}', modelRef: "stella-guarded/model" };
  }), /payload_digest_mismatch/);
});

test("public rules remain consumable in a group without inheriting private evidence", async t => {
  const f = await fixture(t);
  const group = await f.create("group");
  const publicContext = await group.seal({ system: [group.rule("AGENTS.md")], messages: [{ role: "user", fragment: group.currentInput() }] });
  await group.assertConsumption(publicContext.consumption, publicContext.input);
  // A changed private payload must not be read before the audience rejection.
  await writeFile(path.join(f.root, "current.txt"), "Private replacement");
  await assert.rejects(group.evidence(f.evidence), /private_context_audience_forbidden/);
  group.close();
  await assert.rejects(group.assertConsumption(publicContext.consumption, publicContext.input), /host_context_expired/);
});

test("a model cannot issue source credentials or change the processing model through compression", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const input = [authority.currentInput()];
  await assert.rejects(authority.summarize(input, async () => ({ text: '{"summary":"x","dependencies":[]}', modelRef: "stella-guarded/model" })), /host_context_summary_invalid/);
  await assert.rejects(authority.summarize(input, async () => ({ text: '{"summary":"x"}', modelRef: "another/model" })), /host_context_summary_model_mismatch/);
});

test("changing assembly arrays during validation cannot add an unchecked stale fragment", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const stale = await authority.evidence(f.evidence);
  await writeFile(path.join(f.root, "current.txt"), "Changed source");
  const specification = { system: [authority.rule("AGENTS.md")], messages: [{ role: "user" as const, fragment: authority.currentInput() }] };
  const pending = authority.seal(specification);
  specification.messages.push({ role: "user", fragment: stale });
  const sealed = await pending;
  await authority.assertConsumption(sealed.consumption, sealed.input);
  assert.equal(sealed.input.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(sealed.input), /Old interpretation/);
});

test("source authority never promotes current input or evidence to system instructions", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  for (const fragment of [authority.currentInput(), await authority.evidence(f.evidence)]) {
    await assert.rejects(authority.seal({ system: [fragment], messages: [] }), /host_context_system_role_forbidden/);
  }
});

test("only Core-created tool definitions can be bound into a model context", async t => {
  const f = await fixture(t);
  const authority = await f.create("direct", true);
  const sealed = await authority.seal({ system: [authority.rule("AGENTS.md")], messages: [{ role: "user", fragment: authority.currentInput() }] });
  assert.equal(sealed.input.tools[0]?.name, "stella_read_fragment");
  await authority.assertConsumption(sealed.consumption, sealed.input);
  assert.throws(() => readFragmentToolDefinition({ ...sealed.input.tools[0] }), /host_context_tool_unbound/);
  sealed.input.tools[0]!.description += " Unbound memory";
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /host_context_input_changed/);
});

test("managed engine archives raw history but admits only independently bound views", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const rule = authority.rule("AGENTS.md"), history = await authority.evidence(f.evidence);
  const archived: unknown[] = [];
  const engine = new ManagedHostContextEngine(f.request, authority, { system: [rule], history: [history],
    archive: async messages => { archived.push(...messages); }, persistSummary: async () => {},
    complete: async () => ({ text: '{"summary":"Source-bound summary"}', modelRef: "stella-guarded/model" }) });
  const raw = { role: "user" as const, content: "Unbound native memory", timestamp: 1 };
  const result = await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    prompt: f.request.prompt, messages: [raw], availableTools: new Set(), tokenBudget: 100_000 });
  assert.deepEqual(archived, [raw]);
  assert.doesNotMatch(JSON.stringify(result.messages), /Unbound native memory/);
  assert.match(JSON.stringify(result.messages), /Old interpretation/);
  const expected = await authority.seal({ system: [rule], messages: [history, authority.currentInput()].map(fragment => ({ role: "user", fragment })) });
  await engine.assertConsumption(expected.input);
  const continuation = await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    messages: expected.input.messages, tokenBudget: 100_000 });
  assert.deepEqual(continuation.messages, expected.input.messages);
  await engine.compact({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey });
  const compressed = await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    prompt: f.request.prompt, messages: [raw], availableTools: new Set(), tokenBudget: 100_000 });
  const current = { ...expected.input, messages: [...compressed.messages, expected.input.messages.at(-1)!] };
  await engine.assertConsumption(current);
  assert.match(JSON.stringify(current.messages), /Source-bound summary/);
  await f.update("Corrected interpretation");
  await assert.rejects(engine.assertConsumption(current), /stale_generation/);
});

test("an engine archive failure cannot authorize Host fallback messages", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const engine = new ManagedHostContextEngine(f.request, authority, { system: [authority.rule("AGENTS.md")], history: [],
    archive: async () => { throw new Error("archive transaction failed"); }, persistSummary: async () => {},
    complete: async () => { throw new Error("unexpected model"); } });
  await assert.rejects(engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    prompt: f.request.prompt, messages: [], tokenBudget: 100_000 }), /archive transaction failed/);
  await assert.rejects(engine.assertConsumption({ systemPrompt: "fallback", messages: [], tools: [] }), /archive transaction failed/);
});

test("global engine configuration builder does not mutate its input", () => {
  const original = { plugins: { slots: { contextEngine: "legacy" } } };
  assert.equal(withStellaContextEngine(original).plugins?.slots?.contextEngine, STELLA_CONTEXT_ENGINE);
  assert.equal(original.plugins.slots.contextEngine, "legacy");
  assert.throws(() => withStellaContextEngine({ plugins: { slots: { contextEngine: "other-engine" } } }),
    /host_context_existing_engine_migration_required/);
});

test("disposing a lazy engine prevents later resolution and lifecycle side effects", async () => {
  let factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1] | undefined;
  let resolutions = 0;
  registerManagedHostContextEngine({ registerContextEngine(_id, value) { factory = value; } } as OpenClawPluginApi,
    () => ({ resolve() { resolutions++; throw new Error("must not resolve after disposal"); } }));
  const engine = await factory!({});
  await engine.dispose?.();
  assert.throws(() => engine.assemble({ sessionId: "session", messages: [] }), /host_context_expired/);
  assert.throws(() => engine.ingest({ sessionId: "session", message: { role: "user", content: "late event", timestamp: 0 } }), /host_context_expired/);
  assert.throws(() => engine.compact({ sessionId: "session", sessionKey: "agent:stella:main" }), /host_context_expired/);
  await engine.dispose?.();
  assert.equal(resolutions, 0);
});

test("the global context slot selects only the configured Agent and preserves native delegation elsewhere", async () => {
  let factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1] | undefined;
  let bindings = 0;
  registerManagedHostContextEngine({ registerContextEngine(_id, value) { factory = value; } } as OpenClawPluginApi,
    () => { bindings++; return { resolve() { throw new Error("not prepared"); } }; }, { targetAgentId: "stella" });
  const config = { agents: { entries: { stella: { workspace: "/synthetic/stella" }, other: { workspace: "/synthetic/other" } } } };
  const other = await factory!({ config, agentDir: resolveAgentDir(config, "other"), workspaceDir: "/synthetic/other" });
  assert.equal(bindings, 0);
  assert.equal(other.info.id, "legacy");
  assert.equal(other.compact, delegateCompactionToRuntime);
  const messages = [{ role: "user" as const, content: "Other Agent history", timestamp: 0 }];
  assert.deepEqual(await other.ingest({ sessionId: "other", message: messages[0]! }), { ingested: false });
  assert.equal((await other.assemble({ sessionId: "other", messages })).messages, messages);
  const target = await factory!({ config, agentDir: resolveAgentDir(config, "stella"), workspaceDir: "/synthetic/stella" });
  assert.equal(target.info.id, STELLA_CONTEXT_ENGINE);
  assert.equal(bindings, 1);
  assert.throws(() => factory!({ config, agentDir: resolveAgentDir(config, "stella"), workspaceDir: "/synthetic/other" }), /host_context_agent_scope_mismatch/);
  assert.throws(() => factory!({ config }), /host_context_agent_scope_required/);
  assert.throws(() => factory!({ config, agentDir: "/unknown-agent", workspaceDir: "/synthetic/other" }), /host_context_agent_scope_mismatch/);
  const shared = { agents: { entries: { stella: { agentDir: "/shared-agent", workspace: "/synthetic/shared" },
    other: { agentDir: "/shared-agent", workspace: "/synthetic/shared" } } } };
  assert.throws(() => factory!({ config: shared, agentDir: "/shared-agent", workspaceDir: "/synthetic/shared" }), /host_context_agent_scope_mismatch/);
  assert.equal(bindings, 1);
});

test("summary persistence failure remains explicit and invalidates earlier assembly", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const rule = authority.rule("AGENTS.md"), history = await authority.evidence(f.evidence);
  const engine = new ManagedHostContextEngine(f.request, authority, { system: [rule], history: [history],
    archive: async () => {}, persistSummary: async summary => {
      await authority.assertConsumption(summary.consumption, summary.input);
      throw new Error("summary transaction failed");
    }, complete: async () => ({ text: '{"summary":"Source-bound summary"}', modelRef: "stella-guarded/model" }) });
  await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    prompt: f.request.prompt, messages: [], tokenBudget: 100_000 });
  const expected = await authority.seal({ system: [rule], messages: [history, authority.currentInput()].map(fragment => ({ role: "user", fragment })) });
  await engine.assertConsumption(expected.input);
  await assert.rejects(engine.compact({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey }), /summary transaction failed/);
  await assert.rejects(engine.assertConsumption(expected.input), /summary transaction failed/);
});

test("an in-flight archive cannot report success after engine disposal", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const engine = new ManagedHostContextEngine(f.request, authority, { system: [authority.rule("AGENTS.md")], history: [],
    archive: async () => { started(); await gate; }, persistSummary: async () => {},
    complete: async () => { throw new Error("unexpected model"); } });
  const pending = engine.ingest({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    message: { role: "user", content: "Preserved raw event", timestamp: 0 } });
  await entered;
  await engine.dispose();
  release();
  await assert.rejects(pending, /host_context_expired/);
});

test("Host release cannot race a waiting model-consumption check", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  const system = authority.publicRules();
  const engine = new ManagedHostContextEngine(f.request, authority, { system, history: [], archive: async () => {},
    persistSummary: async () => {}, complete: async () => { throw new Error("unexpected summary"); } });
  await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey, prompt: f.request.prompt,
    messages: [], availableTools: new Set(), tokenBudget: 100_000 });
  const { input } = await authority.seal({ system, messages: [{ role: "user", fragment: authority.currentInput() }] });
  let resume!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const validate = authority.assertConsumption.bind(authority);
  authority.assertConsumption = async (consumption, context) => { started(); await gate; await validate(consumption, context); };
  const pending = engine.assertConsumption(input);
  await waiting;
  engine.releaseToCompletion();
  resume();
  await assert.rejects(pending, /host_context_model_phase_ended/);
});

test("Host release during archive work irrevocably ends the model phase", async t => {
  const f = await fixture(t);
  const authority = await f.create();
  let resume!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const engine = new ManagedHostContextEngine(f.request, authority, { system: authority.publicRules(), history: [],
    archive: async () => { started(); await gate; }, persistSummary: async () => {},
    complete: async () => { throw new Error("unexpected summary"); } });
  const pending = engine.ingest({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    message: { role: "user", content: "Raw archive", timestamp: 0 } });
  await waiting;
  assert.throws(() => engine.releaseToCompletion(), /host_context_operation_in_progress/);
  resume();
  await assert.rejects(pending, /host_context_operation_in_progress/);
  await assert.rejects(engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey,
    prompt: f.request.prompt, messages: [], tokenBudget: 100_000 }), /host_context_model_phase_ended/);
});

for (const failure of ["none", "source_changed", "archive_failed", "cancelled"] as const) test(`Core history completion keeps persistence before delivery (${failure})`, async t => {
  const f = await fixture(t);
  let provider: ProviderPlugin | undefined;
  let engine!: ManagedHostContextEngine;
  let authority!: HostContextAuthority;
  let input!: Awaited<ReturnType<HostContextAuthority["seal"]>>["input"];
  const order: string[] = [];
  const cancellation = new AbortController();
  let enterWrite!: () => void, releaseWrite!: () => void, finishPersist!: () => void;
  const writing = new Promise<void>(resolve => { enterWrite = resolve; });
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const persisted = new Promise<void>(resolve => { finishPersist = resolve; });
  registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
    "stella", async (_request, _model, context) => engine.assertConsumption(context), receipt => engine.observeOutput(receipt));
  type Stream = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;
  type Response = Awaited<ReturnType<Awaited<ReturnType<Stream>>["result"]>>;
  const response: Response = { role: "assistant", content: [{ type: "text", text: "Source-bound final answer" }],
    api: "openai-completions", provider: "stella-guarded", model: "model", stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = provider!.wrapStreamFn!({ provider: "stella-guarded", modelId: "model", agentId: "stella", streamFn: () => ({
    async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: response }; }, async result() { return response; },
  }) })!;
  const execution = coordinateCompletion({ operationId: "completion-history", runId: "completion-history", timeoutMs: 15000,
    request: f.request, abortSignal: cancellation.signal }, {
    async generateDraft() {
      const request = readActiveCompletionRequest("stella");
      const resolver = await f.resolver();
      const evidence = await resolver.reader.read(f.evidence, "evidence");
      const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request,
        capturedAt: "2026-09-06T00:00:00Z" }, { policyRef: evidence.policyRef as VersionedRef, objectRoot: "objects", payloadRoot: "ingress", ownerId: "owner" });
      await persistHostInputArchive({ reader: resolver.reader, archive, operationId: "completion_ingress", purpose: resolver.purpose }, {
        persist: async () => {}, confirmPreviouslyCommitted: async () => {},
      });
      authority = await f.create("direct", false, request);
      await authority.bindArchivedInput(archive.evidenceRefs[0]!);
      const system = authority.publicRules();
      engine = new ManagedHostContextEngine(request, authority, { system, history: [], archive: async () => {},
        persistSummary: async () => {}, complete: async () => { throw new Error("unexpected summary"); } });
      await engine.assemble({ sessionId: request.sessionId, sessionKey: request.sessionKey, prompt: request.prompt,
        messages: [], availableTools: new Set(), tokenBudget: 100_000 });
      input = (await authority.seal({ system, messages: [{ role: "user", fragment: authority.currentInput() }] })).input;
      const result = await stream({ provider: "stella-guarded", id: "model" } as Parameters<Stream>[0], input, { sessionId: request.sessionId });
      const final = await result.result();
      assert.equal(final.stopReason, "stop", final.errorMessage);
      engine.releaseToCompletion();
      await assert.rejects(engine.assertConsumption(input), /host_context_model_phase_ended/);
      await assert.rejects(engine.persistCompletedHistory(async () => {}), /host_context_persistence_permit_required/);
      order.push("generated");
      return { draftId: "draft", text: "Source-bound final answer", responseKind: "answer", evidenceRef: "synthetic", requiresCriticalPersistence: true };
    },
    async persist({ operationId, draft, abortSignal }) {
      try {
      if (failure === "source_changed") await f.update("Corrected while the Host was closing");
      const saved = await engine.persistCompletedHistory(context => persistContextHistory(authority, context.consumption, {
        archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, signal: abortSignal,
        durability: { async syncCritical() {
          if (failure === "archive_failed") { order.push("archive_failed"); throw new Error("synthetic archive failure"); }
          if (failure === "cancelled") { enterWrite(); await writeGate; order.push("write_returned"); return; }
          order.push("persisted");
        }, async confirmPreviouslyCommitted() {} },
      }));
      await assert.rejects(engine.persistCompletedHistory(async () => {}), /host_context_completion_phase_invalid/);
      return { schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
        draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind, evidenceRef: draft.evidenceRef,
        writeOperationIds: [saved.operationId], observedRevision: "a".repeat(40), generationId: "synthetic",
        persistenceStatus: "synchronized", checkedAt: new Date().toISOString() };
      } finally { finishPersist(); }
    },
    async publishFinal() { order.push("published"); return { deliveryId: "synthetic", status: "confirmed" }; },
  });
  if (failure === "cancelled") {
    await writing;
    cancellation.abort();
    await assert.rejects(execution, error => error instanceof Error && "stage" in error && error.stage === "persist" &&
      "category" in error && error.category === "cancelled");
    releaseWrite();
    await persisted;
    assert.deepEqual(order, ["generated", "write_returned"]);
    await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  } else if (failure === "none") {
    await execution;
    assert.deepEqual(order, ["generated", "persisted", "published"]);
  } else {
    await assert.rejects(execution, error => error instanceof Error && "stage" in error && error.stage === "persist");
    assert.deepEqual(order, failure === "source_changed" ? ["generated"] : ["generated", "archive_failed"]);
    if (failure === "archive_failed") await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  }
  await assert.rejects(engine.persistCompletedHistory(async () => {}), /host_context_persistence_permit_required/);
  await engine.dispose();
});

test("real provider and tool results extend context and inherit source revocation", async t => {
  const f = await archivedHeadFixture(t);
  let provider: ProviderPlugin | undefined;
  let authority!: HostContextAuthority;
  let sealed!: Awaited<ReturnType<HostContextAuthority["seal"]>>;
  let observed = 0;
  let engine!: ManagedHostContextEngine;
  const receipts: FragmentToolResultReceipt[] = [];
  registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
    "stella", async (_request, _model, input) => engine.assertConsumption(input), async receipt => {
      observed++;
      assert.throws(() => readHostModelOutput({ ...receipt }), /host_model_output_unbound/);
      await engine.observeOutput(receipt);
      sealed = await authority.extendAssistant(sealed.consumption, receipt);
    });
  type Stream = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;
  type Response = Awaited<ReturnType<Awaited<ReturnType<Stream>>["result"]>>;
  const response: Response = { role: "assistant", content: [{ type: "text", text: "INDEPENDENT_ASSISTANT_OBSERVATION" }, { type: "toolCall", id: "call-1", name: "stella_read_fragment", arguments: { action: "list" } },
      { type: "toolCall", id: "call-2", name: "stella_read_fragment", arguments: { action: "list" } }],
    api: "openai-completions", provider: "stella-guarded", model: "model", stopReason: "toolUse", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = provider!.wrapStreamFn!({ provider: "stella-guarded", modelId: "model", agentId: "stella", streamFn: () => ({
    async *[Symbol.asyncIterator]() { yield { type: "done", reason: "toolUse", message: response }; }, async result() { return response; },
  }) })!;
  await coordinateCompletion({ operationId: "model-output-proof", runId: f.request.runId, timeoutMs: 20_000, request: f.request }, {
    async generateDraft() {
      authority = await f.create("direct", true, readActiveCompletionRequest("stella"), async receipt => {
        assert.throws(() => readFragmentToolResult({ ...receipt }), /host_context_tool_result_unbound/);
        receipts.push(receipt);
      });
      await authority.bindArchivedInput(f.ingressRef);
      const rule = authority.rule("AGENTS.md"), evidence = await authority.evidence(f.evidence);
      engine = new ManagedHostContextEngine(readActiveCompletionRequest("stella"), authority, { system: [rule], history: [evidence],
        archive: async () => {}, persistSummary: async () => {}, complete: async ({ prompt }) => {
          for (const included of ["call-1", "call-2", "fragments", "Old interpretation", f.request.prompt]) assert.ok(prompt.includes(included));
          return { text: '{"summary":"Both fragment tool results remain part of the conversation."}', modelRef: "stella-guarded/model" };
        } });
      await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey, prompt: f.request.prompt,
        messages: [], availableTools: new Set(["stella_read_fragment"]), tokenBudget: 100_000 });
      sealed = await authority.seal({ system: [rule], messages: [evidence, authority.currentInput()].map(fragment => ({ role: "user", fragment })) });
      await assert.rejects(authority.extendAssistant(sealed.consumption, { kind: "model_output" }), /host_model_output_unbound/);
      const result = await stream({ provider: "stella-guarded", id: "model" } as Parameters<Stream>[0], sealed.input, { sessionId: f.request.sessionId });
      for await (const event of result) assert.equal(event.type, "done");
      assert.equal((await result.result()).stopReason, "toolUse");
      assert.equal(observed, 1);
      assert.equal(sealed.input.messages.at(-1)?.role, "assistant");
      await authority.assertConsumption(sealed.consumption, sealed.input);
      await f.toolFor(authority).execute("call-2", { action: "list" });
      const toolResult = await f.toolFor(authority).execute("call-1", { action: "list" });
      assert.deepEqual(toolResult.details, { fragments: [] });
      await Promise.all(receipts.map(receipt => engine.observeToolResult(receipt)));
      for (const receipt of receipts) sealed = await authority.extendToolResult(sealed.consumption, receipt);
      assert.equal(sealed.input.messages.at(-1)?.role, "toolResult");
      assert.deepEqual(sealed.input.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["call-1", "call-2"]);
      await authority.assertConsumption(sealed.consumption, sealed.input);
      await engine.assertConsumption(sealed.input);
      await assert.rejects(authority.extendToolResult(sealed.consumption, receipts[0]!), /host_context_tool_result_replayed/);
      const retained = await persistContextHistory(authority, sealed.consumption, { archiveRoot: "retained-context",
        signingKey: f.archiveKeys.privateKey, durability: f.durability });
      const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: retained.locator.sha256 }, f.archiveKeys.publicKey);
      const preparedView = await authority.prepareHistoryRebuild({ viewId: "tool-history", archive, current: [], complete: async ({ prompt }) => {
        for (const content of ["INDEPENDENT_ASSISTANT_OBSERVATION", "call-1", "call-2", "fragments", "Old interpretation", f.request.prompt]) {
          assert.ok(prompt.includes(content), `Eligible content omitted: ${content}`);
        }
        return { text: JSON.stringify({ summary: "The independent observation and both tool results remain available." }), modelRef: "stella-guarded/model" };
      } });
      const view = await authority.historyViewSnapshot(preparedView);
      const retainedProducers = view.retainedNodeIds.map(id => view.trace.nodes.find(node => node.id === id)!.producer);
      assert.ok(retainedProducers.includes("assistant") && retainedProducers.includes("tool_result") && retainedProducers.includes("current_input"));
      await engine.compact({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey });
      const compacted = await engine.assemble({ sessionId: f.request.sessionId, sessionKey: f.request.sessionKey, prompt: f.request.prompt,
        messages: sealed.input.messages, availableTools: new Set(["stella_read_fragment"]), tokenBudget: 100_000 });
      const afterCompaction = { ...sealed.input, messages: [...compacted.messages,
        { role: "user" as const, content: [{ type: "text" as const, text: f.request.prompt }], timestamp: 0 }] };
      assert.match(JSON.stringify(afterCompaction.messages), /Both fragment tool results/);
      await engine.assertConsumption(afterCompaction);
      Object.assign(f.catalog, (await CatalogReader.load(f.root, "catalog.json")).catalog);
      await f.update("Changed original source");
      await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /stale_generation/);
      await assert.rejects(engine.assertConsumption(afterCompaction), /stale_generation/);
      return { draftId: "draft", text: "Test finished", evidenceRef: "synthetic", responseKind: "answer", requiresCriticalPersistence: false };
    },
    async persist({ draft, operationId }) { return { schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
      draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind, evidenceRef: draft.evidenceRef, writeOperationIds: [],
      observedRevision: "a".repeat(40), generationId: "synthetic", persistenceStatus: "not_required", checkedAt: new Date().toISOString() }; },
    async publishFinal() { return { deliveryId: "synthetic", status: "confirmed" }; },
  });
});


for (const segmented of [false, true]) test(`personal view grant revocation invalidates summaries and fresh signed-history restoration (segmented=${segmented})`, async t => {
  const f = await archivedHeadFixture(t, segmented);
  Object.assign(f.catalog, (await CatalogReader.load(f.root, "catalog.json")).catalog);
  await f.put("works", { schemaVersion: "stella.ongoing-work/v1", id: "writing-work", kind: "writing", status: "active",
    goal: "Preserve the author's unresolved question", sourceRefs: [f.evidence], confirmedPremises: [], candidateIdeas: [],
    rejectedInterpretations: [], openQuestions: [], nextStep: null, lastAppliedChangeId: null,
    createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" }, [f.evidence]);
  await f.save();
  const authority = await f.create();
  await authority.bindArchivedInput(f.ingressRef);
  const purpose = { readPurpose: "synthetic", derivePurpose: "synthetic", deliveryScope: "synthetic" };
  const processingAuthority = bindProcessingAuthority({ request: f.request, ownerId: "owner", modelRef: "stella-guarded/model",
    deployment: resolveDeploymentDigest({ agentId: "stella", recoveryRevision: "a".repeat(40), pluginSource: "synthetic-fixed-plugin" }),
    generationId: authority.resolver.reader.catalog.generationId, purpose });
  const config = { schemaVersion: "stella.personal-context-access/v1", ownerId: "owner", requesterIds: ["owner"],
    modelRefs: ["stella-guarded/model"], viewProcessingModelRefs: ["stella-guarded/model"], purpose, descriptors: [] };
  const grantPath = "personal-view-grant.json";
  await writeFile(path.join(f.root, grantPath), canonicalJson(config));
  const processingGrant = await loadPersonalContextAccess(f.root, grantPath);
  const prepared = await preparePersonalViews({ requestId: f.request.runId, question: f.request.prompt, ownerId: "owner",
    modelRef: "stella-guarded/model", audience: "owner_direct", processingAuthority, processingGrant,
    resolver: authority.resolver, assertProcessingCurrent: processingGrant.assertCurrent, complete: async ({ prompt }) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      return { provider: "stella-guarded", model: "model", text: canonicalJson({ requestHash: input.requestHash,
        selections: input.candidates.map((candidate: { handle: string }) => ({ handle: candidate.handle, view: "memory" })) }) };
    } });
  assert.equal(prepared.view.memory.length, 1);
  const fragment = await authority.personalViews(prepared);
  const summary = await authority.summarize([fragment], async () => ({
    text: '{"summary":"The writing question remains unresolved"}', modelRef: "stella-guarded/model" }));
  const sealed = await authority.seal({ system: authority.publicRules(), messages: [{ role: "user", fragment: summary }] });
  const saved = await persistContextHistory(authority, sealed.consumption, {
    archiveRoot: "retained-context", signingKey: f.archiveKeys.privateKey, durability: f.durability });
  const archive = await loadContextHistory(f.root, { archiveRoot: "retained-context", digest: saved.locator.sha256 }, f.archiveKeys.publicKey);
  const next = await f.create();
  const restored = await next.restoreHistory(archive);
  const resumed = await next.seal({ system: next.publicRules(), messages: [{ role: "user", fragment: restored }] });
  await next.assertConsumption(resumed.consumption, resumed.input);
  await writeFile(path.join(f.root, grantPath), canonicalJson({ ...config, requesterIds: ["another-owner"] }));
  await assert.rejects(authority.assertConsumption(sealed.consumption, sealed.input), /host_context_configuration_input_changed/);
  await assert.rejects(next.assertConsumption(resumed.consumption, resumed.input), /host_context_configuration_input_changed/);
  await assert.rejects((await f.create()).restoreHistory(archive), /host_context_configuration_input_changed/);
});

async function preparedHistoryView(f: Awaited<ReturnType<typeof archivedHeadFixture>>, viewId = "session-current-view") {
  const authority = await f.create();
  Object.assign(f.catalog, (await CatalogReader.load(f.root, "catalog.json")).catalog);
  f.catalog.parentGenerationId = f.catalog.generationId;
  f.catalog.generationId = `view-${viewId}`;
  const freshRef = await f.update("CURRENT_VIEW_EVIDENCE");
  const fresh = await f.create();
  const current = await fresh.evidence(freshRef);
  const prepared = await fresh.prepareHistoryRebuild({
    viewId, archive: f.archive, current: [current],
    complete: async () => ({ text: JSON.stringify({ summary: "CURRENT_VIEW_EVIDENCE; continue" }), modelRef: "stella-guarded/model" }),
  });
  return { authority: fresh, prepared, freshRef };
}

test("published history views bind recipe and signature, restore into live consumption, and reject tampering", async t => {
  const f = await archivedHeadFixture(t);
  const { authority, prepared } = await preparedHistoryView(f);
  const ports = {
    signingKey: f.archiveKeys.privateKey,
    durability: f.durability,
    reloadAuthority: async () => f.create(),
  };
  const published = await publishPreparedHistoryView(authority, prepared, ports);
  const reader = await CatalogReader.load(f.root, "catalog.json");
  assert.equal(reader.catalog.views.some(view => view.id === published.viewId && view.required), true);
  const handle = await loadPublishedHistoryView(reader, published.viewId, f.archiveKeys.publicKey);
  assert.equal(handle.digest, published.digest);
  // Publication rewrites the catalog; only a post-commit authority may consume.
  const live = await f.create();
  const restored = await restorePublishedHistoryView(live, published);
  const sealed = await live.seal({ system: live.publicRules(), messages: [{ role: "user", fragment: restored }] });
  await live.assertConsumption(sealed.consumption, sealed.input);
  assert.match(JSON.stringify(sealed.input.messages), /CURRENT_VIEW_EVIDENCE/);

  const artifact = `retained-context/history-views/${published.digest.slice(7)}.json`;
  const original = await readFile(path.join(f.root, artifact), "utf8");
  await writeFile(path.join(f.root, artifact), original.replace("CURRENT_VIEW_EVIDENCE", "TAMPERED_VIEW_EVIDENCE"));
  await assert.rejects(readPublishedHistoryView(published, await CatalogReader.load(f.root, "catalog.json")),
    /host_context_view_(changed|signature_invalid|invalid)/);
  await assert.rejects(live.assertConsumption(sealed.consumption, sealed.input),
    /host_context_view_(changed|signature_invalid|invalid|unbound)/);
  await writeFile(path.join(f.root, artifact), original);

  const signaturePath = path.join(f.root, `${artifact}.sig`);
  const signature = await readFile(signaturePath, "utf8");
  await writeFile(signaturePath, Buffer.alloc(64).toString("base64"));
  await assert.rejects(restorePublishedHistoryView(await f.create(), published), /host_context_view_signature_invalid/);
  await writeFile(signaturePath, signature);

  // Re-admit after signature restoration so the live consumption binding is current.
  const verified = await f.create();
  const again = await restorePublishedHistoryView(verified, published);
  const resumed = await verified.seal({ system: verified.publicRules(), messages: [{ role: "user", fragment: again }] });
  await verified.assertConsumption(resumed.consumption, resumed.input);
  await writeFile(path.join(f.root, "current.txt"), "Source revoked after publication");
  await assert.rejects(verified.assertConsumption(resumed.consumption, resumed.input), /payload_digest_mismatch/);
});

test("published history view consumption rereads recipe bytes on every provider check", async t => {
  const f = await archivedHeadFixture(t);
  const { authority, prepared } = await preparedHistoryView(f, "recipe-bound-view");
  const published = await publishPreparedHistoryView(authority, prepared, {
    signingKey: f.archiveKeys.privateKey, durability: f.durability, reloadAuthority: async () => f.create(),
  });
  const live = await f.create();
  const restored = await restorePublishedHistoryView(live, published);
  const sealed = await live.seal({ system: live.publicRules(), messages: [{ role: "user", fragment: restored }] });
  await live.assertConsumption(sealed.consumption, sealed.input);
  const recipe = await live.resolver.reader.readViewRecipe(published.viewId);
  const recipePath = path.join(f.root, viewRecipePath("catalog.json", {
    id: recipe.id, version: recipe.version,
  }));
  const original = await readFile(recipePath, "utf8");
  await writeFile(recipePath, original.replace(recipe.adapterId, "forged.adapter"));
  await assert.rejects(live.assertConsumption(sealed.consumption, sealed.input),
    /host_context_view_recipe_invalid|view_recipe_version_mismatch|host_context_view_changed/);
  await writeFile(recipePath, original);
  await live.assertConsumption(sealed.consumption, sealed.input);
  const catalogPath = path.join(f.root, "catalog.json");
  const catalogBytes = await readFile(catalogPath, "utf8");
  const forgedCatalog = JSON.parse(catalogBytes) as { generationId: string; views: Array<{ generationId: string }> };
  forgedCatalog.generationId = "forged-generation";
  for (const entry of forgedCatalog.views) entry.generationId = "forged-generation";
  await writeFile(catalogPath, canonicalJson(forgedCatalog));
  await assert.rejects(live.assertConsumption(sealed.consumption, sealed.input),
    /stale_generation|host_context_generation_mismatch|processing_generation_mismatch|host_context_view_catalog_changed|invalid_catalog/);
  await writeFile(catalogPath, catalogBytes);
  await live.assertConsumption(sealed.consumption, sealed.input);
});

test("history view publication recovers a partial write without rerunning the model", async t => {
  const f = await archivedHeadFixture(t);
  const { authority, prepared } = await preparedHistoryView(f, "recoverable-view");
  const snapshot = await authority.historyViewSnapshot(prepared);
  const bytes = canonicalJson(snapshot);
  const digest = bytesVersion(bytes);
  const artifact = `retained-context/history-views/${digest.slice(7)}.json`;
  let calls = 0;
  await assert.rejects(publishPreparedHistoryView(authority, prepared, {
    signingKey: f.archiveKeys.privateKey,
    durability: { ...f.durability, async syncCritical() { throw new Error("Stopped before view commit"); } },
    reloadAuthority: async () => { calls++; return f.create(); },
  }), /Stopped before view commit/);
  assert.ok(calls >= 1);
  await assert.rejects(assertMemoryTransactionReadable(f.root), /memory_transaction_pending/);
  await assert.rejects(loadPublishedHistoryView(await CatalogReader.load(f.root, "catalog.json"), "recoverable-view", f.archiveKeys.publicKey),
    /view_unavailable|host_context_view_pending|memory_transaction_pending/);
  await rm(path.join(f.root, `${artifact}.sig`)).catch(() => undefined);
  const recovered = await recoverHistoryView(f.root, "catalog.json", f.archiveKeys.publicKey, {
    durability: f.durability,
    reloadAuthority: async () => f.create(),
  });
  assert.equal(recovered.digest, digest);
  assert.equal(await readFile(path.join(f.root, artifact), "utf8"), bytes);
  await assertMemoryTransactionReadable(f.root);
  const next = await f.create();
  const restored = await restorePublishedHistoryView(next, recovered);
  const sealed = await next.seal({ system: next.publicRules(), messages: [{ role: "user", fragment: restored }] });
  await next.assertConsumption(sealed.consumption, sealed.input);
});

test("assertHistoryViewSnapshot rejects orphan retained nodes and do_not_retain sources", async t => {
  const f = await archivedHeadFixture(t);
  const { authority, prepared, freshRef } = await preparedHistoryView(f, "lineage-view");
  const snapshot = await authority.historyViewSnapshot(prepared);
  await authority.assertHistoryViewSnapshot(snapshot, f.archiveKeys.publicKey);

  const summary = snapshot.trace.nodes.find(node => node.id === snapshot.trace.roots[0])!;
  const orphaned = structuredClone(snapshot);
  orphaned.trace = {
    nodes: snapshot.trace.nodes.map(node => node.id === summary.id
      ? { ...node, parents: node.parents.filter(parent => {
        const parentNode = snapshot.trace.nodes.find(candidate => candidate.id === parent);
        return parentNode?.producer !== "derived";
      }), sources: node.sources }
      : node),
    roots: snapshot.trace.roots,
  };
  // Rebuild summary id after parent rewrite so the forged graph stays self-consistent enough
  // for structural parsing; lineage must still fail because retained history is orphaned.
  const forgedSummaryBody = { producer: "summary" as const, version: "stella.context-node/v1" as const,
    content: summary.content, parents: orphaned.trace.nodes.find(node => node.id === summary.id)!.parents,
    sources: summary.sources };
  const forgedSummary = { id: bytesVersion(canonicalJson(forgedSummaryBody)), ...forgedSummaryBody };
  orphaned.trace = {
    nodes: orphaned.trace.nodes.map(node => node.id === summary.id ? forgedSummary : node),
    roots: [forgedSummary.id],
  };
  await assert.rejects(authority.assertHistoryViewSnapshot(orphaned, f.archiveKeys.publicKey),
    /host_context_view_lineage_invalid|host_context_graph_invalid/);

  const dnrPolicy = await f.put("policies", { schemaVersion: "stella.source-policy/v1", id: "dnr-policy", ownerId: "owner",
    readPurposes: ["synthetic"], derivePurposes: ["synthetic"], deliveryScopes: ["synthetic"], retention: "do_not_retain",
    authorityEvidenceRefs: [] });
  const coverage = f.catalog.coverage.find(entry => entry.status === "current")!;
  await writeFile(path.join(f.root, "dnr.txt"), "must not be retained in a durable view");
  const dnrSource = await f.put("sources", { schemaVersion: "stella.memory-source/v1", id: "dnr-source",
    origin: { adapterId: "synthetic", collectionId: "history", upstreamId: "dnr" }, capturedAt: "2026-09-06T00:00:00Z",
    policyRef: dnrPolicy, coverageRef: { id: coverage.id, version: coverage.version },
    payloads: [{ path: "dnr.txt", mediaType: "text/plain", bytes: Buffer.byteLength("must not be retained in a durable view"),
      sha256: bytesVersion("must not be retained in a durable view") }] }, [dnrPolicy, { id: coverage.id, version: coverage.version }]);
  const dnrEvidence = await f.put("evidence", { schemaVersion: "stella.memory-evidence/v1", id: "dnr-evidence", source: dnrSource,
    payloadSha256: bytesVersion("must not be retained in a durable view"),
    selector: { kind: "utf8_bytes", value: `0:${Buffer.byteLength("must not be retained in a durable view")}` },
    speakerId: "owner", role: "owner", kind: "reported", independentOriginId: "dnr-source", derivedFrom: [],
    occurredAt: null, authoredAt: "2026-09-06T00:00:00Z", capturedAt: "2026-09-06T00:00:00Z", policyRef: dnrPolicy },
  [dnrSource, dnrPolicy]);
  await f.save();
  const blocked = await f.create();
  const current = await blocked.evidence(dnrEvidence);
  const blockedView = await blocked.prepareHistoryRebuild({
    viewId: "dnr-view", archive: f.archive, current: [current],
    complete: async () => ({ text: JSON.stringify({ summary: "should never publish" }), modelRef: "stella-guarded/model" }),
  });
  await assert.rejects(publishPreparedHistoryView(blocked, blockedView, {
    signingKey: f.archiveKeys.privateKey, durability: f.durability, reloadAuthority: async () => f.create(),
  }), /host_context_archive_retention_forbidden/);
  assert.ok(freshRef);
});
