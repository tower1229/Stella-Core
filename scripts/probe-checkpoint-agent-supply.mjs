import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes, createHash, generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Started by the local runner with an allow-listed environment, before SDK imports.
const root = await realpath(process.cwd());
assert.equal(root, "/Users/zangtao/Workspace/tower1229/Stella-Core");
const attempt = process.argv[2], compilation = process.argv[3], requestedScenario = process.argv[4] ?? "normal";
const scenario = requestedScenario === "history" ? "continuous_chat" : requestedScenario;
assert.ok(["normal", "history", "cancel_after_list", "revoke_after_list", "cas_before_list", "source_before_list", "revoke_before_list", "revoke_after_sent", "next_request", "materialization", "automatic_archive", "continuous_chat"].includes(scenario));
assert.match(attempt ?? "", /^[a-z][a-z0-9]{0,15}$/); assert.match(compilation ?? "", /^a[0-9]+$/);
const art = path.resolve(process.env.STELLA_AGENT_SUPPLY_ARTIFACTS ?? path.join(root, ".artifacts/suqing-batch6-20261022"));
assert.ok(art.startsWith(path.join(root, ".artifacts/suqing-batch")) && await realpath(art) === art);
const out = path.join(art, "host-probe-" + attempt);
await mkdir(out, { mode: 0o700 });
const ownerPath = path.join(art, "host-probe-owner.json"), owner = { pid: process.pid, attempt, startedAtUtc: new Date().toISOString() };
const compiled = path.resolve(process.env.STELLA_AGENT_SUPPLY_COMPILED ?? path.join(art, "compiled-" + compilation));
assert.ok(compiled.startsWith(path.join(root, ".artifacts/suqing-batch")) && await realpath(compiled) === compiled);
await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx" });
const { createAgentSupplySource, publishAgentSupplySourceRevision, publishAgentSupplyPolicyDenial, SUPPLY_MARKER, BOOTSTRAP_MARKER, SKILL_MARKER } = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-agent-supply-fixture.js")));
const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
const source = await createAgentSupplySource({ materialization: scenario === "materialization" }), authority = path.join(out, "authority"), workspace = path.join(out, "workspace"), plugin = path.join(out, "plugin");
const state = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH;
assert.ok(state?.startsWith(art + "/") && configPath?.startsWith(state + "/"));
const cache = process.env.XDG_CACHE_HOME;
assert.ok(cache && path.isAbsolute(cache) && cache.startsWith(state + "/") && await realpath(cache) === cache,
  "The stock SQLite worker requires an isolated public XDG_CACHE_HOME before SDK imports");
