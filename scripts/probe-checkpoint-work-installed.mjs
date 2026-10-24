import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes, createHash, generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { probeHost, isolatedProbeCommand, onProbeCancellation } from "./lib/isolated-probe-host.mjs";

// Execute once through the standard package runner's isolated environment after
// its new package exists. Stock Host loads the installed Core directly. Model
// responses are synthetic; the between-session correction is a labelled trusted
// Core call, not a Host automatic-learning/owner-correction trigger.
const root = await realpath(process.cwd());
assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).name, "@tower1229/stella-core");
const art = await realpath(process.env.STELLA_WORK_ARTIFACTS ?? process.env.STELLA_V3_ARTIFACTS);
assert.ok(art.startsWith(path.join(root, ".artifacts") + path.sep));
const attempt = process.env.STELLA_WORK_ATTEMPT ?? process.env.STELLA_V3_ATTEMPT ?? "a1";
assert.match(attempt, /^a[0-9]+$/);
const compiled = await realpath(process.env.STELLA_AGENT_SUPPLY_COMPILED ?? path.join(root, ".test-dist"));
assert.ok(compiled === path.join(root, ".test-dist") || compiled.startsWith(path.join(root, ".artifacts") + path.sep));
const installed = await realpath(process.env.STELLA_AGENT_SUPPLY_PACKAGE_ROOT ?? path.join(art, "consumer/node_modules/@tower1229/stella-core"));
assert.match(path.relative(art, installed), /^consumer(?:-a[0-9]+)?\/node_modules\/@tower1229\/stella-core$/);
const state = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH;
for (const directory of [state, process.env.HOME, process.env.OPENCLAW_HOME, process.env.TMPDIR, process.env.XDG_CACHE_HOME]) {
  assert.ok(directory && path.isAbsolute(directory) && directory.startsWith(art + path.sep) && await realpath(directory) === directory,
    "Host HOME/state/tmp/cache must already exist in the canonical project artifact directory");
}
assert.equal(process.env.HOME, process.env.OPENCLAW_HOME);
assert.ok(process.env.TMPDIR.startsWith(state + path.sep) && process.env.XDG_CACHE_HOME.startsWith(state + path.sep));
assert.ok(configPath && path.dirname(configPath) === state && path.basename(configPath) === "openclaw.json");
const configStat = await lstat(configPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
assert.ok(!configStat || configStat.isFile() && !configStat.isSymbolicLink() && configStat.nlink === 1);
for (const key of ["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_CRON", "OPENCLAW_NO_AUTO_UPDATE"]) assert.equal(process.env[key], "1");
if (process.argv.includes("--preflight-only")) { console.log("isolated installed work probe path preflight passed; no Host started"); process.exit(0); }
assert.equal(process.argv.length, 2);
const out = path.join(art, "host-work-" + attempt); await mkdir(out, { mode: 0o700 });
const ownerPath = path.join(art, "host-work-owner.json");
await writeFile(ownerPath, JSON.stringify({ pid: process.pid, attempt, startedAtUtc: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
const result = { schemaVersion: "stella.checkpoint-work-installed/v1", passed: false, startedAtUtc: new Date().toISOString(),
  scope: "installed Core + stock OpenClaw public Agent/runtime.llm.complete + synthetic loopback only; trusted direct correction is separate",
  fullMemoryAccepted: false, realModelAccepted: false, realMainAccepted: false, automaticCorrectionAccepted: false,
  requests: [], allHttpRequests: [], cases: [], events: [], gatewayRuns: [], trustedCorrectionCalls: [] };
const save = () => writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
const trace = (name, data = {}) => appendFileSync(path.join(out, "trace.jsonl"), JSON.stringify({ atUtc: new Date().toISOString(), name, ...data }) + "\n");
const execute = promisify(execFile);
const git = async (directory, ...args) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false", "-C", directory, ...args], { timeout: 15000 })).stdout.trim();
const toolOutputs = input => input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output)
  .map(part => typeof part.functionResponse.response.output === "string" ? JSON.parse(part.functionResponse.response.output) : part.functionResponse.response.output);
const editableWork = ["kind", "status", "goal", "sourceRefs", "confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"];
let source, provider, child, client, writer, cleanupPromise, activeCase, agentStep = 0, expectedWork, expectedAuthority, expectedGeneration;
onProbeCancellation(signal => { result.cancelled = signal; result.passed = false; }, cleanup);
try {
  const host = await probeHost(root); const { GatewayClient, hostRoot, openclawBin } = host; result.hostIdentity = host.evidence;
  const fixture = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-work-fixture.js")));
  const { createCheckpointWorkSource, WORK_ID, WORK_GOAL_A, WORK_GOAL_B, WORK_CORRECTION, WORK_MODEL, WORK_QUESTIONS } = fixture;
  const { SUPPLY_MARKER, BOOTSTRAP_MARKER } = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-agent-supply-fixture.js")));
  const fromPackage = name => import(pathToFileURL(path.join(installed, "dist/src", name + ".js")));
  const { createCheckpointPluginRuntime, parseCheckpointPluginConfig } = await fromPackage("openclaw/checkpoint-plugin-runtime");
  const { CatalogReader } = await fromPackage("canghai/catalog-reader");
  const { EpisodeEvidenceResolver } = await fromPackage("praxis/episode-evidence");
  const { loadPersonalContextAccess, createPersonalContextAccess } = await fromPackage("canghai/personal-context-access");
  const { snapshotTurnRequest } = await fromPackage("openclaw/turn-request");
  const { bindProcessingAuthority, resolveDeploymentDigest } = await fromPackage("openclaw/processing-authority");
  const installedMetadata = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedMetadata.name, "@tower1229/stella-core");
  const buildIdentityBytes = await readFile(path.join(installed, "dist/build-identity.json"));
  const buildIdentity = JSON.parse(buildIdentityBytes); assert.match(buildIdentity.coreRevision, /^[a-f0-9]{40}$/); assert.equal(buildIdentity.sourceClean, true);
  let artifact = process.env.STELLA_WORK_PACKAGE_ARTIFACT;
  if (!artifact) {
    const candidates = (await readdir(art)).filter(name => /^tower1229-stella-core-[^/]+\.tgz$/.test(name));
    assert.equal(candidates.length, 1, "Select the exact existing Core tarball with STELLA_WORK_PACKAGE_ARTIFACT"); artifact = path.join(art, candidates[0]);
  }
  artifact = await realpath(artifact); assert.ok(artifact.startsWith(art + path.sep));
  const artifactBytes = await readFile(artifact), artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const lockBytes = await readFile(path.join(installed, "../../../package-lock.json")), lock = JSON.parse(lockBytes);
  const installedIntegrity = lock.packages["node_modules/@tower1229/stella-core"].integrity;
  assert.equal(installedIntegrity, "sha512-" + createHash("sha512").update(artifactBytes).digest("base64"));
  const installedFiles = ["dist/src/plugin.js", "dist/src/openclaw/checkpoint-plugin-runtime.js", "dist/src/openclaw/checkpoint-agent-supply.js", "dist/src/openclaw/checkpoint-source-access.js"];
  result.installation = { packageRoot: installed, root: installed, entry: path.join(installed, "dist/src/plugin.js"),
    directHostLoad: true, observerWrapper: false, artifact, artifactSha256, packageIntegrity: installedIntegrity,
    consumerLockSha256: createHash("sha256").update(lockBytes).digest("hex"), buildIdentity,
    buildIdentitySha256: createHash("sha256").update(buildIdentityBytes).digest("hex"),
    inspectedFiles: await Promise.all(installedFiles.map(async file => ({ path: file, sha256: createHash("sha256").update(await readFile(path.join(installed, file))).digest("hex") }))),
    fullInstalledTreeVerifiedByThisProbe: false };
  source = await createCheckpointWorkSource();
  assert.ok(source.root.startsWith(process.env.TMPDIR + path.sep) && await realpath(source.root) === source.root);
  result.source = { root: source.root, initialRevision: source.revision, manifestPath: "50_PersonalAgent/stella/manifest.yaml",
    catalogPath: source.catalogPath, workRef: source.workRef, schema: "stella.ongoing-work/v1", requesterIds: ["cli"], viewProcessingModelRefs: [WORK_MODEL] };
  const workspace = path.join(out, "workspace"), authority = path.join(out, "authority");
  for (const directory of [workspace, authority]) await mkdir(directory, { mode: 0o700 });
  const policyVerdict = binding => ({ requestHash: binding.requestHash, sourceRef: binding.sourceRef, policyRef: binding.policyRef,
    applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
    ruleChecks: binding.accessRules.map(rule => ({ id: rule.id, satisfied: true })) });
  provider = createServer(async (request, response) => {
    const http = { index: result.allHttpRequests.length + 1, method: request.method, path: request.url, atUtc: new Date().toISOString() };
    result.allHttpRequests.push(http);
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const index = result.requests.length + 1; assert.ok(index <= 24, "bounded work probe exceeded 24 captured requests");
      await writeFile(path.join(out, `provider-${index}.json`), body);
      const entry = { index, kind: "unclassified", case: activeCase, method: request.url, bytes: Buffer.byteLength(body), atUtc: http.atUtc };
      result.requests.push(entry); trace("provider_request", entry);
      assert.equal(request.method, "POST"); assert.match(request.url, /\/gemini-3\.8-flash:(?:streamGenerateContent|generateContent)(?:\?|$)/);
      const input = JSON.parse(body), texts = input.contents.flatMap(item => item.parts ?? []).map(part => part.text).filter(value => typeof value === "string");
      const policyPrompt = texts.find(value => value.startsWith("Judge the semantic relationship between this request and exactly this source."));
      const viewPrompt = texts.find(value => value.startsWith("Select request-local Stella USER and MEMORY views."));
      let parts;
      if (policyPrompt) {
        entry.kind = "source-policy"; const binding = JSON.parse(policyPrompt.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(binding.request, WORK_QUESTIONS[activeCase === "before" ? 0 : 1]);
        assert.ok(!body.includes(SUPPLY_MARKER) && !body.includes("SYNTHETIC_WORK_CORRECTION_ORIGINAL_7296"), "source judgment must receive metadata, not original payload");
        assert.equal(binding.purpose.readPurpose, source.binding.purpose.readPurpose); assert.equal(binding.purpose.deliveryScope, source.binding.purpose.deliveryScope);
        entry.requestHash = binding.requestHash; entry.sourceRef = binding.sourceRef; parts = [{ text: JSON.stringify(policyVerdict(binding)) }];
      } else if (viewPrompt) {
        entry.kind = "view-selector"; const binding = JSON.parse(viewPrompt.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(binding.question, WORK_QUESTIONS[activeCase === "before" ? 0 : 1]);
        assert.equal(binding.candidates.length, 1); const candidate = binding.candidates[0];
        assert.equal(candidate.group, "works"); assert.equal(candidate.record.id, WORK_ID); assert.deepEqual(candidate.record, expectedWork.record);
        assert.deepEqual(candidate.ref, expectedWork.ref); assert.ok(candidate.originals.length >= 1);
        assert.equal(candidate.record.confirmedPremises[0].acceptance, "confirmed"); assert.equal(candidate.record.candidateIdeas[0].acceptance, "proposed");
        assert.equal(candidate.record.rejectedInterpretations[0].acceptance, "rejected"); assert.equal(candidate.record.openQuestions[0].material, true);
        entry.requestHash = binding.requestHash; entry.selectedWork = candidate.ref;
        parts = [{ text: JSON.stringify({ requestHash: binding.requestHash, selections: [{ handle: candidate.handle, view: "memory" }] }) }];
      } else {
        entry.kind = "agent"; assert.ok(activeCase === "before" || activeCase === "after");
        assert.ok(JSON.stringify(input.tools).includes("stella_memory_data"));
        assert.ok(!body.includes(SUPPLY_MARKER) && !body.includes("SYNTHETIC_WORK_CORRECTION_ORIGINAL_7296"), "Candidate originals must not leak into the Agent request");
        const phase = ++agentStep; entry.phase = phase;
        if (phase === 1) parts = [{ functionCall: { name: "stella_memory_data", args: { action: "work" } } }];
        else {
          assert.equal(phase, 2); const supplied = toolOutputs(input).filter(value => Array.isArray(value.works)).at(-1); assert.ok(supplied);
          assert.deepEqual(Object.keys(supplied).sort(), ["currentMemory", "exclusions", "generation", "usageConstraints", "works"]);
          assert.deepEqual(supplied.works, [expectedWork]); assert.deepEqual(Object.keys(supplied.works[0]).sort(), ["record", "ref"]);
          assert.deepEqual(supplied.usageConstraints, [{ work: expectedWork.ref, policies: [{
            policyRef: source.binding.archive.policyRef, quotePolicy: "summarize_only",
            rules: [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }],
          }] }], "The exact current work must retain its source interpretation and quotation constraints without originals");
          assert.deepEqual(supplied.exclusions, {}); assert.equal(supplied.generation, expectedGeneration);
          assert.equal(supplied.currentMemory.checkpointRevision, expectedAuthority.revision);
          assert.equal(supplied.currentMemory.checkpointToken, expectedAuthority.token);
          for (const forbidden of ["originals", "context", "understandings"]) assert.ok(!Object.hasOwn(supplied, forbidden) && !Object.hasOwn(supplied.works[0], forbidden));
          if (activeCase === "after") assert.ok(!body.includes(WORK_GOAL_A), "new session must consume the corrected current work, not the old goal");
          entry.workVerified = expectedWork.ref; entry.checkpointRevision = supplied.currentMemory.checkpointRevision;
          parts = [{ text: `SYNTHETIC_WORK_${activeCase === "before" ? "A" : "B"}_ANSWER_7296: ${expectedWork.record.goal}; keep proposals provisional, rejected readings rejected and questions open.` }];
        }
      }
      await save();
      const output = { responseId: `synthetic-work-${index}`, modelVersion: "gemini-3.8-flash", candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      if (request.url.includes("streamGenerateContent")) { response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify(output)}\n\n`); }
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output)); }
    } catch (error) { result.providerError ??= String(error.stack ?? error); await save(); response.statusCode = 500; response.end("synthetic work protocol assertion failed"); }
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const allocator = net.createServer(); await new Promise(resolve => allocator.listen(0, "127.0.0.1", resolve));
  const gatewayPort = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const token = randomBytes(32).toString("hex");
  const config = { logging: { level: "debug", file: path.join(out, "gateway.log") }, gateway: { mode: "local" },
    memory: { search: { enabled: false } }, hooks: { internal: { enabled: false, entries: { "session-memory": { enabled: false } } } },
    commands: { ownerAllowFrom: ["*"] },
    agents: { ownership: "explicit", defaults: { model: { primary: WORK_MODEL, fallbacks: [] }, thinkingDefault: "low" },
      entries: { synthetic: { workspace, identity: { name: `${BOOTSTRAP_MARKER}_IDENTITY.md`, theme: "Isolated synthetic work acceptance", emoji: "🧪" } } } },
    models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${provider.address().port}`,
      models: [{ id: "gemini-3.8-flash", name: "Synthetic Google loopback", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } },
    plugins: { slots: { memory: "none" }, allow: ["stella-core", "google"], load: { paths: [installed] },
      entries: { "memory-core": { enabled: false }, "stella-core": { enabled: true, hooks: { allowConversationAccess: true },
        config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: source.root,
          dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools" } } } }, tools: { allow: ["stella_memory_data"] } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  result.configuration = { path: configPath, sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    model: WORK_MODEL, thinking: "low", providerBaseUrl: config.models.providers.google.baseUrl,
    conversationHooks: "existing synthetic-only authorization", extraLlmPermissions: false, requestArchive: false };
  // Forward only the package runner's public allow-list, never provider secrets,
  // proxy settings, real Host locations, user npmrc or process-wide preloads.
  const env = Object.fromEntries(["PATH", "LANG", "HOME", "TMPDIR", "XDG_CACHE_HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",
    "NODE_DISABLE_COMPILE_CACHE", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
    "GIT_ALLOW_PROTOCOL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_CRON", "OPENCLAW_NO_AUTO_UPDATE", "GITHUB_ACTIONS"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { OPENCLAW_GATEWAY_PORT: String(gatewayPort), OPENCLAW_GATEWAY_TOKEN: token });
  const launch = await isolatedProbeCommand({ root, out, state, home: process.env.OPENCLAW_HOME, hostRoot,
    args: [openclawBin, "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--auth", "token", "--port", String(gatewayPort), "--ws-log", "compact"] });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deviceId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" }).subarray(-32)).digest("hex");
  const deviceIdentity = { deviceId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
  result.syntheticClientIdentity = { deviceId, privateKeyStorage: "memory_only", clientDeviceAuthTokenPersistence: false,
    clientName: "cli", mode: "cli", sourceRequesterId: "cli", humanProfileClaimed: false };
  const stopGateway = async () => {
    client?.stop(); client = undefined; if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
    result.gateway.exitCode = child.exitCode; result.gateway.signalCode = child.signalCode;
    child = undefined; await save(); assert.equal(result.gateway.exitCode, 0); assert.equal(result.gateway.signalCode, null);
  };
  const startGateway = async () => {
    child = spawn(launch.command, launch.args, { cwd: out, env, stdio: ["ignore", "pipe", "pipe"] });
    result.gateway = { startIndex: result.gatewayRuns.length, pid: child.pid, port: gatewayPort, command: [launch.command, ...launch.args], sandboxed: launch.sandboxed, isolation: launch.isolation };
    result.gatewayRuns.push(result.gateway); await save();
    let output = ""; const capture = chunk => { output += String(chunk); appendFileSync(path.join(out, "gateway-live.log"), chunk); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); clearInterval(interval); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("isolated_gateway_start_timeout")), 45000);
      const interval = setInterval(() => output.includes("stella-core failed to load") ? finish(new Error("installed_plugin_load_failed")) : output.includes("[gateway] ready") ? finish() : undefined, 100);
      child.once("error", finish); child.once("exit", code => finish(new Error(`isolated_gateway_exited_${code}`)));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("isolated_gateway_connect_timeout")), 15000);
      client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"],
        sharedStateMode: "read-only", deviceIdentity, hostDeps: { loadDeviceAuthToken: () => null, storeDeviceAuthToken() {}, clearDeviceAuthToken() {} },
        onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); }, onEvent(event) { result.events.push(event); } }); client.start();
    });
  };
  await startGateway();
  result.initialized = await client.request("stella.checkpoint", { action: "initialize", revision: source.revision, operationId: "synthetic-work-installed-init" });
  try { result.materialization = await client.request("stella.checkpoint", { action: "materialize" }); }
  catch (error) {
    assert.match(String(error), /(?:skill_unavailable_or_shadowed|host_identity_reload_pending)$/);
    const pending = await readFile(path.join(authority, "initialization/pending.json"), "utf8"), plan = JSON.parse(pending);
    assert.equal(plan.sourceRevision, source.revision); await writeFile(path.join(out, "initialization-pending-before-refresh.json"), pending);
    result.initializationRefresh = { refusal: String(error), originalOperationId: plan.operationId, method: "one normal restart of this same isolated Gateway; config/source/state unchanged" };
    await stopGateway(); await startGateway(); result.materialization = await client.request("stella.checkpoint", { action: "materialize" });
    assert.equal(result.materialization.materialized.receipt.operationId, plan.operationId);
  }
  assert.equal(result.materialization.materialized.receipt.files.length, 6); assert.equal(result.materialization.consumed, false);
  assert.equal(result.materialization.capabilities.full_memory, false);
  const currentWork = async () => {
    const reader = await CatalogReader.load(source.root, source.catalogPath), ref = reader.currentRef(WORK_ID, "works");
    return { work: { ref, record: await reader.read(ref, "works") }, generation: reader.catalog.generationId };
  };
  const runCase = async (id, question, expectedGoal) => {
    activeCase = id; agentStep = 0; const start = result.requests.length;
    const current = await currentWork(); expectedWork = current.work; expectedGeneration = current.generation;
    const before = await client.request("stella.checkpoint", { action: "status" }); expectedAuthority = before.authority;
    assert.equal(expectedWork.record.goal, expectedGoal); assert.equal(before.capabilities.full_memory, false);
    const sessionKey = `agent:synthetic:work-${id}`;
    const created = await client.request("sessions.create", { key: sessionKey, agentId: "synthetic", idempotencyKey: `synthetic-work-create-${id}` });
    assert.equal(created.ok, true); assert.ok(!created.runStarted && !created.runId);
    trace("user_request", { id, sessionKey, revision: expectedAuthority.revision, workRef: expectedWork.ref });
    const sent = await client.request("chat.send", { sessionKey, message: question, idempotencyKey: `synthetic-work-${id}` });
    const terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
    const status = await client.request("stella.checkpoint", { action: "status" }), history = await client.request("chat.history", { sessionKey, limit: 30 });
    const end = result.requests.length; // Freeze this case before any later callback or shutdown request.
    result.cases.push({ id, created, sent, terminal, status, history, expectedWork, expectedGeneration,
      firstProviderIndex: start + 1, lastProviderIndex: end }); await save();
    assert.equal(result.providerError, undefined); assert.equal(terminal.status, "ok"); assert.equal(agentStep, 2);
    assert.equal(status.authority.revision, expectedAuthority.revision); assert.equal(status.authority.token, expectedAuthority.token);
    assert.equal(status.capabilities.full_memory, false); assert.ok(JSON.stringify(history).includes(`SYNTHETIC_WORK_${id === "before" ? "A" : "B"}_ANSWER_7296`));
    const requests = result.requests.slice(start, end);
    assert.equal(requests.filter(value => value.kind === "agent").length, 2); assert.equal(requests.filter(value => value.kind === "view-selector").length, 1);
    assert.ok(requests.some(value => value.kind === "source-policy")); assert.equal(requests.filter(value => value.workVerified).length, 1);
  };
  await runCase("before", WORK_QUESTIONS[0], WORK_GOAL_A);
  trace("trusted_core_correction_start", { trigger: "direct installed runtime.correctLocal, not Host event" });
  const checkpointConfig = parseCheckpointPluginConfig(config.plugins.entries["stella-core"].config);
  writer = await createCheckpointPluginRuntime(checkpointConfig, host.evidence.version);
  const recovery = await writer.capture(), reader = await CatalogReader.load(source.root, source.catalogPath);
  const processing = await loadPersonalContextAccess(source.root, source.grantPath), signal = new AbortController().signal;
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-work-trusted-core-correction",
    sessionKey: "agent:synthetic:work-trusted-core-correction", prompt: WORK_CORRECTION, senderId: "cli", senderIsOwner: true, chatType: "direct" }, "synthetic-work-trusted-core-correction");
  const processingAuthority = bindProcessingAuthority({ request, ownerId: "owner-fixture", modelRef: WORK_MODEL, purpose: source.binding.purpose,
    generationId: reader.catalog.generationId, deployment: resolveDeploymentDigest({ agentId: "synthetic", recoveryRevision: recovery.expected.revision,
      pluginSource: "installed-synthetic-direct-correction:" + artifactSha256 }) });
  const assertProcessingCurrent = async () => { signal.throwIfAborted(); await processing.assertCurrent(); };
  const sourceAccess = createPersonalContextAccess({ request, modelRef: WORK_MODEL, binding: processing, reuseWithinRequest: true,
    assertRequestCurrent: assertProcessingCurrent, processingAuthority, signal,
    async complete({ prompt }) {
      const binding = JSON.parse(prompt.split("\n").at(-1));
      result.trustedCorrectionCalls.push({ kind: "source-policy-stub", transport: "local callback, not public Host LLM", sourceRef: binding.sourceRef });
      return { text: JSON.stringify(policyVerdict(binding)) };
    } });
  const complete = async ({ prompt }) => {
    const binding = JSON.parse(prompt.split("\n").at(-1)); let value, kind;
    if (binding.bindingHash) { kind = "interpretation-stub"; value = { bindingHash: binding.bindingHash, checks: binding.data.requirements.map(requirement => ({ handle: requirement.handle, satisfied: true })) }; }
    else if (binding.proposalHash) { kind = "verification-stub"; value = { requestHash: binding.requestHash, proposalHash: binding.proposalHash, valid: true }; }
    else {
      kind = "proposal-stub"; const work = binding.candidates.find(candidate => candidate.group === "works" && candidate.record.id === WORK_ID); assert.ok(work);
      value = { requestHash: binding.requestHash, disposition: "update", clarification: null, rationale: "Synthetic exact author correction changes the goal without changing acceptance states.",
        reviewedHandles: binding.candidates.map(candidate => candidate.handle), replacements: [{ handle: work.handle, group: "works",
          record: { ...Object.fromEntries(editableWork.map(field => [field, work.record[field]])), goal: WORK_GOAL_B } }] };
    }
    const index = result.trustedCorrectionCalls.length + 1; result.trustedCorrectionCalls.push({ kind, transport: "local callback, not public Host LLM" });
    await writeFile(path.join(out, `trusted-correction-${index}.json`), JSON.stringify({ kind, prompt, response: value }, null, 2));
    return { provider: "google", model: "gemini-3.8-flash", text: JSON.stringify(value) };
  };
  const resolver = new EpisodeEvidenceResolver(reader, { ...source.binding.purpose, evidenceCutoff: new Date().toISOString(), signal, sourceAccess,
    trustedAdapters: { user_report: ["openclaw-reply-dispatch-2026.8.2", "openclaw-transcript-2026.8.2"], tool_observation: [], system_event: [] } }, complete);
  const wireCountBeforeCorrection = result.requests.length;
  result.correction = { trigger: "trusted installed Core runtime.correctLocal with explicitly synthetic callbacks; not automatic Host learning", expected: recovery.expected,
    result: await writer.correctLocal({ recovery, operationId: "synthetic_installed_work_correction", request: WORK_CORRECTION, ownerId: "owner-fixture",
      modelRef: WORK_MODEL, recordedAt: new Date().toISOString(), evidenceRefs: [source.correctionEvidenceRef], resolver,
      objectRoot: source.binding.archive.objectRoot, processingAuthority, processingGrant: processing, assertProcessingCurrent, complete, signal }) };
  assert.equal(result.requests.length, wireCountBeforeCorrection, "Trusted local correction callbacks must not be counted as real Host/model requests");
  assert.equal(result.correction.result.persistenceStatus, "local_committed"); assert.equal(result.correction.result.disposition, "update");
  assert.notEqual(result.correction.result.authority.revision, recovery.expected.revision); assert.notEqual(result.correction.result.authority.token, recovery.expected.token);
  assert.equal(await git(source.root, "rev-list", "--count", `${source.revision}..HEAD`), "1");
  const updated = await currentWork();
  for (const field of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"]) assert.deepEqual(updated.work.record[field], source.workRecord[field]);
  trace("trusted_core_correction_committed", { revision: result.correction.result.authority.revision, workRef: updated.work.ref });
  writer.close(); writer = undefined;
  await runCase("after", WORK_QUESTIONS[1], WORK_GOAL_B);
  assert.notEqual(result.cases[0].history.sessionId, result.cases[1].history.sessionId);
  result.boundaries = { twoFreshSessions: true, exactOriginalUserQuestionToSelector: true, modelSelectedWork: true,
    completeWorkRecordAndRefReachedNextAgentWire: true, candidateOriginalsNotForwardedToAgent: true, usageConstraintsInFinalAgentWire: true,
    currentWorkAfterTrustedCorrection: true, automaticHostCorrectionClaimed: false, full_memory: false };
  await stopGateway();
  assert.equal(createHash("sha256").update(await readFile(artifact)).digest("hex"), artifactSha256);
  for (const file of result.installation.inspectedFiles) assert.equal(createHash("sha256").update(await readFile(path.join(installed, file.path))).digest("hex"), file.sha256);
  result.passed = true;
} catch (error) { result.error = { message: String(error), stack: error?.stack }; }
finally { await cleanup(); }
async function cleanup() {
  return cleanupPromise ??= (async () => {
    const wasPassing = result.passed && !result.cancelled;
    writer?.close(); client?.stop();
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
      result.gateway.exitCode = child.exitCode; result.gateway.signalCode = child.signalCode;
    }
    for (const gateway of result.gatewayRuns) if (gateway.exitCode !== 0 || gateway.signalCode !== null) { result.passed = false; result.error ??= { message: "A registered synthetic Gateway did not exit normally" }; }
    try {
      if (provider) {
        provider.closeIdleConnections();
        await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      }
      // Only a fully drained provider can close the evidence set. Requests that
      // arrive after a case's frozen last index cannot be counted as its success.
      assert.equal(result.providerError, undefined, "Provider protocol assertion failed before complete drain");
      assert.equal(result.allHttpRequests.length, result.requests.length, "An HTTP request was not fully captured");
      for (const [offset, request] of result.requests.entries()) {
        assert.equal(request.index, offset + 1);
        assert.ok(["agent", "view-selector", "source-policy"].includes(request.kind), `Invalid request kind at ${request.index}: ${request.kind}`);
        const windows = result.cases.filter(test => request.index >= test.firstProviderIndex && request.index <= test.lastProviderIndex);
        assert.equal(windows.length, 1, `Request ${request.index} is late or outside one closed case window`);
        assert.equal(request.case, windows[0].id, `Request ${request.index} has a mismatched case`);
      }
      if (wasPassing) {
        assert.deepEqual(result.cases.map(test => test.id), ["before", "after"]);
        for (const test of result.cases) {
          const requests = result.requests.slice(test.firstProviderIndex - 1, test.lastProviderIndex);
          assert.ok(requests.length > 0); assert.equal(requests.length, test.lastProviderIndex - test.firstProviderIndex + 1);
          assert.equal(requests.filter(value => value.kind === "agent").length, 2, `${test.id}: expected two Agent requests`);
          assert.equal(requests.filter(value => value.kind === "view-selector").length, 1, `${test.id}: expected one selector`);
          assert.ok(requests.some(value => value.kind === "source-policy"), `${test.id}: expected source policy judgment`);
          assert.equal(requests.filter(value => value.workVerified).length, 1, `${test.id}: expected one verified work supply`);
        }
      }
    } catch (error) {
      result.passed = false;
      result.providerDrainError = { message: String(error), stack: error?.stack };
      result.error ??= result.providerDrainError; // Preserve the original failure, if any.
    }
    if (source) { result.sourceFinalRevision = await git(source.root, "rev-parse", "HEAD"); await rm(source.root, { recursive: true, force: true }); result.syntheticSourceRemoved = true; }
    if (result.cancelled) { result.passed = false; result.error ??= { message: `Probe interrupted by ${result.cancelled}` }; }
    result.endedAtUtc = new Date().toISOString(); await save();
    if (JSON.parse(await readFile(ownerPath, "utf8")).pid === process.pid) await rm(ownerPath);
    console.log(JSON.stringify({ passed: result.passed, error: result.error?.message, providerRequests: result.requests.length, result: path.join(out, "result.json") }));
  })();
}
if (!result.passed) process.exitCode = 1;
