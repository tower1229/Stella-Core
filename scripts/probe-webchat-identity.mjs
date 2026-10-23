import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Only the runner's fresh synthetic state and loopback are reachable. No real
// profile is fabricated in a hook or sent as a wire parameter.
const root = await realpath(process.cwd());
const art = await realpath(process.env.STELLA_IDENTITY_ARTIFACTS);
assert.equal(root, "/Users/zangtao/Workspace/tower1229/Stella-Core");
assert.equal(art, path.join(root, ".artifacts/suqing-batch16-20261023"));
const attempt = process.env.STELLA_IDENTITY_ATTEMPT ?? "a1"; assert.match(attempt, /^a[0-9]+$/);
const state = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH;
assert.equal(await realpath(state), path.join(art, "host-state-" + attempt));
assert.equal(configPath, path.join(state, "openclaw.json"));
for (const name of ["HOME", "OPENCLAW_HOME", "TMPDIR", "XDG_CACHE_HOME"]) assert.ok((await realpath(process.env[name])).startsWith(art + "/"));
const out = path.join(art, "host-identity-" + attempt); await mkdir(out, { mode: 0o700 });
const ownerFile = path.join(art, "identity-probe-owner.json");
await writeFile(ownerFile, JSON.stringify({ pid: process.pid, startedAtUtc: new Date().toISOString() }), { flag: "wx" });
const result = { startedAtUtc: new Date().toISOString(), passed: false, scope: "stock Host public WebChat ingress and diagnostic RPC; actual Core plus labeled observation wrapper; no profile injection", providerRequests: 0, providerRequestDetails: [], events: [] };
const save = () => writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
let provider, gateway, client, phase = "startup";
try {
  const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
  const workspace = path.join(out, "workspace"), plugin = path.join(out, "observer-plugin"), authority = path.join(out, "authority"), absentSource = path.join(out, "source-must-not-be-opened");
  for (const dir of [workspace, plugin, authority]) await mkdir(dir);
  for (const name of ["AGENTS", "SOUL", "USER", "IDENTITY", "MEMORY"]) await writeFile(path.join(workspace, name + ".md"), "Synthetic identity-only probe.\n");
  const manifest = JSON.parse(await readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
  await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "synthetic-webchat-identity-observer", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
  const entry = path.join(art, "compiled-a2/src/plugin.js");
  await writeFile(path.join(plugin, "index.mjs"), `import core from ${JSON.stringify(pathToFileURL(entry).href)};
export default {...core,register(api){const records=[],runtime=Object.create(api.runtime);let llmCalls=0,agentAdmissions=0;
Object.defineProperty(runtime,'llm',{value:{async complete(){llmCalls++;throw Error('Synthetic diagnostic forbids auxiliary LLM');}}});
const observed=Object.create(api);Object.defineProperty(observed,'runtime',{value:runtime});
Object.defineProperty(observed,'on',{value(name,handler,options){return api.on(name,async(event,ctx)=>{if(name==='before_agent_run')agentAdmissions++;
const record=name==='reply_dispatch'?{runId:event.runId,sessionKey:event.sessionKey,provider:event.ctx.Provider,surface:event.ctx.Surface,chatType:event.ctx.ChatType,senderPresent:Boolean(event.ctx.SenderId),profileActor:event.ctx.SessionCreation?.actor??null,admin:event.ctx.GatewayClientScopes?.includes('operator.admin')===true}:null;
const observedCtx=record?{...ctx,recordProcessed(outcome,options){record.category=options?.reason;return ctx.recordProcessed(outcome,options);}}:ctx;
const answer=await handler(event,observedCtx);if(record){record.handled=answer?.handled===true;records.push(record);}return answer;},options);}});
core.register(observed);
api.registerGatewayMethod('stella.syntheticIdentityProbe',({respond})=>respond(true,{records,llmCalls,agentAdmissions}),{scope:'operator.admin'});
}};`);
  provider = createServer(async (request, response) => {
    const index = ++result.providerRequests; let body = ""; for await (const chunk of request) body += chunk;
    const labeling = body.includes("You are labeling the supplied message, not participating in its conversation.");
    result.providerRequestDetails.push({ index, phase, method: request.url, labeling });
    await writeFile(path.join(out, "provider-" + index + ".json"), body);
    const reply = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Synthetic identity diagnostic" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    if (request.url.includes("streamGenerateContent")) { response.setHeader("content-type", "text/event-stream"); response.end("data: " + JSON.stringify(reply) + String.fromCharCode(10, 10)); }
    else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(reply)); }
    await save();
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const allocate = createServer(); await new Promise(resolve => allocate.listen(0, "127.0.0.1", resolve)); const port = allocate.address().port; await new Promise(resolve => allocate.close(resolve));
  const token = randomBytes(32).toString("hex");
  const config = { gateway: { mode: "local" }, logging: { level: "info", file: path.join(out, "gateway.log") }, memory: { search: { enabled: false } }, hooks: { internal: { enabled: false } },
    agents: { ownership: "explicit", defaults: { model: { primary: "google/gemini-3.8-flash", fallbacks: [] }, thinkingDefault: "low" }, entries: { synthetic: { workspace } } },
    models: { providers: { google: { api: "google-generative-ai", apiKey: "synthetic-loopback-only", baseUrl: `http://127.0.0.1:${provider.address().port}`, models: [{ id: "gemini-3.8-flash", name: "Synthetic tripwire", reasoning: true, contextWindow: 1048576, maxTokens: 2048 }] } } },
    plugins: { slots: { memory: "none" }, allow: ["stella-core", "google"], load: { paths: [plugin] }, entries: { "memory-core": { enabled: false }, "stella-core": { enabled: true, hooks: { allowConversationAccess: true }, config: { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: authority, canghaiRoot: absentSource, agentId: "synthetic", dataMode: "local_write", requestArchive: "local", agentMemory: "fresh_tools", webchatOwnerProfileId: "synthetic-unselected-profile" } } } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  result.identity = { coreEntry: entry, compiledEntrySha256: createHash("sha256").update(await readFile(entry)).digest("hex"), hostVersion: "2026.8.2", node: process.version, syntheticConfigSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"), sourceDirectoryExists: false, sourceGrantCreated: false };
  const args = [path.join(root, "node_modules/openclaw/openclaw.mjs"), "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--auth", "token", "--port", String(port), "--ws-log", "compact"];
  gateway = spawn(process.execPath, args, { cwd: out, env: { ...process.env, OPENCLAW_GATEWAY_PORT: String(port), OPENCLAW_GATEWAY_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
  result.gateway = { pid: gateway.pid, port }; let output = "";
  const capture = chunk => { output += String(chunk); void appendFile(path.join(out, "gateway-live.log"), chunk); }; gateway.stdout.on("data", capture); gateway.stderr.on("data", capture);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { clearInterval(interval); reject(Error("isolated_gateway_start_timeout")); }, 45000);
    const interval = setInterval(() => { if (output.includes("stella-core failed to load")) { clearTimeout(timer); clearInterval(interval); reject(Error("plugin_load_failed")); } else if (output.includes("[gateway] ready")) { clearTimeout(timer); clearInterval(interval); resolve(); } }, 100);
    gateway.once("exit", code => { clearTimeout(timer); clearInterval(interval); reject(Error("gateway_exit_" + code)); }); });
  const uiResponse = await fetch(`http://127.0.0.1:${port}/control-ui-config.json`, { headers: { authorization: "Bearer " + token } });
  assert.equal(uiResponse.status, 200); const uiConfig = await uiResponse.json();
  result.uiCompatibility = { serverVersion: uiConfig.serverVersion, serverBuildId: uiConfig.serverBuildId };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deviceIdentity = { deviceId: createHash("sha256").update(publicKey.export({ type: "spki", format: "der" }).subarray(-32)).digest("hex"), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("isolated_webchat_connect_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, token, clientName: "openclaw-control-ui", clientVersion: uiConfig.serverVersion, clientBuildId: uiConfig.serverBuildId, mode: "webchat", role: "operator", scopes: ["operator.admin"], deviceIdentity, sharedStateMode: "read-only",
      hostDeps: { loadDeviceAuthToken: () => null, storeDeviceAuthToken() {}, clearDeviceAuthToken() {} },
      onHelloOk(hello) { clearTimeout(timer); result.hello = { methods: hello.features?.methods?.filter(name => name.startsWith("stella.")) }; resolve(); }, onConnectError(error) { clearTimeout(timer); reject(error); }, onEvent(event) { if (event.event === "chat") result.events.push({ event: event.event, state: event.payload?.state, runId: event.payload?.runId }); } }); client.start(); });
  phase = "identity_rpc";
  try { result.diagnostic = { ok: true, payload: await client.request("stella.identity", {}) }; } catch (error) { result.diagnostic = { ok: false, error: String(error) }; }
  assert.equal(result.providerRequests, 0); result.diagnosticProviderRequests = 0; phase = "chat";
  const key = "agent:synthetic:dashboard:synthetic-identity-new";
  await client.request("sessions.reset", { key, reason: "new" });
  result.sent = await client.request("chat.send", { sessionKey: key, message: "Synthetic identity admission only.", idempotencyKey: "synthetic-webchat-identity-once" });
  for (let index = 0; index < 50; index++) { result.observation = await client.request("stella.syntheticIdentityProbe", {}); if (result.observation.records.length) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const observed = result.observation; assert.equal(observed.records.length, 1); assert.equal(observed.records[0].handled, true);
  assert.ok(["checkpoint_webchat_profile_required", "checkpoint_webchat_profile_not_bound"].includes(observed.records[0].category));
  assert.equal(observed.records[0].senderPresent, false); assert.equal(observed.records[0].admin, true);
  assert.equal(observed.records[0].provider, "webchat"); assert.equal(observed.records[0].chatType, "direct");
  assert.equal(observed.llmCalls, 0); assert.equal(observed.agentAdmissions, 0);
  assert.equal(await readFile(path.join(authority, "checkpoint.json")).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error)), false);
  result.coreAdmissionPassed = true;
} catch (error) { result.error = { message: String(error), stack: error?.stack }; }
finally {
  client?.stop();
  if (gateway) { if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGTERM"); if (gateway.exitCode === null && gateway.signalCode === null) await Promise.race([new Promise(resolve => gateway.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (gateway.exitCode === null && gateway.signalCode === null) { gateway.kill("SIGKILL"); await new Promise(resolve => gateway.once("exit", resolve)); } result.gateway.exitCode = gateway.exitCode; result.gateway.signalCode = gateway.signalCode; }
  if (provider) await new Promise(resolve => provider.close(resolve));
  result.passed = result.coreAdmissionPassed === true && !result.error && result.diagnosticProviderRequests === 0 && result.providerRequests <= 2 &&
    result.providerRequestDetails.every(call => call.phase === "chat" && call.labeling);
  result.backgroundTitleScope = "Captured Host-owned dashboard label calls are separate from Core policy and Agent execution; no claim that reply_dispatch stops them.";
  result.endedAtUtc = new Date().toISOString(); await save(); await rm(ownerFile);
  console.log(JSON.stringify({ passed: result.passed, error: result.error?.message, providerRequests: result.providerRequests, result: path.join(out, "result.json") }));
}
if (!result.passed) process.exitCode = 1;