for (const dir of [authority, workspace, plugin, state, process.env.OPENCLAW_HOME]) await mkdir(dir, { recursive: true });
if (scenario !== "materialization") for (const name of ["AGENTS", "SOUL", "IDENTITY", "USER", "MEMORY"]) await writeFile(path.join(workspace, name + ".md"), `# Synthetic ${name}\nIsolated stock Host acceptance; no private material.\n`);
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
import { getSessionEntry, resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';
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
  const entry = ${JSON.stringify(scenario)}==='continuous_chat' && name==='before_agent_run' && ctx.sessionKey ? getSessionEntry({agentId:'synthetic',sessionKey:ctx.sessionKey,storePath:resolveStorePath(api.runtime.config.current().session?.store,{agentId:'synthetic',env:{OPENCLAW_STATE_DIR:api.runtime.state.resolveStateDir()}}),env:{OPENCLAW_STATE_DIR:api.runtime.state.resolveStateDir()},readConsistency:'latest',hydrateSkillPromptRefs:false}) : undefined;
  const before = {name,registrationId,hostSessionId:entry?.sessionId,hostLifecycleRevision:entry?.lifecycleRevision??null,runId:ctx.runId??event.runId,sessionId:ctx.sessionId,sessionKey:ctx.sessionKey??event.sessionKey,
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
  const revisedMarker = "SYNTHETIC_REVISED_PREFERENCE_B_5281", revisedText = `${revisedMarker}: Write concrete open questions first.`;
  const automaticMarker = "SYNTHETIC_AUTOMATIC_OWNER_INPUT_7296", automaticInput = `${automaticMarker}: Preserve the author's concrete questions.`;
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.match(request.url, /gemini-3\.8-flash:streamGenerateContent/);
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), index = ++count; await refreshFault();
      assert.ok(index <= (scenario === "continuous_chat" ? 9 : scenario === "automatic_archive" ? 6 : scenario === "materialization" ? 8 : scenario === "next_request" ? 9 : scenario === "history" ? 6 : 3), "Stock Host exceeded the exact synthetic model call budget");
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
      const stage = scenario === "materialization" ? (index - 1) % 4 + 1 : ["history", "next_request", "automatic_archive", "continuous_chat"].includes(scenario) ? (index - 1) % 3 + 1 : index;
      if (scenario === "continuous_chat") {
        const outputs = input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output).map(part => { try { return JSON.parse(part.functionResponse.response.output); } catch { return null; } }).filter(Boolean);
        assert.ok(body.includes("history records what was said") && body.includes("not proof of current facts"));
        if (stage === 1) {
          const checkpoint = JSON.parse(await readFile(path.join(authority, "checkpoint.json"), "utf8"));
          result.continuousProviderStarts ??= []; result.continuousProviderStarts.push({ userRound, index, checkpoint });
          if (userRound > 1) assert.ok(body.includes(SUPPLY_MARKER) && body.includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"), "Past conversation should remain in the actual Host input");
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }];
        } else if (stage === 2) {
          const list = outputs.filter(value => Array.isArray(value.items)).at(-1), marker = userRound === 1 ? SUPPLY_MARKER : revisedMarker;
          assert.ok(list && list.currentMemory.userRequest === (userRound === 1 ? "synthetic-stock-host-one" : `synthetic-continuous-${userRound}`));
          const selected = list.items.find(item => item.preview.includes(marker)); assert.ok(selected, "Current list must contain the current source version");
          if (userRound > 1) assert.ok(!JSON.stringify(list).includes(SUPPLY_MARKER), "Current list must not re-serve revised A from history");
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "read", handle: selected.handle } } }];
        } else {
          const output = outputs.filter(value => value.original).at(-1), marker = userRound === 1 ? SUPPLY_MARKER : revisedMarker;
          assert.ok(output && output.original.text.includes(marker)); assert.equal(output.currentMemory.userRequest, userRound === 1 ? "synthetic-stock-host-one" : `synthetic-continuous-${userRound}`);
          assert.equal(output.currentMemory.checkpointRevision, result.continuousProviderStarts.at(-1).checkpoint.revision);
          if (userRound > 1) assert.ok(!JSON.stringify(output).includes(SUPPLY_MARKER));
          parts = [{ text: `SYNTHETIC_STOCK_HOST_ANSWER_4931: round ${userRound} current ${marker}` }];
        }
      } else if (scenario === "automatic_archive") {
        if (stage === 1) {
          assert.ok(!body.includes(SUPPLY_MARKER) && !body.includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"));
          if (userRound === 2) assert.ok(!body.includes(automaticMarker), "Reset request cannot inherit archived prior input through chat history");
          const snapshot = JSON.parse(await readFile(path.join(authority, "checkpoint.json"), "utf8"));
          result.automaticProviderStarts ??= []; result.automaticProviderStarts.push({ userRound, index, atUtc: new Date().toISOString(), checkpoint: snapshot });
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }];
        } else if (stage === 2) {
          const outputs = input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output).map(part => { try { return JSON.parse(part.functionResponse.response.output); } catch { return null; } });
          const selected = outputs.find(value => Array.isArray(value?.items))?.items.find(item => item.preview.includes(automaticMarker));
          assert.ok(selected, "Automatically archived real Host input must be listed");
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "read", handle: selected.handle } } }];
        } else {
          const originals = input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output).map(part => { try { return JSON.parse(part.functionResponse.response.output)?.original; } catch { return null; } }).filter(Boolean);
          assert.equal(originals.length, 1); assert.equal(originals[0].text, automaticInput); assert.equal(originals[0].role, "owner");
          assert.equal(originals[0].sourceAdapterId, "openclaw-reply-dispatch-2026.8.2");
          parts = [{ text: `SYNTHETIC_STOCK_HOST_ANSWER_4931: ${automaticMarker}` }];
        }
      } else if (scenario === "materialization") {
        for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]) assert.ok(body.includes(`${BOOTSTRAP_MARKER}_${file}`), `Host omitted materialized ${file}`);
        assert.ok(body.includes("stella-initialization-probe") && body.includes("Managed skill catalogue") && body.includes("Synthetic initialization acceptance only."), "Public Core hook must expose the verified managed skill catalogue");
        if (stage === 1) {
          assert.ok(!body.includes(SKILL_MARKER) && !body.includes(SUPPLY_MARKER) && !body.includes(nextMarker) && !body.includes("SYNTHETIC_STOCK_HOST_ANSWER_4931") && !body.includes(nextAnswer), "New request may use installed behavior, not prior tool history");
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "skill", handle: "stella-initialization-probe" } } }];
        } else if (stage === 2) {
          assert.ok(body.includes(SKILL_MARKER) && body.includes("functionResponse"));
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }];
        } else if (stage === 3) {
          assert.ok(body.includes(SKILL_MARKER) && body.includes(SUPPLY_MARKER));
          const output = input.contents.flatMap(item => item.parts ?? []).filter(part => part.functionResponse?.response?.output).map(part => part.functionResponse.response.output).map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => Array.isArray(value?.items));
          const item = output.items.find(item => item.preview.includes(userRound === 2 ? nextMarker : SUPPLY_MARKER)); assert.ok(item);
          parts = [{ functionCall: { name: "stella_memory_data", args: { action: "read", handle: item.handle } } }];
        } else {
          assert.ok(body.includes(SKILL_MARKER) && body.includes("original") && body.includes(userRound === 2 ? nextMarker : SUPPLY_MARKER));
          parts = [{ text: userRound === 2 ? `${nextAnswer}: ${nextMarker}` : "SYNTHETIC_STOCK_HOST_ANSWER_4931: Preserve unresolved questions." }];
        }
      } else if (scenario === "next_request" && userRound === 3) {
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
    entries: { synthetic: { workspace, ...scenario === "materialization" ? { identity: { name: `${BOOTSTRAP_MARKER}_IDENTITY.md`, theme: "Isolated local acceptance", emoji: "🧪" } } : {} } } }, models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${port}`,
      models: [{ id: "gemini-3.8-flash", name: "Synthetic Google loopback", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } },
    plugins: { slots: { memory: "none" }, allow: ["stella-core", "google"], load: { paths: [plugin] }, entries: { "memory-core": { enabled: false }, "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority,
      canghaiRoot: source.root, dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools", ...["automatic_archive", "continuous_chat"].includes(scenario) ? { requestArchive: "local" } : {} } } } }, tools: { allow: ["stella_memory_data"] } };
  configuredCheckpoint = config.plugins.entries["stella-core"].config;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const sandbox = `(version 1)\n(allow default)\n(deny file-read* (subpath "/Users/zangtao"))\n(allow file-read-metadata (literal "/Users/zangtao") (literal "/Users/zangtao/Workspace") (literal "/Users/zangtao/Workspace/tower1229") (literal "/Users/zangtao/.nvm") (literal "/Users/zangtao/.nvm/versions") (literal "/Users/zangtao/.nvm/versions/node"))\n(allow file-read* (subpath ${JSON.stringify(root)}) (subpath "/Users/zangtao/.nvm/versions/node/v24.22.1"))\n(deny file-write* (subpath "/Users/zangtao"))\n(allow file-write* (subpath ${JSON.stringify(out)}) (subpath ${JSON.stringify(state)}) (subpath ${JSON.stringify(process.env.OPENCLAW_HOME)}))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(deny process-exec (literal "/bin/ps") (literal "/usr/bin/ps"))\n`;
  const profile = path.join(out, "host-sandbox.sb"); await writeFile(profile, sandbox);
  const env = { ...process.env, OPENCLAW_GATEWAY_PORT: String(gatewayPort), OPENCLAW_GATEWAY_TOKEN: token };
  const args = ["-f", profile, process.execPath, path.join(root, "node_modules/openclaw/openclaw.mjs"), "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--auth", "token", "--port", String(gatewayPort), "--ws-log", "compact"];
  let gatewayStarts = 0;
  const startGateway = async () => {
  child = spawn("/usr/bin/sandbox-exec", args, { cwd: out, env, stdio: ["ignore", "pipe", "pipe"] });
  result.gateway = { startIndex: gatewayStarts++, pid: child.pid, command: ["/usr/bin/sandbox-exec", ...args], port: gatewayPort, sandboxed: true }; (result.gatewayRuns ??= []).push(result.gateway); await save();
  let output = ""; const capture = chunk => { output += String(chunk); appendFileSync(path.join(out, "gateway-live.log"), chunk); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_start_timeout")), 45000);
    const interval = setInterval(() => { if (output.includes("stella-core failed to load")) { clearTimeout(timer); clearInterval(interval); reject(new Error("isolated_core_plugin_load_failed")); } else if (output.includes("[gateway] ready")) { result.gateway.ready = true; clearTimeout(timer); clearInterval(interval); resolve(); } }, 100);
    child.once("exit", code => { clearTimeout(timer); clearInterval(interval); reject(new Error(`isolated_gateway_exited_${code}`)); });
  }).finally(async () => { await writeFile(path.join(out, `gateway-start-${result.gateway.startIndex}.log`), output); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_connect_timeout")), 15000);
    let deviceIdentity = null;
    if (scenario === "continuous_chat") {
      // Satisfy the public idempotent-create identity requirement with an isolated
      // in-memory test key. Never load/store a real device identity or auth token.
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
      const deviceId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" }).subarray(-32)).digest("hex");
      deviceIdentity = { deviceId, publicKeyPem, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
      result.syntheticClientIdentity = { deviceId, privateKeyStorage: "memory_only", clientDeviceAuthTokenPersistence: false, scopesUnchanged: ["operator.admin"] };
    }
    client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity,
      hostDeps: scenario === "continuous_chat" ? { loadDeviceAuthToken: () => null, storeDeviceAuthToken() {}, clearDeviceAuthToken() {} } : undefined,
      onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); },
      onEvent(event) { result.events.push(event); } }); client.start();
  });
  };
  const stopGatewayForRefresh = async () => {
    client?.stop(); client = undefined;
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
    }
    result.gateway.exitCode = child.exitCode; result.gateway.signalCode = child.signalCode;
    assert.equal(child.exitCode, 0); child = undefined; await save();
  };
  await startGateway();
  result.initialized = await client.request("stella.checkpoint", { action: "initialize", revision: source.revision, operationId: "synthetic-stock-host-init" });
  if (scenario === "materialization") {
    result.workspaceBefore = {};
    for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "skills/stella-initialization-probe/SKILL.md"]) {
      result.workspaceBefore[name] = await readFile(path.join(workspace, name), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    }
    assert.ok(Object.values(result.workspaceBefore).every(value => value === null), "Core must not adopt pre-created Host templates");
    try { result.materialization = await client.request("stella.checkpoint", { action: "materialize" }); }
    catch (error) {
      // A single normal lifecycle comparison, never a private cache reset or
      // permission change. Preserve and retry the exact Core pending operation.
      assert.match(String(error), /skill_unavailable_or_shadowed/);
      const pending = await readFile(path.join(authority, "initialization/pending.json"), "utf8"), plan = JSON.parse(pending);
      await writeFile(path.join(out, "initialization-pending-before-refresh.json"), pending);
      assert.equal(plan.sourceRevision, source.revision);
      result.initializationRefresh = { initialRefusal: String(error), originalOperationId: plan.operationId, method: "stop and start this same isolated Gateway with unchanged config/source/state", atUtc: new Date().toISOString() };
      await stopGatewayForRefresh(); await startGateway();
      result.materialization = await client.request("stella.checkpoint", { action: "materialize" });
      assert.equal(result.materialization.materialized.receipt.operationId, plan.operationId);
      result.initializationRefresh.resumedOriginalOperation = true;
    }
    assert.equal(result.materialization.materialized.receipt.files.length, 6);
    assert.equal(result.materialization.consumed, false); assert.equal(result.materialization.capabilities.full_memory, false);
    result.materializedFiles = {};
    for (const file of result.materialization.materialized.receipt.files) {
      const bytes = await readFile(path.join(workspace, file.target));
      const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex"); assert.equal(sha256, file.hash);
      result.materializedFiles[file.target] = { sha256, bytes: bytes.length, text: bytes.toString("utf8") };
    }
    const receipt = result.materialization.materialized.receipt, plan = await readFile(path.join(result.materialization.materialized.stateRoot, `operations/${receipt.operationId}.json`), "utf8");
    await writeFile(path.join(out, "initialization-operation.json"), plan);
    await writeFile(path.join(out, "materialized-files.json"), JSON.stringify(result.materializedFiles, null, 2));
  }
  if (["automatic_archive", "continuous_chat"].includes(scenario)) result.beforeAutomaticArchive = await client.request("stella.checkpoint", { action: "status" });
  if (scenario === "continuous_chat") {
    result.createdSession = await client.request("sessions.create", { key: "agent:synthetic:fresh-supply", agentId: "synthetic", idempotencyKey: "synthetic-continuous-create" });
    assert.equal(result.createdSession.ok, true); assert.equal(result.createdSession.key, "agent:synthetic:fresh-supply");
    assert.ok(!result.createdSession.runStarted && !result.createdSession.runId);
    result.freshSession = { method: "public sessions.create once; no initial turn or transcript copy", key: result.createdSession.key, resets: 0 };
  } else result.freshSession = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply", reason: "new" });
  result.sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: scenario === "automatic_archive" ? automaticInput : "Use the memory tool to recall my retained writing preference.", idempotencyKey: "synthetic-stock-host-one" });
  result.terminal = await client.request("agent.wait", { runId: result.sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
  result.status = await client.request("stella.checkpoint", { action: "status" });
  result.history = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
  await refreshFault();
  assert.equal(result.providerError, undefined); assert.equal(result.status.capabilities.full_memory, false);
  if (["normal", "history", "next_request", "materialization", "automatic_archive", "continuous_chat"].includes(scenario)) {
    assert.equal(result.terminal.status, "ok", JSON.stringify(result.terminal)); assert.equal(count, scenario === "materialization" ? 4 : 3);
    assert.ok(JSON.stringify(result.history).includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"));
    if (scenario === "continuous_chat") {
      const run = promisify(execFile), git = async (...args) => (await run("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", source.root, ...args])).stdout.trim();
      const first = { sent: result.sent, terminal: result.terminal, status: result.status, history: result.history };
      assert.equal(first.status.ingress.state, "local_committed"); assert.equal(first.status.mode, "experimental_owner_chat");
      assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), "1");
      result.continuousChat = { rounds: [first], resets: 0, directKernelArchiveCalledByHarness: false, sourceFileRevisionFixture: true };
      const { createCheckpointPluginRuntime, parseCheckpointPluginConfig } = await import(pathToFileURL(path.join(compiled, "src/openclaw/checkpoint-plugin-runtime.js")));
      const writer = await createCheckpointPluginRuntime(parseCheckpointPluginConfig(configuredCheckpoint), "2026.8.2");
      try { result.continuousChat.sourceRevision = await publishAgentSupplySourceRevision(source, authority, await writer.capture(), revisedText); }
      finally { writer.close(); }
      assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), "2");
      for (const round of [2, 3]) {
        userRound = round;
        const sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: round === 2 ? "Continue our conversation: what is my current writing preference?" : "Use that current preference and keep our discussion context.", idempotencyKey: `synthetic-continuous-${round}` });
        const terminal = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
        const status = await client.request("stella.checkpoint", { action: "status" }), history = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 80 });
        assert.equal(terminal.status, "ok"); assert.equal(status.ingress.state, "local_committed"); assert.equal(count, round * 3);
        assert.equal(history.sessionId, first.history.sessionId);
        assert.equal(await git("rev-list", "--count", `${source.revision}..HEAD`), String(round + 1));
        result.continuousChat.rounds.push({ sent, terminal, status, history });
      }
      assert.equal(result.providerError, undefined); assert.equal(count, 9);
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const admissions = records.filter(value => value.name === "before_agent_run" && value.phase === "before");
      assert.ok(admissions.some(value => value.historyCount > 0));
      result.continuousChat.historyCounts = admissions.map(value => value.historyCount);
      result.continuousChat.sessionObservations = admissions.map(value => ({sessionId:value.hostSessionId,lifecycleRevision:value.hostLifecycleRevision}));
      assert.ok(result.continuousChat.sessionObservations.length >= 3);
      for (const value of result.continuousChat.sessionObservations) assert.deepEqual(value, result.continuousChat.sessionObservations[0]);
      result.continuousChat.commits = (await git("rev-list", "--reverse", `${source.revision}..HEAD`)).split("\n"); assert.equal(result.continuousChat.commits.length, 4);
      for (let i = 0; i < 3; i++) {
        const round = result.continuousChat.rounds[i], checkpoint = result.continuousProviderStarts[i].checkpoint;
        assert.equal(checkpoint.revision, round.status.authority.revision); assert.equal(checkpoint.token, round.status.authority.token);
        const operationId = round.status.ingress.operationId;
        await writeFile(path.join(out, `${operationId}.checkpoint.json`), await readFile(path.join(source.root, path.dirname(source.catalogPath), "operations", `${operationId}.checkpoint.json`), "utf8"));
      }
      result.continuousChat.boundariesVerified = { threeSameOwnerSameSessionRequests: true, noResetOrGatewayRestart: true, oneArchivePerUserRequest: true,
        currentToolsServeRevisedB: true, oldAStillInHistoryInput: true, perRequestCheckpointProvenance: true, nativeHostContextRetained: true, notSemanticQualityAcceptance: true };
    }
    if (scenario === "automatic_archive") {
      const run = promisify(execFile), git = async (...args) => (await run("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", source.root, ...args])).stdout.trim();
      const before = result.beforeAutomaticArchive.authority;
      assert.equal(result.status.ingress.state, "local_committed", JSON.stringify(result.status.ingress));
      assert.equal(result.status.ingress.capturedAtSource, "core_receive_clock");
      assert.equal(result.automaticProviderStarts[0].checkpoint.revision, result.status.authority.revision);
      assert.equal(result.automaticProviderStarts[0].checkpoint.token, result.status.authority.token);
      assert.notEqual(result.status.authority.revision, before.revision); assert.notEqual(result.status.authority.token, before.token);
      assert.equal(await git("rev-list", "--count", `${before.revision}..HEAD`), "1");
      result.automaticArchive = { trigger: "Public chat.send → Core reply_dispatch owner archive → existing archiveCorrectionInput → Git/CAS → normal Host Agent/tools", before,
        afterFirst: result.status, directKernelArchiveCalledByHarness: false, firstInput: automaticInput };
      userRound = 2;
      result.automaticArchive.reset = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply", reason: "new" });
      result.automaticArchive.sentNext = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "Recall the writing preference I previously gave you.", idempotencyKey: "synthetic-stock-host-auto-next" });
      result.automaticArchive.terminalNext = await client.request("agent.wait", { runId: result.automaticArchive.sentNext.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
      result.automaticArchive.afterNext = await client.request("stella.checkpoint", { action: "status" });
      result.automaticArchive.historyNext = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
      assert.equal(result.automaticArchive.terminalNext.status, "ok"); assert.equal(count, 6); assert.equal(result.providerError, undefined);
      assert.equal(result.automaticArchive.afterNext.ingress.state, "local_committed");
      assert.equal(result.automaticProviderStarts[1].checkpoint.revision, result.automaticArchive.afterNext.authority.revision);
      assert.equal(result.automaticProviderStarts[1].checkpoint.token, result.automaticArchive.afterNext.authority.token);
      assert.notEqual(result.automaticArchive.afterNext.authority.token, result.status.authority.token);
      result.automaticArchive.commits = (await git("rev-list", "--reverse", `${before.revision}..HEAD`)).split("\n");
      assert.equal(result.automaticArchive.commits.length, 2);
      const catalog = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8")); assert.equal(catalog.sources.length, 3);
      result.automaticArchive.retainedInputs = [];
      for (const entry of catalog.sources) {
        const document = JSON.parse(await readFile(path.join(source.root, entry.locator.path), "utf8"));
        if (![result.sent.runId, result.automaticArchive.sentNext.runId].includes(document.origin.upstreamId)) continue;
        const snapshot = JSON.parse(await readFile(path.join(source.root, document.payloads[0].path), "utf8"));
        assert.equal(snapshot.request.hostMessageTimestamp, undefined); assert.equal(snapshot.request.senderIsOwner, true);
        result.automaticArchive.retainedInputs.push(snapshot);
      }
      assert.equal(result.automaticArchive.retainedInputs.length, 2);
      assert.equal(result.automaticArchive.retainedInputs.filter(value => value.request.prompt === automaticInput).length, 1);
      for (const status of [result.status, result.automaticArchive.afterNext]) {
        const operationId = status.ingress.operationId;
        const journal = await readFile(path.join(source.root, path.dirname(source.catalogPath), "operations", `${operationId}.checkpoint.json`), "utf8");
        await writeFile(path.join(out, `${operationId}.checkpoint.json`), journal);
      }
      await writeFile(path.join(out, "retained-owner-inputs.json"), JSON.stringify(result.automaticArchive.retainedInputs, null, 2));
      result.automaticArchive.boundariesVerified = { publicHostTriggered: true, kernelNotCalledByHarness: true, oneCommitPerUserRequest: true,
        toolsAndModelContinuationsAddNoCommits: true, nextRequestReadsPriorOwnerOriginal: true, noPriorToolHistoryAtNextRequest: true,
        noAssistantOutputRelabeledAsOwnerEvidence: true, receiveClockNotHostTimestamp: true };
    }
    if (["next_request", "materialization"].includes(scenario)) {
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
        if (scenario === "materialization") result.nextRequest.materializationAfterB = await client.request("stella.checkpoint", { action: "materialize" });
        // Same logical key, official reset completed before chat.send. No history surgery.
        result.nextRequest.resetB = await client.request("sessions.reset", { key: "agent:synthetic:fresh-supply", reason: "new" });
        userRound = 2;
        const sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "Read my current retained writing preference.", idempotencyKey: "synthetic-stock-host-B" });
        result.nextRequest.sentB = sent;
        result.nextRequest.terminalB = await client.request("agent.wait", { runId: sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
        result.nextRequest.historyB = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
        assert.equal(result.nextRequest.terminalB.status, "ok"); assert.equal(count, scenario === "materialization" ? 8 : 6);
        assert.ok(JSON.stringify(result.nextRequest.historyB).includes(nextAnswer));
        const firstB = await readFile(path.join(out, scenario === "materialization" ? "provider-5.json" : "provider-4.json"), "utf8");
        assert.ok(!firstB.includes(SUPPLY_MARKER) && !firstB.includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"));
        if (scenario === "materialization") {
          const last = await readFile(path.join(out, "provider-8.json"), "utf8");
          assert.ok(last.includes(SKILL_MARKER) && last.includes(nextMarker) && last.includes("original"));
          assert.equal(result.nextRequest.materializationAfterB.materialized.receipt.operationId, result.materialization.materialized.receipt.operationId);
          result.nextRequest.boundariesVerified = { installedBootstrapInActualModelInput: true, managedSkillCatalogueViaPublicHook: true, nativeReadPermissionExpanded: false, managedSkillBodyInActualModelInput: true, BOriginalInFinalModelInput: true, noPriorToolHistoryAtNewRequest: true, sameMaterializationUnchangedAfterMemoryOnlyB: true };
        } else {
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
        }
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
