import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { probeHost, isolatedProbeCommand, onProbeCancellation } from "./lib/isolated-probe-host.mjs";

// Actual stock Host, direct installed plugin, synthetic data and loopback only.
// Fake verdicts exercise protocol/mechanism, never semantic model quality.
const root = await realpath(process.cwd());
assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).name, "@tower1229/stella-core");
const art = await realpath(process.env.STELLA_V3_ARTIFACTS);
assert.ok(art.startsWith(path.join(root, ".artifacts") + path.sep));
const installed = await realpath(path.join(art, "consumer/node_modules/@tower1229/stella-core"));
const attempt = process.env.STELLA_V3_ATTEMPT ?? "a1";
assert.match(attempt, /^a[0-9]+$/);
const diagnostic = process.env.STELLA_V3_DIAGNOSTIC === "1";
const compiled = await realpath(process.env.STELLA_AGENT_SUPPLY_COMPILED ?? path.join(art, "compiled-a1")), out = path.join(art, "host-v3-" + attempt);
// Refuse a misconfigured environment before creating any probe artifact/source.
const state = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH;
assert.ok(state && path.isAbsolute(state) && state.startsWith(art + "/") && await realpath(state) === state);
assert.ok(configPath && path.isAbsolute(configPath) && path.dirname(configPath) === state && await realpath(path.dirname(configPath)) === state);
const configStat = await lstat(configPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
assert.ok(!configStat || configStat.isFile() && !configStat.isSymbolicLink() && configStat.nlink === 1);
if (process.argv.includes("--preflight-only")) { console.log("synthetic config path preflight passed"); process.exit(0); }
await mkdir(out, { mode: 0o700 });
const ownerPath = path.join(art, "host-v3-owner.json");
await writeFile(ownerPath, JSON.stringify({ pid: process.pid, startedAtUtc: new Date().toISOString() }), { flag: "wx" });
const { GatewayClient, hostRoot, openclawBin, evidence: hostIdentity } = await probeHost(root);
const { createAgentSupplySource } = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-agent-supply-fixture.js")));
const exec = promisify(execFile), git = async (dir, ...args) => (await exec("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", dir, ...args])).stdout.trim();
let source, provider, child, client;
const result = { hostIdentity, startedAtUtc: new Date().toISOString(), passed: false,
  installation: { root: installed, entry: path.join(installed, "dist/src/plugin.js"), directHostLoad: !diagnostic, observerWrapper: diagnostic },
  scope: "actual isolated OpenClaw public Agent and runtime.llm.complete; fake Google wire, no real model/private source", requests: [], events: [], cases: [] };
const save = () => writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
let cleanupPromise;
onProbeCancellation(signal => { result.passed = false; result.cancelled = signal; result.error = { message: `Interrupted by ${signal}` }; }, cleanup);
const outputs = input => input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output)
  .map(part => { try { return JSON.parse(part.functionResponse.response.output); } catch { return null; } }).filter(Boolean);
