import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { createFixture, initializeFixtureRepository } from "../.test-dist/tests/consciousness-fixture.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = path.join(root, "node_modules/openclaw");
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const questionRecoveryProbe = process.argv.includes("--question-recovery");
const recoveryProbe = process.argv.includes("--outcome-recovery") || questionRecoveryProbe;
const failureProbe = process.argv.includes("--outcome-persist-failure") || recoveryProbe;
const outcomeProbe = process.argv.includes("--outcome") || failureProbe && !questionRecoveryProbe;
const questionProbe = process.argv.includes("--question-evidence") || process.argv.includes("--question-durable") || questionRecoveryProbe;
const managed = process.argv.includes("--managed") || outcomeProbe || process.argv.includes("--question-durable") || questionRecoveryProbe;
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-main-completion-"));
const canghaiRoot = await createFixture();
let outcomeSeed;
let outcomePurpose;
async function verifyQuestionBundle(reader, requestId, revision, remote, remoteRevision) {
  const { loadEvidenceBundle } = await import("../dist/src/praxis/evidence-bundle.js");
  const { EpisodeEvidenceResolver } = await import("../dist/src/praxis/episode-evidence.js");
  const { bytesVersion } = await import("../dist/src/canghai/content-version.js");
  assert.equal(reader.catalog.bundles.length, 1);
  const entry = reader.catalog.bundles[0];
  const resolver = new EpisodeEvidenceResolver(reader, { ...outcomePurpose, evidenceCutoff: new Date().toISOString(),
    trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No new semantic judgment during readback"); });
  const loaded = await loadEvidenceBundle(resolver, { bundleRef: { id: entry.id, version: entry.version }, requestId, revision, generationId: reader.catalog.generationId });
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
  const { loadEvidenceBundle } = await import("../dist/src/praxis/evidence-bundle.js");
  const { EpisodeEvidenceResolver } = await import("../dist/src/praxis/episode-evidence.js");
  assert.equal(reader.catalog.bundles.length, 1);
  const entry = reader.catalog.bundles[0];
  const resolver = new EpisodeEvidenceResolver(reader, { ...outcomePurpose, evidenceCutoff: new Date().toISOString(),
    trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("Readback is not a new action judgment"); });
  const loaded = await loadEvidenceBundle(resolver, { bundleRef: { id: entry.id, version: entry.version }, requestId, revision,
    generationId: reader.catalog.generationId });
  assert.equal(loaded.bundle.suggestedResponseKind, "outcome_ack");
  assert.equal(loaded.originalEvidence.length, 1);
  assert.equal(loaded.originalEvidence[0].role, "owner");
  assert.equal(loaded.bundle.claims.find((claim) => claim.id === "candidate-strategy").kind, "proposal");
  const remoteBundle = JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${entry.locator.path}`])).stdout);
  assert.deepEqual(remoteBundle, loaded.bundle);
}
if (outcomeProbe || questionProbe) {
  const { loadConsciousness } = await import("../dist/src/canghai/manifest.js");
  const { loadPraxisRuntimeBinding, createBoundPraxisRuntime } = await import("../dist/src/praxis/runtime-binding.js");
  const { prepareHostInputArchive } = await import("../dist/src/canghai/host-input-archive.js");
  const { persistHostInputArchive } = await import("../dist/src/canghai/archive-writer.js");
  const { CatalogReader } = await import("../dist/src/canghai/catalog-reader.js");
  const { memoryRoutingRef } = await import("../dist/src/praxis/runtime-memory.js");
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
      recoveryPriority: "important", historicalInputRefs: [], provenance: {}, situation: { summary: "Synthetic weekend invitation", domains: ["social"], observations: [] } },
    decision: { recommendation: "Ask for a suitable weekend time", rationale: [] } });
  outcomeSeed = { episodeId, episodeRef: memoryRoutingRef({ id: episodeId, version: advised.version }, runtime.repository.historicalPath(episodeId, advised.version)),
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
  if (failureProbe) await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", path.join(temp, "intentionally-missing-remote.git")]);
}
const state = path.join(temp, "state");
const plugin = path.join(temp, "plugin");
const workspace = path.join(temp, "workspace");
await Promise.all([state, plugin, workspace].map((directory) => mkdir(directory)));
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic isolated main plugin probe. No tools or private data.\n");
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "stella-main-probe", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
await writeFile(path.join(plugin, "openclaw.plugin.json"), await readFile(path.join(root, "openclaw.plugin.json")));
await writeFile(path.join(plugin, "index.mjs"), `
import main from ${JSON.stringify(pathToFileURL(path.join(root, "dist/src/plugin.js")).href)};
const seed = ${JSON.stringify(outcomeProbe ? outcomeSeed : null)};
export default { ...main, register(api) {
  main.register({ ...api, runtime: { ...api.runtime, llm: { ...api.runtime.llm,
    async complete(params) {
      if (params.purpose === 'stella-core-open-episode-selection') return { text: JSON.stringify({ openEpisodeRef: null }) };
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
let providerRequests = 0;
let providerReceivedOriginalEvidence = false;
const provider = createServer(async (request, response) => {
  providerRequests++;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks).toString('utf8');
  providerReceivedOriginalEvidence ||= requestBody.includes("Synthetic owner report: I asked about the weekend time. My friend confirmed Saturday.") &&
    requestBody.includes("stella.evidence-bundle/v1");
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
async function connectObserver() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Synthetic main observer timeout")), 15_000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); }, onConnectError() { clearTimeout(timeout); reject(new Error("Synthetic main observer failed")); },
      onEvent(event) { observedEvents.push(event); },
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
  const sent = await client.request("chat.send", { sessionKey, message: questionProbe ? "What did my friend confirm about the weekend?" : "Synthetic main plugin question", idempotencyKey: "synthetic-main" });
  const terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60_000 });
  const history = await client.request("chat.history", { sessionKey, limit: 10 });
  const messages = history.messages ?? [];
  assert.equal(terminal.status, failureProbe ? "error" : "ok", JSON.stringify(terminal));
  let persistence;
  if (failureProbe) {
    const { CatalogReader } = await import("../dist/src/canghai/catalog-reader.js");
    await assert.rejects((await CatalogReader.load(canghaiRoot, "30_PersonalData/memory/catalog.json")).assertCurrent(), /memory_transaction_pending/);
    assert.equal((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim(), revision);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["stella-core"].config.recoveryRevision, revision);
    assert.equal(observedEvents.filter((event) => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
    assert.equal(observedEvents.filter((event) => event.event === "chat" && event.payload?.runId === sent.runId && event.payload?.state === "error").length, 1);
    persistence = { synchronized: false, pendingTransactionFenced: true, remoteUnchanged: true, nativeFailureWithoutDraft: true };
    if (recoveryProbe) {
      await client.stopAndWait({ timeoutMs: 2_000 });
      await gateway.stop();
      await run("git", ["-C", canghaiRoot, "remote", "set-url", "origin", remote]);
      gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
      await connectObserver();
      const { bytesVersion } = await import("../dist/src/canghai/content-version.js");
      const operationId = `${questionProbe ? "question" : "outcome"}_${bytesVersion(sent.runId).slice(7)}`;
      const method = questionProbe ? "stella.recoverQuestionEvidence" : "stella.recoverOutcome";
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
      const episode = JSON.parse(await readFile(path.join(canghaiRoot, `30_PersonalData/praxis/episodes/${outcomeSeed.episodeId}/episode.json`), "utf8"));
      assert.equal(episode.status, questionProbe ? "recommended" : "closed");
      if (!questionProbe) assert.equal((await reader.read(episode.learning.praxis[0], "understandings")).status, "candidate");
      const afterRecovery = await client.request("chat.history", { sessionKey, limit: 10 });
      assert.equal(afterRecovery.messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
      assert.equal(observedEvents.filter((event) => JSON.stringify(event).includes("SYNTHETIC_MAIN_ANSWER")).length, 0);
      await (questionProbe ? verifyQuestionBundle : verifyOutcomeBundle)(reader, sent.runId, revision, remote, remoteRevision);
      persistence.recovery = { hostRestarted: true, synchronized: true, pointerConfirmed: true, replyResent: false, evidenceBundleSynchronized: true };
    }
  } else if (questionProbe && managed) {
    const { CatalogReader } = await import("../dist/src/canghai/catalog-reader.js");
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
    const { bytesVersion } = await import("../dist/src/canghai/content-version.js");
    const recordPath = `30_PersonalData/praxis/episodes/${outcomeSeed?.episodeId ?? `praxis_${bytesVersion(sent.runId).slice(7)}`}/episode.json`;
    const localEpisode = JSON.parse(await readFile(path.join(canghaiRoot, recordPath), "utf8"));
    const remoteEpisode = JSON.parse((await run("git", ["--git-dir", remote, "show", `${remoteRevision}:${recordPath}`])).stdout);
    assert.deepEqual(remoteEpisode, localEpisode);
    assert.equal(localEpisode.schemaVersion, "stella.praxis-episode/v2");
    assert.equal(localEpisode.status, outcomeProbe ? "closed" : "recommended");
    assert.equal(localEpisode.twin?.prediction, undefined);
    if (outcomeProbe) {
      assert.equal(localEpisode.actual.occurredAt, null);
      assert.equal(localEpisode.learning.praxis.length, 1);
      const { CatalogReader } = await import("../dist/src/canghai/catalog-reader.js");
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
    } else assert.equal(localEpisode.actual, undefined);
    assert.equal(localRevision, remoteRevision);
    assert.equal(actualConfig.plugins.entries["stella-core"].config.recoveryRevision, remoteRevision);
    assert.notEqual(remoteRevision, revision);
    persistence = { schemaVersion: localEpisode.schemaVersion, status: localEpisode.status, synchronized: true, pointerConfirmed: true,
      actualInvented: false, predictionInvented: false, ...(outcomeProbe ? { strategyStatus: "candidate", learningChangeSynchronized: true, evidenceBundleSynchronized: true } : {}) };
  }
  const report = { schemaVersion: "stella.main-plugin-probe/v1", host: host.version, scope: outcomeProbe
    ? "synthetic owner-bound original evidence; actual main outcome transaction, candidate LearningChange, OpenClaw pointer and local bare remote; semantic verdicts injected, not private/model accuracy proof"
    : questionProbe ? "synthetic original evidence reaches actual main final-generation model input; structured evidence judgment injected; not private or model accuracy proof"
    : managed
    ? "synthetic managed no-prediction advice; actual main v2 archive, Episode writes, OpenClaw pointer and local bare remote; structured router injected"
    : "synthetic read-only ordinary turn; structured router injected; actual main registration and completion adapter",
    terminalStatus: terminal.status, providerRequests, userMessages: messages.filter((message) => message.role === "user").length,
    finalAnswers: messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("SYNTHETIC_MAIN_ANSWER")).length,
    provesV2Persistence: managed && !questionProbe && (!failureProbe || recoveryProbe), provesFailureIsolation: failureProbe,
    provesOutcomeRecovery: recoveryProbe && !questionProbe,
    ...(questionProbe ? { providerReceivedOriginalEvidence, provesQuestionBundlePersistence: managed, provesQuestionRecovery: questionRecoveryProbe } : {}), persistence, evidenceDirectory: temp };
  await writeFile(path.join(temp, "main-completion.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.terminalStatus, failureProbe ? "error" : "ok");
  assert.equal(report.providerRequests, 1);
  assert.equal(report.userMessages, 1);
  assert.equal(report.finalAnswers, failureProbe ? 0 : 1);
  if (questionProbe) assert.equal(providerReceivedOriginalEvidence, true);
} finally {
  await client?.stopAndWait({ timeoutMs: 2_000 });
  await gateway?.stop();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
