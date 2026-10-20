import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFixture, initializeFixtureRepository, prepareInitializationFixture } from "../.test-dist/tests/consciousness-fixture.js";
import { observeExactHostRunTerminal, startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const outputRejectionProbe = process.argv.includes("--correction-output-rejected");
const correctionRecoveryProbe = process.argv.includes("--correction-recovery");
const consolidationCase = process.argv.find(arg => arg.startsWith("--core-consolidation"))?.slice("--core-consolidation".length) || (process.argv.includes("--core-consolidation") ? "success" : undefined);
if (consolidationCase) assert.ok(["success", "-source-stale", "-revoked", "-recovery"].includes(consolidationCase));
const consolidationProbe = Boolean(consolidationCase);
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-main-completion-"));
const nativeCase = process.argv.find(arg => arg.startsWith("--native-memory-"))?.slice("--native-memory-".length);
const [nativeFamily, nativeState] = nativeCase?.split("-") ?? [];
const nativeSuccess = ["success", "rebuilt"].includes(nativeState);
const googleAgent = process.argv.includes("--google-agent");
const nativeQueryControl = process.argv.includes("--native-query-control");
assert.ok(!nativeQueryControl || nativeFamily === "gemini");
assert.ok(!googleAgent || nativeFamily === "gemini", "Google Agent control is limited to synthetic Gemini native fixtures");
if (nativeCase) assert.ok(["fts", "cache", "session", "wiki", "query", "gemini"].includes(nativeFamily) && ["success", "stale", "mismatch", "missing", ...(["query", "gemini"].includes(nativeFamily) ? ["index"] : []), ...(nativeFamily === "gemini" ? ["edit", "delete", "revoked", "generation", "oldindex", "policy", "rebuilt"] : [])].includes(nativeState) && (nativeState !== "missing" || ["cache", "gemini"].includes(nativeFamily)));
let producerReport, nativeSource;
if (nativeFamily === "gemini") {
  const producerWorkspace = path.join(temp, "synthetic-producer");
  await mkdir(path.join(producerWorkspace, "memory"), { recursive: true });
  const text = nativeState === "rebuilt" ? "SYNTHETIC_ALLOWED_FRAGMENT_GEMINI_REBUILT\n" : "SYNTHETIC_ALLOWED_FRAGMENT_GEMINI\n";
  const rawPath = path.join(producerWorkspace, "memory/retained.md");
  await writeFile(rawPath, text);
  nativeSource = { provider: "memory-core", nativePath: "memory/retained.md", rawPath,
    rawSha256: createHash("sha256").update(text).digest("hex"), text, fromLine: 1, lineCount: 1 };
  producerReport = { schemaVersion: "stella.synthetic-memory-source/v1", hostVersion: host.version,
    workspace: producerWorkspace, artifacts: [nativeSource], privateDataCopied: false };
} else if (nativeCase) {
  assert.ok(process.env.STELLA_NATIVE_PRODUCERS_REPORT, "Native consumption requires a real producer report");
  producerReport = JSON.parse(await readFile(process.env.STELLA_NATIVE_PRODUCERS_REPORT, "utf8"));
  assert.equal(producerReport.schemaVersion, "stella.native-memory-producers/v1");
  assert.equal(producerReport.hostVersion, host.version); assert.equal(producerReport.dreamingEnabled, false);
  assert.equal(producerReport.nativeSessionNewExecuted, true); assert.equal(producerReport.nativeWikiCompileExecuted, true);
  assert.equal(producerReport.nativeCompiledClaimRead, true);
  nativeSource = producerReport.artifacts.find(value => value.provider === ({ session: "session-memory", wiki: "memory-wiki" }[nativeFamily] ?? "memory-core"));
  assert.ok(nativeSource);
  if (nativeFamily === "wiki") assert.equal(typeof nativeSource.claimId, "string");
  assert.equal(createHash("sha256").update(await readFile(nativeSource.rawPath)).digest("hex"), nativeSource.rawSha256);
}
const audienceScenario = process.argv.find(arg => arg.startsWith("--source-audience-"))?.slice("--source-audience-".length) ?? (nativeCase ? "owner" : undefined);
if (audienceScenario) assert.ok(["owner", "visitor", "group", "channel", "cron", "subagent", "requester-denied", "revoked"].includes(audienceScenario));
const audienceAllowed = audienceScenario === "owner" || audienceScenario === "revoked";
const ingressField = process.argv.find(arg => arg.startsWith("--host-ingress-"))?.slice("--host-ingress-".length);
if (ingressField) assert.ok(["prependSystemContext", "appendSystemContext", "prependContext", "bootstrap"].includes(ingressField));
const liveFragment = process.argv.includes("--fragment-live");
const fragmentProbe = liveFragment || process.argv.includes("--fragment-skill");
const nativeFragmentFixture = Boolean(audienceScenario) || process.argv.includes("--guarded-active-memory") || process.argv.includes("--guarded-active-memory-stale");
const liveModel = "google/gemini-3.8-flash";
let liveProvider;
if (liveFragment) {
  assert.ok(process.env.STELLA_LIVE_HOST_CONFIG, "STELLA_LIVE_HOST_CONFIG is required for explicitly authorized synthetic model acceptance");
  const configured = JSON.parse(await readFile(process.env.STELLA_LIVE_HOST_CONFIG, "utf8"));
  liveProvider = configured.models?.providers?.google;
  assert.equal(liveProvider?.api, "google-generative-ai");
  assert.ok(liveProvider.apiKey, "Configured Google provider credentials required");
}
const nativeArtifactIndex = process.argv.indexOf("--native-artifact");
const nativeArtifactProbe = nativeArtifactIndex !== -1;
let nativeArtifact;
if (nativeArtifactProbe) {
  const reportPath = process.argv[nativeArtifactIndex + 1];
  assert.ok(reportPath && !reportPath.startsWith("--"), "--native-artifact requires a native generation report");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.hostVersion, "2026.8.2");
  assert.equal(report.scope, "native-artifact-generation");
  assert.equal(report.model, "synthetic-loopback");
  const dreaming = report.artifactKind === "dreaming-diary";
  if (dreaming) {
    assert.equal(report.nativeCronExecuted, true);
    assert.equal(report.nativeNarrativeExecuted, true);
    assert.equal(report.nativeSourceRead, true);
  } else {
    assert.equal(report.genuineToolAuthority, true);
    assert.equal(report.nativeReadExecuted, true);
    assert.equal(report.nativeRecallRequests, 2);
    assert.equal(report.nativeSummaryInjected, true);
  }
  const artifactPath = path.join(path.dirname(path.resolve(reportPath)), dreaming ? "native-dreams.md" : "native-final-input.json");
  const bytes = await readFile(artifactPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), report.artifactSha256);
  let text = bytes.toString("utf8");
  if (!dreaming) {
    const request = JSON.parse(text);
    const users = request.messages.filter(message => message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(typeof users[0].content, "string");
    // Parse only the pinned Host's literal envelope, never semantic content.
    // Preserve the exact prefix that the native plugin actually injected.
    const open = "Context:\n<active_memory_plugin>\n", close = "\n</active_memory_plugin>";
    const start = users[0].content.indexOf(open), end = users[0].content.indexOf(close, start + open.length);
    assert.ok(start >= 0 && end > start && users[0].content.indexOf(open, start + open.length) === -1);
    text = users[0].content.slice(start, end + close.length);
  }
  nativeArtifact = { text, sha256: createHash("sha256").update(text).digest("hex"), generationArtifactSha256: report.artifactSha256,
    entry: dreaming ? "appendSystemContext" : "prependContext", kind: dreaming ? "dreaming-diary" : "active-memory-prompt-prefix",
    generationReport: path.resolve(reportPath) };
}
const managedBusinessFailure = process.argv.includes("--managed-business-failure");
const completionStatusChanged = process.argv.includes("--completion-status-changed");
const nativeCompletionLifecycle = process.argv.includes("--native-completion-lifecycle");
const completionLifecycleProbe = completionStatusChanged || nativeCompletionLifecycle || process.argv.includes("--completion-lifecycle");
const nativeNewPassThrough = process.argv.includes("--native-new-pass-through");
const outcomeHistoryRecoveryProbe = process.argv.includes("--outcome-history-recovery");
const outcomeHistoryProbe = outcomeHistoryRecoveryProbe || process.argv.includes("--outcome-history");
const sourceDeletionProbe = process.argv.includes("--source-deletion-history");
const historyFollowupProbe = process.argv.includes("--history-view-followup");
const historyQueuedNoticeProbe = process.argv.includes("--history-queued-notice");
const standaloneCompactStale = process.argv.includes("--standalone-compact-stale");
const standaloneCompactGrantDenied = process.argv.includes("--standalone-compact-grant-denied");
const standaloneCompactPersistFailure = process.argv.includes("--standalone-compact-persist-failure");
const standaloneCompactProbe = standaloneCompactStale || standaloneCompactGrantDenied || standaloneCompactPersistFailure || process.argv.includes("--standalone-compact");
const historyNativeCompactProbe = process.argv.includes("--history-native-compact");
const historyViewProbe = sourceDeletionProbe || historyFollowupProbe || historyQueuedNoticeProbe || historyNativeCompactProbe || process.argv.includes("--history-view-rebuild");
const nativeActiveStale = process.argv.includes("--guarded-active-memory-stale");
const managedContextProbe = consolidationProbe || Boolean(audienceScenario || ingressField) || nativeActiveStale || completionLifecycleProbe || outcomeHistoryProbe || standaloneCompactProbe || nativeArtifactProbe || managedBusinessFailure || historyViewProbe || process.argv.includes("--guarded-active-memory") || process.argv.includes("--managed-context");
const guardedDreaming = process.argv.includes("--guarded-dreaming");
const guardedActive = nativeActiveStale || process.argv.includes("--guarded-active-memory");
const guardedStale = process.argv.includes("--guarded-provider-stale");
const guardedPayload = process.argv.includes("--guarded-payload-transform");
const guardedSemantic = process.argv.includes("--guarded-semantic");
const guardedProvider = nativeNewPassThrough || managedContextProbe || guardedPayload || guardedDreaming || guardedActive || guardedSemantic || guardedStale || process.argv.includes("--guarded-provider");
const probeProvider = guardedProvider ? "stella-guarded" : "stella-smoke";
const probeModelId = googleAgent ? "gemini-3.8-flash" : "probe";
const probeModel = liveFragment ? liveModel : `${probeProvider}/${probeModelId}`;
const correctionProbe = managedContextProbe || fragmentProbe || outputRejectionProbe || correctionRecoveryProbe || process.argv.includes("--correction");
const questionRecoveryProbe = process.argv.includes("--question-recovery");
const admissionReplayProbe = process.argv.includes("--admission-replay");
const preparationCancellationProbe = process.argv.includes("--cancel-preparation");
const cancellationProbe = process.argv.includes("--cancel") || preparationCancellationProbe;
const adviceRevisionProbe = process.argv.includes("--advice-revision") || process.argv.includes("--advice-revision-recovery");
const adviceTailProbe = process.argv.includes("--advice-evidence-recovery") || process.argv.includes("--advice-revision-recovery");
const recoveryProbe = correctionRecoveryProbe || process.argv.includes("--outcome-recovery") || questionRecoveryProbe || adviceTailProbe;
const failureProbe = nativeActiveStale || completionStatusChanged || nativeArtifactProbe || managedBusinessFailure || outputRejectionProbe || process.argv.includes("--outcome-persist-failure") || recoveryProbe;
const outcomeProbe = outcomeHistoryProbe || process.argv.includes("--outcome") || failureProbe && !correctionProbe && !questionRecoveryProbe && !adviceTailProbe;
const questionProbe = process.argv.includes("--question-evidence") || process.argv.includes("--question-durable") || questionRecoveryProbe || admissionReplayProbe;
const managed = correctionProbe || process.argv.includes("--managed") || cancellationProbe || adviceRevisionProbe || outcomeProbe || process.argv.includes("--question-durable") || questionRecoveryProbe || adviceTailProbe || admissionReplayProbe;
// Resolve dependencies from the tested package's consumer, not the development checkout.
const snapshotParent = path.join(packageRoot, ".artifacts");
await mkdir(snapshotParent, { recursive: true });
const coreSnapshot = await mkdtemp(path.join(snapshotParent, "main-probe-build-"));
const coreDist = path.join(coreSnapshot, "dist");
await cp(path.join(packageRoot, "dist"), coreDist, { recursive: true });
if (nativeCase && nativeFamily !== "gemini") {
  // Record the response at Core's public native-read seam. Host may replace its
  // runtime capability object during config reload, so wrapping one manager
  // instance is insufficient. This isolated Core copy adds observation only.
  const file = path.join(coreDist, "src/openclaw/native-memory-reader.js");
  let source = await readFile(file, "utf8");
  source = `import { appendFileSync as recordNativeRead } from 'node:fs';\n` + source;
  for (const marker of ["result = await supplement.get", "result = await loaded.manager.readFile"]) {
    const start = source.indexOf(marker); assert.ok(start >= 0 && source.indexOf(marker, start + 1) === -1);
    const end = source.indexOf(";", start) + 1; assert.ok(end > start);
    source = source.slice(0, end) + `\nrecordNativeRead(${JSON.stringify(path.join(temp, "native-consumed.jsonl"))}, JSON.stringify({ origin, result }) + '\\n');\n` + source.slice(end);
  }
  await writeFile(file, source);
}
// One-variable diagnostic: change only the isolated Core copy, never the Host.
if (nativeCompletionLifecycle) {
  const adapter = path.join(coreDist, "src/openclaw/completion-adapter.js");
  const original = await readFile(adapter, "utf8");
  assert.equal(original.split("deferTerminalLifecycle: true").length, 2);
  await writeFile(adapter, original.replace("deferTerminalLifecycle: true", "deferTerminalLifecycle: false"));
}
await cp(path.join(packageRoot, "schemas"), path.join(coreSnapshot, "schemas"), { recursive: true });
const buildModule = (relative) => pathToFileURL(path.join(coreDist, relative)).href;
const canghaiRoot = await realpath(await createFixture());
let outcomeSeed;
let outcomePurpose;
async function verifyQuestionBundle(reader, requestId, revision, remote, remoteRevision) {
  const { loadEvidenceBundle } = await import(buildModule("src/praxis/evidence-bundle.js"));
  const { EpisodeEvidenceResolver } = await import(buildModule("src/praxis/episode-evidence.js"));
  const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
  assert.equal(reader.catalog.bundles.length, 1);
  const entry = reader.catalog.bundles[0];
  const resolver = new EpisodeEvidenceResolver(reader, { ...outcomePurpose, evidenceCutoff: new Date().toISOString(),
    trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No new semantic judgment during readback"); });
  const loaded = await loadEvidenceBundle(resolver, { bundleRef: { id: entry.id, version: entry.version }, requestId, revision, generationId: (await reader.read(entry, "bundles")).generationId });
  assert.equal(loaded.bundle.suggestedResponseKind, "answer");
  assert.equal(loaded.originalEvidence.length, 1);
  assert.deepEqual(reader.catalog.changes, []);
  assert.deepEqual(reader.catalog.understandings, []);
  assert.deepEqual(JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${entry.locator.path}`])).stdout), loaded.bundle);
  const bindingPath = `30_PersonalData/memory/operations/question_${bytesVersion(requestId).slice(7)}.evidence.json`;
  const binding = JSON.parse(await readFile(path.join(canghaiRoot, bindingPath), "utf8"));
  assert.equal(binding.requestHash, bytesVersion("What did my friend confirm about the weekend?"));
  assert.equal(binding.draftHash, bytesVersion("SYNTHETIC_MAIN_ANSWER"));
  assert.deepEqual(JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${bindingPath}`])).stdout), binding);
}
async function verifyOutcomeBundle(reader, requestId, revision, remote, remoteRevision) {
  const { loadEvidenceBundle } = await import(buildModule("src/praxis/evidence-bundle.js"));
  const { EpisodeEvidenceResolver } = await import(buildModule("src/praxis/episode-evidence.js"));
  assert.equal(reader.catalog.bundles.length, 1);
  const entry = reader.catalog.bundles[0];
  const resolver = new EpisodeEvidenceResolver(reader, { ...outcomePurpose, evidenceCutoff: new Date().toISOString(),
    trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("Readback is not a new action judgment"); });
  const loaded = await loadEvidenceBundle(resolver, { bundleRef: { id: entry.id, version: entry.version }, requestId, revision,
    generationId: (await reader.read(entry, "bundles")).generationId });
  assert.equal(loaded.bundle.suggestedResponseKind, "outcome_ack");
  assert.equal(loaded.originalEvidence.length, 1);
  assert.equal(loaded.originalEvidence[0].role, "owner");
  assert.equal(loaded.bundle.claims.find((claim) => claim.id === "candidate-strategy").kind, "proposal");
  const remoteBundle = JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${entry.locator.path}`])).stdout);
  assert.deepEqual(remoteBundle, loaded.bundle);
}
async function verifyAdviceBundle(reader, requestId, revision, remote, remoteRevision, episode) {
  const { loadEvidenceBundle } = await import(buildModule("src/praxis/evidence-bundle.js"));
  const { EpisodeEvidenceResolver } = await import(buildModule("src/praxis/episode-evidence.js"));
  const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
  const { episodeVersion } = await import(buildModule("src/praxis/episode-repository.js"));
  const entry = reader.catalog.bundles[0];
  assert.equal(reader.catalog.bundles.length, 1);
  const bundle = await reader.read(entry, "bundles");
  const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat",
    evidenceCutoff: new Date().toISOString(), trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No synthetic action judgment during readback"); });
  const loaded = await loadEvidenceBundle(resolver, { bundleRef: { id: entry.id, version: entry.version }, requestId, revision, generationId: bundle.generationId });
  assert.equal(loaded.bundle.suggestedResponseKind, "action_advice");
  assert.notEqual(loaded.bundle.generationId, loaded.validatedGenerationId);
  assert.deepEqual(JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${entry.locator.path}`])).stdout), bundle);
  const bindingPath = `30_PersonalData/memory/operations/question_${bytesVersion(requestId).slice(7)}.evidence.json`;
  const binding = JSON.parse(await readFile(path.join(canghaiRoot, bindingPath), "utf8"));
  assert.deepEqual(binding.advice, { id: episode.id, version: episodeVersion(episode) });
  assert.equal(binding.draftHash, bytesVersion("SYNTHETIC_MAIN_ANSWER"));
  assert.equal(binding.requestHash, bytesVersion("Synthetic main plugin question"));
  assert.deepEqual(JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${bindingPath}`])).stdout), binding);
}
if (outcomeProbe || questionProbe || adviceRevisionProbe) {
  const { loadConsciousness } = await import(buildModule("src/canghai/manifest.js"));
  const { loadPraxisRuntimeBinding, createBoundPraxisRuntime } = await import(buildModule("src/praxis/runtime-binding.js"));
  const { prepareHostInputArchive } = await import(buildModule("src/canghai/host-input-archive.js"));
  const { persistHostInputArchive } = await import(buildModule("src/canghai/archive-writer.js"));
  const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
  const { memoryRoutingRef } = await import(buildModule("src/praxis/runtime-memory.js"));
  const loaded = await loadConsciousness(canghaiRoot);
  const binding = await loadPraxisRuntimeBinding(loaded);
  const now = "2026-09-05T00:00:00Z";
  const text = "Synthetic owner report: I asked about the weekend time. My friend confirmed Saturday.";
  const snapshot = { schemaVersion: "stella.host-input-snapshot/v1", hostVersion: "2026.8.2", agentId: "probe",
    sessionId: "synthetic-origin", sessionKey: "agent:probe:synthetic-origin", entryId: "synthetic-report", logicalTurnId: "synthetic-report-turn",
    generation: "synthetic-fixture", rawSeq: 1, parentId: null, text,
    event: { type: "message", id: "synthetic-report", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text }] } } };
  // This owner binding is known only inside the explicitly synthetic fixture, not inferred from a Host role.
  const archive = prepareHostInputArchive(snapshot, { ...binding.archive, speaker: { id: "owner-fixture", role: "owner" } });
  outcomePurpose = binding.purpose;
  const archived = await persistHostInputArchive({ reader: await CatalogReader.load(canghaiRoot, binding.catalogPath), archive,
    operationId: "synthetic-outcome-origin", purpose: binding.purpose }, { async persist() {}, async confirmPreviouslyCommitted() {} });
  const runtime = await createBoundPraxisRuntime(loaded, binding, async () => { throw new Error("Seed advice must not verify an action"); }, async () => {});
  const episodeId = "praxis-synthetic-outcome";
  const advised = await runtime.recommend({ operationId: "synthetic-initial", recordedAt: now,
    episode: { schemaVersion: "stella.praxis-episode/v2", id: episodeId, status: "open", createdAt: now, updatedAt: now,
      recoveryPriority: "important", historicalInputRefs: [], provenance: {},
      ...(adviceRevisionProbe ? { twin: { prediction: { possibleActions: { ask: 0.6, wait: 0.4 }, likelyInterpretations: [], keyFactors: [] } } } : {}),
      situation: { summary: "Synthetic weekend invitation", domains: ["social"], observations: [] } },
    decision: { recommendation: "Ask for a suitable weekend time", rationale: [] } });
  outcomeSeed = { episodeId, advised, episodeRef: memoryRoutingRef({ id: episodeId, version: advised.version }, runtime.repository.historicalPath(episodeId, advised.version)),
    actual: { action: "Asked about the weekend time", occurredAt: null, source: "user_report", evidenceRefs: archived.evidenceRefs },
    outcome: { observations: ["Friend confirmed Saturday"], result: "Weekend time confirmed", observedAt: now, evidenceRefs: archived.evidenceRefs },
    learning: { disposition: "propose_strategy", rationale: "Synthetic local candidate based on this report", evidenceRefs: archived.evidenceRefs,
      strategy: { statement: "Confirm specific time for a weekend invitation", scope: { workIds: [], contexts: ["weekend invitation"], domains: ["social"], global: false } } } };
}
const initializationRecipe = await prepareInitializationFixture(canghaiRoot, "probe", fragmentProbe ? "No private data. Use stella_read_fragment to list descriptions, then read an exact fragment handle and cite its Evidence ref. Never read source files." : undefined);
if (correctionProbe) {
  const prefix = "50_PersonalAgent/stella";
  const file = path.join(canghaiRoot, prefix, "runtime-profile.yaml");
  const profile = parseYaml(await readFile(file, "utf8"));
  profile.capabilities.push({ id: "source_access_context", adapter_id: "stella.personal-context-access", adapter_version: "1",
    config_ref: `path:${prefix}/personal-access.json`, acceptance_ref: `path:${prefix}/capability-acceptance.json`, required: true, required_secret_refs: [] });
  await writeFile(file, stringifyYaml(profile));
  await writeFile(path.join(canghaiRoot, prefix, "personal-access.json"), JSON.stringify({ schemaVersion: "stella.personal-context-access/v1",
    ownerId: "owner-fixture", requesterIds: [audienceScenario === "requester-denied" ? "different-requester" : "cli"], modelRefs: [probeModel], viewProcessingModelRefs: [probeModel], operatorRecovery: true,
    ...(standaloneCompactProbe && !standaloneCompactGrantDenied ? { operatorHistoryCompaction: true } : {}),
    ...(consolidationProbe ? { operatorMemoryConsolidation: true } : {}),
    purpose: { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat" }, descriptors: [] }));
}

let fragmentOriginalPath;
if (fragmentProbe || nativeFragmentFixture) {
  const { prepareRepositorySource } = await import(buildModule("src/canghai/repository-source.js"));
  const { canonicalJson, bytesVersion, objectVersion } = await import(buildModule("src/canghai/content-version.js"));
  const catalogFile = path.join(canghaiRoot, "30_PersonalData/memory/catalog.json");
  const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  const base = { schemaVersion: "stella.source-policy/v1", id: "fragment-open", ownerId: "owner-fixture",
    readPurposes: ["alpha_praxis"], derivePurposes: ["alpha_praxis"], deliveryScopes: ["host-chat"], retention: "retain", authorityEvidenceRefs: [] };
  const policies = [base, { ...base, id: "fragment-denied", readPurposes: [] }];
  const refs = [];
  for (const policy of policies) {
    const ref = { id: policy.id, version: objectVersion(policy) }, file = `30_PersonalData/memory/${policy.id}.json`, body = canonicalJson(policy);
    await writeFile(path.join(canghaiRoot, file), body);
    catalog.policies.push({ ...ref, status: "current", dependencies: [], locator: { path: file, sha256: bytesVersion(body) } }); refs.push(ref);
  }
  const allowed = nativeSource?.text ?? "SYNTHETIC_ALLOWED_FRAGMENT\n", denied = nativeFragmentFixture ? "" : "SYNTHETIC_DENIED_NEIGHBOR\n";
  const payload = nativeSource ? await readFile(nativeSource.rawPath, "utf8") : allowed + denied;
  const segmentStart = nativeSource?.segmentStart ?? 0, segmentEnd = nativeSource?.segmentEnd ?? Buffer.byteLength(allowed);
  fragmentOriginalPath = path.join(canghaiRoot, "30_PersonalData/memory/fragments.txt");
  await writeFile(fragmentOriginalPath, payload);
  const imported = await prepareRepositorySource({ root: canghaiRoot, collectionId: "fragment-probe", sourceId: "mixed",
    relativePath: "30_PersonalData/memory/fragments.txt", expectedSha256: bytesVersion(payload), capturedAt: "2026-09-01T00:00:00Z", policyRef: refs[0],
    ...(nativeSource ? { nativeMemory: { schemaVersion: "stella.native-memory-origin/v1", hostVersion: host.version,
      agentId: "probe", provider: nativeSource.provider, path: nativeSource.nativePath, fromLine: nativeSource.fromLine, lineCount: nativeSource.lineCount,
      ...(nativeSource.claimId === undefined ? {} : { claimId: nativeSource.claimId }) } } : {}),
    objectRoot: "30_PersonalData/memory/objects", reviewedSegments: [
      ...(segmentStart > 0 ? [{ start: 0, end: segmentStart, policyRef: refs[0] }] : []),
      { start: segmentStart, end: segmentEnd, policyRef: refs[0] },
      ...(nativeSource && segmentEnd < Buffer.byteLength(payload) ? [{ start: segmentEnd, end: Buffer.byteLength(payload), policyRef: refs[0] }] : []),
      ...(nativeFragmentFixture ? [] : [{ start: Buffer.byteLength(allowed), end: Buffer.byteLength(payload), policyRef: refs[1] }])] });
  for (const object of imported.objects) {
    // Retain the full native file, but expose only the declared body excerpt as
    // retrievable Evidence. Frontmatter remains retained provenance metadata.
    if (nativeSource && object.group === "evidence" && object.object.selector.value !== `${segmentStart}:${segmentEnd}`) continue;
    await mkdir(path.dirname(path.join(canghaiRoot, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(canghaiRoot, object.entry.locator.path), object.bytes); catalog[object.group].push(object.entry);
  }
  await writeFile(catalogFile, canonicalJson(catalog));
  const accessFile = path.join(canghaiRoot, "50_PersonalAgent/stella/personal-access.json");
  const access = JSON.parse(await readFile(accessFile, "utf8"));
  access.descriptors = refs.slice(0, nativeFragmentFixture ? 1 : 2).map((policyRef, index) => ({ sourceRef: imported.sourceRef, policyRef,
    description: index ? "Synthetic unavailable neighboring fragment" : "Synthetic permitted observation fragment",
    segment: { payloadSha256: bytesVersion(payload), start: index ? Buffer.byteLength(allowed) : segmentStart,
      end: index ? Buffer.byteLength(payload) : segmentEnd } }));
  if (!nativeFragmentFixture) access.descriptors.push({ ...access.descriptors[1], policyRef: refs[0] });
  if (nativeSource) for (const segment of [
    ...(segmentStart > 0 ? [{ start: 0, end: segmentStart }] : []),
    ...(segmentEnd < Buffer.byteLength(payload) ? [{ start: segmentEnd, end: Buffer.byteLength(payload) }] : []),
  ]) for (const policyRef of refs.slice(0, 1)) access.descriptors.push({ sourceRef: imported.sourceRef, policyRef,
    description: "Synthetic unavailable native envelope", segment: { payloadSha256: bytesVersion(payload), ...segment } });
  await writeFile(accessFile, canonicalJson(access));
}

let contextSourceCount = 0;
if (managedContextProbe) {
  const { loadConsciousness } = await import(buildModule("src/canghai/manifest.js"));
  const { loadPraxisRuntimeBinding } = await import(buildModule("src/praxis/runtime-binding.js"));
  const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
  const { prepareRepositorySource } = await import(buildModule("src/canghai/repository-source.js"));
  const { parseCangHaiRef } = await import(buildModule("src/canghai/ref.js"));
  const { canonicalJson, bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
  const loaded = await loadConsciousness(canghaiRoot), binding = await loadPraxisRuntimeBinding(loaded);
  const reader = await CatalogReader.load(canghaiRoot, binding.catalogPath);
  for (const document of loaded.bootstrapDocuments) {
    const imported = await prepareRepositorySource({ root: canghaiRoot, collectionId: "main-context", sourceId: document.ref,
      relativePath: parseCangHaiRef(document.ref).relativePath, expectedSha256: bytesVersion(document.content),
      capturedAt: "2026-09-01T00:00:00Z", policyRef: binding.archive.policyRef, objectRoot: binding.archive.objectRoot });
    for (const object of imported.objects) {
      await mkdir(path.dirname(path.join(canghaiRoot, object.entry.locator.path)), { recursive: true });
      await writeFile(path.join(canghaiRoot, object.entry.locator.path), object.bytes);
      reader.catalog[object.group].push(object.entry);
    }
    binding.referenceBindings.push({ routingRef: document.ref, sourceRef: imported.sourceRef });
    contextSourceCount++;
  }
  await writeFile(path.join(canghaiRoot, binding.catalogPath), canonicalJson(reader.catalog));
  const file = path.join(canghaiRoot, binding.configPath), prior = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, canonicalJson({ ...prior, referenceBindings: binding.referenceBindings }));
}
if (nativeCase) {
  const retained = path.join(canghaiRoot, "30_PersonalData/native-producer");
  await mkdir(retained, { recursive: true });
  await cp(producerReport.workspace, path.join(retained, "workspace"), { recursive: true });
  if (nativeFamily !== "gemini") {
    await cp(producerReport.vault, path.join(retained, "vault"), { recursive: true });
    await cp(path.join(producerReport.evidenceDirectory, "wiki-input.md"), path.join(retained, "wiki-input.md"));
  }
  await writeFile(path.join(retained, "producer.json"), JSON.stringify(producerReport, null, 2));
}
const queryServer = nativeFamily === "query" ? createServer() : undefined;
if (queryServer) {
  await new Promise(resolve => queryServer.listen(0, "127.0.0.1", resolve));
  const file = path.join(canghaiRoot, "50_PersonalAgent/stella/personal-access.json");
  const grant = JSON.parse(await readFile(file));
  grant.queryEmbedding = { provider: "openai", model: "text-embedding-3-small", dimensions: 384,
    endpoint: `http://127.0.0.1:${queryServer.address().port}/v1/embeddings` };
  await writeFile(file, JSON.stringify(grant));
}
if (nativeState === "rebuilt") {
  const file = path.join(canghaiRoot, "30_PersonalData/memory/catalog.json");
  const value = JSON.parse(await readFile(file)); value.generationId = "synthetic-rebuilt-generation";
  await writeFile(file, JSON.stringify(value));
  await writeFile(path.join(canghaiRoot, "30_PersonalData/native-producer/previous-source.txt"), "SYNTHETIC_ALLOWED_FRAGMENT_GEMINI\n");
}
const revision = await initializeFixtureRepository(canghaiRoot);
const remote = path.join(temp, "canghai.git");
if (managed) {
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["-C", canghaiRoot, "remote", "add", "origin", remote]);
  await run("git", ["-C", canghaiRoot, "push", "origin", "HEAD:refs/heads/main"]);
  if (failureProbe && !adviceTailProbe && !correctionProbe) await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", path.join(temp, "intentionally-missing-remote.git")]);
}
const state = path.join(temp, "state");
const plugin = path.join(temp, "plugin");
const workspace = path.join(temp, "workspace");
await Promise.all([state, plugin, workspace].map((directory) => mkdir(directory)));
const nativeVault = path.join(temp, "native-vault");
if (nativeCase) {
  await cp(path.join(producerReport.workspace, "memory"), path.join(workspace, "memory"), { recursive: true });
  if (nativeFamily !== "gemini") await cp(producerReport.vault, nativeVault, { recursive: true });
}
const contextKeys = managedContextProbe ? await (await import(buildModule("src/openclaw/host-context-keys.js"))).initializeContextHistoryKeys({
  stateDirectory: state, repositoryRoot: canghaiRoot, agentId: "probe" }) : undefined;
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic isolated main plugin probe. No tools or private data.\n");
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "stella-main-probe", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
await writeFile(path.join(plugin, "openclaw.plugin.json"), await readFile(path.join(packageRoot, "openclaw.plugin.json")));
await writeFile(path.join(plugin, "index.mjs"), `
import main from ${JSON.stringify(buildModule("src/plugin.js"))};
import { GitCangHaiDurability } from ${JSON.stringify(buildModule("src/canghai/durability.js"))};
import { readSessionTranscriptRawDelta } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-transcript-runtime.js")).href)};
import { listSessionEntries, resolveStorePath, patchSessionEntry } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/session-store-runtime.js")).href)};
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ManagedHostContextEngine } from ${JSON.stringify(buildModule("src/openclaw/host-context-engine.js"))};
import { HostContextAuthority } from ${JSON.stringify(buildModule("src/openclaw/host-context-authority.js"))};
import { CatalogReader } from ${JSON.stringify(buildModule("src/canghai/catalog-reader.js"))};
import { readCompletionPreparation, hasCompletionRunPermit } from ${JSON.stringify(buildModule("src/openclaw/completion.js"))};
import { getPluginRuntimeGatewayRequestScope } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/plugin-runtime.js")).href)};
import { getMemoryCapabilityRegistration } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/memory-host-core.js")).href)};
import { resolveCommandAuthorization } from ${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/command-auth.js")).href)};
import { resolveTurnAudience } from ${JSON.stringify(buildModule("src/openclaw/turn-audience.js"))};
if (${completionStatusChanged}) {
  const originalSync = GitCangHaiDurability.prototype.syncCritical;
  GitCangHaiDurability.prototype.syncCritical = async function(paths, message) {
    const receipt = await originalSync.call(this, paths, message);
    if (message.startsWith('preserve question evidence ')) {
      const before = listSessionEntries({ agentId: 'probe', readOnly: true }).find(row => row.sessionKey === 'agent:probe:main-completion')?.entry;
      const after = await patchSessionEntry({ agentId: 'probe', sessionKey: 'agent:probe:main-completion', requireWriteSuccess: true,
        update(entry) {
          if (!Number.isSafeInteger(entry.startedAt)) throw new Error('Synthetic status fault lacks a native start');
          return { startedAt: entry.startedAt + 1 };
        } });
      writeFileSync(${JSON.stringify(path.join(temp, "completion-status-changed.json"))}, JSON.stringify({ before, after, message }));
    }
    return receipt;
  };
}
if (${outcomeHistoryRecoveryProbe}) {
  const checkpoint = ${JSON.stringify(path.join(temp, "outcome-recovery-checkpoint.json"))};
  const originalSync = GitCangHaiDurability.prototype.syncCritical;
  GitCangHaiDurability.prototype.syncCritical = async function(paths, message) {
    if (message.startsWith('close and evaluate outcome_') && !existsSync(checkpoint)) {
      writeFileSync(checkpoint, JSON.stringify({ archiveRevision: execFileSync('git', ['-C', ${JSON.stringify(canghaiRoot)}, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }));
      execFileSync('git', ['-C', ${JSON.stringify(canghaiRoot)}, 'remote', 'set-url', 'origin', ${JSON.stringify(path.join(temp, "intentionally-missing-remote.git"))}]);
    }
    return originalSync.call(this, paths, message);
  };
}
if (${managedContextProbe}) {
  for (const method of ['seal', 'projectBoundary', 'assertConsumption', 'assertReplayConsumption', 'routingCandidates', ...(${outcomeHistoryProbe} ? ['semanticRoute', 'outcomeContext', 'cortexContext'] : [])]) {
    const invoke = HostContextAuthority.prototype[method];
    HostContextAuthority.prototype[method] = async function(...args) {
      const record = value => appendFileSync(${JSON.stringify(path.join(temp, "context-inputs.jsonl"))}, JSON.stringify(value) + '\\n');
      if (method === 'assertConsumption' || method === 'assertReplayConsumption') record({method,input:args[1]});
      if (method === 'routingCandidates') record({method,candidates:args[0].candidates,runId:this.request.runId});
      if (${outcomeHistoryProbe}) record({method,phase:'enter',at:Date.now()});
      let result;
      try { result = await invoke.apply(this, args); }
      catch (error) { record({ method, phase: 'failed', category: error.category, message: error.message, stack: error.stack }); throw error; }
      if (${outcomeHistoryProbe}) record({method,phase:'returned',at:Date.now()});
      if (result?.input) record({method,input:result.input});
      return result;
    };
  }
  for (const method of ['assemble', 'ingest', 'assertConsumption', 'persistCompletedHistory', 'observeOutput']) {
    const original = ManagedHostContextEngine.prototype[method];
    ManagedHostContextEngine.prototype[method] = async function(...args) {
      const record = value => appendFileSync(${JSON.stringify(path.join(temp, "context-lifecycle.jsonl"))}, JSON.stringify(value) + '\\n');
      record({ method, phase: 'enter', prompt: args[0]?.prompt, count: args[0]?.messages?.length, tokenBudget: args[0]?.tokenBudget, availableTools: args[0]?.availableTools ? [...args[0].availableTools] : undefined });
      try { const result = await original.apply(this, args); record({method,phase:'returned'}); return result; }
      catch(error) {record({method,phase:'failed',category:error.category,message:error.message,stack:error.stack});throw error;}
    };
  }
}
if (${managedBusinessFailure}) {
  const originalSync = GitCangHaiDurability.prototype.syncCritical;
  GitCangHaiDurability.prototype.syncCritical = async function(paths, message) {
    if (message.startsWith('preserve question evidence ')) {
      writeFileSync(${JSON.stringify(path.join(temp, "managed-business-failure.json"))}, JSON.stringify({ paths, message }));
      throw new Error('SYNTHETIC_BUSINESS_PERSISTENCE_FAILED');
    }
    return originalSync.call(this, paths, message);
  };
}
if (${correctionRecoveryProbe}) {
  const checkpoint = ${JSON.stringify(path.join(temp, "correction-checkpoint.json"))};
  const originalSync = GitCangHaiDurability.prototype.syncCritical;
  GitCangHaiDurability.prototype.syncCritical = async function(paths, message) {
    if (message.startsWith('stella correction ') && !existsSync(checkpoint)) {
      writeFileSync(checkpoint, JSON.stringify({ archiveRevision: execFileSync('git', ['-C', ${JSON.stringify(canghaiRoot)}, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }));
      execFileSync('git', ['-C', ${JSON.stringify(canghaiRoot)}, 'remote', 'set-url', 'origin', ${JSON.stringify(path.join(temp, "intentionally-missing-remote.git"))}]);
    }
    return originalSync.call(this, paths, message);
  };
}
if (${adviceTailProbe}) {
  const checkpoint = ${JSON.stringify(path.join(temp, "advice-tail-checkpoint.json"))};
  const originalSync = GitCangHaiDurability.prototype.syncCritical;
  GitCangHaiDurability.prototype.syncCritical = async function(paths, message) {
    if (message.startsWith('preserve question evidence ') && !existsSync(checkpoint)) {
      const beforeTailRevision = execFileSync('git', ['-C', ${JSON.stringify(canghaiRoot)}, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      writeFileSync(checkpoint, JSON.stringify({ beforeTailRevision }));
      execFileSync('git', ['-C', ${JSON.stringify(canghaiRoot)}, 'remote', 'set-url', 'origin', ${JSON.stringify(path.join(temp, "intentionally-missing-remote.git"))}]);
    }
    return originalSync.call(this, paths, message);
  };
}
const seed = ${JSON.stringify(outcomeProbe ? outcomeSeed : null)};
const outcomePhase = () => !${outcomeHistoryProbe} || existsSync(${JSON.stringify(path.join(temp, 'outcome-history-phase'))}) && readFileSync(${JSON.stringify(path.join(temp, 'outcome-history-phase'))}, 'utf8') === 'outcome';
const tracedPreparations = new WeakSet();
export default { ...main, register(api) {
  if (${Boolean(nativeCase)}) {
    const record = value => appendFileSync(${JSON.stringify(path.join(temp, "native-backend.jsonl"))}, JSON.stringify({ ...value, observedAt: Date.now() }) + '\\n');
    api.registerGatewayMethod('stella.syntheticNativePrepare', async ({ respond }) => {
      try {
        if (${nativeFamily === "wiki"}) { respond(true, { wiki: true }); return; }
        const runtime = getMemoryCapabilityRegistration()?.capability.runtime;
        if (!runtime) throw new Error('actual_memory_core_registration_missing');
        const { manager } = await runtime.getMemorySearchManager({ cfg: api.runtime.config.current(), agentId: 'probe' });
        if (!manager) throw new Error('actual_native_manager_unavailable');
        let rebuild;
        if (${nativeState === "rebuilt"}) {
          const file = ${JSON.stringify(nativeSource ? path.join(workspace, nativeSource.nativePath) : "")};
          writeFileSync(file, 'SYNTHETIC_ALLOWED_FRAGMENT_GEMINI\\n');
          await manager.sync({ force: true });
          const prior = manager.status();
          const { DatabaseSync } = await import('node:sqlite');
          const indexed = () => { const db = new DatabaseSync(prior.dbPath, { readOnly: true });
            try { return db.prepare('SELECT hash, text FROM memory_index_chunks WHERE path = ? ORDER BY id').all(${JSON.stringify(nativeSource?.nativePath)}); }
            finally { db.close(); } };
          const before = indexed();
          writeFileSync(file, ${JSON.stringify(nativeSource?.text)});
          await manager.sync({ force: true });
          rebuild = { prior, before, after: indexed(), generationId: 'synthetic-rebuilt-generation' };
          record({ operation: 'generation-rebuild', rebuild });
        }
        await manager.sync({ force: true });
        const cold = manager.status();
        record({ operation: 'cold-sync', status: cold });
        await manager.sync({ force: true });
        const warm = manager.status();
        record({ operation: 'warm-sync', status: warm });
        const nativeQuery = ${nativeQueryControl} ? await manager.search('Synthetic source audience acceptance',
          { maxResults: 32, minScore: 0, sources: ['memory'], sessionKey: 'agent:probe:main-completion' }) : undefined;
        if (nativeQuery) record({ operation: 'native-query-control', hits: nativeQuery });
        await manager.close();
        respond(true, { cold, warm, ...(rebuild ? { rebuild } : {}), ...(nativeQuery ? { nativeQuery } : {}) });
      } catch(error) { respond(false, undefined, { code: 'UNAVAILABLE', message: String(error) }); }
    });
    api.on('after_tool_call', event => {
      if (event.toolName === 'stella_read_fragment') appendFileSync(${JSON.stringify(path.join(temp, "native-tool-results.jsonl"))}, JSON.stringify(event) + '\\n');
    });
    if (${["query", "gemini"].includes(nativeFamily) && nativeState === "index"}) api.on('after_tool_call', async event => {
      if (event.toolName !== 'stella_read_fragment' || !event.result?.details?.original?.ref) return;
      const { DatabaseSync } = await import('node:sqlite');
      const { loadSqliteVecExtension } = await import(${JSON.stringify(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/memory-core-host-engine-storage.js")).href)});
      const db = new DatabaseSync(${JSON.stringify(path.join(state, "agents/probe/agent/openclaw-agent.sqlite"))}, { allowExtension: true });
      try {
        if (!(await loadSqliteVecExtension({ db })).ok) throw new Error('synthetic_vector_extension_missing');
        const vector = Array.from({ length: ${nativeFamily === "gemini" ? 3072 : 384} }, (_, index) => index === 1 ? 1 : 0);
        const selected = db.prepare('SELECT id FROM memory_index_chunks WHERE path = ?').all(${JSON.stringify(nativeSource?.nativePath)});
        for (const row of selected) db.prepare('UPDATE memory_index_chunks_vec SET embedding = ? WHERE id = ?').run(new Float32Array(vector), row.id);
        db.prepare('UPDATE memory_index_chunks SET embedding = ? WHERE path = ?').run(JSON.stringify(vector), ${JSON.stringify(nativeSource?.nativePath)});
        db.prepare('UPDATE memory_embedding_cache SET embedding = ?').run(JSON.stringify(vector));
      } finally { db.close(); }
      writeFileSync(${JSON.stringify(path.join(temp, "native-query-index-invalidated.json"))}, JSON.stringify({ afterNativeRead: true }));
    });
    if (${nativeState === "stale"}) api.on('after_tool_call', event => {
      if (event.toolName !== 'stella_read_fragment' || !event.result?.details?.original?.ref) return;
      unlinkSync(${JSON.stringify(fragmentOriginalPath)});
      writeFileSync(${JSON.stringify(path.join(temp, "native-source-stale.json"))}, JSON.stringify({ afterNativeRead: true,
        nativeArtifactRetained: existsSync(${JSON.stringify(nativeSource ? path.join(nativeFamily === "wiki" ? nativeVault : workspace, nativeSource.nativePath) : "")}) }));
    });
  }
  if (${nativeFamily === "gemini" && ["edit", "delete", "revoked", "generation", "oldindex", "policy"].includes(nativeState)}) api.on('after_tool_call', async event => {
    if (event.toolName !== 'stella_read_fragment' || !event.result?.details?.original?.ref) return;
    const action = ${JSON.stringify(nativeState)};
    const root = ${JSON.stringify(canghaiRoot)};
    const expectedPath = { edit: '30_PersonalData/memory/fragments.txt', delete: '30_PersonalData/memory/fragments.txt',
      generation: '30_PersonalData/memory/catalog.json', policy: '30_PersonalData/memory/fragment-open.json' }[action];
    const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
    const before = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1'),
      ...(expectedPath ? { bytes: readFileSync(root + '/' + expectedPath, 'utf8') } : {}) };
    if (action === 'edit') writeFileSync(${JSON.stringify(fragmentOriginalPath)}, 'SYNTHETIC_REPLACED_ORIGINAL\\n');
    if (action === 'delete') unlinkSync(${JSON.stringify(fragmentOriginalPath)});
    if (action === 'revoked') {
      const file = ${JSON.stringify(path.join(canghaiRoot, "50_PersonalAgent/stella/personal-access.json"))};
      const value = JSON.parse(readFileSync(file, 'utf8')); value.requesterIds = ['revoked']; writeFileSync(file, JSON.stringify(value));
    }
    if (action === 'generation') {
      const file = ${JSON.stringify(path.join(canghaiRoot, "30_PersonalData/memory/catalog.json"))};
      const value = JSON.parse(readFileSync(file, 'utf8')); value.generationId = 'synthetic-next-generation'; writeFileSync(file, JSON.stringify(value));
    }
    if (action === 'policy') {
      const file = root + '/' + expectedPath; const value = JSON.parse(readFileSync(file, 'utf8'));
      value.readPurposes = []; value.derivePurposes = []; writeFileSync(file, JSON.stringify(value));
    }
    if (action === 'oldindex') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(path.join(state, "agents/probe/agent/openclaw-agent.sqlite"))});
      try { const row = db.prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'").get();
        const value = JSON.parse(row.value); value.providerKey = '0'.repeat(64);
        db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(JSON.stringify(value));
      } finally { db.close(); }
    }
    writeFileSync(${JSON.stringify(path.join(temp, "gemini-invalidation.json"))}, JSON.stringify({ action, afterAuthorizedFragmentRead: true, expectedPath, before,
      after: { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1'),
        ...(expectedPath ? { bytes: existsSync(root + '/' + expectedPath) ? readFileSync(root + '/' + expectedPath, 'utf8') : null } : {}) } }));
  });
  if (${Boolean(ingressField && ingressField !== "bootstrap")}) api.on('before_prompt_build', () => {
    appendFileSync(${JSON.stringify(path.join(temp, "ingress-hook.jsonl"))}, JSON.stringify({ entry: ${JSON.stringify(ingressField)} }) + '\\n');
    return { [${JSON.stringify(ingressField)}]: 'SYNTHETIC_UNBOUND_HOST_MEMORY' };
  }, { priority: 100 });
  if (${audienceScenario === "revoked"}) api.on('after_tool_call', event => {
    if (event.toolName !== 'stella_read_fragment' || !event.result?.details?.original?.ref) return;
    const file = ${JSON.stringify(path.join(canghaiRoot, "50_PersonalAgent/stella/personal-access.json"))};
    const grant = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...grant, requesterIds: ['revoked-requester'] }));
    writeFileSync(${JSON.stringify(path.join(temp, "audience-revoked.json"))}, JSON.stringify({ afterAuthorizedFragmentRead: true }));
  });
  if (${nativeActiveStale}) {
    api.on('after_tool_call', event => {
      const ref = event.result?.details?.original?.ref;
      if (event.toolName === 'stella_read_fragment' && ref) writeFileSync(${JSON.stringify(path.join(temp, "native-read-evidence.json"))}, JSON.stringify(ref));
    });
    api.on('agent_end', async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      const marker = ${JSON.stringify(path.join(temp, "native-source-invalidation.json"))};
      const selected = ${JSON.stringify(path.join(temp, "native-read-evidence.json"))};
      if (scope?.pluginId !== 'active-memory' || !existsSync(selected) || existsSync(marker)) return;
      const reader = await CatalogReader.load(${JSON.stringify(canghaiRoot)}, '30_PersonalData/memory/catalog.json');
      const evidence = await reader.read(JSON.parse(readFileSync(selected, 'utf8')), 'evidence');
      const source = await reader.read(evidence.source, 'sources');
      const payload = source.payloads[0];
      const deletedPath = ${JSON.stringify(canghaiRoot)} + '/' + payload.path;
      const before = readFileSync(deletedPath);
      unlinkSync(deletedPath);
      writeFileSync(marker, JSON.stringify({ sourceRef: evidence.source, payload, deletedPath,
        retainedBytesBeforeDeletion: before.length, generationId: reader.catalog.generationId,
        nativeModelOutputAlreadyObserved: true }));
    });
  }
  if (${historyFollowupProbe || nativeNewPassThrough}) api.registerGatewayMethod('stella.syntheticResetEvidence', async ({ respond }) => {
    const storePath = resolveStorePath(undefined, { agentId: 'probe' });
    const found = listSessionEntries({ agentId: 'probe', storePath, readOnly: true }).find(row => row.sessionKey === 'agent:probe:main-completion');
    if (!found) { respond(true, { resets: 0 }); return; }
    const page = await readSessionTranscriptRawDelta({ agentId: 'probe', sessionId: found.entry.sessionId,
      sessionKey: found.sessionKey, storePath, maxEvents: 1000, maxBytes: 1024 * 1024 });
    if (page.kind !== 'page' || page.hasMore) throw new Error('Incomplete synthetic reset inspection');
    respond(true, { resets: page.events.filter(row => row.event.type === 'reset').length,
      lifecycleRevision: found.entry.lifecycleRevision, sessionId: found.entry.sessionId });
  }, { scope: 'operator.admin' });
  if (${nativeArtifactProbe}) api.on('before_prompt_build', () => {
    appendFileSync(${JSON.stringify(path.join(temp, "native-reinjection-hook.jsonl"))}, JSON.stringify({
      sha256: ${JSON.stringify(nativeArtifact?.sha256 ?? null)}, entry: ${JSON.stringify(nativeArtifact?.entry ?? null)} }) + '\\n');
    return { [${JSON.stringify(nativeArtifact?.entry ?? "appendSystemContext")}]: ${JSON.stringify(nativeArtifact?.text ?? "")} };
  }, { priority: 100 });
  if (${guardedDreaming}) api.on('before_agent_run', (_event, ctx) => {
    appendFileSync(${JSON.stringify(path.join(temp, "native-runs.jsonl"))}, JSON.stringify({ trigger: ctx.trigger,
      sessionKey: ctx.sessionKey, runId: ctx.runId }) + '\\n');
  }, { priority: 2000 });
  if (${guardedActive}) api.on('before_prompt_build', (_event, ctx) => {
    appendFileSync(${JSON.stringify(path.join(temp, "active-hooks.jsonl"))}, JSON.stringify({ trigger: ctx.trigger,
      sessionKey: ctx.sessionKey, messageProvider: ctx.messageProvider, channelId: ctx.channelId,
      readAllowed: ctx.toolAuthority?.allows('read'), fragmentAllowed: ctx.toolAuthority?.allows('stella_read_fragment') }) + '\\n');
  }, { priority: 1100, requiresToolAuthority: true });
  if (${guardedStale}) api.on('after_tool_call', () => {
    const catalogPath = ${JSON.stringify(path.join(canghaiRoot, "30_PersonalData/memory/catalog.json"))};
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    catalog.parentGenerationId = catalog.generationId;
    catalog.generationId = 'synthetic-after-tool-generation';
    writeFileSync(catalogPath, JSON.stringify(catalog));
  });
  if (${liveFragment}) api.on('after_tool_call', event => appendFileSync(${JSON.stringify(path.join(temp, "live-tools.jsonl"))}, JSON.stringify(event) + '\\n'));
  if (${liveFragment}) api.on('llm_input', event => appendFileSync(${JSON.stringify(path.join(temp, "live-inputs.jsonl"))}, JSON.stringify({ forbiddenNeighbor: JSON.stringify(event).includes('SYNTHETIC_DENIED_NEIGHBOR'), correctionPresent: JSON.stringify(event).includes('SYNTHETIC_CORRECTED_PREMISE'), event }) + '\\n'));
  main.register({ ...api,
    on(name, handler, options) {
      if (${Boolean(audienceScenario || ingressField)} && name === 'reply_dispatch') return api.on(name, async (event, ctx) => {
        const sender = resolveCommandAuthorization({ ctx: event.ctx, cfg: ctx.cfg, commandAuthorized: event.ctx.CommandAuthorized });
        const request = { sessionKey: event.sessionKey, chatType: event.ctx.ChatType, ...sender };
        appendFileSync(${JSON.stringify(path.join(temp, "audience-dispatch.jsonl"))}, JSON.stringify({ ...request,
          audience: resolveTurnAudience(request).audience }) + '\\n');
        return handler(event, ctx);
      }, options);
      if (${guardedActive} && ['before_prompt_build', 'before_agent_run'].includes(name)) return api.on(name, async (event, ctx) => {
        const owner = getPluginRuntimeGatewayRequestScope();
        const record = value => appendFileSync(${JSON.stringify(path.join(temp, "native-authority-events.jsonl"))}, JSON.stringify(value) + '\\n');
        record({ name, phase: 'enter', runId: ctx.runId, sessionId: ctx.sessionId,
          owner: owner && { pluginId: owner.pluginId, pluginOrigin: owner.pluginOrigin, pluginSource: owner.pluginSource },
          authorizedPhase: options?.requiresToolAuthority === true });
        try { const result = await handler(event, ctx);
          const prepared = hasCompletionRunPermit(ctx.runId) ? readCompletionPreparation(ctx.runId) : undefined;
          if (name === 'before_agent_run' && prepared && !tracedPreparations.has(prepared)) {
            tracedPreparations.add(prepared);
            for (const method of ['persistContextHistory', 'persistRecommendation', 'publishContextHistory']) {
              const invoke = prepared[method];
              if (!invoke) continue;
              prepared[method] = async (...args) => {
                try { return await invoke(...args); }
                catch(error) { record({name:method,phase:'failed',category:error.category,message:error.message,stack:error.stack});throw error; }
              };
            }
          }
          record({ name, phase: 'returned', result }); return result; }
        catch(error) { record({ name, phase: 'failed', category: error.category, message: error.message, stack: error.stack }); throw error; }
      }, options);
      if (${sourceDeletionProbe || completionLifecycleProbe} && name === 'reply_dispatch') return api.on(name, async (event, ctx) => {
        let owned;
        const result = await handler(event, { ...ctx, onAgentRunStart(...args) {
          const ownership = ctx.onAgentRunStart(...args);
          if (ownership === 'reply-dispatch') owned = args[2];
          return ownership;
        } });
        if (owned?.completionSource === 'reply-dispatch') {
          const terminal = owned.getResult()?.terminalOutcome;
          if (terminal) {
            appendFileSync(${JSON.stringify(path.join(temp, "completion-dispatch-settled.jsonl"))}, JSON.stringify({
              runId: event.runId, terminal, at: Date.now(),
              session: listSessionEntries({ agentId: 'probe', readOnly: true }).find(row => row.sessionKey === event.sessionKey)?.entry,
            }) + '\\n');
          }
        }
        return result;
      }, options);
      if (${nativeNewPassThrough} && name === 'reply_dispatch') return api.on(name, async (event, ctx) => {
        if (event.ctx.BodyForCommands?.trim() !== '/new') return handler(event, ctx);
        writeFileSync(${JSON.stringify(path.join(temp, "native-new-pass-through.json"))}, JSON.stringify({ commandTurn: event.ctx.CommandTurn }));
        return handler(event, ctx);
      }, options);
      return api.on(name, handler, options);
    },
    registerContextEngine(id, factory) {
      api.registerContextEngine(id, context => {
        const engine = factory(context);
        if (${managedContextProbe}) appendFileSync(${JSON.stringify(path.join(temp, "context-lifecycle.jsonl"))}, JSON.stringify({
          method: 'factory', engine: engine.info, agentDir: context.agentDir, workspace: context.workspaceDir,
          agents: context.config?.agents }) + '\\n');
        if (${managedContextProbe}) {
          for (const method of ['assemble', 'ingest', 'compact', 'dispose']) {
            const invoke = engine[method];
            if (!invoke) continue;
            engine[method] = async (...args) => {
              try { return await invoke.apply(engine, args); }
              catch(error) { appendFileSync(${JSON.stringify(path.join(temp, "context-lifecycle.jsonl"))}, JSON.stringify({
                method: 'lazy_' + method, category: error.category, stack: error.stack }) + '\\n'); throw error; }
            };
          }
        }
        return engine;
      });
    }, runtime: { ...api.runtime, ...(${guardedActive} ? { agent: { ...api.runtime.agent,
      async runEmbeddedAgent(params) {
        try { return await api.runtime.agent.runEmbeddedAgent(params); }
        catch(error) { appendFileSync(${JSON.stringify(path.join(temp, "native-runtime-error.jsonl"))}, JSON.stringify({
          category: error.category, message: error.message, stack: error.stack }) + '\\n'); throw error; }
      },
    } } : {}), llm: { ...api.runtime.llm,
    async complete(params) {
      if (${Boolean(audienceScenario || ingressField)}) appendFileSync(${JSON.stringify(path.join(temp, "audience-semantic.jsonl"))}, JSON.stringify({ purpose: params.purpose }) + '\\n');
      if (${cancellationProbe}) appendFileSync(${JSON.stringify(path.join(temp, "cancellation-semantic-calls.jsonl"))}, JSON.stringify({ purpose: params.purpose, at: Date.now() }) + '\\n');
      if (${outcomeHistoryRecoveryProbe} && existsSync(${JSON.stringify(path.join(temp, "outcome-recovery-running"))})) {
        appendFileSync(${JSON.stringify(path.join(temp, "outcome-recovery-inference.jsonl"))}, JSON.stringify({ purpose: params.purpose }) + '\\n');
        throw new Error('Recovery must not invoke any semantic model');
      }
      if (${guardedSemantic} && params.purpose === 'stella-core-semantic-routing') return api.runtime.llm.complete(params);
      if (${consolidationProbe} && params.purpose === 'stella-memory-consolidation') return api.runtime.llm.complete(params);
      if (${standaloneCompactProbe} && params.purpose === 'stella-history-rebuild') return api.runtime.llm.complete(params);
      if (${liveFragment} && ['stella-source-access', 'stella-source-output'].includes(params.purpose)) {
        if (JSON.stringify(params.messages).includes('SYNTHETIC_DENIED_NEIGHBOR')) throw new Error('live_semantic_input_leaked_neighbor');
        let result;
        try { result = await api.runtime.llm.complete(params); }
        catch (error) {
          writeFileSync(${JSON.stringify(path.join(temp, "live-model-failure.json"))}, JSON.stringify({ purpose: params.purpose, message: String(error.message) }), { mode: 0o600 });
          throw error;
        }
        appendFileSync(${JSON.stringify(path.join(temp, "live-semantic.jsonl"))}, JSON.stringify({ purpose: params.purpose, provider: result.provider, model: result.model, text: result.text }) + '\\n');
        return result;
      }
      if (${preparationCancellationProbe}) return api.runtime.llm.complete(params);
      if (${fragmentProbe || nativeFragmentFixture} && params.purpose === 'stella-source-access') {
        const value = JSON.parse(params.messages[0].content.split('\\n').at(-1));
        return { provider: ${JSON.stringify(liveFragment ? 'google' : probeProvider)}, model: ${JSON.stringify(liveFragment ? 'gemini-3.8-flash' : probeModelId)}, text: JSON.stringify({ requestHash: value.requestHash, sourceRef: value.sourceRef,
          policyRef: value.policyRef, segment: value.segment, applicable: true, scenarios: ['synthetic'], topicRequested: true, topicExplicitlyNamed: true }) };
      }
      if (${correctionProbe} && params.purpose === 'stella-source-output') {
        const value = JSON.parse(params.messages[0].content.split('\\n').at(-1));
        return { provider: ${JSON.stringify(liveFragment ? 'google' : probeProvider)}, model: ${JSON.stringify(liveFragment ? 'gemini-3.8-flash' : probeModelId)}, text: JSON.stringify({ requestHash: value.requestHash,
          draftHash: value.draftHash, sourcesHash: value.sourcesHash, compliant: ${!outputRejectionProbe}, violations: ${JSON.stringify(outputRejectionProbe ? ["quotation_not_authorized"] : [])} }) };
      }
      if (${correctionProbe} && ['stella-correction', 'stella-personal-views'].includes(params.purpose)) {
        const value = JSON.parse(params.messages[0].content.split('\\n').at(-1));
        let result;
        if (params.purpose === 'stella-personal-views') result = { requestHash: value.requestHash, selections: value.candidates.map(c => ({ handle: c.handle, view: 'memory' })) };
        else if (value.proposalHash) result = { requestHash: value.requestHash, proposalHash: value.proposalHash, valid: true };
        else if (${consolidationProbe} && existsSync(${JSON.stringify(path.join(temp, "consolidation-followup-phase"))}) || ${outcomeHistoryProbe} || ${sourceDeletionProbe} && existsSync(${JSON.stringify(path.join(temp, "source-deletion-phase"))}) || ${historyFollowupProbe || standaloneCompactProbe} && existsSync(${JSON.stringify(path.join(temp, "history-followup-phase"))})) {
          result = { requestHash: value.requestHash, disposition: 'no_change', clarification: null,
            reviewedHandles: value.candidates.map(c => c.handle), rationale: 'Synthetic follow-up has no new correction', replacements: [] };
        } else {
          result = { requestHash: value.requestHash, disposition: 'update', clarification: null, reviewedHandles: value.candidates.map(c => c.handle),
          rationale: 'Synthetic owner intent', replacements: [{ handle: null, group: 'understandings', record: { kind: 'owner_statement', status: 'active',
            statement: ${historyViewProbe} && existsSync(${JSON.stringify(path.join(temp, "published-history-view.json"))}) ? 'SYNTHETIC_NEW_PREMISE' : 'SYNTHETIC_CORRECTED_PREMISE', scope: { workIds: [], contexts: ['synthetic writing'], domains: ['writing'], global: false },
            supportRefs: value.ownerEvidence.map(e => e.ref), counterRefs: [], dependencyRefs: [] } }] };
          if (${historyViewProbe} && existsSync(${JSON.stringify(path.join(temp, "published-history-view.json"))})) result.replacements[0].handle = value.candidates.find(c => c.group === 'understandings')?.handle ?? null;
        }
        return { provider: ${JSON.stringify(liveFragment ? 'google' : probeProvider)}, model: ${JSON.stringify(liveFragment ? 'gemini-3.8-flash' : probeModelId)}, text: JSON.stringify(result) };
      }
      if (${historyViewProbe || outcomeHistoryProbe} && params.purpose === 'stella-history-rebuild') {
        appendFileSync(${JSON.stringify(path.join(temp, "history-rebuild-prompts.jsonl"))}, JSON.stringify(params.messages) + '\\n');
        return { provider: ${JSON.stringify(probeProvider)}, model: 'probe', text: JSON.stringify({ summary: ${JSON.stringify(sourceDeletionProbe ? 'SYNTHETIC_POST_DELETE_CURRENT' : outcomeHistoryProbe ? 'SYNTHETIC_OUTCOME_CURRENT' : 'SYNTHETIC_NEW_PREMISE')} }) };
      }
      if (${sourceDeletionProbe || historyFollowupProbe || historyNativeCompactProbe || outcomeHistoryProbe} && params.purpose === 'stella-context-summary') {
        appendFileSync(${JSON.stringify(path.join(temp, "history-summary-prompts.jsonl"))}, JSON.stringify(params.messages) + '\\n');
        return { provider: ${JSON.stringify(probeProvider)}, model: 'probe', text: JSON.stringify({ summary: ${JSON.stringify(sourceDeletionProbe ? 'SYNTHETIC_POST_DELETE_CURRENT' : outcomeHistoryProbe ? 'SYNTHETIC_OUTCOME_CURRENT' : 'SYNTHETIC_NEW_PREMISE')} }) };
      }

      if (params.purpose === 'stella-core-open-episode-selection') return { provider: ${JSON.stringify(guardedProvider ? probeProvider : 'synthetic')}, model: ${JSON.stringify(guardedProvider ? probeModelId : 'injected')}, text: JSON.stringify({ openEpisodeRef: ${JSON.stringify(adviceRevisionProbe ? outcomeSeed.episodeRef : null)} }) };
      if (params.purpose === 'stella-question-evidence') {
        const input = JSON.parse(params.messages[0].content.split('\\n').at(-1));
        return { provider: ${JSON.stringify(liveFragment ? 'google' : correctionProbe ? probeProvider : 'synthetic')}, model: ${JSON.stringify(liveFragment ? 'gemini-3.8-flash' : correctionProbe ? probeModelId : 'injected')}, text: JSON.stringify({ status: input.provisionalRoute.evidenceStatus,
          claims: [], unresolvedLeads: input.provisionalRoute.materialUnknowns.map((question) => ({ question, material: true, reason: 'Synthetic unknown' })),
          stoppingReason: 'Synthetic configured source scope', suggestedResponseKind: input.provisionalRoute.responseKind }) };
      }
      if (seed) {
        const prompt = params.messages[0].content;
        const result = (value) => ({ text: JSON.stringify(value), provider: ${JSON.stringify(outcomeHistoryProbe ? probeProvider : 'synthetic')}, model: ${JSON.stringify(outcomeHistoryProbe ? 'probe' : 'injected')} });
        if (prompt.startsWith("You are Stella's actual-action evidence verifier")) return result({ supported: true, ...seed.actual, rationale: 'Synthetic injected action verdict' });
        if (prompt.startsWith("You are Stella's reported-outcome evidence verifier")) return result({ supported: true, outcome: seed.outcome, rationale: 'Synthetic injected outcome verdict' });
      }
      if (seed && outcomePhase()) {
        const result = (value) => ({ text: JSON.stringify(value), provider: ${JSON.stringify(outcomeHistoryProbe ? probeProvider : 'synthetic')}, model: ${JSON.stringify(outcomeHistoryProbe ? 'probe' : 'injected')} });
        if (params.purpose === 'stella-core-open-episode-selection') return result({ openEpisodeRef: null });
        if (params.purpose === 'stella-core-semantic-routing') return result({ mode: 'outcome', responseKind: 'outcome_ack', evidenceStatus: 'sufficient', materialUnknowns: [],
          domains: ['social'], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false, outcome: { openEpisodeRef: seed.episodeRef } });
        const prompt = params.messages[0].content;
        if (prompt.startsWith('Prepare a Stella outcome plan')) return result({ disposition: 'ready', actual: seed.actual, outcome: seed.outcome,
          predictionAssessment: 'unresolved', learning: seed.learning });
        throw new Error('Unexpected synthetic completion phase');
      }
      return { provider: ${JSON.stringify(liveFragment ? "google" : correctionProbe ? probeProvider : "synthetic")}, model: ${JSON.stringify(liveFragment ? "gemini-3.8-flash" : correctionProbe ? probeModelId : "injected")}, text: JSON.stringify(${JSON.stringify(managed && !questionProbe && !correctionProbe ? {
      mode: "praxis", responseKind: "action_advice", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["social"], stakes: "low", reversibility: "high",
      needsTwin: true, needsFramework: true, needsReality: true, needsExternalResearch: false, candidateTwinRefs: [], candidateFrameworks: [], candidatePraxisRefs: [],
      situation: { actors: ["self"], observations: ["Synthetic question"], interpretations: [], unknowns: [], userGoals: ["Choose a reversible step"], constraints: [] },
    } : { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false })}) }; },
  } } });
} };
`);
const providerArrived = Promise.withResolvers();
const providerRelease = Promise.withResolvers();
let providerRequests = 0;
let semanticProviderRequests = 0;
let providerReceivedOriginalEvidence = false;
let providerReceivedCorrection = false;
let providerReceivedInitialization = false;
let initializationInputEvidence;
let initializationVerification;
const skillReadProbe = (!managed || managedContextProbe && guardedStale) && !cancellationProbe;
let providerReceivedSkillBody = false;
let providerReceivedInitializationResult = false;
let observedSkillResult;
let cancellationCheckpoint;
const fragmentChecks = { allowedRead: false, descriptionListed: false, skillBodyRead: false, deniedNeighborAbsent: true, wholeFileBlocked: false, unavailableHandleBlocked: false };
let nativeRecallRequests = 0;
let nativeFragmentRead = false;
let nativeSummaryConsumed = false;
const embeddingRequests = [];
const provider = queryServer ?? createServer();
provider.on("request", async (request, response) => {
  if (nativeFamily === 'gemini' && request.url === '/v1beta/models/gemini-embedding-001:embedContent') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    assert.equal(nativeQueryControl, true);
    assert.deepEqual(input, { content: { parts: [{ text: 'Synthetic source audience acceptance' }] }, taskType: 'RETRIEVAL_QUERY' });
    embeddingRequests.push({ ...input, observedAt: Date.now() });
    await writeFile(path.join(temp, 'native-gemini-query.json'), JSON.stringify(input));
    response.setHeader('content-type','application/json'); response.end(JSON.stringify({ embedding: { values:
      Array.from({ length:3072 }, (_,i) => i === 0 ? 1 : 0) } })); return;
  }
  if (nativeFamily === "gemini" && request.url?.includes(':batchEmbedContents')) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.url, '/v1beta/models/gemini-embedding-001:batchEmbedContents');
    assert.ok(input.requests.length > 0);
    for (const value of input.requests) {
      assert.equal(value.model, 'models/gemini-embedding-001'); assert.equal(value.taskType, 'RETRIEVAL_DOCUMENT');
      assert.equal(value.content.parts.length, 1); assert.equal(typeof value.content.parts[0].text, 'string');
      assert.ok(value.content.parts[0].text.length <= 16000, 'Only bounded synthetic workspace documents may be indexed');
    }
    embeddingRequests.push({ ...input, observedAt: Date.now() });
    await writeFile(path.join(temp, `embedding-${embeddingRequests.length}.json`), JSON.stringify(input));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ embeddings: input.requests.map(() => ({ values: Array.from({ length: 3072 }, (_, i) => i === 0 ? 1 : 0) })) })); return;
  }
  if (nativeCase && request.url?.endsWith('/embeddings')) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); embeddingRequests.push({ ...input, observedAt: Date.now() });
    await writeFile(path.join(temp, `embedding-${embeddingRequests.length}.json`), JSON.stringify(input));
    const texts = Array.isArray(input.input) ? input.input : [input.input];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: texts.map((_text, index) => ({ object: 'embedding', index,
      embedding: Array.from({ length: 384 }, (_, position) => position === 0 ? 1 : 0) })), model: input.model,
      usage: { prompt_tokens: 1, total_tokens: 1 } })); return;
  }
  // Native background model discovery is metadata, not a completion request.
  if (guardedDreaming && request.method === "GET" && request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "probe", object: "model", owned_by: "synthetic" }] })); return;
  }
  providerRequests++;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks).toString('utf8');
  const wireRequest = JSON.parse(requestBody);
  let parsedRequest = wireRequest;
  if (googleAgent) {
    assert.ok(request.url.startsWith('/v1beta/models/gemini-3.8-flash:streamGenerateContent'));
    await writeFile(path.join(temp, `google-provider-${providerRequests}.json`), requestBody);
    const messages = [];
    for (const item of wireRequest.contents ?? []) for (const part of item.parts ?? []) {
      if (part.functionResponse) messages.push({ role: 'tool', content: part.functionResponse.response.output ?? part.functionResponse.response.error });
      else if (typeof part.text === 'string') messages.push({ role: item.role === 'model' ? 'assistant' : 'user', content: part.text });
    }
    parsedRequest = { messages };
  }
  const googleResponse = parts => {
    const value = { responseId: `synthetic-google-${providerRequests}`, modelVersion: probeModelId,
      candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    response.setHeader('content-type', 'text/event-stream'); response.end(`data: ${JSON.stringify(value)}\n\n`);
  };
  if (consolidationProbe && parsedRequest.messages?.length === 1 && typeof parsedRequest.messages[0].content === "string" &&
      ["Consolidate the explicitly selected retained evidence", "Independently verify this proposed consolidation"].some(prefix => parsedRequest.messages[0].content.startsWith(prefix))) {
    const prompt = parsedRequest.messages[0].content, data = JSON.parse(prompt.split("\n").at(-1));
    await writeFile(path.join(temp, `consolidation-model-${providerRequests}.json`), requestBody);
    if (!data.proposalHash) {
      if (consolidationCase === "-source-stale") {
        const selected = JSON.parse(await readFile(path.join(temp, "consolidation-selected-payload.json"), "utf8"));
        await rm(selected.path);
      }
      if (consolidationCase === "-revoked") {
        const grantFile = path.join(canghaiRoot, "50_PersonalAgent/stella/personal-access.json");
        const grant = JSON.parse(await readFile(grantFile, "utf8")); delete grant.operatorMemoryConsolidation;
        await writeFile(grantFile, JSON.stringify(grant));
      }
      if (consolidationCase === "-recovery") await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", path.join(temp, "missing-consolidation-remote.git")]);
    }
    const result = data.proposalHash ? { requestHash: data.requestHash, proposalHash: data.proposalHash, valid: true }
      : { requestHash: data.requestHash, disposition: "update", clarification: null, rationale: "Synthetic retained source supports a scoped candidate.",
        reviewedHandles: data.candidates.map(c => c.handle), replacements: [{ handle: null, group: "understandings", record: {
          kind: "hypothesis", status: "candidate", statement: "SYNTHETIC_CORE_CONSOLIDATED_CANDIDATE",
          scope: { workIds: [], contexts: ["synthetic writing"], domains: ["writing"], global: false },
          supportRefs: data.ownerEvidence.map(e => e.ref), counterRefs: [], dependencyRefs: [] } }] };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "core-consolidation", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
  }
  if (guardedSemantic && requestBody.includes("Semantically classify one user turn for Stella Cortex")) {
    providerRequests--;
    semanticProviderRequests++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "synthetic-semantic", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
        mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"],
        needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false,
      }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }

  if (consolidationProbe || audienceScenario || ingressField || cancellationProbe || skillReadProbe || fragmentProbe || historyViewProbe || standaloneCompactProbe || outcomeHistoryProbe) await writeFile(path.join(temp, `synthetic-provider-${providerRequests}.json`), requestBody);
  observedSkillResult = parsedRequest.messages?.filter((message) => message.role === "tool");
  providerReceivedSkillBody ||= parsedRequest.messages?.some((message) => message.role === "tool" &&
    JSON.stringify(message.content).includes("No private data.")) === true;
  providerReceivedInitializationResult ||= parsedRequest.messages?.some((message) => message.role === "tool" &&
    typeof message.content === "string" && message.content.includes('"state":"ready"') && message.content.includes('"scope":"host_bootstrap"')) === true;
  initializationInputEvidence = { agents: requestBody.includes("# Synthetic AGENTS.md"), soul: requestBody.includes("# Synthetic SOUL.md"),
    identity: requestBody.includes("- Name: Synthetic Stella"), skill: requestBody.includes("stella-initialization-probe") };
  providerReceivedInitialization ||= Object.values(initializationInputEvidence).every(Boolean);
  providerReceivedCorrection ||= requestBody.includes("SYNTHETIC_CORRECTED_PREMISE");
  providerReceivedOriginalEvidence ||= requestBody.includes("Synthetic owner report: I asked about the weekend time. My friend confirmed Saturday.") &&
    requestBody.includes("stella.evidence-bundle/v1");
  if (cancellationProbe) {
    cancellationCheckpoint = { revision: (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(),
      status: (await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim() };
    await writeFile(path.join(temp, "cancellation-checkpoint.json"), JSON.stringify(cancellationCheckpoint, null, 2));
    providerArrived.resolve();
    await providerRelease.promise;
  }
  response.setHeader("content-type", "application/json");
  if (audienceAllowed) {
    assert.ok(!requestBody.includes("SYNTHETIC_DENIED_NEIGHBOR"));
    const steps = [["stella_read_fragment", { action: "list" }], ["stella_read_fragment", { action: "read", handle: "F1" }]];
    if (providerRequests <= steps.length) {
      const [name, args] = steps[providerRequests - 1];
      if (googleAgent) { googleResponse([{ functionCall: { id: `audience-${providerRequests}`, name, args }, thoughtSignature: 'c3ludGhldGlj' }]); return; }
      response.end(JSON.stringify({ id: "audience-tool", object: "chat.completion", created: 1, model: "probe",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `audience-${providerRequests}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    assert.ok(requestBody.includes("SYNTHETIC_ALLOWED_FRAGMENT"), "The actual final transport must consume the authorized fragment");
    if (nativeCase) assert.ok(parsedRequest.messages.some(message => message.role === "tool" &&
      typeof message.content === "string" && JSON.parse(message.content).original?.text === nativeSource.text),
    "The final model must receive the complete native original in the admitted tool result");
  }
  if (guardedActive && requestBody.includes("You are a memory search agent.")) {
    assert.ok(!requestBody.includes("SYNTHETIC_DENIED_NEIGHBOR"), "Native recall must not receive the denied neighboring segment");
    nativeRecallRequests++;
    await writeFile(path.join(temp, `native-recall-input-${nativeRecallRequests}.json`), requestBody);
    assert.ok(nativeRecallRequests <= 3, "Native recall must stay within the synthetic call budget");
    if (nativeRecallRequests <= 2) {
      const args = nativeRecallRequests === 1 ? { action: "list" } : { action: "read", handle: "F1" };
      response.end(JSON.stringify({ id: "synthetic-native-fragment", object: "chat.completion", created: 1, model: "probe",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `native-fragment-${nativeRecallRequests}`, type: "function",
          function: { name: "stella_read_fragment", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    nativeFragmentRead = parsedRequest.messages.some(message => message.role === "tool" &&
      JSON.stringify(message.content).includes('original') && JSON.stringify(message.content).includes("SYNTHETIC_ALLOWED_FRAGMENT"));
    response.end(JSON.stringify({ id: "synthetic-native-summary", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "The owner requested preservation of unresolved questions. SYNTHETIC_NATIVE_RECALL_SUMMARY" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  if (guardedActive) {
    nativeSummaryConsumed ||= requestBody.includes("<active_memory_plugin>") && requestBody.includes("SYNTHETIC_NATIVE_RECALL_SUMMARY");
    await writeFile(path.join(temp, "native-main-input.json"), requestBody);
  }
  if (standaloneCompactProbe && requestBody.includes("Reconstruct a current Stella conversation view.")) {
    await writeFile(path.join(temp, "standalone-summary-input.json"), requestBody);
    if (standaloneCompactPersistFailure) await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", path.join(temp, "missing-compaction-remote.git")]);
    if (standaloneCompactStale) {
      const archiveRoot = path.join(canghaiRoot, "30_PersonalData/context-history");
      const heads = await Promise.all((await readdir(path.join(archiveRoot, "sessions"))).map(async name =>
        JSON.parse(await readFile(path.join(archiveRoot, "sessions", name), "utf8"))));
      const head = heads.find(value => value.scope.sessionKey === "agent:probe:main-completion");
      const snapshot = JSON.parse(await readFile(path.join(archiveRoot, "contexts", `${head.digest.slice(7)}.json`), "utf8"));
      const payload = snapshot.payloads[0];
      assert.ok(payload, "Compaction must retain an actual original payload dependency");
      const catalog = JSON.parse(await readFile(path.join(canghaiRoot, "30_PersonalData/memory/catalog.json"), "utf8"));
      const entry = catalog.sources.find(value => value.id === payload.source.id && value.version === payload.source.version);
      const source = JSON.parse(await readFile(path.join(canghaiRoot, entry.locator.path), "utf8"));
      const locator = source.payloads.find(value => value.sha256 === payload.sha256);
      assert.equal(locator.revision, undefined);
      const deletedPath = path.join(canghaiRoot, locator.path);
      const bytes = await readFile(deletedPath);
      await rm(deletedPath);
      await writeFile(path.join(temp, "standalone-source-invalidation.json"), JSON.stringify({ sourceRef: payload.source,
        payload: locator, deletedPath, retainedBytesBeforeDeletion: bytes.length, afterSummaryModelInput: true }, null, 2));
    }
    response.end(JSON.stringify({ id: "synthetic-history-compaction", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ summary: "SYNTHETIC_COMPACTED_HISTORY" }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  if (fragmentProbe) {
    fragmentChecks.deniedNeighborAbsent &&= !requestBody.includes("SYNTHETIC_DENIED_NEIGHBOR");
    const steps = [
      ["read", { path: path.join(workspace, "skills/stella-initialization-probe/SKILL.md") }],
      ["stella_read_fragment", { action: "list" }],
      ["stella_read_fragment", { action: "read", handle: "F1" }],
      ["read", { path: fragmentOriginalPath }],
      ["stella_read_fragment", { action: "read", handle: "F2" }],
    ];
    if (providerRequests <= steps.length) {
      const [name, args] = steps[providerRequests - 1];
      response.end(JSON.stringify({ id: "fragment-probe", object: "chat.completion", created: 1, model: "probe",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `fragment-${providerRequests}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    const results = parsedRequest.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)).join("\n");
    fragmentChecks.skillBodyRead = results.includes("stella_read_fragment");
    fragmentChecks.descriptionListed = results.includes("Synthetic permitted observation fragment");
    fragmentChecks.allowedRead = results.includes("SYNTHETIC_ALLOWED_FRAGMENT");
    fragmentChecks.wholeFileBlocked = results.includes("skill_read_forbidden") || results.includes("unsafe_path");
    fragmentChecks.unavailableHandleBlocked = results.includes("fragment_handle_not_available");
  }
  if (managedContextProbe && guardedStale && providerRequests === 1) {
    response.end(JSON.stringify({ id: "synthetic-managed-fragment", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "synthetic-managed-fragment", type: "function",
        function: { name: "stella_read_fragment", arguments: JSON.stringify({ action: "list" }) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  if (skillReadProbe && providerRequests === 1) {
    response.end(JSON.stringify({ id: "synthetic-skill-read", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "synthetic-read", type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: path.join(workspace, "skills/stella-initialization-probe/SKILL.md") }) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  if (skillReadProbe && providerRequests === 2) {
    response.end(JSON.stringify({ id: "synthetic-initialize", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "synthetic-initialize", type: "function",
        function: { name: "stella_initialize", arguments: JSON.stringify({ action: "apply" }) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  if (googleAgent) { googleResponse([{ text: 'SYNTHETIC_MAIN_ANSWER' }]); return; }
  response.end(JSON.stringify({ id: "synthetic-main", object: "chat.completion", created: 1, model: "probe",
    choices: [{ index: 0, message: { role: "assistant", content: "SYNTHETIC_MAIN_ANSWER" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
if (!queryServer) await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const configPath = path.join(state, "openclaw.json");
let mainMemorySnapshot;
if (nativeFamily === "gemini") {
  assert.ok(process.env.STELLA_MAIN_MEMORY_CONFIG, "A filtered nonsecret main configuration snapshot is required");
  mainMemorySnapshot = JSON.parse(await readFile(process.env.STELLA_MAIN_MEMORY_CONFIG));
  assert.deepEqual(Object.keys(mainMemorySnapshot.memorySearch).sort(), ["model", "provider"]);
  assert.equal(mainMemorySnapshot.memorySearch.provider, "gemini");
  assert.equal(mainMemorySnapshot.memorySearch.model, "gemini-embedding-001");
}
await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" },
  ...(nativeCase ? { memory: { search: { enabled: true, provider: nativeFamily === "gemini" ? mainMemorySnapshot.memorySearch.provider : ["cache", "query"].includes(nativeFamily) ? "openai" : "none", fallback: "none",
    model: nativeFamily === "gemini" ? mainMemorySnapshot.memorySearch.model : "text-embedding-3-small", remote: { baseUrl: `http://127.0.0.1:${provider.address().port}/${nativeFamily === "gemini" ? "v1beta" : "v1"}`, apiKey: "synthetic-local-only", batch: { enabled: false } },
    sources: ["memory"], cache: { enabled: true }, store: { vector: { enabled: ["cache", "query", "gemini"].includes(nativeFamily) }, fts: { tokenizer: "unicode61" } },
    sync: { onSessionStart: false, onSearch: false, watch: false }, query: { minScore: 0 } } },
    ...(nativeFamily === "gemini" ? {} : { hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true, llmSlug: false } } } } }) } : {}),
  agents: { defaults: { model: { primary: probeModel }, ...(liveFragment || googleAgent ? { thinkingDefault: "low" } : {}), ...(standaloneCompactProbe ? { compaction: { model: "synthetic-compaction/probe" } } : {}), ...(guardedPayload ? { models: {
    [probeModel]: { params: { extra_body: { messages: [{ role: "user", content: "SYNTHETIC_UNBOUND_OLD_UNDERSTANDING" }] } } },
  } } : {}) }, entries: { probe: { workspace } } },
  models: { providers: { ...(standaloneCompactProbe ? { "synthetic-compaction": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "probe", name: "synthetic compaction", contextWindow: 262144, maxTokens: 256 }] } } : {}), ...(liveFragment ? { google: { ...liveProvider, models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash acceptance", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } : {}), [probeProvider]: { baseUrl: `http://127.0.0.1:${provider.address().port}${googleAgent ? "" : "/v1"}`, apiKey: "synthetic-local-only",
    api: googleAgent ? "google-generative-ai" : "openai-completions", models: [{ id: probeModelId, name: probeModelId,
      ...(googleAgent ? { reasoning: true } : {}), contextWindow: managedContextProbe ? 262144 : 32768, maxTokens: googleAgent ? 8192 : 256 }] } } },
  plugins: { ...(managedContextProbe ? { slots: { contextEngine: "stella-core" } } : {}), allow: ["stella-core", ...(guardedDreaming || nativeCase ? ["memory-core"] : []), ...(nativeFamily === "wiki" ? ["memory-wiki"] : []), ...(guardedActive ? ["active-memory"] : []), ...(liveFragment ? ["google"] : [])], load: { paths: [plugin] }, entries: { ...(guardedDreaming ? { "memory-core": { enabled: true, config: { dreaming: {
    enabled: true, frequency: "0 0 * * *", model: probeModel,
    phases: { light: { enabled: true, limit: 3, lookbackDays: 7, execution: { model: probeModel } }, rem: { enabled: false },
      deep: { enabled: true, limit: 3, minScore: 0, minRecallCount: 0, minUniqueQueries: 0 } },
  } } } } : { "memory-core": { ...(nativeCase ? { enabled: true } : {}), config: { dreaming: { enabled: false } } } }),
  ...(nativeFamily === "wiki" ? { "memory-wiki": { enabled: true, config: { vaultMode: "isolated", vault: { scope: "global", path: nativeVault },
    obsidian: { enabled: false, useOfficialCli: false }, bridge: { enabled: false }, context: { includeCompiledDigestPrompt: false },
    search: { backend: "local", corpus: "wiki" } } } } : {}), ...(guardedActive ? { "active-memory": { enabled: true, config: {
    enabled: true, mode: "always", queryMode: "message", agents: ["probe"], model: probeModel, toolsAllow: ["stella_read_fragment"], timeoutMs: 120000, logging: true,
  } } } : {}), "stella-core": { enabled: true,
    llm: { allowAgentIdOverride: true, ...(liveFragment ? { allowModelOverride: true, allowedModels: [liveModel], allowedCompletionModels: [liveModel] } : standaloneCompactProbe || consolidationProbe ? { allowModelOverride: true, allowedModels: [probeModel], allowedCompletionModels: [probeModel] } : {}) }, hooks: { allowConversationAccess: true }, config: { canghaiRoot, recoveryRevision: revision, agentId: "probe", initializationGatewayAccess: "local_operator_read", dataMode: managed ? "managed_durable_write" : "read_only",
      ...(managed ? { durabilityRemote: "origin", durabilityBranch: "main" } : {}),
      ...(contextKeys ? { contextHistorySignerId: contextKeys.signerId, contextHistoryArchiveRoot: "30_PersonalData/context-history" } : {}) } } } },
  tools: { allow: ["read", "stella_initialize", ...(fragmentProbe || managedContextProbe ? ["stella_read_fragment"] : [])] },
}), { mode: 0o600 });
const env = { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
delete env.NODE_OPTIONS;
let gateway;
let client;
const observedEvents = [];
const evaluationListeners = new Set();
async function connectObserver() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Synthetic main observer timeout")), 15_000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); }, onConnectError() { clearTimeout(timeout); reject(new Error("Synthetic main observer failed")); },
      onEvent(event) { observedEvents.push(event); for (const listener of evaluationListeners) listener(event); },
    });
    client.start();
  });
}
async function readHistory(params) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { return await client.request("chat.history", params); }
    catch (error) {
      if (error?.gatewayCode !== "UNAVAILABLE" || error.retryable !== true || error.details?.method !== "chat.history" ||
        !Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 0 || error.retryAfterMs > 5_000 ||
        Date.now() + error.retryAfterMs >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, error.retryAfterMs)));
    }
  }
}
async function waitForInitializationReady() {
  let initializationStatus = await client.request("stella.initialize", { action: "status" });
  for (let attempt = 0; initializationStatus.state === "initializing" && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    initializationStatus = await client.request("stella.initialize", { action: "status" });
  }
  assert.equal(initializationStatus.state, "ready", JSON.stringify(initializationStatus));
}
async function verifyMain() {
try {
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"),
    diagnosticPrefixes: ["Stella completion:", "Stella history compaction model failed:", ...(guardedActive ? ["active-memory:"] : [])] });
  await connectObserver();
  await waitForInitializationReady();
  if (guardedDreaming) {
    const inventory = await client.request("stella.initialize", { action: "memory-inventory" });
    assert.equal(inventory.complete, false);
    assert.ok(inventory.entries.some(entry => entry.kind === "dreaming" && entry.state === "unverifiable"),
      "Enabled bundled Dreaming must appear even without a standalone plugin row");
    await writeFile(path.join(temp, "native-dreaming-inventory.json"), JSON.stringify(inventory, null, 2));
    await mkdir(path.join(workspace, "memory"), { recursive: true });
    await writeFile(path.join(workspace, "memory", new Date().toISOString().slice(0, 10) + ".md"),
      "# Synthetic retained daily log\n\n- SYNTHETIC_UNBOUND_DREAMING_SOURCE: The synthetic project meeting was moved to Tuesday. This retained test fixture has no Core source or policy binding.\n");
  }
  const displayedAgents = await client.request("agents.list", {});
  assert.equal(displayedAgents.agents.find((agent) => agent.id === "probe")?.identity?.name, "Synthetic Stella",
    "The Gateway must expose the initialized identity, not merely a workspace file");
  assert.equal((await client.request("stella.initialize", { action: "apply" })).state, "ready");
  if (audienceScenario || ingressField) {
    const inventory = await client.request("stella.initialize", { action: "memory-inventory" });
    let nativePreparation;
    let embeddingRequestsBeforeConsumption = 0;
    if (nativeCase) {
      nativePreparation = nativeFamily === "wiki" ? { compiled: await client.request("wiki.compile", { agentId: "probe" }, { timeoutMs: 60000 }),
        wiki: await client.request("wiki.status", { agentId: "probe" }) } : await client.request("stella.syntheticNativePrepare", {}, { timeoutMs: 60000 });
      await writeFile(path.join(temp, "native-preparation.json"), JSON.stringify(nativePreparation, null, 2));
      if (nativeState === "missing") {
        const index = await realpath(nativePreparation.warm.dbPath);
        assert.ok(index.startsWith((await realpath(temp)) + path.sep), "Remove only this synthetic Host index");
        const backup = path.join(temp, "native-index-before-removal.sqlite");
        await cp(index, backup);
        for (const suffix of ["", "-wal", "-shm"]) await rm(index + suffix, { force: true });
        await writeFile(path.join(temp, "native-index-removal.json"), JSON.stringify({ index, backup,
          sha256: createHash("sha256").update(await readFile(backup)).digest("hex"), afterIndexPreparation: true }));
      }
      if (nativeState === "mismatch") {
        const file = path.join(nativeFamily === "wiki" ? nativeVault : workspace, nativeSource.nativePath);
        const original = await readFile(file, "utf8");
        const changed = original.replaceAll("SYNTHETIC_ALLOWED_FRAGMENT", "SYNTHETIC_ALLOWED_FRAGMENT_CHANGED");
        assert.notEqual(changed, original);
        await writeFile(file, changed);
        await writeFile(path.join(temp, "native-payload-invalidation.json"), JSON.stringify({ file,
          originalSha256: createHash("sha256").update(original).digest("hex"), afterIndexPreparation: true }));
      }
    }
    embeddingRequestsBeforeConsumption = embeddingRequests.length;
    if (ingressField === "bootstrap") await writeFile(path.join(workspace, "MEMORY.md"), "SYNTHETIC_UNBOUND_HOST_MEMORY\n");
    let visitor;
    try {
      if (audienceScenario === "visitor") await new Promise((resolve, reject) => {
        visitor = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
          env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.read", "operator.write"],
          sharedStateMode: "read-only", deviceIdentity: null, onHelloOk: resolve, onConnectError: reject });
        visitor.start();
      });
      const sessionKey = audienceScenario === "group" ? "agent:probe:telegram:group:synthetic-room"
        : audienceScenario === "channel" ? "agent:probe:discord:work:channel:synthetic-room"
        : audienceScenario === "cron" ? "agent:probe:cron:synthetic-job"
        : audienceScenario === "subagent" ? "agent:probe:subagent:11111111-2222-3333-4444-555555555555"
        : "agent:probe:main-completion";
      const before = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
      const sent = await (visitor ?? client).request("chat.send", { sessionKey, message: "Synthetic source audience acceptance", idempotencyKey: "synthetic-audience" });
      // Observe one admitted run through the Host's queue/drain states. A wait
      // timeout is not a terminal failure and never authorizes another send.
      const deadline = Date.now() + 300_000;
      let terminal;
      do {
        terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
        if (!["pending", "timeout"].includes(terminal.status) || terminal.endedAt != null) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      const denied = !audienceAllowed || audienceScenario === "revoked" || Boolean(nativeCase && !nativeSuccess);
      assert.equal(terminal.status, denied ? "error" : "ok", JSON.stringify(terminal));
      const dispatch = (await readFile(path.join(temp, "audience-dispatch.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(dispatch.length, 1);
      assert.equal(dispatch[0].chatType, "direct", "Record the original Gateway envelope without modifying it");
      const expectedAudience = ["group", "channel", "cron", "subagent"].includes(audienceScenario) ? audienceScenario
        : audienceScenario === "visitor" ? "non_owner_direct" : "owner_direct";
      assert.equal(dispatch[0].audience, expectedAudience);
      let semantic = [];
      try { semantic = (await readFile(path.join(temp, "audience-semantic.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const expectedCategory = nativeCase ? nativeState === "stale" ? "source_payload_unavailable" : "native_memory_payload_changed"
        : ingressField === "bootstrap" ? "projection_drift" : ingressField ? "host_context_input_changed"
        : audienceScenario === "requester-denied" ? "personal_context_requester_forbidden"
        : audienceScenario === "revoked" ? "personal_context_access_changed" : "private_context_audience_forbidden";
      let initializationBlocker;
      if (ingressField === "bootstrap") {
        const status = await client.request("stella.initialize", { action: "status" });
        assert.equal(status.state, "blocked", JSON.stringify(status));
        assert.equal(status.category, expectedCategory, JSON.stringify(status));
        initializationBlocker = status.category;
      } else if (denied && !nativeCase) assert.ok(gateway.diagnostics().includes(expectedCategory), gateway.diagnostics());
      assert.equal(providerRequests, nativeCase ? nativeSuccess ? 3 : nativeFamily === "gemini" && ["missing", "mismatch"].includes(nativeState) ? 0 : 2 : audienceScenario === "owner" ? 3 : audienceScenario === "revoked" ? 2 : 0);
      if (audienceScenario && !audienceAllowed) {
        assert.equal(semantic.length, 0, "Rejected audiences/requesters must be stopped before semantic disclosure");
        assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), before);
      }
      if (audienceScenario === "owner" && !denied) {
        assert.ok(semantic.some(call => call.purpose === "stella-source-access"));
        assert.ok(semantic.some(call => call.purpose === "stella-source-output"));
      }
      if (audienceScenario === "revoked") assert.equal(JSON.parse(await readFile(path.join(temp, "audience-revoked.json"))).afterAuthorizedFragmentRead, true);
      if (ingressField && ingressField !== "bootstrap") assert.ok((await readFile(path.join(temp, "ingress-hook.jsonl"), "utf8")).trim());
      const history = await readHistory({ sessionKey, limit: 10 });
      const finalAnswers = (history.messages ?? []).filter(message => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length;
      assert.equal(finalAnswers, denied ? 0 : 1);
      const cron = await client.request("cron.list", { includeDisabled: true });
      assert.ok(!cron.jobs.find(job => job.declarationKey === "memory-core:memory-dreaming-promotion")?.enabled);
      const report = { schemaVersion: "stella.host-memory-boundary-probe/v1", host: host.version, evidenceDirectory: temp,
        scope: "synthetic exact Host; native chat.send metadata; injected semantic verdicts; loopback final model",
        dreamingEnabled: false, memoryInventory: inventory, audienceScenario, ingressField, dispatch,
        terminalStatus: terminal.status, category: denied && !nativeCase ? expectedCategory : undefined,
        terminalError: terminal.error, initializationBlocker, providerRequests, finalAnswers,
        semanticCalls: semantic.length, sourceAccessCalls: semantic.filter(call => call.purpose === "stella-source-access").length,
        outputChecks: semantic.filter(call => call.purpose === "stella-source-output").length,
        authorizedFragmentConsumed: audienceScenario === "owner", revokedBeforeContinuation: audienceScenario === "revoked",
        modelRequestsAfterRevocation: audienceScenario === "revoked" ? 0 : undefined,
        unknownInputConsumed: false, fullMemoryAccepted: false, realModelAccepted: false };
      if (nativeCase) {
        const backend = nativeFamily === "wiki" ? [] : (await readFile(path.join(temp, "native-backend.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
        const readLog = await readFile(path.join(temp, "native-consumed.jsonl"), "utf8").catch(error => {
          if ((nativeState === "missing" || nativeFamily === "gemini") && error.code === "ENOENT") return "";
          throw error;
        });
        const reads = readLog.trim() ? readLog.trim().split("\n").map(JSON.parse) : [];
        assert.ok(nativeFamily === "gemini" ? reads.length === 0 : nativeFamily === "query" ? reads.length >= 1 : reads.length === (nativeState === "missing" ? 0 : 1),
          "Only an available authorized index permits the actual native read");
        const nativeConsumerEmbeddingRequests = embeddingRequests.length - embeddingRequestsBeforeConsumption;
        assert.equal(nativeConsumerEmbeddingRequests, nativeFamily === "query" ? 1 : 0, "Only the explicitly granted original query may be embedded");
        const queryRequests = embeddingRequests.slice(embeddingRequestsBeforeConsumption);
        if (nativeFamily === "query") {
          assert.equal(queryRequests[0].model, "text-embedding-3-small");
          assert.deepEqual(queryRequests[0].input, ["Synthetic source audience acceptance"]);
        }
        const toolLog = await readFile(path.join(temp, "native-tool-results.jsonl"), "utf8").catch(error => {
          if (nativeFamily === 'gemini' && ['missing','mismatch'].includes(nativeState) && error.code === 'ENOENT') return '';
          throw error;
        });
        const toolResults = toolLog.trim() ? toolLog.trim().split("\n").map(JSON.parse) : [];
        if (nativeState === "index") {
          assert.ok(gateway.diagnostics().includes(nativeFamily === "gemini" ? "native_memory_consumption_changed" : "native_query_embedding_consumption_changed"), gateway.diagnostics());
          assert.deepEqual(JSON.parse(await readFile(path.join(temp, "native-query-index-invalidated.json"))), { afterNativeRead: true });
        }
        const mismatchCategory = nativeFamily === "wiki" ? "native_memory_read_unverifiable" : "native_memory_payload_changed";
        if (nativeState === "missing") assert.ok(nativeFamily === "gemini" ? gateway.diagnostics().includes("native_memory_index_unavailable") : toolResults.some(row => row.error?.includes("native_memory_index_unavailable")),
          "An absent native index must fail explicitly without bootstrapping or reading the retained copy");
        if (nativeState === "mismatch") {
          assert.ok(nativeFamily === "gemini" ? gateway.diagnostics().includes(mismatchCategory) : toolResults.some(row => row.error?.includes(mismatchCategory)),
            "The actual native tool must explicitly reject changed bytes or their invalidated compiled claim");
          if (nativeFamily === "wiki") assert.equal(reads[0].result, null,
            "Changing the native page must invalidate the compiled claim lookup, without a page-path fallback");
        }
        if (nativeState === "stale") assert.deepEqual(JSON.parse(await readFile(path.join(temp, "native-source-stale.json"))),
          { afterNativeRead: true, nativeArtifactRetained: true });
        if (nativeFamily === "gemini" && ["edit", "delete", "revoked", "generation", "oldindex", "policy"].includes(nativeState)) {
          const invalidation = JSON.parse(await readFile(path.join(temp, "gemini-invalidation.json")));
          assert.equal(invalidation.action, nativeState); assert.equal(invalidation.afterAuthorizedFragmentRead, true);
          if (["edit", "delete", "generation", "policy"].includes(nativeState)) {
            assert.equal(invalidation.before.status, ""); assert.equal(invalidation.after.head, invalidation.before.head);
            assert.ok(invalidation.after.status.endsWith(invalidation.expectedPath));
            assert.notEqual(invalidation.after.bytes, invalidation.before.bytes);
            if (nativeState === 'delete') assert.equal(invalidation.after.bytes, null);
            if (nativeState === 'edit') assert.equal(invalidation.after.bytes, 'SYNTHETIC_REPLACED_ORIGINAL\n');
            if (nativeState === 'generation') assert.equal(JSON.parse(invalidation.after.bytes).generationId, 'synthetic-next-generation');
            if (nativeState === 'policy') assert.deepEqual(JSON.parse(invalidation.after.bytes).readPurposes, []);
            assert.equal(invalidation.after.status.split('\n').length, 1, 'The injected source is the only changed file');
            const expectedRevision = invalidation.before.head;
            const verifierRoot = path.join(temp, 'independent-' + nativeState);
            await run('git', ['clone','--quiet','--shared','--no-checkout', canghaiRoot, verifierRoot]);
            await run('git', ['-C',verifierRoot,'checkout','--quiet','--detach', expectedRevision]);
            const { loadConsciousness } = await import(buildModule('src/canghai/manifest.js'));
            const { CatalogReader } = await import(buildModule('src/canghai/catalog-reader.js'));
            const options = { recoveryRevision: expectedRevision,
              coreVersion: (await import(buildModule('src/plugin.js'))).STELLA_CORE_COMPATIBILITY_VERSION,
              openclawVersion: host.version, dataMode: 'managed_durable_write' };
            await loadConsciousness(verifierRoot, undefined, options);
            const pinned = await CatalogReader.load(verifierRoot, '30_PersonalData/memory/catalog.json');
            const target = path.join(verifierRoot, invalidation.expectedPath);
            if (invalidation.after.bytes === null) await rm(target);
            else await writeFile(target, invalidation.after.bytes);
            await assert.rejects(loadConsciousness(verifierRoot, undefined, options), error =>
              error.category === 'stella_recovery_revision_invalid' && error.message === `CangHai checkout must be clean at configured recovery revision ${expectedRevision}`);
            if (nativeState === 'generation') {
              await assert.rejects(pinned.assertCurrent(), error => error.category === 'stale_generation');
              assert.ok(['stella_recovery_revision_invalid','stale_generation'].some(category => gateway.diagnostics().includes(category)), gateway.diagnostics());
            } else assert.ok(gateway.diagnostics().includes('stella_recovery_revision_invalid'), gateway.diagnostics());
            await writeFile(path.join(temp,'independent-invalidation-proof.json'), JSON.stringify({ cleanAccepted: true,
              changedFileOnly: invalidation.expectedPath, recoveryCategory: 'stella_recovery_revision_invalid',
              ...(nativeState === 'generation' ? { generationCategory: 'stale_generation' } : {}) }));
          } else assert.ok(gateway.diagnostics().includes(nativeState === 'revoked' ? 'personal_context_access_changed' : 'native_memory_'), gateway.diagnostics());
        }
        if (["cache", "gemini"].includes(nativeFamily)) {
          assert.ok(nativePreparation.cold.cache.entries > 0 && nativePreparation.warm.cache.entries > 0);
          assert.ok(embeddingRequests.length > 0);
          const cold = backend.find(row => row.operation === "cold-sync"), warm = backend.find(row => row.operation === "warm-sync");
          assert.equal(cold.status.vector.index.state, "complete"); assert.equal(warm.status.vector.index.state, "complete");
          assert.equal(embeddingRequests.filter(row => row.observedAt > cold.observedAt && row.observedAt <= warm.observedAt).length, 0,
            "Forced native reindex must reuse embeddings without requesting fresh chunk embeddings");
        }
        if (nativeFamily === 'gemini') {
          for (let i = 1; i <= providerRequests; i++) {
            const raw = JSON.parse(await readFile(path.join(temp, `${googleAgent ? 'google' : 'synthetic'}-provider-${i}.json`)));
            const value = JSON.stringify(raw);
            if (i <= 2) assert.equal(value.includes(nativeSource.text.trim()), true,
              'The initial admitted evidence bundle also contains native originals and must be covered by native validation');
          }
          if (nativeState === 'rebuilt') {
            const rebuilt = nativePreparation.rebuild; assert.equal(rebuilt.generationId, 'synthetic-rebuilt-generation');
            assert.ok(rebuilt.before.every(row => !row.text.includes('GEMINI_REBUILT')));
            assert.ok(rebuilt.after.some(row => row.text.includes('GEMINI_REBUILT')));
            assert.notDeepEqual(rebuilt.before, rebuilt.after);
          }
        }
        if (nativeQueryControl) {
          assert.ok(nativePreparation.nativeQuery.some(hit => hit.path === nativeSource.nativePath));
          assert.ok((await readFile(path.join(temp,'native-gemini-query.json'),'utf8')).includes('RETRIEVAL_QUERY'));
        }
        Object.assign(report, { schemaVersion: "stella.native-memory-consumption/v1", nativeFamily, nativeState,
          producerReport: nativeFamily === "gemini" ? producerReport : process.env.STELLA_NATIVE_PRODUCERS_REPORT, mainMemorySnapshot, nativeSource, nativePreparation, nativeBackend: backend, nativeReads: reads, nativeToolResults: toolResults,
          nativeReadExecuted: nativeState !== "missing", packageNativeReadInstrumented: nativeFamily !== "gemini",
          realApiRequests: 0, privateDataCopied: false, sessionMemoryEnabled: nativeFamily === "gemini" ? false : undefined,
          configuredVectorProvider: nativeFamily === "gemini" ? "gemini" : undefined,
          finalTransport: googleAgent ? 'google-generative-ai-loopback' : 'openai-completions-loopback', modelRef: probeModel,
          nativeGeminiQueryProtocolExecuted: nativeQueryControl, coreGeminiQueryBindingAccepted: false,
          initialEvidenceBundleNativeValidated: nativeFamily === 'gemini',
          independentInvalidationProof: nativeFamily === 'gemini' && ['edit','delete','generation','policy'].includes(nativeState)
            ? JSON.parse(await readFile(path.join(temp,'independent-invalidation-proof.json'))) : undefined,
          sourceInvalidationProof: nativeFamily === 'gemini' && ['edit','delete','generation','policy','revoked','oldindex'].includes(nativeState)
            ? JSON.parse(await readFile(path.join(temp, 'gemini-invalidation.json'))) : undefined,
          queryVectorRetrievalAccepted: nativeFamily === "query", nativeIndexRemoved: nativeState === "missing",
          nativeConsumerEmbeddingRequests, embeddingRequestsBeforeConsumption, nativeQueryExact: nativeFamily === "query",
          nativeLookupMode: nativeFamily === "query" ? "authorized-query-readonly-native-vector" : nativeFamily === "wiki" ? "compiled-corpus" : "readonly-exact-fts-index",
          actualNativeBytesConsumed: nativeSuccess, staleNativeArtifactRetained: nativeState === "stale",
          changedNativeBytesRejected: nativeState === "mismatch", modelRequestsAfterInvalidation: nativeSuccess ? undefined : 0,
          modelRequestsAfterNativeToolFailure: nativeSuccess ? undefined : 0,
          embeddingRequests: embeddingRequests.length, authorizedFragmentConsumed: nativeSuccess,
          nativeFinalToolOriginalConsumed: nativeSuccess,
          wikiCompiledClaimCacheRequired: nativeFamily === "wiki",
          nativeReadFailure: nativeState === "missing" ? "native_memory_index_unavailable" : nativeState === "mismatch" ? mismatchCategory : undefined,
          embeddingCacheReuseVerified: ["cache", "gemini"].includes(nativeFamily),
          diagnostics: gateway.diagnostics() });
      }
      await writeFile(path.join(temp, "host-memory-boundary.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      return;
    } finally { await visitor?.stopAndWait({ timeoutMs: 2_000 }); }
  }
  if (process.argv.includes("--initialization")) {
    const checked = await client.request("stella.initialize", { action: "verify" });
    assert.equal(checked.verification.schemaVersion, "stella.initialization-verification/v1");
    assert.equal(checked.verification.scope, "host_bootstrap");
    assert.equal(checked.verification.runtimeAdmission, false);
    initializationVerification = checked.verification;
    assert.equal(checked.runtime.state, "not_evaluated");
    assert.ok(Object.values(checked.verification.binding).every(value => /^sha256:[a-f0-9]{64}$/.test(value)));
    assert.equal(providerRequests, 0, "Restricted bootstrap verification must not invoke a model");
    await assert.rejects(client.request("stella.initialize", { action: "verify", passed: true }));
    const changedModule = path.join(coreDist, "src/openclaw/initialization-templates.js");
    const originalModule = await readFile(changedModule);
    try {
      await writeFile(changedModule, Buffer.concat([originalModule, Buffer.from("\n// Synthetic installed-code drift\n")]));
      await assert.rejects(client.request("stella.initialize", { action: "verify" }), /verification_code_reload_required/);
    } finally { await writeFile(changedModule, originalModule); }
  }
  let direct;
  try {
    direct = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "agent", "--agent", "probe", "--session-key", "agent:probe:direct", "--message", "Synthetic direct probe", "--json", "--timeout", "30"], { cwd: temp, env: gateway.env, timeout: 60_000 });
  } catch (error) { direct = error; }
  assert.equal(providerRequests, 0, "Direct agent execution must not reach the model");
  assert.match(`${direct.stdout}\n${direct.stderr}`, /Stella Core 需要经过可验证的完成协调入口/);
  const sessionKey = "agent:probe:main-completion";
  const submission = { sessionKey, message: liveFragment ? `Synthetic fragment acceptance only. Read the stella-initialization-probe skill, list fragment descriptions with stella_read_fragment, and read the permitted observation fragment using its listed handle. Then test these two explicit negative cases: read the synthetic source file ${fragmentOriginalPath} with read, and request the unavailable handle F2 with stella_read_fragment. These attempts must be denied; do not try other tools or routes. Finish with only SYNTHETIC_MAIN_ANSWER and the Evidence ref returned by the successful fragment read. All source bodies are summary-only: do not quote or reproduce any original text, including the permitted fragment. Do not add a narrative report.` : skillReadProbe ? "Read the stella-initialization-probe skill and initialize Stella again now."
    : sourceDeletionProbe ? "Synthetic source assertion for this writing task: SYNTHETIC_CORRECTED_PREMISE. Preserve the open questions."
    : questionProbe ? "What did my friend confirm about the weekend?" : "Synthetic main plugin question", idempotencyKey: "synthetic-main" };
  const { runExactHostEvaluationChat } = await import(buildModule("src/acceptance/exact-host-chat.js"));
  const sent = completionLifecycleProbe || failureProbe || cancellationProbe || guardedStale || guardedPayload ? await client.request("chat.send", submission) : await runExactHostEvaluationChat({
    request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
    subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
  }, submission);
  if (cancellationProbe) {
    let timer;
    try {
      await Promise.race([providerArrived.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic provider did not receive generation within the observation window")), 60_000);
      })]);
    } finally { clearTimeout(timer); }
    const aborted = await client.request("chat.abort", { sessionKey, runId: sent.runId });
    providerRelease.resolve();
    assert.equal(aborted.aborted, true);
  }
  if (!completionLifecycleProbe && !failureProbe && !cancellationProbe && !guardedStale && !guardedPayload) liveFragment ? assert.ok(sent.text.includes("SYNTHETIC_MAIN_ANSWER")) : assert.equal(sent.text, "SYNTHETIC_MAIN_ANSWER");
  let terminal = await observeExactHostRunTerminal({ runId: sent.runId,
    timeoutMs: nativeActiveStale ? 600_000 : 300_000,
    readTerminal: params => client.request("agent.wait", params, { timeoutMs: 35_000 }),
  });
  if (completionLifecycleProbe) {
    const deadline = Date.now() + 120_000;
    for (;;) {
      let settled = [];
      try { settled = (await readFile(path.join(temp, "completion-dispatch-settled.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (settled.some(row => row.runId === sent.runId)) break;
      if (Date.now() >= deadline) throw new Error("Synthetic completion owner did not settle");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
  }
  const history = await readHistory({ sessionKey, limit: 10 });
  const messages = history.messages ?? [];
  if (completionLifecycleProbe) {
    // Dispatch settlement above precedes the Host's WebChat terminal projection.
    const deadline = Date.now() + 5_000;
    while (!observedEvents.some(event => event.event === "chat" && event.payload?.runId === sent.runId &&
      ["final", "error", "aborted"].includes(event.payload?.state)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const lifecycle = { hostVersion: host.version, nativeCompletionLifecycle, runId: sent.runId,
      terminal, providerRequests, session: (await client.request("sessions.list", {})).sessions.find(session => session.key === sessionKey),
      events: observedEvents.filter(event => JSON.stringify(event).includes(sent.runId)) };
    await writeFile(path.join(temp, "completion-lifecycle.json"), JSON.stringify(lifecycle, null, 2));
    assert.equal(lifecycle.events.filter(event => event.event === "chat" && event.payload?.state === "final").length,
      failureProbe || cancellationProbe ? 0 : 1, "Only the receipt-backed dispatcher may publish a final completion");
    if (!failureProbe && !cancellationProbe) {
      const delivered = lifecycle.events.find(event => event.event === "chat" && event.payload?.state === "final");
      assert.ok(JSON.stringify(delivered?.payload?.message ?? null).includes("SYNTHETIC_MAIN_ANSWER"), "An early empty Host terminal cannot count as completion");
    }
    assert.equal(lifecycle.session?.status, completionStatusChanged ? "running" : failureProbe ? "failed" : cancellationProbe ? "killed" : "done",
      "A settled completion must reach the matching native session terminal state");
  }
  assert.equal(terminal.status, failureProbe || cancellationProbe || guardedStale || guardedPayload ? "error" : "ok", JSON.stringify(terminal));
  let persistence;
  if (nativeActiveStale) {
    const invalidation = JSON.parse(await readFile(path.join(temp, 'native-source-invalidation.json'), 'utf8'));
    assert.equal(providerRequests, 3, "A valid native summary must be followed by zero main-model requests after source deletion");
    assert.equal(nativeSummaryConsumed, false);
    // The original Host reaches the parent admission gate before transport.
    // Preserve its actual category rather than bypassing it to reach a later
    // source check merely for the probe.
    assert.ok(gateway.diagnostics().includes("initialization admission blocked (source_dirty)"), gateway.diagnostics());
    const admissions = (await readFile(path.join(temp, "native-authority-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(admissions.some(row => row.name === "before_agent_run" && row.phase === "returned" &&
      row.result?.outcome === "block" && row.result.category === "source_dirty"));
    persistence = { nativeSourceInvalidation: invalidation, mainModelRequests: 0, staleSummaryConsumed: false };
  } else if (nativeArtifactProbe) {
    const hooks = (await readFile(path.join(temp, "native-reinjection-hook.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(hooks.length > 0 && hooks.every(hook => hook.sha256 === nativeArtifact.sha256 && hook.entry === nativeArtifact.entry));
    assert.equal(providerRequests, 0, "The actual final model transport must not receive the unbound native artifact");
    const expectedCategory = "host_context_input_changed";
    assert.ok(gateway.diagnostics().includes(expectedCategory), "Fail at the actual bound-input gate, not an unrelated preparation error");
    const lifecycle = (await readFile(path.join(temp, "context-lifecycle.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(lifecycle.some(event => event.method === "assertConsumption" && event.phase === "failed" && event.category === expectedCategory),
      "The real provider must recheck and reject even if Host falls back after an engine error");
    if (nativeArtifact.entry === "prependContext") {
      const failedAssembly = lifecycle.findIndex(event => event.method === "assemble" && event.phase === "failed" && event.category === expectedCategory);
      const failedProvider = lifecycle.findIndex(event => event.method === "assertConsumption" && event.phase === "failed" && event.category === expectedCategory);
      assert.ok(failedAssembly >= 0 && failedProvider > failedAssembly, "Observe the Host fallback reaching the latched provider gate");
    }
    persistence = { nativeArtifactSha256: nativeArtifact.sha256, generationArtifactSha256: nativeArtifact.generationArtifactSha256, actualPromptHookInvocations: hooks.length,
      sourceGenerationReport: nativeArtifact.generationReport, artifactKind: nativeArtifact.kind,
      entry: `before_prompt_build.${nativeArtifact.entry}`, hostFallbackRejected: nativeArtifact.entry === "prependContext", finalInputRejected: true, draftNotDelivered: true };
  } else if (guardedStale) {
    assert.match(terminal.error ?? "", /processing_generation_mismatch|stella_recovery_revision_invalid|stale_generation/);
    assert.equal(providerRequests, 1);
    assert.ok(!messages.some(message => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")));
    if (managedContextProbe) {
      const lifecycle = (await readFile(path.join(temp, "context-lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(lifecycle.some(event => event.method === "observeOutput" && event.phase === "returned"));
      assert.ok(lifecycle.some(event => event.method === "assertConsumption" && event.phase === "failed" && event.category === "stale_generation"));
    }
    persistence = { staleToolContinuationBlocked: true, modelRequestsAfterChange: 0,
      ...(managedContextProbe ? { managedContextCategory: "stale_generation" } : {}) };
  } else if (cancellationProbe) {
    const events = observedEvents.filter(event => event.event === "chat" && event.payload?.runId === sent.runId);
    assert.equal(events.filter(event => event.payload.state === "final").length, 0);
    assert.ok(events.some(event => ["aborted", "error"].includes(event.payload.state)));
    assert.ok(cancellationCheckpoint, "Observe the repository immediately before cancelling the actual model request");
    assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), cancellationCheckpoint.revision);
    assert.equal((await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim(), cancellationCheckpoint.status);
    persistence = { cancelledDuringPreparation: preparationCancellationProbe, cancelledDuringGeneration: !preparationCancellationProbe,
      revisionAtCancellation: cancellationCheckpoint.revision, preparationChangedRevision: cancellationCheckpoint.revision !== revision,
      businessRevisionUnchangedAfterCancellation: true, lateProviderAnswerNotDelivered: true };
  } else if (outputRejectionProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
    await reader.assertCurrent();
    assert.equal(reader.catalog.changes.length, 1);
    assert.equal(reader.catalog.bundles.length, 0);
    assert.equal(providerRequests, 1);
    assert.equal(observedEvents.filter(event => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
    persistence = { correctionSynchronized: true, rejectedDraftNotDelivered: true, unverifiedAnswerNotPersisted: true };
  } else if (correctionRecoveryProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
    await assert.rejects((await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json")).assertCurrent(), /memory_transaction_pending/);
    const checkpoint = JSON.parse(await readFile(path.join(temp, "correction-checkpoint.json"), "utf8"));
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), checkpoint.archiveRevision);
    assert.equal(providerRequests, 0);
    await client.stopAndWait({ timeoutMs: 2000 }); await gateway.stop();
    await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", remote]);
    gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"), ...(guardedActive ? { diagnosticPrefixes: ["active-memory:"] } : {}) });
    await connectObserver();
    const operationId = `learn_${bytesVersion(sent.runId).slice(7)}`;
    const recovered = await client.request("stella.recoverCorrection", { operationId });
    assert.deepEqual(await client.request("stella.recoverCorrection", { operationId }), recovered);
    assert.equal(recovered.replyResent, false);
    assert.equal(recovered.revision, (await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim());
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, recovered.revision);
    const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json"); await reader.assertCurrent();
    assert.equal(reader.catalog.changes.length, 1); assert.equal(reader.catalog.understandings.length, 1);
    assert.equal(observedEvents.filter(event => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
    persistence = { synchronized: true, pendingTransactionFencedBeforeRecovery: true, recoveredAfterHostRestart: true, replyResent: false, duplicateLearningCreated: false };
  } else if (completionStatusChanged) {
    const changed = JSON.parse(await readFile(path.join(temp, "completion-status-changed.json"), "utf8"));
    assert.equal(changed.after.startedAt, changed.before.startedAt + 1);
    assert.match(terminal.error ?? "", /host_completion_session_changed/);
    assert.equal(providerRequests, 1);
    assert.ok(!messages.some(message => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")));
    assert.ok(!observedEvents.some(event => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")));
    assert.ok(gateway.diagnostics().includes("host_completion_session_changed"));
    persistence = { synchronized: true, hostSessionOwnerChanged: true, foreignStatusNotOverwritten: true, draftNotDelivered: true };
  } else if (managedBusinessFailure) {
    const fault = JSON.parse(await readFile(path.join(temp, "managed-business-failure.json"), "utf8"));
    assert.match(fault.message, /^preserve question evidence /);
    const historyRoot = path.join(canghaiRoot, "30_PersonalData/context-history");
    const { readdir } = await import("node:fs/promises");
    const retained = await readdir(path.join(historyRoot, "contexts"));
    assert.ok(retained.some(file => file.endsWith(".json.sig")), "A real signed consumption must be archived before the injected business failure");
    const sessionHeads = await readdir(path.join(historyRoot, "sessions")).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(sessionHeads, [], "A failed business transaction cannot publish its private draft as session history");
    const pending = JSON.parse(await readFile(path.join(canghaiRoot, ".stella-memory-transaction.json"), "utf8"));
    assert.match(pending.operationId, /^question_/);
    assert.equal(providerRequests, 1, "Exercise a generated answer followed by the real business transaction");
    persistence = { synchronized: false, signedContextRetained: true, businessFailureObserved: true,
      pendingTransactionFenced: true, sessionHeadUnchanged: true, draftNotDelivered: true };
  } else if (failureProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    await assert.rejects((await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json")).assertCurrent(), /memory_transaction_pending/);
    const beforeTailRevision = adviceTailProbe ? JSON.parse(await readFile(path.join(temp, "advice-tail-checkpoint.json"), "utf8")).beforeTailRevision : revision;
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim(), beforeTailRevision);
    const expectedPointer = adviceTailProbe ? (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim() : beforeTailRevision;
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, expectedPointer);
    if (adviceTailProbe) assert.notEqual(beforeTailRevision, revision);
    assert.equal(observedEvents.filter((event) => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
    assert.equal(observedEvents.filter((event) => event.event === "chat" && event.payload?.runId === sent.runId && event.payload?.state === "error").length, 1);
    persistence = { synchronized: false, pendingTransactionFenced: true, remoteUnchangedSinceFailingStage: true, nativeFailureWithoutDraft: true,
      ...(adviceTailProbe ? { adviceAlreadySynchronizedBeforeBundleFailure: true } : {}) };
    if (recoveryProbe) {
      await client.stopAndWait({ timeoutMs: 2_000 });
      await gateway.stop();
      await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", remote]);
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"), ...(guardedActive ? { diagnosticPrefixes: ["active-memory:"] } : {}) });
      await connectObserver();
      const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
      const operationId = `${questionProbe || adviceTailProbe ? "question" : "outcome"}_${bytesVersion(sent.runId).slice(7)}`;
      const method = questionProbe || adviceTailProbe ? "stella.recoverQuestionEvidence" : "stella.recoverOutcome";
      if (process.argv.includes("--outcome-recovery")) {
        // This legacy fixture has no signed context archive. Current outcome
        // recovery must refuse it; the signed success path is exercised by
        // --outcome-history-recovery, including restart and final consumption.
        const marker = await readFile(path.join(canghaiRoot, ".stella-memory-transaction.json"), "utf8");
        const before = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
        const pointer = JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision;
        const calls = providerRequests;
        await assert.rejects(client.request(method, { operationId }), /host_context_history_configuration_required/);
        assert.equal(providerRequests, calls);
        assert.equal(await readFile(path.join(canghaiRoot, ".stella-memory-transaction.json"), "utf8"), marker);
        assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), before);
        assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, pointer);
        assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim(), beforeTailRevision);
        persistence.recovery = { hostRestarted: true, blocked: true, category: "host_context_history_configuration_required",
          pendingTransactionPreserved: true, sourceUnchanged: true, pointerUnchanged: true, remoteUnchanged: true,
          modelRequests: 0, replyResent: false };
      } else {
        const recovered = await client.request(method, { operationId });
        assert.deepEqual(await client.request(method, { operationId }), recovered);
        assert.equal(recovered.replyResent, false);
        assert.deepEqual(recovered.writeOperationIds, [operationId]);
        const remoteRevision = (await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
        assert.equal(recovered.revision, remoteRevision);
        assert.notEqual(remoteRevision, revision);
        assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, remoteRevision);
        const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
        await reader.assertCurrent();
        const episodeId = adviceTailProbe && !adviceRevisionProbe ? `praxis_${bytesVersion(sent.runId).slice(7)}` : outcomeSeed.episodeId;
        const episode = JSON.parse(await readFile(path.join(canghaiRoot, `30_PersonalData/praxis/episodes/${episodeId}/episode.json`), "utf8"));
        assert.equal(episode.status, questionProbe || adviceTailProbe ? "recommended" : "closed");
        if (outcomeProbe) assert.equal((await reader.read(episode.learning.praxis[0], "understandings")).status, "candidate");
        const afterRecovery = await readHistory({ sessionKey, limit: 10 });
        assert.equal(afterRecovery.messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
        assert.equal(observedEvents.filter((event) => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
        if (adviceTailProbe) await verifyAdviceBundle(reader, sent.runId, revision, remote, remoteRevision, episode);
        else await (questionProbe ? verifyQuestionBundle : verifyOutcomeBundle)(reader, sent.runId, revision, remote, remoteRevision);
        if (adviceRevisionProbe) {
          assert.equal(episode.id, outcomeSeed.episodeId);
          assert.deepEqual(episode.twin?.prediction, outcomeSeed.advised.episode.twin.prediction);
          assert.deepEqual(episode.historicalInputRefs, outcomeSeed.advised.episode.historicalInputRefs);
        }
        persistence.recovery = { hostRestarted: true, synchronized: true, pointerConfirmed: true, replyResent: false, evidenceBundleSynchronized: true };
        if (adviceRevisionProbe) persistence.recovery.adviceRevisionPreserved = true;
      }
    }
  } else if (outcomeHistoryProbe) {
    persistence = { firstOrdinaryTurnSynchronized: true, noOutcomeBeforeExplicitPhase: true };
  } else if (correctionProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
    assert.equal(reader.catalog.understandings.length, 1);
    assert.equal(reader.catalog.changes.length, 1);
    assert.equal(reader.catalog.sources.length, contextSourceCount + (fragmentProbe || nativeFragmentFixture ? 2 : 1));
    assert.equal(reader.catalog.bundles.length, 1);
    if (!liveFragment) assert.equal(providerReceivedCorrection, true, "Final Host prompt must contain the newly synchronized understanding");
    const localRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    assert.equal(localRevision, (await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim());
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, localRevision);
    persistence = { synchronized: true, ownerInputArchivedBeforeInference: true, correctionPresentInFinalPrompt: liveFragment ? "pending_observation" : true };
    if (managedContextProbe) {
      const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
      const archiveRoot = "30_PersonalData/context-history";
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(path.join(canghaiRoot, archiveRoot, "sessions"));
      assert.equal(files.length, 1);
      const head = JSON.parse(await readFile(path.join(canghaiRoot, archiveRoot, "sessions", files[0]), "utf8"));
      assert.equal(head.schemaVersion, "stella.host-context-head/v2");
      assert.equal(head.business.body.draftHash, bytesVersion("SYNTHETIC_MAIN_ANSWER"));
      assert.equal(head.business.body.generationId, reader.catalog.generationId);
      const { loadContextHistoryHead } = await import(buildModule("src/openclaw/host-context-head.js"));
      const restored = await loadContextHistoryHead({ root: canghaiRoot, archiveRoot, revision: localRevision,
        request: head.scope, verificationKey: contextKeys.verificationKey, requireBusinessCommit: true });
      assert.equal(restored.archive.digest, head.digest);
      persistence.businessCommitBindingVerified = true;
      if (guardedActive) {
        const { readContextHistory } = await import(buildModule("src/openclaw/host-context-history.js"));
        const snapshot = await readContextHistory(restored.archive, canghaiRoot, reader);
        assert.ok(snapshot.graph.nodes.some(node => node.producer === "assistant" && node.content.includes("SYNTHETIC_NATIVE_RECALL_SUMMARY")));
        assert.ok(snapshot.graph.nodes.some(node => node.producer === "tool_result" && node.content.includes("SYNTHETIC_ALLOWED_FRAGMENT")));
        persistence.nativeRecallTraceSignedAndSynchronized = true;
      }
    }
  } else if (questionProbe && managed) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
    const remoteRevision = (await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
    assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), remoteRevision);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, remoteRevision);
    await verifyQuestionBundle(reader, sent.runId, revision, remote, remoteRevision);
    persistence = { synchronized: true, evidenceBundleSynchronized: true, requestAndDraftHashVerified: true, learningCreated: false };
  } else if (managed) {
    const localRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    const remoteRevision = (await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
    const actualConfig = JSON.parse(await readFile(configPath, "utf8"));
    const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
    const recordPath = `30_PersonalData/praxis/episodes/${outcomeSeed?.episodeId ?? `praxis_${bytesVersion(sent.runId).slice(7)}`}/episode.json`;
    const localEpisode = JSON.parse(await readFile(path.join(canghaiRoot, recordPath), "utf8"));
    const remoteEpisode = JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${recordPath}`])).stdout);
    assert.deepEqual(remoteEpisode, localEpisode);
    assert.equal(localEpisode.schemaVersion, "stella.praxis-episode/v2");
    assert.equal(localEpisode.status, outcomeProbe ? "closed" : "recommended");
    assert.deepEqual(localEpisode.twin?.prediction, adviceRevisionProbe ? outcomeSeed.advised.episode.twin.prediction : undefined);
    if (outcomeProbe) {
      assert.equal(localEpisode.actual.occurredAt, null);
      assert.equal(localEpisode.learning.praxis.length, 1);
      const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
      const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
      const strategy = await reader.read(localEpisode.learning.praxis[0], "understandings");
      assert.equal(strategy.status, "candidate");
      const change = await reader.read(reader.currentRef(strategy.originChangeId, "changes"), "changes");
      assert.equal(change.modelRef, "synthetic/injected");
      assert.equal(change.disposition, "update");
      const strategyEntry = reader.entry(localEpisode.learning.praxis[0]);
      const remoteStrategy = JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${strategyEntry.locator.path}`])).stdout);
      assert.deepEqual(remoteStrategy, strategy);
      await verifyOutcomeBundle(reader, sent.runId, revision, remote, remoteRevision);
    } else {
      assert.equal(localEpisode.actual, undefined);
      const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
      await verifyAdviceBundle(await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json"), sent.runId, revision, remote, remoteRevision, localEpisode);
      if (adviceRevisionProbe) {
        assert.equal(localEpisode.id, outcomeSeed.episodeId);
        assert.deepEqual(localEpisode.historicalInputRefs, outcomeSeed.advised.episode.historicalInputRefs);
        assert.ok(localEpisode.decision.inputRefs.length > 0);
        assert.equal(localEpisode.provenance.runId, sent.runId);
        const restored = path.join(temp, "restored-source");
        await run("git", ["clone", "--quiet", "--branch", "main", remote, restored]);
        const { loadConsciousness } = await import(buildModule("src/canghai/manifest.js"));
        const { loadPraxisRuntimeBinding, createBoundPraxisRuntime } = await import(buildModule("src/praxis/runtime-binding.js"));
        const loaded = await loadConsciousness(restored);
        const runtime = await createBoundPraxisRuntime(loaded, await loadPraxisRuntimeBinding(loaded),
          async () => { throw new Error("Restoration must not invent new action evidence"); }, async () => {});
        const memory = await runtime.listMemory();
        assert.equal(memory.openEpisodes.length, 1);
        assert.equal(memory.openEpisodes[0].recommendation, "SYNTHETIC_MAIN_ANSWER");
        assert.deepEqual(await runtime.repository.readHistorical(localEpisode.id, outcomeSeed.advised.version), outcomeSeed.advised);
      }
    }
    assert.equal(localRevision, remoteRevision);
    assert.equal(actualConfig.plugins.entries["stella-core"].config.recoveryRevision, remoteRevision);
    assert.notEqual(remoteRevision, revision);
    persistence = { schemaVersion: localEpisode.schemaVersion, status: localEpisode.status, synchronized: true, pointerConfirmed: true,
      actualInvented: false, predictionInvented: false, evidenceBundleSynchronized: true,
      ...(outcomeProbe ? { strategyStatus: "candidate", learningChangeSynchronized: true } : { adviceAndDraftHashBound: true }),
      ...(adviceRevisionProbe ? { adviceRevision: true, originalPredictionPreserved: true, oldAdviceRestored: true, importantOpenStateRestored: true } : {}) };
  }
  let admissionReplay;
  if (admissionReplayProbe) {
    const beforeReplayRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    await client.stopAndWait({ timeoutMs: 2_000 });
    await gateway.stop();
    gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"), ...(guardedActive ? { diagnosticPrefixes: ["active-memory:"] } : {}) });
    await connectObserver();
    await waitForInitializationReady();
    const replay = await client.request("chat.send", submission);
    const replayTerminal = await client.request("agent.wait", { runId: replay.runId, timeoutMs: 60_000 });
    assert.equal(replay.runId, sent.runId);
    assert.equal(replayTerminal.status, "error");
    const coreAdmissionRejected = JSON.stringify(replayTerminal).includes("run_recovery_required");
    const hostSessionRejected = replayTerminal.error === `Error: Session "${sessionKey}" changed while starting work. Retry.`;
    assert.ok(coreAdmissionRejected || hostSessionRejected, "Replay must fail at an identified admission boundary");
    const replayHistory = await readHistory({ sessionKey, limit: 10 });
    await writeFile(path.join(temp, "replay-observation.json"), JSON.stringify({
      replayTerminal, providerRequests,
      messages: replayHistory.messages.map((message) => ({ role: message.role, id: message.id,
        content: message.content })),
      terminalEvents: observedEvents.filter((event) => event.event === "chat" && event.payload?.runId === sent.runId),
    }, null, 2));
    // Exact Host may store its blocked-input notice with role=user. Count the
    // submitted payload, not that role label, as evidence of a repeated input.
    const replayUsers = replayHistory.messages.filter((message) => message.role === "user");
    const messageText = (message) => typeof message.content === "string" ? message.content
      : message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    assert.equal(replayUsers.filter((message) => messageText(message) === submission.message).length, 1);
    const notices = replayUsers.filter((message) => messageText(message) !== submission.message);
    // The terminal above proves persistent replay admission. Host transcript
    // notices come from independent guards and do not replace that proof.
    const noticeKinds = notices.map((notice) => {
      const text = messageText(notice);
      if (text === "Your message could not be sent: Stella Core 需要经过可验证的完成协调入口，已停止本轮请求。 (blocked by stella-core)") return "completion_gate";
      assert.equal(text, "Your message could not be sent: Stella 初始化尚未完成或运行文件已变化；请执行 /stella-initialize。 (blocked by stella-core)");
      assert.ok(gateway.diagnostics().includes("Stella initialization admission blocked (initialization_pending)"),
        "An initialization notice requires its actual gate diagnostic");
      return "initialization_gate";
    });
    assert.ok(notices.length <= 1, "Host must not multiply rejection notices");
    assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), beforeReplayRevision);
    assert.equal((await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim(), "");
    assert.equal(replayHistory.messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length, 1);
    assert.equal(observedEvents.filter((event) => event.event === "chat" && event.payload?.runId === sent.runId && event.payload?.state === "final").length, 1);
    assert.equal(providerRequests, 1);
    admissionReplay = { hostRestarted: true, sameRunRejectedBeforeModel: true,
      rejectionLayer: coreAdmissionRejected ? "core_persistent_admission" : "host_session_state",
      duplicateUserMessages: 0, hostRejectionNotices: notices.length, hostRejectionNoticeKinds: noticeKinds, duplicateFinals: 0,
      businessRevisionUnchanged: true };
  }
  let liveEvidence;
  if (liveFragment) {
    const toolEvents = (await readFile(path.join(temp, "live-tools.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const semanticEvents = (await readFile(path.join(temp, "live-semantic.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const inputs = (await readFile(path.join(temp, "live-inputs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(inputs.length > 0 && inputs.every(e => !e.forbiddenNeighbor));
    assert.ok(inputs.some(e => e.correctionPresent));
    persistence.correctionPresentInFinalPrompt = true;
    const results = JSON.stringify(toolEvents) + JSON.stringify(inputs);
    fragmentChecks.skillBodyRead = toolEvents.some(e => e.toolName === "read" && JSON.stringify(e.result).includes("stella_read_fragment"));
    fragmentChecks.descriptionListed = results.includes("Synthetic permitted observation fragment");
    fragmentChecks.allowedRead = results.includes("SYNTHETIC_ALLOWED_FRAGMENT");
    fragmentChecks.deniedNeighborAbsent = !results.includes("SYNTHETIC_DENIED_NEIGHBOR") && !sent.text.includes("SYNTHETIC_DENIED_NEIGHBOR");
    fragmentChecks.wholeFileBlocked = results.includes("skill_read_forbidden") || results.includes("unsafe_path");
    fragmentChecks.unavailableHandleBlocked = results.includes("fragment_handle_not_available");
    const readResult = toolEvents.find(e => e.toolName === "stella_read_fragment" && e.params?.action === "read" && e.result?.details?.original)?.result.details.original;
    assert.ok(readResult?.ref?.id, "Successful fragment tool result must retain Evidence identity");
    assert.ok(sent.text.includes(readResult.ref.id), "Final model answer must cite the returned Evidence identity");
    assert.ok(semanticEvents.some(e => e.purpose === "stella-source-access"));
    assert.ok(semanticEvents.some(e => e.purpose === "stella-source-output"));
    assert.ok(semanticEvents.every(e => `${e.provider}/${e.model}` === liveModel));
    liveEvidence = { model: liveModel, realAccessAndOutputJudgments: true, realAgentToolSelection: true, evidenceCitationMatched: true,
      syntheticPreparationJudgments: true, privateContextSent: false, semanticCalls: semanticEvents.length, toolCalls: toolEvents.length, modelInputsChecked: inputs.length };
  }
  if (fragmentProbe) assert.ok(Object.values(fragmentChecks).every(Boolean), JSON.stringify(fragmentChecks));
  let historyView;
  let historyFollowup;
  let sourceDeletion;
  let outcomeHistory;
  if (outcomeHistoryProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const { EpisodeEvidenceResolver } = await import(buildModule("src/praxis/episode-evidence.js"));
    const { HostContextAuthority } = await import(buildModule("src/openclaw/host-context-authority.js"));
    const { compileInitializationSource } = await import(buildModule("src/openclaw/initialization-source.js"));
    const { loadConsciousness } = await import(buildModule("src/canghai/manifest.js"));
    const { snapshotTurnRequest } = await import(buildModule("src/openclaw/turn-request.js"));
    const { loadContextHistoryHead } = await import(buildModule("src/openclaw/host-context-head.js"));
    const { readContextHistory } = await import(buildModule("src/openclaw/host-context-history.js"));
    const { publishPreparedHistoryView, loadPublishedHistoryView } = await import(buildModule("src/openclaw/host-context-view.js"));
    const { GitCangHaiDurability } = await import(buildModule("src/canghai/durability.js"));
    const archiveRoot = "30_PersonalData/context-history", catalogPath = "30_PersonalData/memory/catalog.json";
    const firstRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    const headFile = (await (await import("node:fs/promises")).readdir(path.join(canghaiRoot, archiveRoot, "sessions")))[0];
    const head = JSON.parse(await readFile(path.join(canghaiRoot, archiveRoot, "sessions", headFile), "utf8"));
    const prior = await loadContextHistoryHead({ root: canghaiRoot, archiveRoot, revision: firstRevision,
      request: head.scope, verificationKey: contextKeys.verificationKey, requireBusinessCommit: true });
    assert.ok(prior);
    const snapshot = await readContextHistory(prior.archive, canghaiRoot);
    assert.equal(snapshot.configurationHash?.startsWith("sha256:"), true);
    const loaded = await loadConsciousness(canghaiRoot);
    const profile = parseYaml(await readFile(path.join(canghaiRoot, "50_PersonalAgent/stella/runtime-profile.yaml"), "utf8"));
    const compilation = await compileInitializationSource(canghaiRoot, initializationRecipe, { agentId: "probe", hostVersion: host.version,
      contractProfile: profile.contract_profile, requiredCapabilities: profile.capabilities.filter(capability => capability.required).map(capability => capability.id),
      ...(loaded.manifest.extensions?.skillRegistryRef ? { skillRegistryRef: loaded.manifest.extensions.skillRegistryRef } : {}) });
    const request = snapshotTurnRequest({ ...head.scope, prompt: submission.message,
      senderId: snapshot.authority.senderId, senderIsOwner: snapshot.authority.senderIsOwner, chatType: "direct" }, sent.runId);
    const createAuthority = async () => {
      const reader = await CatalogReader.load(canghaiRoot, catalogPath);
      const currentAuthority = { ...snapshot.authority, generationId: reader.catalog.generationId };
      const resolver = new EpisodeEvidenceResolver(reader, { ...snapshot.authority.purpose,
        evidenceCutoff: new Date().toISOString(), trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
      async () => { throw new Error("History view probe does not perform semantic source selection"); });
      return new HostContextAuthority(resolver, request, { authority: currentAuthority,
        configurationHash: snapshot.configurationHash, compilation, historyVerificationKey: contextKeys.verificationKey,
        captureCurrent: async () => ({ request, modelRef: snapshot.authority.modelRef, deployment: snapshot.authority.deployment,
          purpose: snapshot.authority.purpose, generationId: (await CatalogReader.load(canghaiRoot, catalogPath)).catalog.generationId,
          configurationHash: snapshot.configurationHash, compilation }) });
    };
    const authority = await createAuthority();
    const prepared = await authority.prepareHistoryRebuild({ viewId: "session-current-view", archive: prior.archive, current: [],
      complete: async () => ({ text: JSON.stringify({ summary: "SYNTHETIC_OUTCOME_PENDING" }), modelRef: probeModel }) });
    await client.stopAndWait({ timeoutMs: 2_000 });
    await gateway.stop();
    const durability = new GitCangHaiDurability({ root: canghaiRoot, remote: "origin", branch: "main",
      criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
      onRevision: async current => {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        config.plugins.entries["stella-core"].config.recoveryRevision = current;
        await writeFile(configPath, JSON.stringify(config));
      } });
    const published = await publishPreparedHistoryView(authority, prepared, { signingKey: contextKeys.signingKey,
      durability, reloadAuthority: createAuthority });
    await writeFile(path.join(temp, "outcome-history-phase"), "outcome");
    gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
    await connectObserver();
    await waitForInitializationReady();
    const beforeRequests = providerRequests;
    const outcomeSubmission = { sessionKey, message: submission.message, idempotencyKey: "synthetic-outcome-history" };
    const outcome = outcomeHistoryRecoveryProbe ? await client.request("chat.send", outcomeSubmission) : await runExactHostEvaluationChat({
      request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
      subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
    }, { ...outcomeSubmission, timeoutMs: 300_000 });
    let recovery;
    if (outcomeHistoryRecoveryProbe) {
      let failed;
      const deadline = Date.now() + 300_000;
      do {
        assert.ok(Date.now() < deadline, "Outcome failure observation timed out");
        failed = await client.request("agent.wait", { runId: outcome.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
      } while ((failed.status === "pending" || failed.status === "timeout") && failed.endedAt == null &&
        ["queue", "gateway_draining"].includes(failed.timeoutPhase));
      assert.equal(failed.status, "error", JSON.stringify(failed));
      assert.equal(observedEvents.filter(event => event.event === "chat" && event.payload?.runId === outcome.runId && event.payload?.state === "error").length, 1);
      assert.ok(!observedEvents.some(event => event.event === "chat" && event.payload?.runId === outcome.runId &&
        event.payload?.state === "final"), "The failed business draft must not be delivered");
      const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
      const operationId = `outcome_${bytesVersion(outcome.runId).slice(7)}`;
      const pending = JSON.parse(await readFile(path.join(canghaiRoot, ".stella-memory-transaction.json"), "utf8"));
      assert.equal(pending.operationId, operationId);
      assert.ok(pending.contextArchive?.digest);
      const checkpoint = JSON.parse(await readFile(path.join(temp, "outcome-recovery-checkpoint.json"), "utf8"));
      assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), checkpoint.archiveRevision);
      const previousTools = JSON.parse(await readFile(configPath, "utf8")).agents.entries.probe.tools ?? null;
      await client.stopAndWait({ timeoutMs: 2_000 }); await gateway.stop();
      await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", remote]);
      await writeFile(path.join(temp, "outcome-recovery-running"), "no-inference");
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
      await connectObserver();
      const isolationDeadline = Date.now() + 30_000;
      for (;;) {
        const state = await client.request("stella.initialize", { action: "status" });
        const isolation = await readFile(path.join(temp, "state/stella-core/initialization/probe/host-isolation.json"), "utf8")
          .then(JSON.parse).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        const tools = JSON.parse(await readFile(configPath, "utf8")).agents.entries.probe.tools;
        // inspect() reports initialization_required once the isolation is
        // durable; the startup diagnostic retains the original source fault.
        if (state.state === "blocked" && ["source_dirty", "initialization_required"].includes(state.category) &&
          gateway.diagnostics().includes("Stella initialization blocked (source_dirty)") &&
          isolation?.agentId === "probe" && isolation.reason === "plugin_start_failed" &&
          JSON.stringify(tools) === JSON.stringify({ deny: ["*"] })) {
          await writeFile(path.join(temp, "startup-isolation.json"), JSON.stringify({ state, isolation, tools }, null, 2));
          break;
        }
        assert.ok(Date.now() < isolationDeadline, "Pending business recovery must establish its real startup isolation");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const beforeRecoveryRequests = providerRequests;
      const receipt = await client.request("stella.recoverOutcome", { operationId });
      assert.deepEqual(await client.request("stella.recoverOutcome", { operationId }), receipt);
      assert.equal(receipt.replyResent, false);
      assert.equal(providerRequests, beforeRecoveryRequests);
      assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), receipt.revision);
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, receipt.revision);
      assert.equal(await readFile(path.join(temp, "outcome-recovery-inference.jsonl"), "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error; return "";
      }), "");
      const reinitialized = await client.request("stella.initialize", { action: "apply" }, { timeoutMs: 120_000 });
      assert.equal(reinitialized.state, "ready", JSON.stringify(reinitialized));
      await waitForInitializationReady();
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).agents.entries.probe.tools ?? null, previousTools);
      await rm(path.join(temp, "outcome-recovery-running"));
      recovery = { hostRestarted: true, semanticModelCalls: 0, modelRequests: 0, replyResent: false, synchronized: true,
        signedPlanBound: true, idempotent: true, startupIsolated: true, bootstrapReverified: true,
        recordedToolConfigurationRestored: true, operationId, revision: receipt.revision };
    }
    const reader = await CatalogReader.load(canghaiRoot, catalogPath);
    const current = await loadPublishedHistoryView(reader, published.viewId, contextKeys.verificationKey);
    const episode = JSON.parse(await readFile(path.join(canghaiRoot, `30_PersonalData/praxis/episodes/${outcomeSeed.episodeId}/episode.json`), "utf8"));
    const prompts = (await readFile(path.join(temp, "history-rebuild-prompts.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const finalInput = await readFile(path.join(temp, `synthetic-provider-${providerRequests}.json`), "utf8");
    const live = await createAuthority();
    const { restorePublishedHistoryView } = await import(buildModule("src/openclaw/host-context-view.js"));
    const restored = await restorePublishedHistoryView(live, current);
    const consumed = await live.seal({ system: live.publicRules(), messages: [{ role: "user", fragment: restored }] });
    await live.assertConsumption(consumed.consumption, consumed.input);
    outcomeHistory = { episodeStatus: episode.status, answer: outcome.text, modelRequests: providerRequests - beforeRequests,
      rebuildCalls: prompts.length, viewChanged: current.digest !== published.digest, generationId: reader.catalog.generationId,
      currentViewConsumableAfterCommit: true, finalInputHasOutcome: finalInput.includes("Weekend time confirmed"), ...(recovery ? { recovery } : {}) };
    await writeFile(path.join(temp, "outcome-history.json"), JSON.stringify(outcomeHistory, null, 2));
    assert.equal(outcomeHistory.episodeStatus, "closed", JSON.stringify(outcomeHistory));
    if (!outcomeHistoryRecoveryProbe) assert.equal(outcomeHistory.answer, "SYNTHETIC_MAIN_ANSWER");
    assert.equal(outcomeHistory.modelRequests, 1);
    assert.equal(outcomeHistory.rebuildCalls, 1);
    assert.equal(outcomeHistory.viewChanged, true);
    assert.equal(outcomeHistory.finalInputHasOutcome, true);
    await writeFile(path.join(temp, "outcome-history-phase"), "followup");
    const beforeFollowup = providerRequests;
    const followup = await runExactHostEvaluationChat({
      request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
      subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
    }, { sessionKey, message: "What is the current synthetic outcome status?", idempotencyKey: "after-synthetic-outcome", timeoutMs: 300_000 });
    const inputs = (await readFile(path.join(temp, "context-inputs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const candidates = inputs.filter(input => input.method === "routingCandidates" && input.candidates &&
      input.runId === followup.runId).at(-1)?.candidates;
    assert.ok(candidates, "The actual follow-up must record its current routing candidates");
    outcomeHistory.followup = { answer: followup.text, modelRequests: providerRequests - beforeFollowup,
      openEpisodes: candidates.openEpisodes.length };
    await writeFile(path.join(temp, "outcome-history.json"), JSON.stringify(outcomeHistory, null, 2));
    assert.equal(outcomeHistory.followup.answer, "SYNTHETIC_MAIN_ANSWER");
    assert.equal(outcomeHistory.followup.modelRequests, 1);
    assert.equal(outcomeHistory.followup.openEpisodes, 0);
  }
  if (historyViewProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const { EpisodeEvidenceResolver } = await import(buildModule("src/praxis/episode-evidence.js"));
    const { HostContextAuthority } = await import(buildModule("src/openclaw/host-context-authority.js"));
    const { compileInitializationSource } = await import(buildModule("src/openclaw/initialization-source.js"));
    const { loadConsciousness } = await import(buildModule("src/canghai/manifest.js"));
    const { snapshotTurnRequest } = await import(buildModule("src/openclaw/turn-request.js"));
    const { loadContextHistoryHead } = await import(buildModule("src/openclaw/host-context-head.js"));
    const { readContextHistory } = await import(buildModule("src/openclaw/host-context-history.js"));
    const { publishPreparedHistoryView, loadPublishedHistoryView } = await import(buildModule("src/openclaw/host-context-view.js"));
    const { GitCangHaiDurability } = await import(buildModule("src/canghai/durability.js"));
    const archiveRoot = "30_PersonalData/context-history", catalogPath = "30_PersonalData/memory/catalog.json";
    const firstRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    const headFile = (await (await import("node:fs/promises")).readdir(path.join(canghaiRoot, archiveRoot, "sessions")))[0];
    const head = JSON.parse(await readFile(path.join(canghaiRoot, archiveRoot, "sessions", headFile), "utf8"));
    const prior = await loadContextHistoryHead({ root: canghaiRoot, archiveRoot, revision: firstRevision,
      request: head.scope, verificationKey: contextKeys.verificationKey, requireBusinessCommit: true });
    assert.ok(prior);
    const snapshot = await readContextHistory(prior.archive, canghaiRoot);
    assert.equal(snapshot.configurationHash?.startsWith("sha256:"), true);
    const loaded = await loadConsciousness(canghaiRoot);
    const profile = parseYaml(await readFile(path.join(canghaiRoot, "50_PersonalAgent/stella/runtime-profile.yaml"), "utf8"));
    const compilation = await compileInitializationSource(canghaiRoot, initializationRecipe, { agentId: "probe", hostVersion: host.version,
      contractProfile: profile.contract_profile, requiredCapabilities: profile.capabilities.filter(capability => capability.required).map(capability => capability.id),
      ...(loaded.manifest.extensions?.skillRegistryRef ? { skillRegistryRef: loaded.manifest.extensions.skillRegistryRef } : {}) });
    const request = snapshotTurnRequest({ ...head.scope, prompt: submission.message,
      senderId: snapshot.authority.senderId, senderIsOwner: snapshot.authority.senderIsOwner, chatType: "direct" }, sent.runId);
    const createAuthority = async () => {
      const reader = await CatalogReader.load(canghaiRoot, catalogPath);
      const currentAuthority = { ...snapshot.authority, generationId: reader.catalog.generationId };
      const resolver = new EpisodeEvidenceResolver(reader, { ...snapshot.authority.purpose,
        evidenceCutoff: new Date().toISOString(), trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
      async () => { throw new Error("History view probe does not perform semantic source selection"); });
      return new HostContextAuthority(resolver, request, { authority: currentAuthority,
        configurationHash: snapshot.configurationHash, compilation, historyVerificationKey: contextKeys.verificationKey,
        captureCurrent: async () => ({ request, modelRef: snapshot.authority.modelRef, deployment: snapshot.authority.deployment,
          purpose: snapshot.authority.purpose, generationId: (await CatalogReader.load(canghaiRoot, catalogPath)).catalog.generationId,
          configurationHash: snapshot.configurationHash, compilation }) });
    };
    const authority = await createAuthority();
    const prepared = await authority.prepareHistoryRebuild({ viewId: "session-current-view", archive: prior.archive, current: [],
      complete: async () => ({ text: JSON.stringify({ summary: "SYNTHETIC_CORRECTED_PREMISE" }), modelRef: probeModel }) });
    if (historyQueuedNoticeProbe) {
      let blocked;
      try {
        blocked = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "agent", "--agent", "probe", "--session-key", sessionKey,
          "--message", "Synthetic direct run that must be blocked", "--json", "--timeout", "30"],
        { cwd: temp, env: gateway.env, timeout: 60_000 });
      } catch (error) { blocked = error; }
      assert.match(`${blocked.stdout}\n${blocked.stderr}`, /Stella Core 需要经过可验证的完成协调入口/);
      assert.equal(providerRequests, 1);
    }
    await client.stopAndWait({ timeoutMs: 2_000 });
    await gateway.stop();
    const durability = new GitCangHaiDurability({ root: canghaiRoot, remote: "origin", branch: "main",
      criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
      onRevision: async current => {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        config.plugins.entries["stella-core"].config.recoveryRevision = current;
        await writeFile(configPath, JSON.stringify(config));
      } });
    const published = await publishPreparedHistoryView(authority, prepared, { signingKey: contextKeys.signingKey,
      durability, reloadAuthority: createAuthority });
    await writeFile(path.join(temp, "published-history-view.json"), JSON.stringify({ viewId: published.viewId, digest: published.digest }));
    const beforeCorrection = await CatalogReader.load(canghaiRoot, catalogPath);
    assert.equal((await loadPublishedHistoryView(beforeCorrection, published.viewId, contextKeys.verificationKey)).digest, published.digest);
    const oldUnderstanding = beforeCorrection.catalog.understandings.find(entry => entry.status === "current");
    assert.ok(oldUnderstanding);
    assert.ok(beforeCorrection.catalog.views.find(view => view.id === published.viewId)?.sourceRefs.some(ref =>
      ref.id === oldUnderstanding.id && ref.version === oldUnderstanding.version), "Published view must depend on the old understanding");
    if (sourceDeletionProbe) {
      const { synchronize } = await import(buildModule("src/canghai/synchronize.js"));
      const { bytesVersion, canonicalJson } = await import(buildModule("src/canghai/content-version.js"));
      const { loadPublishedHistoryArchives, prepareHostHistoryRebuildAdmissions, restorePublishedHistoryView } =
        await import(buildModule("src/openclaw/host-context-view.js"));
      const oldRecord = await beforeCorrection.read(oldUnderstanding, "understandings");
      const sourceRefs = new Map();
      for (const ref of oldRecord.supportRefs) {
        const evidence = await beforeCorrection.read(ref, "evidence");
        sourceRefs.set(canonicalJson(evidence.source), evidence.source);
      }
      assert.ok(sourceRefs.size > 0, "Delete the actual source of the current understanding");
      const deletedPaths = new Set();
      for (const ref of sourceRefs.values()) {
        const source = await beforeCorrection.read(ref, "sources");
        for (const payload of source.payloads) {
          const { bytes } = await beforeCorrection.readPayload(ref, payload.sha256);
          assert.ok(bytes.toString("utf8").includes("SYNTHETIC_CORRECTED_PREMISE"), "The original must carry the removable assertion");
          deletedPaths.add(payload.path);
        }
      }
      const oldArchiveDigest = prior.archive.digest;
      const fromRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
      for (const file of deletedPaths) await rm(path.join(canghaiRoot, file));
      await run("git", ["-C", canghaiRoot, "add", "-u"]);
      await run("git", ["-C", canghaiRoot, "commit", "--quiet", "-m", "Synthetic owner deletes source payload"]);
      const toRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
      await run("git", ["-C", canghaiRoot, "push", "origin", "main"]);
      const rebuildPrompts = [], semanticPrompts = [];
      const ports = { root: canghaiRoot, catalogPath, objectRoot: "30_PersonalData/memory/objects", durability,
        ownerId: snapshot.authority.ownerId, modelRef: probeModel, purpose: { ...snapshot.authority.purpose,
          evidenceCutoff: new Date().toISOString(), trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
        processingAuthority: snapshot.authority, assertProcessingCurrent: async () => {
          assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.contextHistorySignerId,
            snapshot.signerId);
        },
        complete: async ({ prompt }) => {
          semanticPrompts.push(prompt);
          const input = JSON.parse(prompt.split("\n").at(-1));
          return { provider: "stella-guarded", model: "probe", text: JSON.stringify(input.proposalHash
            ? { bindingHash: input.bindingHash, proposalHash: input.proposalHash, valid: true }
            : { bindingHash: input.bindingHash, decisions: input.targets.map(target => ({ ref: target.ref,
              disposition: "withdraw", record: null })), rationale: "The removed source cannot support current understanding." }) };
        },
        viewRebuilds: async (generationId, after, journalPath, context) => {
          await context.assertCurrent();
          const resolver = context.resolver;
          const currentAuthority = { ...snapshot.authority, generationId: resolver.reader.catalog.generationId };
          const fresh = new HostContextAuthority(resolver, request, { authority: currentAuthority, configurationHash: snapshot.configurationHash,
            compilation, historyVerificationKey: contextKeys.verificationKey,
            captureCurrent: async () => { await context.assertCurrent(); return { request, modelRef: probeModel,
              deployment: snapshot.authority.deployment, purpose: snapshot.authority.purpose,
              generationId: resolver.reader.catalog.generationId, configurationHash: snapshot.configurationHash, compilation }; } });
          const archives = await loadPublishedHistoryArchives(resolver.reader, context.before.views.map(view => view.id),
            contextKeys.verificationKey, request.agentId);
          return prepareHostHistoryRebuildAdmissions({ authority: fresh, signingKey: contextKeys.signingKey, catalogPath,
            publicationJournalPath: journalPath, before: context.before, after, archives,
            complete: async ({ prompt }) => {
              assert.ok(!prompt.includes("SYNTHETIC_CORRECTED_PREMISE"), "Removed text must not reach the reconstruction model");
              rebuildPrompts.push(prompt);
              return { text: JSON.stringify({ summary: "SYNTHETIC_POST_DELETE_CURRENT" }), modelRef: probeModel };
            } });
        } };
      const syncRequest = { operationId: "synthetic_source_delete", fromRevision, toRevision,
        expectedGenerationId: beforeCorrection.catalog.generationId };
      const receipt = await synchronize(syncRequest, ports);
      assert.deepEqual(await synchronize(syncRequest, { ...ports, complete: async () => { throw new Error("Synchronization replay must not infer"); },
        viewRebuilds: async () => { throw new Error("History replay must not regenerate"); } }), receipt);
      assert.ok(receipt.removedSourceIds.every(id => [...sourceRefs.values()].some(ref => ref.id === id)));
      assert.equal(receipt.removedSourceIds.length, sourceRefs.size);
      assert.ok(rebuildPrompts.length > 0);
      const synced = await CatalogReader.load(canghaiRoot, catalogPath);
      await assert.rejects(synced.read(oldUnderstanding, "understandings"), /evidence_not_currently_eligible/);
      const current = await loadPublishedHistoryView(synced, published.viewId, contextKeys.verificationKey);
      assert.notEqual(current.digest, published.digest);
      const fresh = await createAuthority();
      const restored = await restorePublishedHistoryView(fresh, current);
      const consumption = await fresh.seal({ system: fresh.publicRules(), messages: [{ role: "user", fragment: restored }] });
      await fresh.assertConsumption(consumption.consumption, consumption.input);
      assert.ok(!JSON.stringify(consumption.input).includes("SYNTHETIC_CORRECTED_PREMISE"));
      sourceDeletion = { receipt, removedSourceIds: receipt.removedSourceIds, deletedPaths: [...deletedPaths],
        originalArchiveRetained: true, requiredViewRebuilt: true, rebuildCalls: rebuildPrompts.length, semanticCalls: semanticPrompts.length,
        replayWithoutInference: true, sourceArchiveDigest: oldArchiveDigest, turns: [] };
      const terminalAdmission = (await readFile(path.join(temp, "completion-dispatch-settled.jsonl"), "utf8"))
        .trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.runId === sent.runId);
      assert.equal(terminalAdmission?.terminal.reason, "completed");
      assert.equal(terminalAdmission.session.status, 'done');
      sourceDeletion.completionStatus = terminalAdmission;
      await writeFile(path.join(temp, "source-deletion.json"), JSON.stringify(sourceDeletion, null, 2));
      await writeFile(path.join(temp, "source-deletion-prompts.json"), JSON.stringify({ semanticPrompts, rebuildPrompts }, null, 2));
      await writeFile(path.join(temp, "source-deletion-phase"), "synchronized");
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
      await connectObserver(); await waitForInitializationReady();
      const restartedSession = (await client.request("sessions.list", {})).sessions.find(session => session.key === sessionKey);
      assert.equal(restartedSession?.status, "done", "Restart must not recover an already completed turn");
      assert.equal(restartedSession.hasActiveRun, false);
      assert.equal(restartedSession.abortedLastRun, false);
      sourceDeletion.restartedSession = restartedSession;
      const beforeHistory = await client.request("chat.history", { sessionKey });
      assert.ok(JSON.stringify(beforeHistory).includes("SYNTHETIC_CORRECTED_PREMISE"), "Old native session content must remain present");
      sourceDeletion.nativeSessionRetainedBeforeFollowup = true;
      for (const phase of ["after_delete_sync", "subsequent_turn"]) {
        const beforeRequests = providerRequests;
        let answer;
        try {
          answer = await runExactHostEvaluationChat({ request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
            subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); } },
          { sessionKey, message: "Continue with the currently authorized writing context.", idempotencyKey: `synthetic-source-deletion-${phase}`, timeoutMs: 600_000 });
        } catch (error) {
          sourceDeletion.failure = { phase, category: error.message, modelRequests: providerRequests - beforeRequests,
            events: observedEvents.filter(event => event.event === "chat" && event.payload?.runId === `synthetic-source-deletion-${phase}`),
            sessions: (await client.request("sessions.list", {})).sessions.filter(session => session.key === sessionKey) };
          await writeFile(path.join(temp, "source-deletion.json"), JSON.stringify(sourceDeletion, null, 2));
          throw error;
        }
        assert.equal(answer.text, "SYNTHETIC_MAIN_ANSWER");
        assert.equal(providerRequests - beforeRequests, 1);
        const finalInput = await readFile(path.join(temp, `synthetic-provider-${providerRequests}.json`), "utf8");
        assert.ok(!finalInput.includes("SYNTHETIC_CORRECTED_PREMISE"), "Deleted content must not return through system/messages/tools");
        assert.ok(finalInput.includes("SYNTHETIC_POST_DELETE_CURRENT"));
        let completedSession = (await client.request("sessions.list", {})).sessions.find(session => session.key === sessionKey);
        const settledDeadline = Date.now() + 5_000;
        while (completedSession?.hasActiveRun && Date.now() < settledDeadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          completedSession = (await client.request("sessions.list", {})).sessions.find(session => session.key === sessionKey);
        }
        assert.equal(completedSession?.status, "done");
        assert.equal(completedSession.hasActiveRun, false);
        sourceDeletion.turns.push({ phase, runId: answer.runId, answer: answer.text, modelRequests: 1, oldContentInFinalInput: false,
          currentViewInFinalInput: true, session: completedSession });
        await writeFile(path.join(temp, "source-deletion.json"), JSON.stringify(sourceDeletion, null, 2));
      }
      assert.ok(JSON.stringify(await client.request("chat.history", { sessionKey })).includes("SYNTHETIC_CORRECTED_PREMISE"));
      assert.equal((await readContextHistory(prior.archive, canghaiRoot)).consumptionDigest, snapshot.consumptionDigest);
      assert.equal((await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim(), "");
      sourceDeletion.nativeSessionRetained = true;
      sourceDeletion.sourceRemainsDeleted = (await CatalogReader.load(canghaiRoot, catalogPath)).catalog.sources
        .filter(entry => receipt.removedSourceIds.includes(entry.id)).every(entry => entry.status === "removed");
      assert.equal(sourceDeletion.sourceRemainsDeleted, true);
      await writeFile(path.join(temp, "source-deletion.json"), JSON.stringify(sourceDeletion, null, 2));
    } else {
    gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"),
      diagnosticPrefixes: ["Stella correction preparation failed:", "Stella completion:"] });
    await connectObserver();
    await waitForInitializationReady();
    const second = await runExactHostEvaluationChat({
      request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
      subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
    }, { sessionKey, message: "Synthetic correction: replace the previous writing premise with the new premise.", idempotencyKey: "synthetic-view-correction", timeoutMs: 600_000 });
    const secondTerminal = await client.request("agent.wait", { runId: second.runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
    const rebuildPrompts = await readFile(path.join(temp, "history-rebuild-prompts.jsonl"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const secondRequest = await readFile(path.join(temp, "synthetic-provider-2.json"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const afterCorrection = await CatalogReader.load(canghaiRoot, catalogPath);
    const currentUnderstanding = afterCorrection.catalog.understandings.find(entry => entry.status === "current");
    const currentView = afterCorrection.catalog.views.find(view => view.id === published.viewId);
    const finalRevision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    historyView = { publishedDigest: published.digest, oldUnderstanding: oldUnderstanding.version,
      secondStatus: secondTerminal.status, secondError: secondTerminal.error,
      rebuildCalls: rebuildPrompts.trim() ? rebuildPrompts.trim().split("\n").length : 0,
      finalModelRequestsAfterCorrection: providerRequests - 1,
      newPremiseInFinalInput: secondRequest.includes("SYNTHETIC_NEW_PREMISE"),
      oldPremiseInFinalInput: secondRequest.includes("SYNTHETIC_CORRECTED_PREMISE"),
      finalAnswerDelivered: second.text === "SYNTHETIC_MAIN_ANSWER",
      oldUnderstandingSuperseded: afterCorrection.catalog.understandings.some(entry => entry.id === oldUnderstanding.id &&
        entry.version === oldUnderstanding.version && entry.status === "superseded"),
      oldUnderstandingAbsentFromCurrentView: !currentView?.sourceRefs.some(ref => ref.id === oldUnderstanding.id && ref.version === oldUnderstanding.version),
      newUnderstandingCurrent: Boolean(currentUnderstanding && currentUnderstanding.version !== oldUnderstanding.version),
      rebuiltViewReadable: Boolean(currentView && (await loadPublishedHistoryView(afterCorrection, currentView.id, contextKeys.verificationKey)).digest),
      synchronized: finalRevision === (await run("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(),
      evidenceDirectory: temp };
    if (historyQueuedNoticeProbe) {
      const lifecycle = (await readFile(path.join(temp, "context-lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      historyView.queuedHostFailureProjected = lifecycle.some(event => event.method === "assemble" && event.phase === "enter" &&
        event.prompt?.startsWith("[Queued user message from a previous active turn; preserved as context only."));
    }
    await writeFile(path.join(temp, "history-view-probe.json"), JSON.stringify(historyView, null, 2));
    assert.equal(secondTerminal.status, "ok", JSON.stringify(historyView));
    assert.equal(historyView.rebuildCalls, 1, JSON.stringify(historyView));
    assert.equal(historyView.newPremiseInFinalInput, true, JSON.stringify(historyView));
    assert.equal(historyView.oldPremiseInFinalInput, false, JSON.stringify(historyView));
    for (const key of ["finalAnswerDelivered", "oldUnderstandingSuperseded", "oldUnderstandingAbsentFromCurrentView",
      "newUnderstandingCurrent", "rebuiltViewReadable", "synchronized"]) assert.equal(historyView[key], true, JSON.stringify(historyView));
    if (historyQueuedNoticeProbe) assert.equal(historyView.queuedHostFailureProjected, true, JSON.stringify(historyView));
    if (historyNativeCompactProbe) {
      const beforeCompact = providerRequests;
      let compact;
      try {
        const response = await client.request("sessions.compact", { key: sessionKey, agentId: "probe" }, { timeoutMs: 60_000 });
        compact = { status: "returned", response };
      } catch (error) {
        compact = { status: "error", message: String(error.message), gatewayCode: error.gatewayCode };
      }
      const lifecycle = (await readFile(path.join(temp, "context-lifecycle.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      historyView.nativeCompact = { ...compact, modelRequests: providerRequests - beforeCompact,
        engineEvents: lifecycle.filter(event => event.method === "lazy_compact" || event.method === "compact").map(event => ({
          method: event.method, phase: event.phase, category: event.category,
        })) };
      await writeFile(path.join(temp, "history-view-probe.json"), JSON.stringify(historyView, null, 2));
    }
    if (historyFollowupProbe) {
      await writeFile(path.join(temp, "history-followup-phase"), "ordinary follow-up turns");
      const sessionIdentity = async () => (await client.request("sessions.list", {})).sessions.find(session => session.key === sessionKey)?.sessionId;
      const consume = async (phase, idempotencyKey) => {
        const before = providerRequests;
        let reply;
        try {
          reply = await runExactHostEvaluationChat({
            request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
            subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
          }, { sessionKey, message: "What is the current synthetic writing premise?", idempotencyKey, timeoutMs: 600_000 });
        } catch (error) {
          const failed = observedEvents.filter(event => event.event === "chat" && event.payload?.sessionKey === sessionKey &&
            event.payload?.state === "error").at(-1);
          historyFollowup.turns.push({ phase, status: "error", modelRequests: providerRequests - before,
            hostError: failed?.payload?.errorMessage });
          await writeFile(path.join(temp, "history-followup-probe.json"), JSON.stringify(historyFollowup, null, 2));
          throw error;
        }
        const requests = [];
        for (let index = before + 1; index <= providerRequests; index++) {
          requests.push(await readFile(path.join(temp, `synthetic-provider-${index}.json`), "utf8"));
        }
        const result = { phase, modelRequests: providerRequests - before, finalAnswerDelivered: reply.text === "SYNTHETIC_MAIN_ANSWER",
          newPremiseInFinalInput: requests.every(request => request.includes("SYNTHETIC_NEW_PREMISE")),
          oldPremiseInFinalInput: requests.some(request => request.includes("SYNTHETIC_CORRECTED_PREMISE")) };
        historyFollowup.turns.push(result);
        await writeFile(path.join(temp, "history-followup-probe.json"), JSON.stringify(historyFollowup, null, 2));
        assert.equal(result.modelRequests, 1, JSON.stringify(result));
        assert.equal(result.finalAnswerDelivered, true, JSON.stringify(result));
        assert.equal(result.newPremiseInFinalInput, true, JSON.stringify(result));
        assert.equal(result.oldPremiseInFinalInput, false, JSON.stringify(result));
      };
      historyFollowup = { turns: [], newCommand: null, apiReset: null, restartPreservedSession: false, evidenceDirectory: temp };
      await consume("original_session", "synthetic-view-followup-original");
      const beforeNew = await sessionIdentity();
      const beforeNativeReset = await client.request("stella.syntheticResetEvidence", {});
      assert.ok(beforeNew);
      const beforeCommand = providerRequests;
      const command = await client.request("chat.send", { sessionKey, message: "/new", idempotencyKey: "synthetic-view-new-command" });
      const commandTerminal = await client.request("agent.wait", { runId: command.runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
      const afterNew = await sessionIdentity();
      const afterNativeReset = await client.request("stella.syntheticResetEvidence", {});
      historyFollowup.newCommand = { status: commandTerminal.status, modelRequests: providerRequests - beforeCommand,
        sessionIdRetained: afterNew === beforeNew, resetBoundaryIncreased: afterNativeReset.resets === beforeNativeReset.resets + 1,
        lifecycleRevisionChanged: afterNativeReset.lifecycleRevision !== beforeNativeReset.lifecycleRevision };
      await writeFile(path.join(temp, "history-followup-probe.json"), JSON.stringify(historyFollowup, null, 2));
      assert.equal(commandTerminal.status, "ok", JSON.stringify(historyFollowup.newCommand));
      assert.equal(historyFollowup.newCommand.modelRequests, 0, JSON.stringify(historyFollowup.newCommand));
      assert.equal(historyFollowup.newCommand.sessionIdRetained, true, JSON.stringify(historyFollowup.newCommand));
      assert.equal(historyFollowup.newCommand.resetBoundaryIncreased, true, JSON.stringify(historyFollowup.newCommand));
      assert.equal(historyFollowup.newCommand.lifecycleRevisionChanged, true, JSON.stringify(historyFollowup.newCommand));
      await consume("after_native_new", "synthetic-view-followup-native-new");
      const reset = await client.request("sessions.reset", { key: sessionKey, reason: "new" });
      historyFollowup.apiReset = { sessionIdRetained: await sessionIdentity() === beforeNew,
        lifecycleRevisionReported: typeof reset.entry?.lifecycleRevision === "string" };
      await writeFile(path.join(temp, "history-followup-probe.json"), JSON.stringify(historyFollowup, null, 2));
      assert.equal(historyFollowup.apiReset.sessionIdRetained, true, JSON.stringify(historyFollowup.apiReset));
      assert.equal(historyFollowup.apiReset.lifecycleRevisionReported, true, JSON.stringify(historyFollowup.apiReset));
      await consume("after_api_reset", "synthetic-view-followup-reset");
      const beforeRestart = await sessionIdentity();
      await client.stopAndWait({ timeoutMs: 2_000 });
      await gateway.stop();
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs"),
        diagnosticPrefixes: ["Stella correction preparation failed:", "Stella completion:"] });
      await connectObserver();
      await waitForInitializationReady();
      historyFollowup.restartPreservedSession = await sessionIdentity() === beforeRestart;
      assert.equal(historyFollowup.restartPreservedSession, true, JSON.stringify(historyFollowup));
      await consume("after_restart", "synthetic-view-followup-restart");
      const summaries = await readFile(path.join(temp, "history-summary-prompts.jsonl"), "utf8");
      historyFollowup.summaryCalls = summaries.trim().split("\n").length;
      assert.ok(historyFollowup.summaryCalls > 0, JSON.stringify(historyFollowup));
      await writeFile(path.join(temp, "history-followup-probe.json"), JSON.stringify(historyFollowup, null, 2));
    }
  }
  }
  let nativeReset;
  if (nativeNewPassThrough) {
    const before = await client.request("stella.syntheticResetEvidence", {});
    const beforeRequests = providerRequests;
    const command = await client.request("chat.send", { sessionKey, message: "/new", idempotencyKey: "synthetic-reset-prototype" });
    const commandTerminal = await client.request("agent.wait", { runId: command.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
    const after = await client.request("stella.syntheticResetEvidence", {});
    const call = JSON.parse(await readFile(path.join(temp, "native-new-pass-through.json"), "utf8"));
    nativeReset = { commandStatus: commandTerminal.status, commandError: commandTerminal.error,
      modelRequests: providerRequests - beforeRequests, sessionIdRetained: after?.sessionId === before?.sessionId,
      lifecycleRevisionChanged: after?.lifecycleRevision !== before?.lifecycleRevision,
      resetBoundaryIncreased: after.resets === before.resets + 1, nativeCommand: call };
    assert.equal(nativeReset.modelRequests, 0, JSON.stringify(nativeReset));
    assert.equal(nativeReset.resetBoundaryIncreased, true, JSON.stringify(nativeReset));
    assert.equal(nativeReset.lifecycleRevisionChanged, true, JSON.stringify(nativeReset));
  }
  let coreConsolidation;
  if (consolidationProbe) {
    const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
    const reader = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
    const selected = reader.catalog.evidence.find(entry => entry.status === "current");
    assert.ok(selected);
    const evidenceRef = { id: selected.id, version: selected.version };
    const evidence = await reader.read(evidenceRef, "evidence"), source = await reader.read(evidence.source, "sources");
    const payload = source.payloads.find(value => value.sha256 === evidence.payloadSha256);
    assert.ok(payload && !payload.revision);
    const selectedPayload = path.join(canghaiRoot, payload.path);
    await writeFile(path.join(temp, "consolidation-selected-payload.json"), JSON.stringify({ path: selectedPayload, sha256: payload.sha256 }));
    const params = { operationId: "synthetic_consolidation", request: "Organize these retained observations without inflating owner intent.", evidenceRefs: [evidenceRef] };
    const before = providerRequests;
    const catalogBefore = await readFile(path.join(canghaiRoot, "30_PersonalData/memory/catalog.json"), "utf8");
    coreConsolidation = { caseVersion: "core-consolidation:guarded-generation,restart-consumption,invalidation:v1", scenario: consolidationCase,
      nativeDreamingExecuted: false, externalModelCalls: 0, model: "loopback-synthetic" };
    if (["-source-stale", "-revoked"].includes(consolidationCase)) {
      await assert.rejects(client.request("stella.consolidateMemory", params, { timeoutMs: 330_000 }),
        consolidationCase === "-source-stale" ? /correction_model_failed|source_unavailable|source_dirty/ : /personal_context_access_changed|correction_model_failed/);
      assert.equal(providerRequests - before, 1, "Invalidation after proposal cannot reach independent verification or publication");
      assert.equal(await readFile(path.join(canghaiRoot, "30_PersonalData/memory/catalog.json"), "utf8"), catalogBefore);
      coreConsolidation.invalidatedBeforePublication = true;
    } else {
      if (consolidationCase === "-recovery") {
        await assert.rejects(client.request("stella.consolidateMemory", params, { timeoutMs: 330_000 }), /critical_sync_failed|durability|memory_consolidation_failed/);
        await assert.rejects((await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json")).assertCurrent(), /memory_transaction_pending/);
        await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", remote]);
        await client.stopAndWait({ timeoutMs: 2000 }); await gateway.stop();
        gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
        await connectObserver();
      }
      const published = await client.request("stella.consolidateMemory", params, { timeoutMs: 330_000 });
      assert.equal(providerRequests - before, 2, "Exactly proposal and independent verification use real guarded transport; recovery must not regenerate");
      const current = await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json");
      assert.notEqual(current.catalog.generationId, reader.catalog.generationId);
      const candidate = await current.read(published.changeRef, "changes");
      const target = await current.read(candidate.targetRefs[0], "understandings");
      assert.equal(target.kind, "hypothesis"); assert.equal(target.status, "candidate"); assert.equal(target.scope.global, false);
      assert.ok(target.dependencyRefs.some(ref => ref.id === evidenceRef.id && ref.version === evidenceRef.version));
      const revision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
      assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim(), revision);
      const replay = await client.request("stella.consolidateMemory", params, { timeoutMs: 330_000 });
      assert.equal(replay.generationId, published.generationId); assert.equal(providerRequests - before, 2);
      await client.stopAndWait({ timeoutMs: 2000 }); await gateway.stop();
      await writeFile(path.join(temp, "consolidation-followup-phase"), "No owner correction in subsequent consumption");
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
      await connectObserver(); await waitForInitializationReady();
      const consumed = await runExactHostEvaluationChat({ request: (method, data) => client.request(method, data, { timeoutMs: 35_000 }),
        subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); } },
      { sessionKey: "agent:probe:consolidation-consumer", message: "Use the current writing context.", idempotencyKey: "consolidation-consumer", timeoutMs: 300_000 });
      assert.equal(consumed.text, "SYNTHETIC_MAIN_ANSWER");
      assert.ok((await readFile(path.join(temp, `synthetic-provider-${providerRequests}.json`), "utf8")).includes("SYNTHETIC_CORE_CONSOLIDATED_CANDIDATE"));
      const requestsBeforeDeletion = providerRequests;
      await rm(selectedPayload);
      const denied = await client.request("chat.send", { sessionKey: "agent:probe:consolidation-after-deletion", message: "Use the current writing context.", idempotencyKey: "consolidation-after-deletion" });
      const terminal = await client.request("agent.wait", { runId: denied.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
      assert.equal(terminal.status, "error", JSON.stringify(terminal));
      assert.equal(providerRequests, requestsBeforeDeletion, "Deleted source cannot reach the final model through the new candidate");
      Object.assign(coreConsolidation, { generationBound: true, exactSourceBound: true, criticalSynchronized: true,
        guardedGenerationRequests: 2, replayRegenerated: false, recovered: consolidationCase === "-recovery",
        restartFinalConsumptionVerified: true, deletedSourceFinalCalls: 0 });
    }
    await writeFile(path.join(temp, "core-consolidation.json"), JSON.stringify(coreConsolidation, null, 2));
  }
  let standaloneCompaction;
  if (standaloneCompactProbe) {
    const before = providerRequests;
    const response = await client.request("sessions.compact", { key: sessionKey, agentId: "probe" }, { timeoutMs: 60_000 });
    standaloneCompaction = { compactionModel: "synthetic-compaction/probe", response, modelRequests: providerRequests - before };
    await writeFile(path.join(temp, "standalone-compaction.json"), JSON.stringify(standaloneCompaction, null, 2));
    assert.equal(standaloneCompaction.modelRequests, 0, JSON.stringify(standaloneCompaction));
    assert.equal(response.ok, false, JSON.stringify(standaloneCompaction));
    assert.equal(response.compacted, false, JSON.stringify(standaloneCompaction));
    assert.equal(response.reason, "host_context_compaction_not_admitted", JSON.stringify(standaloneCompaction));
    const repeated = await client.request("sessions.compact", { key: sessionKey, agentId: "probe" }, { timeoutMs: 60_000 });
    assert.equal(repeated.reason, "host_context_compaction_not_admitted", JSON.stringify(repeated));
    assert.equal(providerRequests, before, "Repeated refusal must not quarantine the engine into legacy");
    await writeFile(path.join(temp, "history-followup-phase"), "ordinary follow-up turn after refused compaction");
    const followup = await runExactHostEvaluationChat({
      request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
      subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
    }, { sessionKey, message: "Synthetic follow-up after refused compaction", idempotencyKey: "after-refused-compaction", timeoutMs: 120_000 });
    standaloneCompaction.repeated = repeated;
    standaloneCompaction.followup = { answer: followup.text, modelRequests: providerRequests - before };
    await writeFile(path.join(temp, "standalone-compaction.json"), JSON.stringify(standaloneCompaction, null, 2));
    assert.equal(followup.text, "SYNTHETIC_MAIN_ANSWER", JSON.stringify(followup));
    assert.equal(standaloneCompaction.followup.modelRequests, 1);
    const sessionId = (await client.request("sessions.list", {})).sessions.find(session => session.key === sessionKey)?.sessionId;
    assert.ok(sessionId);
    let visitor;
    try {
      await new Promise((resolve, reject) => {
        visitor = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
          env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.read"],
          sharedStateMode: "read-only", deviceIdentity: null, onHelloOk: resolve, onConnectError: reject });
        visitor.start();
      });
      await assert.rejects(visitor.request("stella.compactHistory", { sessionKey, sessionId }, { timeoutMs: 15_000 }), /operator.admin/);
      standaloneCompaction.visitorDenied = true;
    } finally { await visitor?.stopAndWait({ timeoutMs: 2_000 }); }
    if (!standaloneCompactGrantDenied) await assert.rejects(client.request("stella.compactHistory", { sessionKey, sessionId: "unbound-session" }, { timeoutMs: 60_000 }),
        /host_context_completed_archive_required/);
    const catalogFile = path.join(canghaiRoot, "30_PersonalData/memory/catalog.json");
    const catalogBefore = await readFile(catalogFile, "utf8");
    const revisionBefore = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
    if (standaloneCompactGrantDenied) {
      await assert.rejects(client.request("stella.compactHistory", { sessionKey, sessionId }, { timeoutMs: 60_000 }),
        /operator_history_compaction_grant_required/);
      assert.equal(providerRequests - before, 1, "Missing explicit grant must cause zero summary-model requests");
      assert.equal(await readFile(catalogFile, "utf8"), catalogBefore);
      standaloneCompaction.explicitGrantDenied = true;
    } else if (standaloneCompactPersistFailure) {
      await assert.rejects(client.request("stella.compactHistory", { sessionKey, sessionId }, { timeoutMs: 330_000 }),
        /host_context_compaction_publication_failed/);
      const { CatalogReader } = await import(buildModule("src/canghai/catalog-reader.js"));
      await assert.rejects((await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json")).assertCurrent(), /memory_transaction_pending/);
      assert.ok(await readFile(path.join(canghaiRoot, ".stella-memory-transaction.json")), "Failed synchronization must preserve the transaction fence");
      standaloneCompaction.failedPublicationFenced = true;
    } else if (standaloneCompactStale) {
      await assert.rejects(client.request("stella.compactHistory", { sessionKey, sessionId }, { timeoutMs: 330_000 }),
        /host_context_rebuild_model_failed|source_dirty/);
      assert.equal(await readFile(catalogFile, "utf8"), catalogBefore, "Invalidated summary cannot publish a view");
      assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), revisionBefore);
      standaloneCompaction.staleSourceRejected = true;
      standaloneCompaction.publishedViewsAfterInvalidation = 0;
      standaloneCompaction.invalidation = JSON.parse(await readFile(path.join(temp, "standalone-source-invalidation.json"), "utf8"));
    } else {
      const authorized = await client.request("stella.compactHistory", { sessionKey, sessionId }, { timeoutMs: 330_000 });
      assert.equal(authorized.ok, true, JSON.stringify(authorized));
      assert.equal(authorized.compacted, true, JSON.stringify(authorized));
      standaloneCompaction.authorized = authorized;
      const revision = (await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim();
      assert.notEqual(revision, revisionBefore);
      assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim(), revision);
      assert.equal(JSON.parse(await readFile(catalogFile, "utf8")).generationId, JSON.parse(catalogBefore).generationId,
        "Compaction must not invent a new source generation");
      standaloneCompaction.durableRevision = revision;
      await client.stopAndWait({ timeoutMs: 2_000 });
      await gateway.stop();
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
      await connectObserver();
      await waitForInitializationReady();
      const beforeFollowup = providerRequests;
      const consumed = await runExactHostEvaluationChat({
        request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
        subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
      }, { sessionKey, message: "Synthetic follow-up after authorized compaction", idempotencyKey: "after-authorized-compaction", timeoutMs: 300_000 });
      assert.equal(consumed.text, "SYNTHETIC_MAIN_ANSWER");
      assert.equal(providerRequests - beforeFollowup, 1);
      assert.ok((await readFile(path.join(temp, `synthetic-provider-${providerRequests}.json`), "utf8")).includes("SYNTHETIC_COMPACTED_HISTORY"),
        "Actual main-model input after restart must consume the signed compacted view");
      standaloneCompaction.restartConsumptionVerified = true;
    }
    standaloneCompaction.summaryModelRequests = standaloneCompactGrantDenied ? 0 : 1;
    await writeFile(path.join(temp, "standalone-compaction.json"), JSON.stringify(standaloneCompaction, null, 2));
  }
  const report = { schemaVersion: "stella.main-plugin-probe/v1", host: host.version, nativeCompletionLifecycle,
    scope: nativeCompletionLifecycle ? "diagnostic only: isolated Core adapter bytes changed; original Host untouched; not source or package acceptance" : nativeArtifactProbe ? "real native artifact from a separate original Host run; replayed through the public prompt hook into actual Stella main; synthetic model and semantic setup, not native plugins co-running with Stella" : liveFragment ? "synthetic sources; real Gemini fragment access/output judgments and native Host skill/tool selection; setup routing/correction judgments injected; not private main or full_memory acceptance" : cancellationProbe
    ? `synthetic managed ${preparationCancellationProbe ? "preparation" : "generation"} cancelled through chat.abort; no subsequent business write or late answer delivery; preparation may already be synchronized`
    : correctionProbe ? "synthetic Host input custody and learning before final generation; injected semantic judgments"
    : outcomeProbe
    ? "synthetic owner-bound original evidence; actual main outcome transaction, candidate LearningChange, OpenClaw pointer and local bare remote; semantic verdicts injected, not private/model accuracy proof"
    : questionProbe ? "synthetic original evidence reaches actual main final-generation model input; structured evidence judgment injected; not private or model accuracy proof"
    : managed
    ? "synthetic managed no-prediction advice; actual main v2 archive, Episode writes, OpenClaw pointer and local bare remote; structured router injected"
    : "synthetic read-only ordinary turn; structured router injected; actual main registration and completion adapter",
    ...(fragmentProbe ? { fragmentSkill: fragmentChecks } : {}), ...(liveEvidence ? { liveEvidence } : {}),
    managedContextProbe, guardedProvider, guardedActive, guardedPayload, semanticProviderRequests, coreConsolidation, terminalStatus: terminal.status, providerRequests, userMessages: messages.filter((message) => message.role === "user").length,
    finalAnswers: messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length,
    provesSourceOutputRejection: outputRejectionProbe, provesCorrectionPersistence: correctionProbe && !failureProbe && !cancellationProbe && !guardedStale && !guardedPayload, provesCorrectionRecovery: correctionRecoveryProbe, provesV2Persistence: managed && !correctionProbe && !questionProbe && !cancellationProbe && (!failureProbe || recoveryProbe), provesFailureIsolation: outcomeHistoryRecoveryProbe || failureProbe || cancellationProbe || guardedStale || guardedPayload,
    provesOutcomeRecovery: outcomeHistoryRecoveryProbe || recoveryProbe && outcomeProbe, provesAdviceEvidenceRecovery: adviceTailProbe, admissionReplay,
    initialization: { providerReceivedInitialization, hostIdentityVerified: true, restrictedVerification: initializationVerification,
      skillBodyRead: fragmentProbe ? fragmentChecks.skillBodyRead : skillReadProbe ? providerReceivedSkillBody : "not_exercised",
      ownerRequestedReinitialization: skillReadProbe ? providerReceivedInitializationResult : "not_exercised", scope: "host_bootstrap" },
    ...(questionProbe ? { providerReceivedOriginalEvidence, provesQuestionBundlePersistence: managed, provesQuestionRecovery: questionRecoveryProbe } : {}), persistence,
    ...(sourceDeletion ? { sourceDeletion } : {}), ...(outcomeHistory ? { outcomeHistory } : {}), ...(standaloneCompaction ? { standaloneCompaction } : {}), ...(historyView ? { historyView } : {}), ...(historyFollowup ? { historyFollowup } : {}), ...(nativeReset ? { nativeReset } : {}), evidenceDirectory: temp };
  if (guardedSemantic) assert.ok(semanticProviderRequests > 0);
  assert.equal(report.terminalStatus, failureProbe || cancellationProbe || guardedStale || guardedPayload ? "error" : "ok");
  if (!guardedDreaming) {
    const currentConfig = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(currentConfig.plugins.entries["memory-core"].config.dreaming.enabled, false);
    const cron = await client.request("cron.list", { includeDisabled: true });
    assert.ok(!cron.jobs.find(job => job.declarationKey === "memory-core:memory-dreaming-promotion")?.enabled,
      "Dreaming promotion cron must stay disabled");
    report.dreamingEnabled = false;
  }
  if (guardedActive) {
    const plugins = await client.request("plugins.list", {});
    assert.ok(plugins.plugins.some(plugin => plugin.id === "active-memory" && plugin.installed && plugin.enabled));
    let observations = [];
    try { observations = (await readFile(path.join(temp, "active-hooks.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.ok(observations.length > 0, "The Host must issue genuine post-policy tool authority");
    assert.ok(observations.every(row => row.fragmentAllowed === true && row.readAllowed === false));
    assert.equal(nativeRecallRequests, 3);
    assert.equal(nativeFragmentRead, true);
    assert.equal(nativeSummaryConsumed, !nativeActiveStale);
    report.nativeActiveMemory = { scope: "synthetic exact Host consumption", verified: true, loaded: true,
      postPolicyHookInvocations: observations.length, nativeRecallRequests, nativeFragmentRead, nativeSummaryConsumed,
      ...(nativeActiveStale ? { staleSourceRejected: true, mainModelRequestsAfterInvalidation: 0 } : {}),
      dreamingEnabled: false };
  }
  assert.equal(report.providerRequests, consolidationProbe ? ["-source-stale", "-revoked"].includes(consolidationCase) ? 2 : 4 : nativeActiveStale ? 3 : nativeArtifactProbe || guardedPayload ? 0 : guardedStale ? 1 : liveFragment || correctionRecoveryProbe ? 0 : guardedActive ? 4 : fragmentProbe ? 6 : skillReadProbe ? 3 : sourceDeletionProbe ? 3 : historyFollowupProbe ? 6 : historyViewProbe ? 2 + (historyView?.nativeCompact?.modelRequests ?? 0) : outcomeHistoryProbe ? 3 : standaloneCompactGrantDenied ? 2 : standaloneCompactStale || standaloneCompactPersistFailure ? 3 : standaloneCompactProbe ? 4 : 1);
  if (skillReadProbe && !guardedStale && !guardedPayload) assert.equal(providerReceivedSkillBody, true, JSON.stringify(observedSkillResult));
  if (skillReadProbe && !guardedStale && !guardedPayload) assert.equal(providerReceivedInitializationResult, true, JSON.stringify(observedSkillResult));
  if (!liveFragment && !preparationCancellationProbe && !correctionRecoveryProbe && !guardedPayload && !nativeArtifactProbe) assert.equal(providerReceivedInitialization, true, JSON.stringify(initializationInputEvidence));
  // Preparation cancellation precedes the Host user transcript append.
  assert.equal(report.userMessages, preparationCancellationProbe || correctionRecoveryProbe ? 0 : 1);
  assert.equal(report.finalAnswers, failureProbe || cancellationProbe || guardedStale || guardedPayload ? 0 : 1);
  if (guardedPayload) {
    assert.ok(gateway.diagnostics().includes("host_memory_payload_transform_unbound"), "Must fail at the actual payload gate, not an unrelated admission failure");
    report.payloadTransform = { nativeExtraBodyExecuted: true, unboundPayloadSent: false, modelRequests: providerRequests };
  }
  if (questionProbe) assert.equal(providerReceivedOriginalEvidence, true);
  if (guardedDreaming) {
    let job;
    for (let attempt = 0; attempt < 30; attempt++) {
      const jobs = await client.request("cron.list", { includeDisabled: true });
      job = jobs.jobs.find(candidate => candidate.declarationKey === "memory-core:memory-dreaming-promotion");
      if (job) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(job, "Native memory-core must create its own managed Dreaming job");
    const before = providerRequests;
    const started = await client.request("cron.run", { id: job.id, mode: "force" });
    assert.equal(started.enqueued, true);
    let finished;
    for (let attempt = 0; attempt < 60; attempt++) {
      const runs = await client.request("cron.runs", { id: job.id, limit: 5 });
      finished = runs.entries.find(entry => entry.runId === started.runId && entry.action === "finished");
      if (finished) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(finished, "Native Dreaming must finish, not merely be enqueued");
    const written = (await readFile(path.join(workspace, "MEMORY.md"), "utf8")).includes("SYNTHETIC_UNBOUND_DREAMING_SOURCE");
    assert.equal(written, true, "Exercise native fallback materialization, not an empty Dreaming run");
    const followup = await client.request("chat.send", { sessionKey, message: "Synthetic next turn after native Dreaming", idempotencyKey: "after-native-dreaming" });
    const next = await client.request("agent.wait", { runId: followup.runId, timeoutMs: 60_000 });
    assert.equal(next.status, "error", JSON.stringify(next));
    const initialization = await client.request("stella.initialize", { action: "status" });
    assert.equal(initialization.state, "blocked", JSON.stringify(initialization));
    assert.equal(initialization.category, "projection_drift", JSON.stringify(initialization));
    assert.equal(providerRequests, before, "Neither native subruns nor the next turn may consume the unbound projection");
    const runs = (await readFile(path.join(temp, "native-runs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const nativeSubruns = runs.filter(run => run.sessionKey?.startsWith("agent:probe:dreaming-narrative-"));
    assert.ok(nativeSubruns.length > 0, "Observe actual Host-created Dreaming subruns");
    report.nativeDreaming = { scope: "diagnostic", verified: false, managedJobExecuted: true,
      schedulerStatus: finished.status, nativeSubruns: nativeSubruns.length, unboundProjectionWritten: written,
      nextTurnStatus: next.status, nextTurnBlocker: initialization.category, modelRequestsAfterDreaming: providerRequests - before,
      coreGenerationBound: false, sourceEligibilityBound: false };
  }
  await writeFile(path.join(temp, "main-completion.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  process.stderr.write(JSON.stringify({ initializationProbe: temp, events: observedEvents.filter((event) => event.event === "chat"), diagnostics: gateway?.diagnostics() }) + "\n");
  throw error;
} finally {
  providerRelease.resolve();
  await client?.stopAndWait({ timeoutMs: 2_000 });
  await gateway?.stop();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  assert.ok(coreSnapshot.startsWith(path.join(snapshotParent, "main-probe-build-")));
  await rm(coreSnapshot, { recursive: true, force: true });
}
}
await verifyMain();
