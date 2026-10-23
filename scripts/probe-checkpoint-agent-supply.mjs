import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Started by the local runner with an allow-listed environment, before SDK imports.
const root = await realpath(process.cwd());
assert.equal(root, "/Users/zangtao/Workspace/tower1229/Stella-Core");
const attempt = process.argv[2], compilation = process.argv[3], scenario = process.argv[4] ?? "normal";
assert.ok(["normal", "history", "cancel_after_list", "revoke_after_list", "cas_before_list", "source_before_list", "revoke_before_list", "revoke_after_sent", "next_request"].includes(scenario));
assert.match(attempt ?? "", /^[a-z][a-z0-9]{0,15}$/); assert.match(compilation ?? "", /^a[0-9]+$/);
const art = path.resolve(process.env.STELLA_AGENT_SUPPLY_ARTIFACTS ?? path.join(root, ".artifacts/suqing-batch6-20261022"));
assert.ok(art.startsWith(path.join(root, ".artifacts/suqing-batch")) && await realpath(art) === art);
const out = path.join(art, "host-probe-" + attempt);
await mkdir(out, { mode: 0o700 });
const ownerPath = path.join(art, "host-probe-owner.json"), owner = { pid: process.pid, attempt, startedAtUtc: new Date().toISOString() };
const compiled = path.resolve(process.env.STELLA_AGENT_SUPPLY_COMPILED ?? path.join(art, "compiled-" + compilation));
assert.ok(compiled.startsWith(path.join(root, ".artifacts/suqing-batch")) && await realpath(compiled) === compiled);
await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx" });
const { createAgentSupplySource, publishAgentSupplyPolicyDenial, SUPPLY_MARKER } = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-agent-supply-fixture.js")));
const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
const source = await createAgentSupplySource(), authority = path.join(out, "authority"), workspace = path.join(out, "workspace"), plugin = path.join(out, "plugin");
const state = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH;
assert.ok(state?.startsWith(art + "/") && configPath?.startsWith(state + "/"));
const cache = process.env.XDG_CACHE_HOME;
assert.ok(cache && path.isAbsolute(cache) && cache.startsWith(state + "/") && await realpath(cache) === cache,
  "The stock SQLite worker requires an isolated public XDG_CACHE_HOME before SDK imports");
