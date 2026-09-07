import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFixture, initializeFixtureRepository } from "../.test-dist/tests/consciousness-fixture.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const questionRecoveryProbe = process.argv.includes("--question-recovery");
const admissionReplayProbe = process.argv.includes("--admission-replay");
const cancellationProbe = process.argv.includes("--cancel");
const adviceRevisionProbe = process.argv.includes("--advice-revision") || process.argv.includes("--advice-revision-recovery");
const adviceTailProbe = process.argv.includes("--advice-evidence-recovery") || process.argv.includes("--advice-revision-recovery");
const recoveryProbe = process.argv.includes("--outcome-recovery") || questionRecoveryProbe || adviceTailProbe;
const failureProbe = process.argv.includes("--outcome-persist-failure") || recoveryProbe;
const outcomeProbe = process.argv.includes("--outcome") || failureProbe && !questionRecoveryProbe && !adviceTailProbe;
const questionProbe = process.argv.includes("--question-evidence") || process.argv.includes("--question-durable") || questionRecoveryProbe || admissionReplayProbe;
const managed = process.argv.includes("--managed") || cancellationProbe || adviceRevisionProbe || outcomeProbe || process.argv.includes("--question-durable") || questionRecoveryProbe || adviceTailProbe || admissionReplayProbe;
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-main-completion-"));
// Resolve dependencies from the tested package's consumer, not the development checkout.
const snapshotParent = path.join(packageRoot, ".artifacts");
await mkdir(snapshotParent, { recursive: true });
const coreSnapshot = await mkdtemp(path.join(snapshotParent, "main-probe-build-"));
const coreDist = path.join(coreSnapshot, "dist");
await cp(path.join(packageRoot, "dist"), coreDist, { recursive: true });
await cp(path.join(packageRoot, "schemas"), path.join(coreSnapshot, "schemas"), { recursive: true });
const buildModule = (relative) => pathToFileURL(path.join(coreDist, relative)).href;
const canghaiRoot = await createFixture();
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
const revision = await initializeFixtureRepository(canghaiRoot);
const remote = path.join(temp, "canghai.git");
if (managed) {
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["-C", canghaiRoot, "remote", "add", "origin", remote]);
  await run("git", ["-C", canghaiRoot, "push", "origin", "HEAD:refs/heads/main"]);
  if (failureProbe && !adviceTailProbe) await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", path.join(temp, "intentionally-missing-remote.git")]);
}
const state = path.join(temp, "state");
const plugin = path.join(temp, "plugin");
const workspace = path.join(temp, "workspace");
await Promise.all([state, plugin, workspace].map((directory) => mkdir(directory)));
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic isolated main plugin probe. No tools or private data.\n");
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "stella-main-probe", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
await writeFile(path.join(plugin, "openclaw.plugin.json"), await readFile(path.join(packageRoot, "openclaw.plugin.json")));
await writeFile(path.join(plugin, "index.mjs"), `
import main from ${JSON.stringify(buildModule("src/plugin.js"))};
import { GitCangHaiDurability } from ${JSON.stringify(buildModule("src/canghai/durability.js"))};
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
export default { ...main, register(api) {
  main.register({ ...api, runtime: { ...api.runtime, llm: { ...api.runtime.llm,
    async complete(params) {
      if (params.purpose === 'stella-core-open-episode-selection') return { text: JSON.stringify({ openEpisodeRef: ${JSON.stringify(adviceRevisionProbe ? outcomeSeed.episodeRef : null)} }) };
      if (params.purpose === 'stella-question-evidence') {
        const input = JSON.parse(params.messages[0].content.split('\\n').at(-1));
        return { provider: 'synthetic', model: 'injected', text: JSON.stringify({ status: input.provisionalRoute.evidenceStatus,
          claims: [], unresolvedLeads: input.provisionalRoute.materialUnknowns.map((question) => ({ question, material: true, reason: 'Synthetic unknown' })),
          stoppingReason: 'Synthetic configured source scope', suggestedResponseKind: input.provisionalRoute.responseKind }) };
      }
      if (seed) {
        const result = (value) => ({ text: JSON.stringify(value), provider: 'synthetic', model: 'injected' });
        if (params.purpose === 'stella-core-open-episode-selection') return result({ openEpisodeRef: null });
        if (params.purpose === 'stella-core-semantic-routing') return result({ mode: 'outcome', responseKind: 'outcome_ack', evidenceStatus: 'sufficient', materialUnknowns: [],
          domains: ['social'], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false, outcome: { openEpisodeRef: seed.episodeRef } });
        const prompt = params.messages[0].content;
        if (prompt.startsWith('Prepare a Stella outcome plan')) return result({ disposition: 'ready', actual: seed.actual, outcome: seed.outcome,
          predictionAssessment: 'unresolved', learning: seed.learning });
        if (prompt.startsWith("You are Stella's actual-action evidence verifier")) return result({ supported: true, ...seed.actual, rationale: 'Synthetic injected action verdict' });
        if (prompt.startsWith("You are Stella's reported-outcome evidence verifier")) return result({ supported: true, outcome: seed.outcome, rationale: 'Synthetic injected outcome verdict' });
        throw new Error('Unexpected synthetic completion phase');
      }
      return { text: JSON.stringify(${JSON.stringify(managed && !questionProbe ? {
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
let providerReceivedOriginalEvidence = false;
const provider = createServer(async (request, response) => {
  providerRequests++;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks).toString('utf8');
  providerReceivedOriginalEvidence ||= requestBody.includes("Synthetic owner report: I asked about the weekend time. My friend confirmed Saturday.") &&
    requestBody.includes("stella.evidence-bundle/v1");
  if (cancellationProbe) { providerArrived.resolve(); await providerRelease.promise; }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "synthetic-main", object: "chat.completion", created: 1, model: "probe",
    choices: [{ index: 0, message: { role: "assistant", content: "SYNTHETIC_MAIN_ANSWER" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const configPath = path.join(state, "openclaw.json");
await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" },
  agents: { defaults: { model: { primary: "stella-smoke/probe" } }, entries: { probe: { workspace } } },
  models: { providers: { "stella-smoke": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-local-only",
    api: "openai-completions", models: [{ id: "probe", name: "probe", contextWindow: 32768, maxTokens: 256 }] } } },
  plugins: { allow: ["stella-core"], load: { paths: [plugin] }, entries: { "stella-core": { enabled: true,
    hooks: { allowConversationAccess: true }, config: { canghaiRoot, recoveryRevision: revision, agentId: "probe", dataMode: managed ? "managed_durable_write" : "read_only",
      ...(managed ? { durabilityRemote: "origin", durabilityBranch: "main" } : {}) } } } },
  tools: { deny: ["*"] },
}));
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
try {
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  await connectObserver();
  let direct;
  try {
    direct = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "agent", "--agent", "probe", "--session-key", "agent:probe:direct", "--message", "Synthetic direct probe", "--json", "--timeout", "30"], { cwd: temp, env: gateway.env, timeout: 60_000 });
  } catch (error) { direct = error; }
  assert.equal(providerRequests, 0, "Direct agent execution must not reach the model");
  assert.match(`${direct.stdout}\n${direct.stderr}`, /Stella Core 需要经过可验证的完成协调入口/);
  const sessionKey = "agent:probe:main-completion";
  const submission = { sessionKey, message: questionProbe ? "What did my friend confirm about the weekend?" : "Synthetic main plugin question", idempotencyKey: "synthetic-main" };
  const { runExactHostEvaluationChat } = await import(buildModule("src/acceptance/exact-host-chat.js"));
  const sent = failureProbe || cancellationProbe ? await client.request("chat.send", submission) : await runExactHostEvaluationChat({
    request: (method, params) => client.request(method, params, { timeoutMs: 35_000 }),
    subscribe(listener) { evaluationListeners.add(listener); return () => evaluationListeners.delete(listener); },
  }, submission);
  if (cancellationProbe) {
    let timer;
    try {
      await Promise.race([providerArrived.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic provider did not receive generation")), 15000);
      })]);
    } finally { clearTimeout(timer); }
    const aborted = await client.request("chat.abort", { sessionKey, runId: sent.runId });
    providerRelease.resolve();
    assert.equal(aborted.aborted, true);
  }
  if (!failureProbe && !cancellationProbe) assert.equal(sent.text, "SYNTHETIC_MAIN_ANSWER");
  const terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60_000 });
  const history = await client.request("chat.history", { sessionKey, limit: 10 });
  const messages = history.messages ?? [];
  assert.equal(terminal.status, failureProbe || cancellationProbe ? "error" : "ok", JSON.stringify(terminal));
  let persistence;
  if (cancellationProbe) {
    const events = observedEvents.filter(event => event.event === "chat" && event.payload?.runId === sent.runId);
    assert.equal(events.filter(event => event.payload.state === "final").length, 0);
    assert.ok(events.some(event => ["aborted", "error"].includes(event.payload.state)));
    assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), revision);
    assert.equal((await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim(), "");
    persistence = { cancelledDuringGeneration: true, businessRevisionUnchanged: true, lateProviderAnswerNotDelivered: true };
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
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
      await connectObserver();
      const { bytesVersion } = await import(buildModule("src/canghai/content-version.js"));
      const operationId = `${questionProbe || adviceTailProbe ? "question" : "outcome"}_${bytesVersion(sent.runId).slice(7)}`;
      const method = questionProbe || adviceTailProbe ? "stella.recoverQuestionEvidence" : "stella.recoverOutcome";
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
      const afterRecovery = await client.request("chat.history", { sessionKey, limit: 10 });
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
    gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
    await connectObserver();
    const replay = await client.request("chat.send", submission);
    const replayTerminal = await client.request("agent.wait", { runId: replay.runId, timeoutMs: 60_000 });
    assert.equal(replay.runId, sent.runId);
    assert.equal(replayTerminal.status, "error");
    const coreAdmissionRejected = JSON.stringify(replayTerminal).includes("run_recovery_required");
    const hostSessionRejected = replayTerminal.error === `Error: Session "${sessionKey}" changed while starting work. Retry.`;
    assert.ok(coreAdmissionRejected || hostSessionRejected, "Replay must fail at an identified admission boundary");
    const replayHistory = await client.request("chat.history", { sessionKey, limit: 10 });
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
    for (const notice of notices) assert.equal(messageText(notice),
      "Your message could not be sent: Stella Core 需要经过可验证的完成协调入口，已停止本轮请求。 (blocked by stella-core)");
    assert.ok(notices.length <= 1, "Host must not multiply rejection notices");
    assert.equal((await run("git", ["-C", canghaiRoot, "rev-parse", "HEAD"])).stdout.trim(), beforeReplayRevision);
    assert.equal((await run("git", ["-C", canghaiRoot, "status", "--porcelain"])).stdout.trim(), "");
    assert.equal(replayHistory.messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length, 1);
    assert.equal(observedEvents.filter((event) => event.event === "chat" && event.payload?.runId === sent.runId && event.payload?.state === "final").length, 1);
    assert.equal(providerRequests, 1);
    admissionReplay = { hostRestarted: true, sameRunRejectedBeforeModel: true,
      rejectionLayer: coreAdmissionRejected ? "core_persistent_admission" : "host_session_state",
      duplicateUserMessages: 0, hostRejectionNotices: notices.length, duplicateFinals: 0,
      businessRevisionUnchanged: true };
  }
  const report = { schemaVersion: "stella.main-plugin-probe/v1", host: host.version, scope: cancellationProbe
    ? "synthetic managed generation cancelled through chat.abort; no business write or late answer delivery"
    : outcomeProbe
    ? "synthetic owner-bound original evidence; actual main outcome transaction, candidate LearningChange, OpenClaw pointer and local bare remote; semantic verdicts injected, not private/model accuracy proof"
    : questionProbe ? "synthetic original evidence reaches actual main final-generation model input; structured evidence judgment injected; not private or model accuracy proof"
    : managed
    ? "synthetic managed no-prediction advice; actual main v2 archive, Episode writes, OpenClaw pointer and local bare remote; structured router injected"
    : "synthetic read-only ordinary turn; structured router injected; actual main registration and completion adapter",
    terminalStatus: terminal.status, providerRequests, userMessages: messages.filter((message) => message.role === "user").length,
    finalAnswers: messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length,
    provesV2Persistence: managed && !questionProbe && !cancellationProbe && (!failureProbe || recoveryProbe), provesFailureIsolation: failureProbe || cancellationProbe,
    provesOutcomeRecovery: recoveryProbe && outcomeProbe, provesAdviceEvidenceRecovery: adviceTailProbe, admissionReplay,
    ...(questionProbe ? { providerReceivedOriginalEvidence, provesQuestionBundlePersistence: managed, provesQuestionRecovery: questionRecoveryProbe } : {}), persistence, evidenceDirectory: temp };
  await writeFile(path.join(temp, "main-completion.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.terminalStatus, failureProbe || cancellationProbe ? "error" : "ok");
  assert.equal(report.providerRequests, 1);
  assert.equal(report.userMessages, 1);
  assert.equal(report.finalAnswers, failureProbe || cancellationProbe ? 0 : 1);
  if (questionProbe) assert.equal(providerReceivedOriginalEvidence, true);
} finally {
  providerRelease.resolve();
  await client?.stopAndWait({ timeoutMs: 2_000 });
  await gateway?.stop();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  assert.ok(coreSnapshot.startsWith(path.join(snapshotParent, "main-probe-build-")));
  await rm(coreSnapshot, { recursive: true, force: true });
}