try {
  source = await createAgentSupplySource({ additionalEvidence: 17, policyContext: "allow" });
  // The test grant names the real public CLI identity observed by the previous
  // stock Host probe. This edits only the newly generated synthetic fixture.
  const grantPath = path.join(source.root, "50_PersonalAgent/stella/checkpoint-access.json");
  const grant = JSON.parse(await readFile(grantPath, "utf8")); grant.requesterIds = ["cli"];
  await writeFile(grantPath, JSON.stringify(grant));
  await git(source.root, "add", "--", "50_PersonalAgent/stella/checkpoint-access.json");
  await git(source.root, "commit", "--quiet", "-m", "[synthetic] bind reviewed metadata grant to public CLI principal");
  source.revision = await git(source.root, "rev-parse", "HEAD");
  const catalog = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8"));
  assert.equal(catalog.evidence.length, 18);
  result.source = { root: source.root, revision: source.revision, evidence: 18, schema: "stella.source-policy/v3", requesterIds: grant.requesterIds };
  await writeFile(path.join(out, "synthetic-catalog.json"), JSON.stringify(catalog, null, 2));
  const workspace = path.join(out, "workspace"), authority = path.join(out, "authority");
  assert.ok(state?.startsWith(art + "/"));
  for (const p of [workspace, authority]) await mkdir(p, { mode: 0o700 });
  for (const name of ["AGENTS", "SOUL", "IDENTITY", "USER", "MEMORY"]) await writeFile(path.join(workspace, name + ".md"), `# Synthetic ${name}\nOnly isolated v3 protocol acceptance.\n`);
  let activeCase = "allowed", agentStep = 0;
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.match(request.url, /gemini-3\.8-flash:(?:streamGenerateContent|generateContent)/);
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), textParts = input.contents.flatMap(item => item.parts ?? []).map(part => part.text).filter(value => typeof value === "string");
      const judgmentPrompt = textParts.find(value => value.startsWith("Judge the semantic relationship between this request and exactly this source."));
      const index = result.requests.length + 1, kind = judgmentPrompt ? "policy" : "agent";
      assert.ok(index <= 50, "bounded synthetic probe exceeded 50 captured requests");
      await writeFile(path.join(out, `provider-${index}.json`), body);
      const entry = { index, kind, case: activeCase, method: request.url, bytes: Buffer.byteLength(body), atUtc: new Date().toISOString() };
      result.requests.push(entry); appendFileSync(path.join(out, "wire-events.jsonl"), JSON.stringify(entry) + "\n");
      let parts;
      if (judgmentPrompt) {
        const binding = JSON.parse(judgmentPrompt.split("\n").at(-1));
        assert.equal(input.tools?.length ?? 0, 0, "policy completion must have no callable tools");
        assert.ok(!body.includes("Synthetic retained entry") && !body.includes("SYNTHETIC_ALLOWED_MEMORY_4931"), "originals must not enter metadata judgment");
        assert.equal(binding.purpose.readPurpose, "alpha_praxis"); assert.equal(binding.purpose.deliveryScope, "host-chat");
        const denied = binding.request.includes("SYNTHETIC_V3_FORBIDDEN_USE");
        const verdict = { requestHash: binding.requestHash, sourceRef: binding.sourceRef, policyRef: binding.policyRef,
          applicable: true, scenarios: [denied ? "relationship_judgment" : "self_reflection"], topicRequested: true, topicExplicitlyNamed: true,
          ruleChecks: binding.accessRules.map(rule => ({ id: rule.id, satisfied: true })) };
        parts = [{ text: JSON.stringify(verdict) }]; entry.policyTarget = { sourceRef: binding.sourceRef, policyRef: binding.policyRef };
      } else {
        const phase = ++agentStep, returned = outputs(input);
        assert.ok(JSON.stringify(input.tools).includes("stella_memory_data"));
        if (phase === 1) parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }];
        else if (phase === 2) {
          const page = returned.filter(value => Array.isArray(value.items)).at(-1); assert.ok(page); assert.equal(page.examined, 16); assert.equal(page.nextCursor, 16);
          assert.equal(page.items.length, activeCase === "allowed" ? 16 : 0);
          if (activeCase === "denied_use") assert.deepEqual(page.exclusions, { source_scenario_forbidden: 16 });
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list", cursor: page.nextCursor } } }];
        } else if (phase === 3) {
          const page = returned.filter(value => Array.isArray(value.items)).at(-1); assert.ok(page); assert.equal(page.examined, 2); assert.equal(page.nextCursor, null);
          if (activeCase === "allowed") {
            assert.deepEqual(page.exclusions, {}); assert.deepEqual(page.contextRequired, {}); assert.equal(page.items.length, 2);
            const selected = page.items.find(item => item.handle === "E18"); assert.ok(selected);
            assert.equal(selected.usageConstraints[0].quotePolicy, "summarize_only"); assert.equal(selected.usageConstraints[0].rules[0].id, "keep_scope");
            parts = [{ functionCall: { name: "stella_memory_data", args: { action: "read", handle: "E18" } } }];
          } else {
            assert.deepEqual(page.items, []); assert.deepEqual(page.exclusions, { source_scenario_forbidden: 2 });
            assert.ok(!body.includes("Synthetic retained entry") && !body.includes("SYNTHETIC_ALLOWED_MEMORY_4931"));
            parts = [{ text: "SYNTHETIC_V3_POLICY_REFUSED: no current source supplied for the forbidden use." }];
          }
        } else {
          assert.equal(activeCase, "allowed"); assert.equal(phase, 4);
          const read = returned.filter(value => value.original).at(-1); assert.ok(read);
          assert.equal(read.original.text, "Synthetic retained entry 18."); assert.equal(read.original.usageConstraints[0].quotePolicy, "summarize_only");
          assert.equal(read.original.usageConstraints[0].rules[0].id, "keep_scope");
          parts = [{ text: "SYNTHETIC_V3_INSTALLED_ANSWER: entry 18 recalled with its original constraints." }];
        }
      }
      await save();
      const output = { responseId: `synthetic-v3-${index}`, modelVersion: "gemini-3.8-flash", candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      if (request.url.includes("streamGenerateContent")) { response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify(output)}\n\n`); }
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(output)); }
    } catch (error) { result.providerError = String(error); await save(); response.statusCode = 500; response.end("synthetic protocol assertion failed"); }
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const allocator = net.createServer(); await new Promise(resolve => allocator.listen(0, "127.0.0.1", resolve)); const gatewayPort = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const token = randomBytes(32).toString("hex");
  let loadRoot = installed;
  if (diagnostic) {
    loadRoot = path.join(out, "diagnostic-plugin"); await mkdir(loadRoot);
    await writeFile(path.join(loadRoot, "package.json"), JSON.stringify({ name: "synthetic-v3-api-observer", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
    await writeFile(path.join(loadRoot, "openclaw.plugin.json"), await readFile(path.join(installed, "openclaw.plugin.json")));
    await writeFile(path.join(loadRoot, "index.mjs"), `import core from ${JSON.stringify(pathToFileURL(path.join(installed, "dist/src/plugin.js")).href)};
import {appendFileSync} from 'node:fs';
export default {...core,register(api){const runtime=Object.create(api.runtime),llm=api.runtime.llm;
Object.defineProperty(runtime,'llm',{value:{...llm,async complete(args){try{return await llm.complete(args);}catch(error){appendFileSync(${JSON.stringify(path.join(out, "llm-error.jsonl"))},JSON.stringify({code:error?.code??null,name:error?.name,message:error?.message})+String.fromCharCode(10));throw error;}}}});
const observed=Object.create(api);Object.defineProperty(observed,'runtime',{value:runtime});return core.register(observed);}};`);
  }
  const config = { logging: { level: "debug", file: path.join(out, "gateway.log") }, gateway: { mode: "local" },
    memory: { search: { enabled: false } }, hooks: { internal: { enabled: false } }, commands: { ownerAllowFrom: ["*"] },
    agents: { ownership: "explicit", defaults: { model: { primary: "google/gemini-3.8-flash", fallbacks: [] }, thinkingDefault: "low" }, entries: { synthetic: { workspace } } },
    models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${provider.address().port}`, models: [{ id: "gemini-3.8-flash", name: "Synthetic Google loopback", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } },
    plugins: { slots: { memory: "none" }, allow: ["stella-core", "google"], load: { paths: [loadRoot] }, entries: { "memory-core": { enabled: false }, "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: source.root, dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools" } } } }, tools: { allow: ["stella_memory_data"] } };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
  result.configuration = { path: process.env.OPENCLAW_CONFIG_PATH, sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"), newLlmPermissions: false, conversationHooks: "preapproved synthetic only", model: "google/gemini-3.8-flash", thinking: "low", providerBaseUrl: config.models.providers.google.baseUrl };
  const launch = await isolatedProbeCommand({ root, out, state, home: process.env.OPENCLAW_HOME, hostRoot,
    args: [openclawBin, "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--auth", "token", "--port", String(gatewayPort), "--ws-log", "compact"] });
  child = spawn(launch.command, launch.args, { cwd: out, env: { ...process.env, OPENCLAW_GATEWAY_PORT: String(gatewayPort), OPENCLAW_GATEWAY_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
  result.gateway = { pid: child.pid, command: [launch.command, ...launch.args], port: gatewayPort, sandboxed: launch.sandboxed, isolation: launch.isolation }; await save();
  let output = ""; const capture = chunk => { output += String(chunk); appendFileSync(path.join(out, "gateway-live.log"), chunk); }; child.stdout.on("data", capture); child.stderr.on("data", capture);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(interval); reject(new Error("isolated_gateway_start_timeout")); }, 45000);
    const interval = setInterval(() => { if (output.includes("stella-core failed to load")) { clearTimeout(timer); clearInterval(interval); reject(new Error("installed_plugin_load_failed")); } else if (output.includes("[gateway] ready")) { clearTimeout(timer); clearInterval(interval); resolve(); } }, 100);
    child.once("exit", code => { clearTimeout(timer); clearInterval(interval); reject(new Error(`isolated_gateway_exited_${code}`)); });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_connect_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); }, onEvent(event) { result.events.push(event); } }); client.start();
  });
  result.initialized = await client.request("stella.checkpoint", { action: "initialize", revision: source.revision, operationId: "synthetic-v3-installed-init" });
  for (const testCase of [{ id: "allowed", input: "SYNTHETIC_V3_ALLOWED: reflect on the reviewed synthetic writing topic.", expected: "SYNTHETIC_V3_INSTALLED_ANSWER", steps: 4 }, { id: "denied_use", input: "SYNTHETIC_V3_FORBIDDEN_USE: make the forbidden synthetic relationship judgment.", expected: "SYNTHETIC_V3_POLICY_REFUSED", steps: 3 }]) {
    activeCase = testCase.id; agentStep = 0;
    const sessionKey = `agent:synthetic:v3-${testCase.id}`;
    await client.request("sessions.reset", { key: sessionKey, reason: "new" });
    const sent = await client.request("chat.send", { sessionKey, message: testCase.input, idempotencyKey: `synthetic-v3-${testCase.id}` });
    const terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
    const status = await client.request("stella.checkpoint", { action: "status" });
    const history = await client.request("chat.history", { sessionKey, limit: 30 });
    result.cases.push({ id: testCase.id, sent, terminal, status, history }); await save();
    assert.equal(result.providerError, undefined); assert.equal(terminal.status, "ok"); assert.equal(agentStep, testCase.steps);
    assert.ok(JSON.stringify(history).includes(testCase.expected)); assert.equal(status.capabilities.full_memory, false);
    const calls = result.requests.filter(value => value.case === testCase.id);
    assert.equal(calls.filter(value => value.kind === "policy").length, 18); assert.equal(calls.filter(value => value.kind === "agent").length, testCase.steps);
  }
  activeCase = "denied_audience"; const before = result.requests.length;
  const shared = "agent:synthetic:telegram:group:synthetic-v3-room";
  await client.request("sessions.reset", { key: shared, reason: "new" });
  const sent = await client.request("chat.send", { sessionKey: shared, message: "SYNTHETIC_V3_SHARED: read private memory.", idempotencyKey: "synthetic-v3-denied-audience" });
  let status;
  for (let i = 0; i < 30; i++) { status = await client.request("stella.checkpoint", { action: "status" }); if (status.supply?.category === "private_context_audience_forbidden") break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(status.supply?.category, "private_context_audience_forbidden"); assert.equal(result.requests.length, before);
  result.cases.push({ id: activeCase, sent, status, providerRequests: 0 });
  result.passed = true;
} catch (error) { result.error = { message: String(error), stack: error?.stack }; }
finally { await cleanup(); }
async function cleanup() {
  return cleanupPromise ??= (async () => {
  client?.stop();
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
    result.gateway.exitCode = child.exitCode; result.gateway.signalCode = child.signalCode;
  }
  if (provider) await new Promise(resolve => provider.close(resolve));
  if (source) { result.sourceFinalRevision = await git(source.root, "rev-parse", "HEAD"); await rm(source.root, { recursive: true, force: true }); result.syntheticSourceRemoved = true; }
  result.endedAtUtc = new Date().toISOString(); if (result.cancelled) result.passed = false; await save();
  if (JSON.parse(await readFile(ownerPath, "utf8")).pid === process.pid) await rm(ownerPath);
  console.log(JSON.stringify({ passed: result.passed, error: result.error?.message, providerRequests: result.requests.length, result: path.join(out, "result.json") }));

  })();
}

if (!result.passed) process.exitCode = 1;