for (const dir of [authority, workspace, plugin, state, process.env.OPENCLAW_HOME]) await mkdir(dir, { recursive: true });
for (const name of ["AGENTS", "SOUL", "IDENTITY", "USER", "MEMORY"]) await writeFile(path.join(workspace, name + ".md"), `# Synthetic ${name}\nIsolated stock Host acceptance; no private material.\n`);
const logPath = path.join(out, "public-events.jsonl");
const sourceCatalog = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8"));
const policyEntry = sourceCatalog.policies.find(value => value.id === source.binding.archive.policyRef.id);
assert.ok(policyEntry); const syntheticPolicyPath = path.join(source.root, policyEntry.locator.path);
const manifest = JSON.parse(await readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify(manifest));
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "@synthetic/stella-stock-host-probe", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
// Instrument only public callback arguments/results. Preserve the Host envelope.
await writeFile(path.join(plugin, "index.mjs"), `import core from ${JSON.stringify(pathToFileURL(path.join(compiled, "src/plugin.js")).href)};
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { abortAgentHarnessRun } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { randomUUID } from 'node:crypto';
const record = value => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({atUtc:new Date().toISOString(),...value})+String.fromCharCode(10));
export default {id:'stella-core',name:'Stella public supply probe',configSchema:core.configSchema,register(api){
 const registrationId=randomUUID();record({name:'plugin_registration',registrationId,pid:process.pid});
 let faultSent=false;const listCalls=new Map();
 api.on('tool_result_persist',(event,ctx)=>{
  const call=listCalls.get(event.toolCallId??event.message?.toolCallId);
  if(!['cancel_after_list','revoke_after_list'].includes(${JSON.stringify(scenario)})||faultSent||!call||ctx.sessionKey!==call.sessionKey||event.isSynthetic===true)return;
  faultSent=true;record({name:'fault_boundary_start',registrationId,phase:'tool_result_persist',callId:event.toolCallId,sessionId:call.sessionId,sourceMarker:JSON.stringify(event.message).includes(${JSON.stringify(SUPPLY_MARKER)})});
  let result;
  if(${JSON.stringify(scenario)}==='cancel_after_list') result={kind:${JSON.stringify(scenario)},phase:'tool_result_persist',atUtc:new Date().toISOString(),accepted:abortAgentHarnessRun(call.sessionId),sessionId:call.sessionId};
  else {const file=${JSON.stringify(syntheticPolicyPath)},policy=JSON.parse(readFileSync(file,'utf8'));policy.readPurposes=[];delete policy.version;writeFileSync(file,JSON.stringify(policy));result={kind:${JSON.stringify(scenario)},phase:'tool_result_persist',atUtc:new Date().toISOString(),policyPath:${JSON.stringify(policyEntry.locator.path)},readPurposes:[],publishedCheckpoint:false,qualification:'Synthetic source policy edit, not a published policy/CAS migration'};}
  record({name:'fault_boundary_complete',registrationId,result});
 },{priority:10000});
 core.register({...api,on(name,handler,options){api.on(name,(event,ctx)=>{
  const before = {name,registrationId,runId:ctx.runId??event.runId,sessionId:ctx.sessionId,sessionKey:ctx.sessionKey??event.sessionKey,
    senderIsOwner:event.senderIsOwner,requester:ctx.requester,toolCallId:ctx.toolCallId,toolName:event.toolName,
    historyCount:Array.isArray(event.messages)?event.messages.length:undefined,chatType:event.ctx?.ChatType,messageRole:event.message?.role,
    ingressBodyType:typeof event.ctx?.Body,ingressTimestamp:event.ctx?.Timestamp,ingressTimestampType:typeof event.ctx?.Timestamp};
  record({...before,phase:'before'}); const result=handler(event,ctx);const after=value=>{record({...before,phase:'after',result:value});return value;};return result&&typeof result.then==='function'?result.then(after):after(result);
 },options)},registerTool(factory,options){api.registerTool(ctx=>{
 const tool=typeof factory==='function'?factory(ctx):factory;
 if(!tool||Array.isArray(tool)||tool.name!=='stella_memory_data')return tool;
 return {...tool,async execute(...args){record({name:'tool_execute',callId:args[0],input:args[1],sessionId:ctx.sessionId,sessionKey:ctx.sessionKey,senderIsOwner:ctx.senderIsOwner,requesterSenderId:ctx.requesterSenderId});
 const result=await tool.execute(...args);record({name:'tool_result',result});if(args[1]?.action==='list')listCalls.set(args[0],{sessionId:ctx.sessionId,sessionKey:ctx.sessionKey});return result;}};
 },options)}});
}};`);
let child, client, provider, configuredCheckpoint, result = { attempt, compilation, scenario, sourceRevision: source.revision, sourceRoot: source.root, rawProviderRequests: [], events: [], passed: false };
const save = () => writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
const refreshFault = async () => {
  if (result.fault) return;
  const records = (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const fault = records.find(value => value.name === "fault_boundary_complete"); if (fault) result.fault = fault.result;
};
try {
  let count = 0, userRound = 1;
  const nextMarker = "SYNTHETIC_UPDATED_MEMORY_B_6147", nextAnswer = "SYNTHETIC_UPDATED_ANSWER_B_6147";
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.match(request.url, /gemini-3\.8-flash:streamGenerateContent/);
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), index = ++count; await refreshFault();
      assert.ok(index <= (scenario === "next_request" ? 9 : scenario === "history" ? 6 : 3), "Stock Host exceeded the exact synthetic model call budget");
      await writeFile(path.join(out, `provider-${index}.json`), body);
      result.rawProviderRequests.push({ index, path: request.url, bytes: Buffer.byteLength(body), atUtc: new Date().toISOString(), sourceMarker: body.includes(SUPPLY_MARKER), faultAlreadyApplied: Boolean(result.fault), userRound, updatedMemory: body.includes(nextMarker) });
      appendFileSync(logPath, JSON.stringify({ name: "provider_request", ...result.rawProviderRequests.at(-1) }) + "\n"); await save();
      if (scenario === "revoke_after_sent" && index === 2) {
        const policy = JSON.parse(await readFile(syntheticPolicyPath, "utf8")); policy.readPurposes = []; delete policy.version;
        await writeFile(syntheticPolicyPath, JSON.stringify(policy));
        result.fault = { kind: scenario, phase: "provider_received_request", atUtc: new Date().toISOString(), inFlightRequestIndex: index, publishedCheckpoint: false };
        appendFileSync(logPath, JSON.stringify({ name: "fault_boundary_complete", result: result.fault }) + "\n"); await save();
      }
      let parts;
      const stage = ["history", "next_request"].includes(scenario) ? (index - 1) % 3 + 1 : index;
      if (scenario === "next_request" && userRound === 3) {
        assert.ok(!body.includes(SUPPLY_MARKER) && !body.includes(nextMarker) && !body.includes(nextAnswer), "New denied request must contain no prior memory/history");
        parts = index === 7 ? [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }] : [{ text: "SYNTHETIC_CURRENT_POLICY_DENIED_6147" }];
      } else if (stage === 1) {
        assert.ok(!body.includes(SUPPLY_MARKER) && !body.includes("SYNTHETIC_STOCK_HOST_ANSWER_4931") && !body.includes(nextMarker) && !body.includes(nextAnswer), "Fresh model input must not inherit prior memory or answer");
        assert.ok(JSON.stringify(input.tools).includes("stella_memory_data"));
        if (scenario === "revoke_before_list") {
          const policy = JSON.parse(await readFile(syntheticPolicyPath, "utf8")); policy.readPurposes = []; delete policy.version;
          await writeFile(syntheticPolicyPath, JSON.stringify(policy));
          result.fault = { kind: scenario, phase: "before_tool_response", atUtc: new Date().toISOString(), publishedCheckpoint: false };
        }
        if (scenario === "source_before_list") {
          await writeFile(path.join(source.root, source.archive.payload.path), "SYNTHETIC_REPLACEMENT_AFTER_FIRST_MODEL_INPUT");
          result.fault = { kind: scenario, atUtc: new Date().toISOString(), payloadPath: source.archive.payload.path, publishedCheckpoint: false };
        }
        if (scenario === "cas_before_list") {
          const { createCheckpointPluginRuntime, parseCheckpointPluginConfig } = await import(pathToFileURL(path.join(compiled, "src/openclaw/checkpoint-plugin-runtime.js")));
          const { CatalogReader } = await import(pathToFileURL(path.join(compiled, "src/canghai/catalog-reader.js")));
          const { prepareHostRequestArchive } = await import(pathToFileURL(path.join(compiled, "src/canghai/host-request-archive.js")));
          const { snapshotTurnRequest } = await import(pathToFileURL(path.join(compiled, "src/openclaw/turn-request.js")));
          const writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(configuredCheckpoint), "2026.8.2");
          try {
            const recovery = await writer.capture(), request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-independent-writer", sessionKey: "agent:synthetic:other",
              prompt: "SYNTHETIC_INDEPENDENT_ARCHIVE_B", senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-independent-writer");
            const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2020-01-02T00:00:00Z" }, { ...source.binding.archive, ownerId: "owner-fixture" });
            const accepted = await writer.archiveLocal({ recovery, reader: await CatalogReader.load(source.root, source.catalogPath), archive, operationId: "synthetic-independent-CAS-B", purpose: source.binding.purpose });
            result.fault = { kind: scenario, atUtc: new Date().toISOString(), before: recovery.expected, after: accepted.authority };
            assert.notEqual(accepted.authority.token, recovery.expected.token); assert.notEqual(accepted.authority.revision, source.revision);
          } finally { writer.close(); }
        }
        parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }];
      } else if (["cas_before_list", "source_before_list", "revoke_before_list"].includes(scenario)) {
        assert.ok(!body.includes(SUPPLY_MARKER)); parts = [{ text: "SYNTHETIC_REFUSED_SOURCE_DRAFT_4931" }];
      } else if (scenario === "revoke_after_sent") {
        parts = [{ text: "SYNTHETIC_STOCK_HOST_ANSWER_4931: Preserve unresolved questions." }];
      } else if (stage === 2) {
        assert.ok(body.includes(SUPPLY_MARKER));
        let handle = "E1";
        if (scenario === "next_request" && userRound === 2) {
          const output = input.contents.flatMap(item => item.parts ?? []).find(part => part.functionResponse)?.functionResponse.response.output;
          const list = JSON.parse(output); handle = list.items.find(item => item.preview.includes(nextMarker))?.handle;
          assert.ok(handle && body.includes(nextMarker), "Next request must list newly committed B");
        }
        parts = [{ functionCall: { name: "stella_memory_data", args: { action: "read", handle } } }];
      } else {
        assert.ok(body.includes(SUPPLY_MARKER) && body.includes('functionResponse'));
        if (scenario !== "revoke_after_list") assert.ok(body.includes('original'));
        parts = [{ text: scenario === "next_request" && userRound === 2 ? `${nextAnswer}: ${nextMarker}` : "SYNTHETIC_STOCK_HOST_ANSWER_4931: Preserve unresolved questions." }];
        if (scenario === "next_request" && userRound === 2) assert.ok(body.includes(nextMarker));
      }
      const output = { responseId: `synthetic-google-${index}`, modelVersion: "gemini-3.8-flash", candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify(output)}\n\n`);
    } catch (error) { result.providerError = String(error); response.statusCode = 500; response.end("synthetic probe refused"); }
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const allocator = net.createServer(); await new Promise(resolve => allocator.listen(0, "127.0.0.1", resolve)); const gatewayPort = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const token = randomBytes(32).toString("hex"), port = provider.address().port;
  const config = { logging: { level: "debug", file: path.join(out, "gateway.log") }, gateway: { mode: "local" }, memory: { search: { enabled: false } }, hooks: { internal: { enabled: false, entries: { "session-memory": { enabled: false } } } }, commands: { ownerAllowFrom: ["*"] }, agents: { ownership: "explicit", defaults: { model: { primary: "google/gemini-3.8-flash", fallbacks: [] }, thinkingDefault: "low" },
    entries: { synthetic: { workspace } } }, models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${port}`,
      models: [{ id: "gemini-3.8-flash", name: "Synthetic Google loopback", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } },
    plugins: { slots: { memory: "none" }, allow: ["stella-core", "google"], load: { paths: [plugin] }, entries: { "memory-core": { enabled: false }, "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority,
      canghaiRoot: source.root, dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools" } } } }, tools: { allow: ["stella_memory_data"] } };
  configuredCheckpoint = config.plugins.entries["stella-core"].config;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const sandbox = `(version 1)\n(allow default)\n(deny file-read* (subpath "/Users/zangtao"))\n(allow file-read-metadata (literal "/Users/zangtao") (literal "/Users/zangtao/Workspace") (literal "/Users/zangtao/Workspace/tower1229") (literal "/Users/zangtao/.nvm") (literal "/Users/zangtao/.nvm/versions") (literal "/Users/zangtao/.nvm/versions/node"))\n(allow file-read* (subpath ${JSON.stringify(root)}) (subpath "/Users/zangtao/.nvm/versions/node/v24.22.1"))\n(deny file-write* (subpath "/Users/zangtao"))\n(allow file-write* (subpath ${JSON.stringify(out)}) (subpath ${JSON.stringify(state)}) (subpath ${JSON.stringify(process.env.OPENCLAW_HOME)}))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(deny process-exec (literal "/bin/ps") (literal "/usr/bin/ps"))\n`;
  const profile = path.join(out, "host-sandbox.sb"); await writeFile(profile, sandbox);
  const env = { ...process.env, OPENCLAW_GATEWAY_PORT: String(gatewayPort), OPENCLAW_GATEWAY_TOKEN: token };
  const args = ["-f", profile, process.execPath, path.join(root, "node_modules/openclaw/openclaw.mjs"), "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--auth", "token", "--port", String(gatewayPort), "--ws-log", "compact"];
  child = spawn("/usr/bin/sandbox-exec", args, { cwd: out, env, stdio: ["ignore", "pipe", "pipe"] });
  result.gateway = { pid: child.pid, command: ["/usr/bin/sandbox-exec", ...args], port: gatewayPort, sandboxed: true }; await save();
  let output = ""; const capture = chunk => { output += String(chunk); appendFileSync(path.join(out, "gateway-live.log"), chunk); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_start_timeout")), 45000);
    const interval = setInterval(() => { if (output.includes("stella-core failed to load")) { clearTimeout(timer); clearInterval(interval); reject(new Error("isolated_core_plugin_load_failed")); } else if (output.includes("[gateway] ready")) { result.gateway.ready = true; clearTimeout(timer); clearInterval(interval); resolve(); } }, 100);
    child.once("exit", code => { clearTimeout(timer); clearInterval(interval); reject(new Error(`isolated_gateway_exited_${code}`)); });
  }).finally(async () => { await writeFile(path.join(out, "gateway-start.log"), output); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_connect_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); },
      onEvent(event) { result.events.push(event); } }); client.start();
  });
  result.initialized = await client.request("stella.checkpoint", { action: "initialize", revision: source.revision, operationId: "synthetic-stock-host-init" });
  result.freshSession = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply", reason: "new" });
  result.sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "Use the memory tool to recall my retained writing preference.", idempotencyKey: "synthetic-stock-host-one" });
  result.terminal = await client.request("agent.wait", { runId: result.sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
  result.status = await client.request("stella.checkpoint", { action: "status" });
  result.history = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
  await refreshFault();
  assert.equal(result.providerError, undefined); assert.equal(result.status.capabilities.full_memory, false);
  if (["normal", "history", "next_request"].includes(scenario)) {
    assert.equal(result.terminal.status, "ok", JSON.stringify(result.terminal)); assert.equal(count, 3);
    assert.ok(JSON.stringify(result.history).includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"));
    if (scenario === "history") {
      const sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "SYNTHETIC_REUSE_OLD_HISTORY_4931", idempotencyKey: "synthetic-stock-host-two" });
      const terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
      result.historyIsolation = { reusedTerminal: terminal, modelRequestsAfterReuse: count - 3 }; assert.equal(count, 3);
      const session = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply-next", reason: "new" });
      assert.notEqual(session.entry.sessionId, result.freshSession.entry.sessionId);
      const next = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply-next", message: "SYNTHETIC_NEW_FRESH_REQUEST_4931", idempotencyKey: "synthetic-stock-host-three" });
      result.historyIsolation.freshTerminal = await client.request("agent.wait", { runId: next.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
      assert.equal(result.historyIsolation.freshTerminal.status, "ok"); assert.equal(count, 6); result.historyIsolation.distinctPhysicalSession = true;
    }
    if (scenario === "next_request") {
      const { createCheckpointPluginRuntime, parseCheckpointPluginConfig } = await import(pathToFileURL(path.join(compiled, "src/openclaw/checkpoint-plugin-runtime.js")));
      const { CatalogReader } = await import(pathToFileURL(path.join(compiled, "src/canghai/catalog-reader.js")));
      const { prepareHostRequestArchive } = await import(pathToFileURL(path.join(compiled, "src/canghai/host-request-archive.js")));
      const { snapshotTurnRequest } = await import(pathToFileURL(path.join(compiled, "src/openclaw/turn-request.js")));
      const writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(configuredCheckpoint), "2026.8.2");
      try {
        const recovery = await writer.capture(), request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-writer-B", sessionKey: "agent:synthetic:archive-B",
          prompt: `${nextMarker}: Keep the author's concrete questions.`, senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-writer-B");
        const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2020-01-02T00:00:00Z" }, { ...source.binding.archive, ownerId: "owner-fixture" });
        const accepted = await writer.archiveLocal({ recovery, reader: await CatalogReader.load(source.root, source.catalogPath), archive, operationId: "synthetic-user-boundary-B", purpose: source.binding.purpose });
        assert.notEqual(accepted.authority.token, recovery.expected.token);
        result.nextRequest = { before: recovery.expected, publishedB: accepted, qualification: "Production Core archive/transaction/CAS writer over synthetic repository; no user data" };
        // Same logical key, official reset completed before chat.send. No history surgery.
        result.nextRequest.resetB = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply", reason: "new" });
        userRound = 2;
        const sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "Read my current retained writing preference.", idempotencyKey: "synthetic-stock-host-B" });
        result.nextRequest.sentB = sent;
        result.nextRequest.terminalB = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
        result.nextRequest.historyB = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
        assert.equal(result.nextRequest.terminalB.status, "ok"); assert.equal(count, 6);
        assert.ok(JSON.stringify(result.nextRequest.historyB).includes(nextAnswer));
        const firstB = await readFile(path.join(out, "provider-4.json"), "utf8");
        assert.ok(!firstB.includes(SUPPLY_MARKER) && !firstB.includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"));
        const current = await writer.capture(); assert.equal(current.expected.token, accepted.authority.token);
        const denied = await publishAgentSupplyPolicyDenial(source, configuredCheckpoint.checkpointStateDirectory, current);
        assert.ok(denied.authority && denied.authority.token !== current.expected.token);
        result.nextRequest.publishedC = { ...denied, qualification: "Test-only policy business plan; production transaction/journal/CAS, not a deployed policy editor" };
        result.nextRequest.resetC = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply", reason: "new" });
        userRound = 3;
        const blocked = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "What current memory may you read?", idempotencyKey: "synthetic-stock-host-C" });
        result.nextRequest.sentC = blocked;
        result.nextRequest.terminalC = await client.request("agent.wait", { runId: blocked.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
        result.nextRequest.historyC = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
        result.nextRequest.statusC = await client.request("stella.checkpoint", { action: "status" });
        assert.equal(result.nextRequest.statusC.authority.token, denied.authority.token);
        assert.equal(count, 8); assert.equal(result.nextRequest.terminalC.status, "ok");
        for (const i of [7, 8]) {
          const request = await readFile(path.join(out, `provider-${i}.json`), "utf8");
          assert.ok(!request.includes(SUPPLY_MARKER) && !request.includes(nextMarker) && !request.includes(nextAnswer));
        }
        result.nextRequest.boundariesVerified = { BLoaded: true, CPolicyAppliedBeforeFirstSupply: true, noOldHistoryInFreshInputs: true, resetBeforeSend: true };
      } finally { writer.close(); }
    }
    result.passed = true;
  } else {
    assert.ok(result.fault, "Synthetic fault must actually run");
    const publicEvents = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const next = result.rawProviderRequests.filter(value => value.index > 1);
    result.faultOutcome = { nextModelRequests: next.length, staleMarkerInNextRequests: next.some(value => value.sourceMarker),
      dataToolExecutions: publicEvents.filter(value => value.name === "tool_execute").length,
      successfulToolResults: publicEvents.filter(value => value.name === "tool_result").length,
      finalPayloadCancelled: publicEvents.some(value => value.name === "reply_payload_sending" && value.phase === "after" && value.result?.cancel === true),
      answerStoredInHistory: JSON.stringify(result.history).includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"),
      webchatDeltaWithAnswer: result.events.some(value => value.event === "chat" && value.payload?.state === "delta" && JSON.stringify(value).includes("SYNTHETIC_STOCK_HOST_ANSWER_4931")),
      webchatFinalWithAnswer: result.events.some(value => value.event === "chat" && value.payload?.state === "final" && JSON.stringify(value).includes("SYNTHETIC_STOCK_HOST_ANSWER_4931")),
      assistantWritesBlocked: publicEvents.filter(value => value.name === "before_message_write" && value.phase === "after" && value.result?.block).length,
      requestsStartedAfterFault: result.rawProviderRequests.filter(value => value.faultAlreadyApplied).length };
    if (scenario === "cancel_after_list") { assert.equal(result.fault.accepted, true); assert.equal(count, 1); assert.equal(result.faultOutcome.nextModelRequests, 0); result.passed = true; }
    else if (scenario === "revoke_after_sent") {
      assert.equal(count, 2); assert.equal(result.faultOutcome.requestsStartedAfterFault, 0); result.characterized = true;
      assert.equal(result.faultOutcome.webchatDeltaWithAnswer, false, "Already-sent response still reaches WebChat after policy edit");
      assert.equal(result.faultOutcome.webchatFinalWithAnswer, false); assert.equal(result.faultOutcome.answerStoredInHistory, false); result.passed = true;
    }
    else if (scenario === "revoke_after_list") {
      assert.equal(result.faultOutcome.successfulToolResults, 1); assert.equal(result.faultOutcome.finalPayloadCancelled, true);
      result.characterized = true; assert.equal(result.faultOutcome.staleMarkerInNextRequests, false, "Host still forwards previously released preview after policy edit; post-release zero-continuation guarantee not met"); result.passed = true;
    } else {
      if (scenario === "cas_before_list") assert.equal(result.faultOutcome.dataToolExecutions, 0);
      assert.equal(result.faultOutcome.successfulToolResults, 0); assert.equal(result.faultOutcome.staleMarkerInNextRequests, false);
      assert.equal(result.faultOutcome.finalPayloadCancelled, true); result.passed = true;
    }
  }
  result.scope = "Actual isolated installed Host Gateway and native Google Agent/tool loop, loopback fake model only; installed tree identity unverified, full_memory not accepted";
} catch (error) { result.error = { message: String(error), stack: error?.stack }; }
finally {
  client?.stop();
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
    result.gateway.exitCode = child.exitCode; result.gateway.signalCode = child.signalCode;
  }
  if (provider) await new Promise(resolve => provider.close(resolve));
  await rm(source.root, { recursive: true, force: true }); result.sourceFixtureRemoved = true;
  await save();
  const saved = JSON.parse(await readFile(ownerPath, "utf8")); if (saved.pid === process.pid) await rm(ownerPath);
  console.log(JSON.stringify({ passed: result.passed, error: result.error?.message, providerRequests: result.rawProviderRequests.length, result: path.join(out, "result.json") }));
}
if (!result.passed) process.exitCode = 1;
