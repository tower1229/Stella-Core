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

// Stock Host directly loads the installed Core. Three same-owner user requests:
// scoped USER/MEMORY A, cached A -> Agent-selected correction -> B, then B.
// Every semantic completion goes through the public Host to this fake loopback
// provider. No direct writer callback, wrapper, real model or real source is used.
const root = await realpath(process.cwd());
assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).name, "@tower1229/stella-core");
const art = await realpath(process.env.STELLA_UNDERSTANDING_ARTIFACTS ?? process.env.STELLA_V3_ARTIFACTS);
assert.ok(art.startsWith(path.join(root, ".artifacts") + path.sep));
const attempt = process.env.STELLA_UNDERSTANDING_ATTEMPT ?? process.env.STELLA_V3_ATTEMPT ?? "a1";
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
const out = path.join(art, "host-understanding-" + attempt); await mkdir(out, { mode: 0o700 });
const ownerPath = path.join(art, "host-understanding-owner.json");
await writeFile(ownerPath, JSON.stringify({ pid: process.pid, attempt, startedAtUtc: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
const result = { schemaVersion: "stella.checkpoint-understanding-installed/v1", passed: false, startedAtUtc: new Date().toISOString(),
  scope: "installed Core + stock OpenClaw Current Understanding USER/MEMORY and correction tools; public Host semantic calls, same-session synthetic loopback only",
  fullMemoryAccepted: false, realModelAccepted: false, realMainAccepted: false, currentUnderstandingMechanismVerified: false,
  requests: [], allHttpRequests: [], cases: [], events: [], gatewayRuns: [] };
const save = () => writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
const trace = (name, data = {}) => appendFileSync(path.join(out, "trace.jsonl"), JSON.stringify({ atUtc: new Date().toISOString(), name, ...data }) + "\n");
const execute = promisify(execFile);
const git = async (directory, ...args) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false", "-C", directory, ...args], { timeout: 15000 })).stdout.trim();
const toolResponses = input => input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output)
  .map(part => ({ name: part.functionResponse.name, output: typeof part.functionResponse.response.output === "string"
    ? JSON.parse(part.functionResponse.response.output) : part.functionResponse.response.output }));
const editableUnderstanding = ["kind", "status", "statement", "scope", "supportRefs", "counterRefs", "dependencyRefs"];
let source, provider, child, client, cleanupPromise, activeCase, agentStep = 0, round;
onProbeCancellation(signal => { result.cancelled = signal; result.passed = false; }, cleanup);
try {
  const host = await probeHost(root); const { GatewayClient, hostRoot, openclawBin } = host; result.hostIdentity = host.evidence;
  const fixture = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-understanding-fixture.js")));
  const { createCheckpointUnderstandingSource, UNDERSTANDING_IDS, UNDERSTANDING_STATEMENT_A, UNDERSTANDING_STATEMENT_B,
    UNDERSTANDING_HYPOTHESIS, UNDERSTANDING_CORRECTION, UNDERSTANDING_MODEL, UNDERSTANDING_QUESTIONS } = fixture;
  const { SUPPLY_MARKER, BOOTSTRAP_MARKER } = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-agent-supply-fixture.js")));
  const fromPackage = name => import(pathToFileURL(path.join(installed, "dist/src", name + ".js")));
  const { CatalogReader } = await fromPackage("canghai/catalog-reader");
  const { bytesVersion, canonicalJson } = await fromPackage("canghai/content-version");
  const installedMetadata = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedMetadata.name, "@tower1229/stella-core");
  const buildIdentityBytes = await readFile(path.join(installed, "dist/build-identity.json"));
  const buildIdentity = JSON.parse(buildIdentityBytes); assert.match(buildIdentity.coreRevision, /^[a-f0-9]{40}$/); assert.equal(buildIdentity.sourceClean, true);
  let artifact = process.env.STELLA_UNDERSTANDING_PACKAGE_ARTIFACT;
  if (!artifact) {
    const candidates = (await readdir(art)).filter(name => /^tower1229-stella-core-[^/]+\.tgz$/.test(name));
    assert.equal(candidates.length, 1, "Select the exact existing Core tarball with STELLA_UNDERSTANDING_PACKAGE_ARTIFACT"); artifact = path.join(art, candidates[0]);
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
  source = await createCheckpointUnderstandingSource();
  assert.ok(source.root.startsWith(process.env.TMPDIR + path.sep) && await realpath(source.root) === source.root);
  const originalPolicyRef = source.originalPolicyRef, archivePolicyRef = source.archivePolicyRef;
  result.source = { root: source.root, initialRevision: source.revision, manifestPath: "50_PersonalAgent/stella/manifest.yaml",
    catalogPath: source.catalogPath, understandingRefs: source.understandingRefs, schema: "stella.understanding/v1", originalPolicyRef, archivePolicyRef,
    requesterIds: ["cli"], viewProcessingModelRefs: [UNDERSTANDING_MODEL] };
  const workspace = path.join(out, "workspace"), authority = path.join(out, "authority");
  for (const directory of [workspace, authority]) await mkdir(directory, { mode: 0o700 });
  const operations = path.posix.join(path.posix.dirname(source.catalogPath), "operations");
  const operationFiles = async () => (await readdir(path.join(source.root, operations)).catch(error => { if (error.code === "ENOENT") return []; throw error; })).sort();
  const assertHypothesis = actual => {
    assert.deepEqual(actual.ref, source.understandingRefs.hypothesis); assert.deepEqual(actual.record, source.records.hypothesis);
    assert.equal(actual.record.kind, "hypothesis"); assert.equal(actual.record.status, "candidate"); assert.equal(actual.record.statement, UNDERSTANDING_HYPOTHESIS);
  };
  const snapshot = async () => {
    const reader = await CatalogReader.load(source.root, source.catalogPath), status = await client.request("stella.checkpoint", { action: "status" });
    assert.equal(status.capabilities.full_memory, false); assert.equal(status.authority.revision, await git(source.root, "rev-parse", "HEAD"));
    assert.equal(reader.catalog.works.length, 0);
    const understandings = {};
    for (const name of ["owner", "hypothesis"]) {
      const ref = reader.currentRef(UNDERSTANDING_IDS[name], "understandings");
      understandings[name] = { ref, record: await reader.read(ref, "understandings") };
    }
    assert.equal(understandings.owner.record.kind, "owner_statement"); assert.equal(understandings.owner.record.status, "active");
    assert.deepEqual(understandings.owner.record.scope, source.records.owner.scope); assertHypothesis(understandings.hypothesis);
    return { authority: status.authority, status, catalog: reader.catalog, understandings, files: await operationFiles() };
  };
  const inspectArchivedInput = async current => {
    const old = new Set(round.before.catalog.sources.map(ref => ref.id));
    const candidates = current.catalog.sources.filter(entry => entry.status === "current" && !old.has(entry.id));
    assert.equal(candidates.length, 1, "Exactly one source must be archived for the current user request");
    const entry = candidates[0], stored = JSON.parse(await readFile(path.join(source.root, entry.locator.path), "utf8"));
    assert.equal(stored.origin.adapterId, "openclaw-reply-dispatch-2026.8.2"); assert.equal(stored.origin.collectionId, round.sessionKey);
    assert.deepEqual(stored.policyRef, archivePolicyRef);
    const payload = JSON.parse(await readFile(path.join(source.root, stored.payloads[0].path), "utf8"));
    assert.equal(payload.schemaVersion, "stella.host-request-snapshot/v1"); assert.equal(payload.request.prompt, round.input);
    assert.equal(payload.request.senderId, "cli"); assert.equal(payload.request.senderIsOwner, true); assert.equal(payload.request.chatType, "direct");
    const sourceRef = { id: entry.id, version: entry.version }, evidence = [];
    for (const item of current.catalog.evidence.filter(value => value.status === "current")) {
      const object = JSON.parse(await readFile(path.join(source.root, item.locator.path), "utf8"));
      if (object.source.id === sourceRef.id && object.source.version === sourceRef.version) evidence.push({ id: item.id, version: item.version });
    }
    assert.equal(evidence.length, 1);
    return { sourceRef, evidenceRef: evidence[0], runId: payload.request.runId, requestHash: payload.request.requestHash, policyRef: archivePolicyRef };
  };
  const assertCurrentMemory = (actual, current) => {
    assert.deepEqual(Object.keys(actual).sort(), ["checkpointRevision", "checkpointToken", "userRequest"]);
    assert.equal(actual.userRequest, round.archive.runId); assert.equal(actual.checkpointRevision, current.authority.revision);
    assert.equal(actual.checkpointToken, current.authority.token);
  };
  const assertUnderstandingResult = async (supplied, statement) => {
    const current = await snapshot(); assert.equal(current.understandings.owner.record.statement, statement);
    assert.deepEqual(Object.keys(supplied).sort(), ["currentMemory", "exclusions", "generation", "understandings", "usageConstraints"]);
    assert.equal(supplied.understandings.length, 2); assert.deepEqual(supplied.exclusions, {}); assert.equal(supplied.generation, current.catalog.generationId);
    const expected = [{ view: "user", ...current.understandings.owner }, { view: "memory", ...current.understandings.hypothesis }];
    const ordered = entries => [...entries].sort((a, b) => a.ref.id.localeCompare(b.ref.id));
    assert.deepEqual(ordered(supplied.understandings), ordered(expected));
    for (const item of supplied.understandings) assert.deepEqual(Object.keys(item).sort(), ["record", "ref", "view"]);
    const policies = [{ policyRef: originalPolicyRef, quotePolicy: "summarize_only", rules: [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }] }];
    const constraints = supplied.usageConstraints.map(item => ({ ...item, ref: item.understanding }));
    const expectedConstraints = expected.map(item => ({ understanding: item.ref, view: item.view, policies, ref: item.ref }));
    assert.deepEqual(ordered(constraints), ordered(expectedConstraints));
    assertCurrentMemory(supplied.currentMemory, current);
    assert.ok(!JSON.stringify(supplied).includes(SUPPLY_MARKER), "Understanding projection must not embed Candidate.originals/context");
    return current;
  };
  const policyVerdict = binding => ({ requestHash: binding.requestHash, sourceRef: binding.sourceRef, policyRef: binding.policyRef,
    applicable: true, scenarios: ["self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
    ruleChecks: binding.accessRules.map(rule => ({ id: rule.id, satisfied: true })) });
  const prefixes = { policy: "Judge the semantic relationship between this request and exactly this source.",
    view: "Select request-local Stella USER and MEMORY views.", proposal: "Propose one evidence-bound correction or useful work-state update for Stella.",
    verification: "Independently verify this proposed correction against the exact owner originals and existing state.",
    interpretation: "Independently check the derived artifact against every supplied source interpretation requirement." };
  provider = createServer(async (request, response) => {
    const http = { index: result.allHttpRequests.length + 1, method: request.method, path: request.url, atUtc: new Date().toISOString() };
    result.allHttpRequests.push(http);
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      assert.ok(result.allHttpRequests.length <= 40, "bounded understanding probe exceeded 40 HTTP requests");
      const index = result.requests.length + 1;
      const entry = { index, kind: "unclassified", case: activeCase, method: request.url, bytes: Buffer.byteLength(body), atUtc: http.atUtc };
      result.requests.push(entry); await writeFile(path.join(out, `provider-${index}.json`), body); trace("provider_request", entry);
      assert.equal(request.method, "POST"); assert.match(request.url, /\/gemini-3\.8-flash:(?:streamGenerateContent|generateContent)(?:\?|$)/);
      const input = JSON.parse(body), texts = input.contents.flatMap(item => item.parts ?? []).map(part => part.text).filter(value => typeof value === "string");
      const prompt = Object.fromEntries(Object.entries(prefixes).map(([key, prefix]) => [key, texts.find(value => value.startsWith(prefix))]));
      let parts;
      if (prompt.policy) {
        entry.kind = "source-policy"; const binding = JSON.parse(prompt.policy.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(binding.request, round.input);
        // The request itself can lawfully contain the current owner's correction;
        // the metadata judgment must not contain prior original payloads/candidates.
        assert.ok(!body.includes(SUPPLY_MARKER)); assert.ok(!Object.hasOwn(binding, "originals") && !Object.hasOwn(binding, "candidates"));
        assert.equal(binding.purpose.readPurpose, source.binding.purpose.readPurpose); assert.equal(binding.purpose.deliveryScope, source.binding.purpose.deliveryScope);
        entry.sourceRef = binding.sourceRef; parts = [{ text: JSON.stringify(policyVerdict(binding)) }];
      } else if (prompt.view) {
        entry.kind = "view-selector"; const binding = JSON.parse(prompt.view.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(binding.question, round.input);
        const current = await snapshot(); assert.equal(binding.candidates.length, 2);
        const selections = [];
        for (const candidate of binding.candidates) {
          assert.equal(candidate.group, "understandings"); assert.ok(candidate.originals.length >= 1);
          const name = candidate.ref.id === UNDERSTANDING_IDS.owner ? "owner" : candidate.ref.id === UNDERSTANDING_IDS.hypothesis ? "hypothesis" : null;
          assert.ok(name); assert.deepEqual(candidate.ref, current.understandings[name].ref); assert.deepEqual(candidate.record, current.understandings[name].record);
          if (name === "owner") assert.ok(candidate.originals.some(original => original.role === "owner" && original.kind === "reported"));
          else assertHypothesis(current.understandings.hypothesis);
          selections.push({ handle: candidate.handle, view: name === "owner" ? "user" : "memory" });
        }
        entry.selectedUnderstandings = [current.understandings.owner.ref, current.understandings.hypothesis.ref];
        parts = [{ text: JSON.stringify({ requestHash: binding.requestHash, selections }) }];
      } else if (prompt.proposal) {
        entry.kind = "correction-proposal"; const binding = JSON.parse(prompt.proposal.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(activeCase, "correction"); assert.equal(binding.request, UNDERSTANDING_CORRECTION);
        assert.equal(binding.ownerEvidence.length, 1); assert.equal(binding.ownerEvidence[0].text, round.input);
        assert.deepEqual(binding.ownerEvidence[0].ref, round.archive.evidenceRef); assert.notDeepEqual(binding.ownerEvidence[0].ref, source.evidenceRef);
        assert.equal(binding.candidates.length, 2);
        const owner = binding.candidates.find(candidate => candidate.group === "understandings" && candidate.ref.id === UNDERSTANDING_IDS.owner);
        const hypothesis = binding.candidates.find(candidate => candidate.group === "understandings" && candidate.ref.id === UNDERSTANDING_IDS.hypothesis);
        assert.ok(owner && hypothesis); assert.equal(owner.record.statement, UNDERSTANDING_STATEMENT_A); assertHypothesis(hypothesis);
        const supportRefs = [...new Map([...owner.record.supportRefs, round.archive.evidenceRef].map(ref => [canonicalJson(ref), ref])).values()];
        const verdict = { requestHash: binding.requestHash, disposition: "update", clarification: null,
          rationale: "Synthetic explicit owner correction updates the scoped statement while preserving the unaccepted hypothesis.",
          reviewedHandles: binding.candidates.map(candidate => candidate.handle), replacements: [{ handle: owner.handle, group: "understandings",
            record: { ...Object.fromEntries(editableUnderstanding.map(field => [field, owner.record[field]])), statement: UNDERSTANDING_STATEMENT_B, supportRefs } }] };
        entry.ownerEvidenceRef = round.archive.evidenceRef; parts = [{ text: JSON.stringify(verdict) }];
      } else if (prompt.verification) {
        entry.kind = "correction-verification"; const binding = JSON.parse(prompt.verification.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(activeCase, "correction"); assert.deepEqual(binding.ownerEvidence[0].ref, round.archive.evidenceRef);
        parts = [{ text: JSON.stringify({ requestHash: binding.requestHash, proposalHash: binding.proposalHash, valid: true }) }];
      } else if (prompt.interpretation) {
        entry.kind = "source-interpretation"; const binding = JSON.parse(prompt.interpretation.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0); assert.equal(activeCase, "correction"); assert.equal(binding.data.request, UNDERSTANDING_CORRECTION);
        assert.ok(binding.data.requirements.some(requirement => requirement.id === "keep_scope"));
        parts = [{ text: JSON.stringify({ bindingHash: binding.bindingHash, checks: binding.data.requirements.map(requirement => ({ handle: requirement.handle, satisfied: true })) }) }];
      } else {
        entry.kind = "agent"; assert.ok(round); assert.ok(JSON.stringify(input.tools).includes("stella_memory_data") && JSON.stringify(input.tools).includes("stella_memory_correct"));
        const phase = ++agentStep; entry.phase = phase;
        if (phase === 1) {
          round.agentStart = await snapshot(); round.archive = await inspectArchivedInput(round.agentStart);
          trace("owner_archive_seen_before_agent", { case: activeCase, ...round.archive, authority: round.agentStart.authority });
          assert.equal(round.agentStart.understandings.owner.record.statement, activeCase === "next" ? UNDERSTANDING_STATEMENT_B : UNDERSTANDING_STATEMENT_A);
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "understanding" } } }];
        } else if (activeCase === "correction" && phase === 2) {
          const response = toolResponses(input).at(-1); assert.equal(response.name, "stella_memory_data");
          const current = await assertUnderstandingResult(response.output, UNDERSTANDING_STATEMENT_A);
          assert.equal(current.authority.revision, round.agentStart.authority.revision);
          round.cacheFill = { ownerRef: current.understandings.owner.ref, currentMemory: response.output.currentMemory };
          entry.understandingVerified = { phase: "cached-A", ownerRef: current.understandings.owner.ref };
          parts = [{ functionCall: { name: "stella_memory_correct", args: {} } }];
        } else if (activeCase === "correction" && phase === 3) {
          const response = toolResponses(input).at(-1); assert.equal(response.name, "stella_memory_correct"); const supplied = response.output;
          assert.deepEqual(Object.keys(supplied).sort(), ["correction", "currentMemory"]);
          assert.deepEqual(Object.keys(supplied.correction).sort(), ["changeRef", "clarification", "disposition", "operationId", "persistenceStatus"]);
          assert.equal(supplied.correction.disposition, "update"); assert.equal(supplied.correction.clarification, null);
          assert.equal(supplied.correction.persistenceStatus, "local_committed"); assert.ok(supplied.correction.operationId);
          const current = await snapshot(); assert.equal(current.understandings.owner.record.statement, UNDERSTANDING_STATEMENT_B); assertCurrentMemory(supplied.currentMemory, current);
          assert.notEqual(current.authority.revision, round.agentStart.authority.revision); assert.notEqual(current.authority.token, round.agentStart.authority.token);
          assert.notDeepEqual(current.understandings.owner.ref, round.cacheFill.ownerRef);
          const reader = await CatalogReader.load(source.root, source.catalogPath), change = await reader.read(supplied.correction.changeRef, "changes");
          assert.deepEqual(change.inputRefs, [round.archive.evidenceRef]); assert.equal(change.operationId, supplied.correction.operationId);
          assert.deepEqual(change.targetRefs, [current.understandings.owner.ref]);
          assert.ok(current.understandings.owner.record.supportRefs.some(ref => canonicalJson(ref) === canonicalJson(round.archive.evidenceRef)));
          const journal = JSON.parse(await readFile(path.join(source.root, operations, `${supplied.correction.operationId}.transaction.json`), "utf8"));
          assert.equal(journal.recoveryCheckpoint.expected.revision, round.agentStart.authority.revision);
          assert.equal(journal.recoveryCheckpoint.expected.token, round.agentStart.authority.token);
          round.correction = { receipt: supplied.correction, currentMemory: supplied.currentMemory, authority: current.authority };
          entry.correctionVerified = supplied.correction.changeRef;
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "understanding" } } }];
        } else {
          assert.equal(phase, activeCase === "correction" ? 4 : 2);
          const response = toolResponses(input).at(-1); assert.equal(response.name, "stella_memory_data");
          const statement = activeCase === "before" ? UNDERSTANDING_STATEMENT_A : UNDERSTANDING_STATEMENT_B;
          const current = await assertUnderstandingResult(response.output, statement);
          if (activeCase === "correction") {
            assert.equal(current.authority.revision, round.correction.authority.revision);
            assert.notDeepEqual(current.understandings.owner.ref, round.cacheFill.ownerRef, "The pre-correction understanding cache must be invalidated");
          }
          entry.understandingVerified = { phase: activeCase === "before" ? "A" : "B", ownerRef: current.understandings.owner.ref, hypothesisRef: current.understandings.hypothesis.ref };
          entry.checkpointRevision = current.authority.revision;
          parts = [{ text: `SYNTHETIC_UNDERSTANDING_${activeCase.toUpperCase()}_ANSWER_5827: USER is scoped owner statement: ${statement} MEMORY remains provisional: ${UNDERSTANDING_HYPOTHESIS}` }];
        }
      }
      await save();
      const output = { responseId: `synthetic-understanding-${index}`, modelVersion: "gemini-3.8-flash", candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      await writeFile(path.join(out, `provider-${index}-response.json`), JSON.stringify(output));
      if (request.url.includes("streamGenerateContent")) { response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify(output)}\n\n`); }
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output)); }
    } catch (error) { result.providerError ??= String(error.stack ?? error); await save(); response.statusCode = 500; response.end("synthetic understanding assertion failed"); }
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const allocator = net.createServer(); await new Promise(resolve => allocator.listen(0, "127.0.0.1", resolve));
  const gatewayPort = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const token = randomBytes(32).toString("hex");
  const config = { logging: { level: "debug", file: path.join(out, "gateway.log") }, gateway: { mode: "local" },
    memory: { search: { enabled: false } }, hooks: { internal: { enabled: false, entries: { "session-memory": { enabled: false } } } },
    commands: { ownerAllowFrom: ["*"] },
    agents: { ownership: "explicit", defaults: { model: { primary: UNDERSTANDING_MODEL, fallbacks: [] }, thinkingDefault: "low" },
      entries: { synthetic: { workspace, identity: { name: `${BOOTSTRAP_MARKER}_IDENTITY.md`, theme: "Isolated synthetic work acceptance", emoji: "🧪" } } } },
    models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${provider.address().port}`,
      models: [{ id: "gemini-3.8-flash", name: "Synthetic Google loopback", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } },
    plugins: { slots: { memory: "none" }, allow: ["stella-core", "google"], load: { paths: [installed] },
      entries: { "memory-core": { enabled: false }, "stella-core": { enabled: true, hooks: { allowConversationAccess: true },
        config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: source.root,
          dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools", requestArchive: "local", agentCorrection: "tool" } } } }, tools: { allow: ["stella_memory_data", "stella_memory_correct"] } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  result.configuration = { path: configPath, sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    model: UNDERSTANDING_MODEL, thinking: "low", providerBaseUrl: config.models.providers.google.baseUrl,
    conversationHooks: "existing synthetic-only authorization", extraLlmPermissions: false, requestArchive: "local", agentCorrection: "tool" };
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
  result.initialized = await client.request("stella.checkpoint", { action: "initialize", revision: source.revision, operationId: "synthetic-understanding-installed-init" });
  try { result.materialization = await client.request("stella.checkpoint", { action: "materialize" }); }
  catch (error) {
    assert.match(String(error), /skill_unavailable_or_shadowed/);
    const pending = await readFile(path.join(authority, "initialization/pending.json"), "utf8"), plan = JSON.parse(pending);
    assert.equal(plan.sourceRevision, source.revision); await writeFile(path.join(out, "initialization-pending-before-refresh.json"), pending);
    result.initializationRefresh = { refusal: String(error), originalOperationId: plan.operationId, method: "one normal restart of this same isolated Gateway; config/source/state unchanged" };
    await stopGateway(); await startGateway(); result.materialization = await client.request("stella.checkpoint", { action: "materialize" });
    assert.equal(result.materialization.materialized.receipt.operationId, plan.operationId);
  }
  assert.equal(result.materialization.materialized.receipt.files.length, 6); assert.equal(result.materialization.consumed, false);
  assert.equal(result.materialization.capabilities.full_memory, false);
  const userFile = path.join(workspace, "USER.md"), userBefore = await readFile(userFile);
  result.userFile = { path: userFile, initialSha256: createHash("sha256").update(userBefore).digest("hex"), unchanged: false };
  const sessionKey = "agent:synthetic:current-understanding";
  result.createdSession = await client.request("sessions.create", { key: sessionKey, agentId: "synthetic", idempotencyKey: "synthetic-understanding-create" });
  assert.equal(result.createdSession.ok, true); assert.ok(!result.createdSession.runStarted && !result.createdSession.runId);
  const runCase = async (id, input, expectedAgentRequests) => {
    activeCase = id; agentStep = 0; const start = result.requests.length;
    round = { id, input, sessionKey, before: await snapshot() };
    const beforeArchive = round.before.files.filter(file => file.endsWith(".archive.json"));
    const beforeCorrection = round.before.files.filter(file => file.endsWith(".correction.json"));
    round.sent = await client.request("chat.send", { sessionKey, message: input, idempotencyKey: `synthetic-understanding-${id}` });
    round.terminal = await client.request("agent.wait", { runId: round.sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
    round.after = await snapshot(); round.history = await client.request("chat.history", { sessionKey, limit: 40 });
    const end = result.requests.length; round.firstProviderIndex = start + 1; round.lastProviderIndex = end; result.cases.push(round); await save();
    assert.equal(result.providerError, undefined); assert.equal(round.terminal.status, "ok"); assert.equal(agentStep, expectedAgentRequests);
    assert.equal(round.archive.runId, round.sent.runId); assert.equal(round.archive.requestHash, bytesVersion(input));
    assert.equal(round.after.status.ingress.state, "local_committed"); assert.equal(round.after.status.ingress.runId, round.sent.runId);
    const archiveFiles = round.after.files.filter(file => file.endsWith(".archive.json") && !beforeArchive.includes(file));
    const correctionFiles = round.after.files.filter(file => file.endsWith(".correction.json") && !beforeCorrection.includes(file));
    assert.equal(archiveFiles.length, 1, "Each user request must archive once, independent of its tool/model continuation count");
    assert.equal(correctionFiles.length, id === "correction" ? 1 : 0);
    for (const group of ["sources", "evidence", "coverage"]) assert.equal(round.after.catalog[group].length - round.before.catalog[group].length, 1);
    const archiveOperation = round.after.status.ingress.operationId; assert.equal(archiveFiles[0], `${archiveOperation}.archive.json`);
    const archiveJournal = JSON.parse(await readFile(path.join(source.root, operations, `${archiveOperation}.checkpoint.json`), "utf8"));
    assert.deepEqual(archiveJournal.recoveryCheckpoint.expected, { revision: round.before.authority.revision, token: round.before.authority.token });
    const commitsFor = async file => (await git(source.root, "log", "--format=%H", `${round.before.authority.revision}..${round.after.authority.revision}`, "--", path.posix.join(operations, file))).split("\n").filter(Boolean);
    const archiveCommits = await commitsFor(archiveFiles[0]); assert.equal(archiveCommits.length, 1);
    assert.equal(archiveCommits[0], round.after.status.ingress.revision); round.archiveCommit = archiveCommits[0];
    if (id === "correction") {
      const semanticCommits = await commitsFor(correctionFiles[0]); assert.equal(semanticCommits.length, 1);
      assert.notEqual(semanticCommits[0], round.archiveCommit); assert.equal(semanticCommits[0], round.correction.authority.revision);
      assert.equal(await git(source.root, "show", "--format=%P", "-s", semanticCommits[0]), round.agentStart.authority.revision);
      assert.equal(correctionFiles[0], `${round.correction.receipt.operationId}.correction.json`);
      const receipt = JSON.parse(await readFile(path.join(source.root, operations, correctionFiles[0]), "utf8"));
      assert.equal(receipt.schemaVersion, "stella-correction/v2"); assert.equal(receipt.requestHash, bytesVersion(input));
      assert.deepEqual(receipt.changeRef, round.correction.receipt.changeRef); round.semanticCommit = semanticCommits[0];
    }
    round.gitCommits = (await git(source.root, "rev-list", "--reverse", `${round.before.authority.revision}..${round.after.authority.revision}`)).split("\n").filter(Boolean);
    round.ownerArchiveWrites = 1; round.semanticWrites = correctionFiles.length;
    assert.deepEqual(await readFile(userFile), userBefore, "Read-only understanding supply must not materialize new USER.md content");
    const answer = `SYNTHETIC_UNDERSTANDING_${id.toUpperCase()}_ANSWER_5827`;
    assert.ok(JSON.stringify(round.history).includes(answer)); await save();
  };
  await runCase("before", UNDERSTANDING_QUESTIONS[0], 2);
  await runCase("correction", UNDERSTANDING_CORRECTION, 4);
  await runCase("next", UNDERSTANDING_QUESTIONS[1], 2);
  assert.equal(new Set(result.cases.map(test => test.history.sessionId)).size, 1);
  assert.ok(result.cases[2].history.messages?.length > result.cases[0].history.messages?.length);
  assert.ok(JSON.stringify(result.cases[2].history).includes("SYNTHETIC_UNDERSTANDING_QUERY_A_5827"));
  assert.equal(result.cases.reduce((sum, test) => sum + test.ownerArchiveWrites, 0), 3);
  assert.equal(result.cases.reduce((sum, test) => sum + test.semanticWrites, 0), 1);
  assert.equal(result.cases[1].after.understandings.owner.ref.version, result.cases[2].after.understandings.owner.ref.version);
  assert.notEqual(result.cases[0].after.understandings.owner.ref.version, result.cases[2].after.understandings.owner.ref.version);
  result.boundaries = { sameOwnerSameSession: true, resets: 0, userRequests: 3, agentRequests: 8, ownerArchiveWrites: 3, semanticWrites: 1,
    userAndMemoryPartitionsPreserved: true, hypothesisRemainsProvisionalAndUnchanged: true, currentHostArchiveEvidenceUsedByCorrection: true,
    modelSelectedCorrectionTool: true, publicHostSemanticCompletionsOnly: true, preCorrectionCacheInvalidated: true,
    sameRoundUnderstandingUsesReturnedCAS: true, nextRequestUnderstandingRemainsCorrected: true, usageConstraintsReachAgent: true,
    historyMayRetainPastValues: true, full_memory: false, realSemanticQualityAccepted: false };
  await stopGateway();
  assert.deepEqual(await readFile(userFile), userBefore); result.userFile.unchanged = true;
  result.userFile.finalSha256 = createHash("sha256").update(await readFile(userFile)).digest("hex");
  assert.equal(createHash("sha256").update(await readFile(artifact)).digest("hex"), artifactSha256);
  for (const file of result.installation.inspectedFiles) assert.equal(createHash("sha256").update(await readFile(path.join(installed, file.path))).digest("hex"), file.sha256);
  result.currentUnderstandingMechanismVerified = true; result.passed = true;
} catch (error) { result.error = { message: String(error), stack: error?.stack }; }
finally { await cleanup(); }
async function cleanup() {
  return cleanupPromise ??= (async () => {
    const wasPassing = result.passed && !result.cancelled;
    client?.stop();
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
        assert.ok(["agent", "view-selector", "source-policy", "correction-proposal", "correction-verification", "source-interpretation"].includes(request.kind), `Invalid request kind at ${request.index}: ${request.kind}`);
        const windows = result.cases.filter(test => request.index >= test.firstProviderIndex && request.index <= test.lastProviderIndex);
        assert.equal(windows.length, 1, `Request ${request.index} is late or outside one closed case window`);
        assert.equal(request.case, windows[0].id, `Request ${request.index} has a mismatched case`);
      }
      if (wasPassing) {
        assert.deepEqual(result.cases.map(test => test.id), ["before", "correction", "next"]);
        assert.ok(result.allHttpRequests.length <= 40);
        for (const test of result.cases) {
          const requests = result.requests.slice(test.firstProviderIndex - 1, test.lastProviderIndex);
          const count = kind => requests.filter(value => value.kind === kind).length;
          assert.equal(count("agent"), test.id === "correction" ? 4 : 2);
          assert.equal(count("view-selector"), test.id === "correction" ? 2 : 1);
          assert.equal(requests.filter(value => value.understandingVerified).length, test.id === "correction" ? 2 : 1);
          assert.equal(requests.filter(value => value.correctionVerified).length, test.id === "correction" ? 1 : 0);
          assert.ok(count("source-policy") >= 1);
          for (const kind of ["correction-proposal", "correction-verification", "source-interpretation"]) assert.equal(count(kind), test.id === "correction" ? 1 : 0);
          assert.equal(test.ownerArchiveWrites, 1); assert.equal(test.semanticWrites, test.id === "correction" ? 1 : 0);
        }
      }
    } catch (error) {
      result.passed = false;
      result.providerDrainError = { message: String(error), stack: error?.stack };
      result.error ??= result.providerDrainError; // Preserve the original failure, if any.
    }
    if (source) { result.sourceFinalRevision = await git(source.root, "rev-parse", "HEAD"); await rm(source.root, { recursive: true, force: true }); result.syntheticSourceRemoved = true; }
    if (result.cancelled) { result.passed = false; result.error ??= { message: `Probe interrupted by ${result.cancelled}` }; }
    if (!result.passed) result.currentUnderstandingMechanismVerified = false;
    result.endedAtUtc = new Date().toISOString(); await save();
    if (JSON.parse(await readFile(ownerPath, "utf8")).pid === process.pid) await rm(ownerPath);
    console.log(JSON.stringify({ passed: result.passed, error: result.error?.message, providerRequests: result.requests.length, result: path.join(out, "result.json") }));
  })();
}
if (!result.passed) process.exitCode = 1;
