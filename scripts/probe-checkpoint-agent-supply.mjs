import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Started by the local runner with an allow-listed environment, before SDK imports.
const root = await realpath(process.cwd());
assert.equal(root, "/Users/zangtao/Workspace/tower1229/Stella-Core");
const attempt = process.argv[2], compilation = process.argv[3];
assert.match(attempt ?? "", /^[a-z][a-z0-9]{0,15}$/); assert.match(compilation ?? "", /^a[0-9]+$/);
const art = path.join(root, ".artifacts/suqing-batch6-20261022"), out = path.join(art, "host-probe-" + attempt);
await mkdir(out, { mode: 0o700 });
const ownerPath = path.join(art, "host-probe-owner.json"), owner = { pid: process.pid, attempt, startedAtUtc: new Date().toISOString() };
await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx" });
const compiled = path.join(art, "compiled-" + compilation);
const { createAgentSupplySource, SUPPLY_MARKER } = await import(pathToFileURL(path.join(compiled, "tests/checkpoint-agent-supply-fixture.js")));
const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
const source = await createAgentSupplySource(), authority = path.join(out, "authority"), workspace = path.join(out, "workspace"), plugin = path.join(out, "plugin");
const state = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH;
assert.ok(state?.startsWith(art + "/") && configPath?.startsWith(state + "/"));
for (const dir of [authority, workspace, plugin, state, process.env.OPENCLAW_HOME]) await mkdir(dir, { recursive: true });
for (const name of ["AGENTS", "SOUL", "IDENTITY", "USER", "MEMORY"]) await writeFile(path.join(workspace, name + ".md"), `# Synthetic ${name}\nIsolated stock Host acceptance; no private material.\n`);
const logPath = path.join(out, "public-events.jsonl");
const manifest = JSON.parse(await readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify(manifest));
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "@synthetic/stella-stock-host-probe", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
// Instrument only public callback arguments/results. Preserve the Host envelope.
await writeFile(path.join(plugin, "index.mjs"), `import core from ${JSON.stringify(pathToFileURL(path.join(compiled, "src/plugin.js")).href)};
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value)+'\n');
export default {id:'stella-core',name:'Stella public supply probe',configSchema:core.configSchema,register(api){
 core.register({...api,on(name,handler,options){api.on(name,async(event,ctx)=>{
  const before = {name,runId:ctx.runId??event.runId,sessionId:ctx.sessionId,sessionKey:ctx.sessionKey??event.sessionKey,
    senderIsOwner:event.senderIsOwner,requester:ctx.requester,toolCallId:ctx.toolCallId,toolName:event.toolName,
    historyCount:Array.isArray(event.messages)?event.messages.length:undefined,chatType:event.ctx?.ChatType};
  record({...before,phase:'before'}); const result=await handler(event,ctx); record({...before,phase:'after',result});return result;
 },options)},registerTool(factory,options){api.registerTool(ctx=>{
 const tool=typeof factory==='function'?factory(ctx):factory;
 if(!tool||Array.isArray(tool)||tool.name!=='stella_memory_data')return tool;
 return {...tool,async execute(...args){record({name:'tool_execute',sessionId:ctx.sessionId,sessionKey:ctx.sessionKey,senderIsOwner:ctx.senderIsOwner,requesterSenderId:ctx.requesterSenderId});
 const result=await tool.execute(...args);record({name:'tool_result',result});return result;}};
 },options)}});
}};`);
let child, client, provider, result = { attempt, compilation, sourceRevision: source.revision, sourceRoot: source.root, rawProviderRequests: [], events: [], passed: false };
const save = () => writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
try {
  let count = 0;
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.match(request.url, /gemini-3\.8-flash:streamGenerateContent/);
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), index = ++count;
      assert.ok(index <= 3, "Stock Host exceeded the exact synthetic model call budget");
      await writeFile(path.join(out, `provider-${index}.json`), body);
      result.rawProviderRequests.push({ index, path: request.url, bytes: Buffer.byteLength(body) }); await save();
      let parts;
      if (index === 1) {
        assert.ok(JSON.stringify(input.tools).includes("stella_memory_data"));
        parts = [{ functionCall: { name: "stella_memory_data", args: { action: "list" } } }];
      } else if (index === 2) {
        assert.ok(body.includes(SUPPLY_MARKER)); parts = [{ functionCall: { name: "stella_memory_data", args: { action: "read", handle: "E1" } } }];
      } else {
        assert.ok(body.includes(SUPPLY_MARKER) && body.includes('original') && body.includes('functionResponse'));
        parts = [{ text: "SYNTHETIC_STOCK_HOST_ANSWER_4931: Preserve unresolved questions." }];
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
  const config = { gateway: { mode: "local" }, commands: { ownerAllowFrom: ["*"] }, agents: { ownership: "explicit", defaults: { model: { primary: "google/gemini-3.8-flash", fallbacks: [] }, thinkingDefault: "low" },
    entries: { synthetic: { workspace } } }, models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${port}`,
      models: [{ id: "gemini-3.8-flash", name: "Synthetic Google loopback", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }] } } },
    plugins: { allow: ["stella-core", "google"], load: { paths: [plugin] }, entries: { "stella-core": { enabled: true, config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority,
      canghaiRoot: source.root, dataMode: "local_write", agentId: "synthetic", agentMemory: "fresh_tools" } } } }, tools: { allow: ["stella_memory_data"] } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const sandbox = `(version 1)\n(allow default)\n(deny file-read* (subpath "/Users/zangtao"))\n(allow file-read-metadata (literal "/Users/zangtao") (literal "/Users/zangtao/Workspace") (literal "/Users/zangtao/Workspace/tower1229") (literal "/Users/zangtao/.nvm") (literal "/Users/zangtao/.nvm/versions") (literal "/Users/zangtao/.nvm/versions/node"))\n(allow file-read* (subpath ${JSON.stringify(root)}) (subpath "/Users/zangtao/.nvm/versions/node/v24.22.1"))\n(deny file-write* (subpath "/Users/zangtao"))\n(allow file-write* (subpath ${JSON.stringify(out)}) (subpath ${JSON.stringify(state)}) (subpath ${JSON.stringify(process.env.OPENCLAW_HOME)}))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(deny process-exec (literal "/bin/ps") (literal "/usr/bin/ps"))\n`;
  const profile = path.join(out, "host-sandbox.sb"); await writeFile(profile, sandbox);
  const env = { ...process.env, OPENCLAW_GATEWAY_PORT: String(gatewayPort), OPENCLAW_GATEWAY_TOKEN: token };
  const args = ["-f", profile, process.execPath, path.join(root, "node_modules/openclaw/openclaw.mjs"), "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--auth", "token", "--port", String(gatewayPort), "--ws-log", "compact"];
  child = spawn("/usr/bin/sandbox-exec", args, { cwd: out, env, stdio: ["ignore", "pipe", "pipe"] });
  result.gateway = { pid: child.pid, command: ["/usr/bin/sandbox-exec", ...args], port: gatewayPort, sandboxed: true }; await save();
  let output = ""; const capture = chunk => { output += String(chunk); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_start_timeout")), 45000);
    const interval = setInterval(() => { if (output.includes("listening on")) { clearTimeout(timer); clearInterval(interval); resolve(); } }, 100);
    child.once("exit", code => { clearTimeout(timer); clearInterval(interval); reject(new Error(`isolated_gateway_exited_${code}`)); });
  }).finally(async () => { await writeFile(path.join(out, "gateway-start.log"), output); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated_gateway_connect_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); },
      onEvent(event) { result.events.push(event); } }); client.start();
  });
  result.initialized = await client.request("stella.checkpoint", { action: "initialize", revision: source.revision, operationId: "synthetic-stock-host-init" });
  result.sent = await client.request("chat.send", { sessionKey: "agent:synthetic:fresh-supply", message: "Use the memory tool to recall my retained writing preference.", idempotencyKey: "synthetic-stock-host-one" });
  result.terminal = await client.request("agent.wait", { runId: result.sent.runId, timeoutMs: 60000 }, { timeoutMs: 65000 });
  result.status = await client.request("stella.checkpoint", { action: "status" });
  result.history = await client.request("chat.history", { sessionKey: "agent:synthetic:fresh-supply", limit: 30 });
  assert.equal(result.terminal.status, "ok", JSON.stringify(result.terminal)); assert.equal(count, 3); assert.equal(result.providerError, undefined);
  assert.ok(JSON.stringify(result.history).includes("SYNTHETIC_STOCK_HOST_ANSWER_4931"));
  assert.equal(result.status.capabilities.full_memory, false);
  result.passed = true;
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
