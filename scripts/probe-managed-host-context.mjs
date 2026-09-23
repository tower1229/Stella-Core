import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFixture, prepareInitializationFixture } from "../.test-dist/tests/consciousness-fixture.js";
import { bundleFixture } from "../.test-dist/tests/evidence-bundle-fixture.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const moduleUrl = relative => pathToFileURL(path.join(packageRoot, "dist/src", relative)).href;
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const { runExactHostEvaluationChat } = await import(moduleUrl("acceptance/exact-host-chat.js"));
const { bytesVersion, canonicalJson, objectVersion } = await import(moduleUrl("canghai/content-version.js"));
const { initializeContextHistoryKeys } = await import(moduleUrl("openclaw/host-context-keys.js"));
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-managed-host-context-"));
const state = path.join(temp, "state"), workspace = path.join(temp, "workspace"), plugin = path.join(temp, "plugin");
const otherWorkspace=path.join(temp,"other-workspace");
await Promise.all([state, workspace, plugin, otherWorkspace].map(directory => mkdir(directory, { mode: 0o700 })));
await writeFile(path.join(otherWorkspace,"AGENTS.md"),"SYNTHETIC_OTHER_BOOTSTRAP\n");
// Retain synthetic fixtures alongside failure receipts; no private repository.
const catalog = await bundleFixture({ after() {} });
const policy = { schemaVersion: "stella.source-policy/v1", id: "probe-policy", ownerId: "synthetic-owner",
  readPurposes: ["synthetic"], derivePurposes: ["synthetic"], deliveryScopes: ["synthetic"],
  retention: "retain", authorityEvidenceRefs: [] };
const policyRef = { id: policy.id, version: objectVersion(policy) };
const policyBytes = canonicalJson({ ...policy, version: policyRef.version });
await writeFile(path.join(catalog.root, "policy.json"), policyBytes);
catalog.catalog.policies.push({ ...policyRef, status: "current", dependencies: [],
  locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } });
await catalog.save();
const git = async (...args) => (await promisify(execFile)("git", args)).stdout.trim();
const remote = path.join(temp, "synthetic-remote.git");
await git("init", "--bare", "--quiet", remote);
await git("-C", catalog.root, "init", "--quiet", "-b", "main");
await git("-C", catalog.root, "config", "user.name", "Synthetic Context Probe");
await git("-C", catalog.root, "config", "user.email", "context@example.invalid");
await git("-C", catalog.root, "add", ".");
await git("-C", catalog.root, "commit", "--quiet", "-m", "Synthetic memory source");
await git("-C", catalog.root, "remote", "add", "origin", remote);
await git("-C", catalog.root, "push", "--quiet", "-u", "origin", "main");
const keyScope = { stateDirectory: state, repositoryRoot: catalog.root, agentId: "probe" };
const keys = await initializeContextHistoryKeys(keyScope);
const failPersistence = process.env.STELLA_CONTEXT_FAIL_PERSISTENCE === "1";
const nativeControl = process.env.STELLA_CONTEXT_NATIVE_CONTROL === "1";
const source = await realpath(await createFixture());
const recipe = await prepareInitializationFixture(source, "probe");
const nativeDirectory = process.env.STELLA_NATIVE_ACTIVE_EVIDENCE;
const dreamingDirectory = process.env.STELLA_NATIVE_DREAMING_EVIDENCE;
assert.ok(!(nativeDirectory && dreamingDirectory), "Replay one native artifact per isolated Host");
let nativePrompt;
let nativeArtifactSha256;
let nativeArtifactKind;
if (nativeDirectory) {
  nativeArtifactKind = "active-memory-recall";
  const receipt = JSON.parse(await readFile(path.join(nativeDirectory, "native-active-memory.json"), "utf8"));
  assert.equal(receipt.nativeSummaryInjected, true);
  assert.equal(receipt.genuineToolAuthority, true);
  assert.equal(receipt.nativeReadExecuted, true);
  assert.equal(receipt.hostVersion, host.version);
  const bytes = await readFile(path.join(nativeDirectory, "native-final-input.json"));
  nativeArtifactSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(nativeArtifactSha256, receipt.artifactSha256);
  const events = (await readFile(path.join(nativeDirectory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  nativePrompt = events.find(event => event.kind === "llm_input" && event.event.model === "native-final")?.event.prompt;
  assert.equal(typeof nativePrompt, "string");
  assert.ok(nativePrompt.includes("SYNTHETIC_NATIVE_RECALL_SUMMARY"));
  assert.ok(JSON.parse(bytes.toString("utf8")).messages.some(message => message.role === "user" &&
    typeof message.content === "string" && message.content.includes(nativePrompt)));
}
if (dreamingDirectory) {
  const receipt = JSON.parse(await readFile(path.join(dreamingDirectory, "native-dreaming.json"), "utf8"));
  assert.equal(receipt.hostVersion, host.version);
  assert.equal(receipt.scope, "native-artifact-generation");
  assert.equal(receipt.nativeCronExecuted, true);
  assert.equal(receipt.nativeNarrativeExecuted, true);
  assert.equal(receipt.nativeSourceRead, true);
  assert.equal(receipt.artifactKind, "dreaming-diary");
  const bytes = await readFile(path.join(dreamingDirectory, "native-dreams.md"));
  nativeArtifactSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(nativeArtifactSha256, receipt.artifactSha256);
  nativeArtifactKind = receipt.artifactKind;
  nativePrompt = bytes.toString("utf8");
  assert.ok(nativePrompt.includes("SYNTHETIC_NATIVE_DREAM_NARRATIVE"));
}
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic managed context probe.\n");
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "stella-core", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
await writeFile(path.join(plugin, "openclaw.plugin.json"), JSON.stringify({ id: "stella-core", providers: ["stella-guarded"],
  activation: { onStartup: true, onAgentHarnesses: ["openclaw"] }, configSchema: { type: "object", additionalProperties: false } }));
await writeFile(path.join(plugin, "index.mjs"), `
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { CatalogReader } from ${JSON.stringify(moduleUrl("canghai/catalog-reader.js"))};
import { GitCangHaiDurability } from ${JSON.stringify(moduleUrl("canghai/durability.js"))};
import { loadContextHistoryHead, publishContextHistoryHead } from ${JSON.stringify(moduleUrl("openclaw/host-context-head.js"))};
import { bytesVersion } from ${JSON.stringify(moduleUrl("canghai/content-version.js"))};
import { EpisodeEvidenceResolver } from ${JSON.stringify(moduleUrl("praxis/episode-evidence.js"))};
import { HostContextAuthority } from ${JSON.stringify(moduleUrl("openclaw/host-context-authority.js"))};
import { ManagedHostContextEngine, registerManagedHostContextEngine, STELLA_CONTEXT_ENGINE } from ${JSON.stringify(moduleUrl("openclaw/host-context-engine.js"))};
import { createHostContextTurnStore } from ${JSON.stringify(moduleUrl("openclaw/host-context-turn-store.js"))};
import { loadContextHistoryKeys } from ${JSON.stringify(moduleUrl("openclaw/host-context-keys.js"))};
import { loadContextHistory, persistContextHistory } from ${JSON.stringify(moduleUrl("openclaw/host-context-history.js"))};
import { prepareHostRequestArchive } from ${JSON.stringify(moduleUrl("canghai/host-request-archive.js"))};
import { persistHostInputArchive } from ${JSON.stringify(moduleUrl("canghai/archive-writer.js"))};
import { compileInitializationSource } from ${JSON.stringify(moduleUrl("openclaw/initialization-source.js"))};
import { bindProcessingAuthority } from ${JSON.stringify(moduleUrl("openclaw/processing-authority.js"))};
import { registerCompletionAdapter } from ${JSON.stringify(moduleUrl("openclaw/completion-adapter.js"))};
import { readActiveCompletionRequest, hasCompletionRunPermit, hasCompletionPersistencePermit, completionDraftHash, recordCompletionPreparation, readCompletionPreparation } from ${JSON.stringify(moduleUrl("openclaw/completion.js"))};
import { registerCompletionTranscriptGuard } from ${JSON.stringify(moduleUrl("openclaw/completion-transcript.js"))};
import { registerHostMemoryProvider } from ${JSON.stringify(moduleUrl("openclaw/host-memory-provider.js"))};
export default { id: 'stella-core', register(api) {
  const prepared = runId => readCompletionPreparation(runId);
  const pending = new Map();
  const record = value => appendFileSync(${JSON.stringify(path.join(temp, "events.jsonl"))}, JSON.stringify(value) + '\\n');
  const durability = new GitCangHaiDurability({root:${JSON.stringify(catalog.root)},remote:'origin',branch:'main',
    criticalWritePolicy:'sync_immediately',normalWritePolicy:'sync_immediately',maxNormalRpoSeconds:0});
  registerCompletionTranscriptGuard(api, 'probe');
  registerManagedHostContextEngine(api, () => {
    const request = readActiveCompletionRequest('probe');
    record({kind:'engine_created',runId:request.runId});
    const commit = createHostContextTurnStore({root:${JSON.stringify(catalog.root)},archiveRoot:'raw-host',
      agentId:request.agentId,sessionId:request.sessionId,sessionKey:request.sessionKey,
      async validate(){},durability});
    return {
      retainForCompletion:true,
      async commitTurn(params){const result=await commit(params);record({kind:'turn_committed',status:result.status});return result;},
      resolve() { const engine = prepared(request.runId)?.engine; if (!engine) throw new Error('probe_context_not_prepared'); return engine; }};
  },{targetAgentId:'probe'});
  registerHostMemoryProvider(api, 'probe', async (request, modelRef, input) => {
    record({kind:'consumption',runId:request.runId,modelRef,input});
    const engine = prepared(request.runId)?.engine;
    if (!engine) throw new Error('probe_context_not_prepared');
    try { await engine.assertConsumption(input); }
    catch(error) { record({kind:'consumption_rejected',runId:request.runId,category:error.category}); throw error; }
  }, receipt => prepared(readActiveCompletionRequest('probe').runId).engine.observeOutput(receipt));
  const prepareInput = async () => {
    const request = readActiveCompletionRequest('probe');
    let reader = await CatalogReader.load(${JSON.stringify(catalog.root)}, 'catalog.json');
    const capturedAt=new Date().toISOString();
    const purpose = {readPurpose:'synthetic',derivePurpose:'synthetic',deliveryScope:'synthetic',evidenceCutoff:capturedAt,trustedAdapters:{user_report:[],tool_observation:[],system_event:[]}};
    const archive = prepareHostRequestArchive({schemaVersion:'stella.host-request-snapshot/v1',request,capturedAt},
      {policyRef:${JSON.stringify(policyRef)},objectRoot:'objects',payloadRoot:'ingress',ownerId:'synthetic-owner'});
    await persistHostInputArchive({reader,archive,operationId:'ingress_'+bytesVersion(request.runId).slice(7),purpose}, {
      async persist(paths){await durability.syncCritical(paths,'Archive synthetic ingress');},
      confirmPreviouslyCommitted:file=>durability.confirmPreviouslyCommitted(file),
    });
    reader = await CatalogReader.load(${JSON.stringify(catalog.root)}, 'catalog.json');
    const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => {throw new Error('Unexpected semantic operation');});
    const compilation = await compileInitializationSource(${JSON.stringify(source)}, ${JSON.stringify(recipe)}, {agentId:'probe',hostVersion:api.runtime.version});
    const current = {request,modelRef:'stella-guarded/probe',deployment:bytesVersion('synthetic-deployment'),generationId:reader.catalog.generationId,
      purpose:{readPurpose:purpose.readPurpose,derivePurpose:purpose.derivePurpose,deliveryScope:purpose.deliveryScope},
      configurationHash:bytesVersion('synthetic-config'),compilation};
    const keys=await loadContextHistoryKeys(${JSON.stringify(keyScope)},${JSON.stringify(keys.signerId)});
    const authority = new HostContextAuthority(resolver, request, {authority:bindProcessingAuthority({...current,ownerId:'synthetic-owner'}),
      historyVerificationKey:keys.verificationKey,
      configurationHash:current.configurationHash,compilation,captureCurrent:async () => {
        if (!hasCompletionPersistencePermit(request.runId) && readActiveCompletionRequest('probe') !== request) throw new Error('Expired request');
        await reader.assertCurrent(); return current;}});
    await authority.bindArchivedInput(archive.evidenceRefs[0]);
    const rules = authority.publicRules();
    const history=[];
    const previous=await loadContextHistoryHead({root:${JSON.stringify(catalog.root)},archiveRoot:'retained-context',
      revision:(await durability.diagnostics()).localRevision,request,verificationKey:keys.verificationKey});
    if(previous){
      history.push(await authority.restoreHistory(previous.archive));
      record({kind:'history_restored',runId:request.runId,digest:previous.archive.digest});
    }
    const engine = new ManagedHostContextEngine(request, authority, {system:rules,history,hostTimezone:"UTC",
      async archive(messages) {
        const bytes=JSON.stringify(messages);
        await writeFile(${JSON.stringify(temp)}+'/observed-'+bytesVersion(bytes).slice(7)+'.json',bytes,{mode:0o600});
        record({kind:'raw_observed',count:messages.length});
      },
      async persistSummary() {throw new Error('Compaction not exercised by this probe');},
      async complete() {throw new Error('Compaction not exercised by this probe');}});
    const assemble=engine.assemble.bind(engine);
    engine.assemble=async params=>{record({kind:'assemble',runId:request.runId,prompt:params.prompt,expected:request.prompt,messages:params.messages});return assemble(params);};
    recordCompletionPreparation(request.runId,{engine,authority,keys,previous,request,durability,generationId:reader.catalog.generationId,systemPrompt:await authority.systemPrompt(rules)});
  };
  api.on('before_prompt_build', async (_event, ctx) => {
    if(ctx.agentId !== 'probe') return;
    return {systemPrompt:prepared(readActiveCompletionRequest('probe').runId).systemPrompt,toolsAllow:[],${nativePrompt ? `prependContext:${JSON.stringify(nativePrompt)},` : ''}};
  });
  api.on('before_agent_run', (_event, ctx) => ctx.agentId!=='probe' ? undefined : hasCompletionRunPermit(ctx.runId) ? {outcome:'pass'} : {outcome:'block',reason:'missing coordinator',message:'missing coordinator',category:'capability_unavailable'});
  registerCompletionAdapter(api,'probe',{
    async prepareInput(){try{await prepareInput();}catch(error){record({kind:'preparation_failed',error:String(error),stack:error.stack});throw error;}},
    async resourceScope(){return ${JSON.stringify(workspace)};},
    describeDraft(runId,text,_input,preparation){pending.set(runId,preparation);return {draftId:'context-probe',text,evidenceRef:'synthetic-context',responseKind:'answer',requiresCriticalPersistence:true};},
    async persist({operationId,draft,responseKind,abortSignal}){
      const value=pending.get(operationId);
      const saved=await value.engine.persistCompletedHistory(async context=>{
        const stored=await persistContextHistory(value.authority,context.consumption,{
          archiveRoot:'retained-context',signingKey:value.keys.signingKey,signal:abortSignal,durability:{
            async syncCritical(paths,message){
              if(${JSON.stringify(failPersistence)}){record({kind:'persistence_failed'});throw new Error('synthetic_context_persistence_failure');}
              return value.durability.syncCritical(paths,message);
            },
            confirmPreviouslyCommitted:file=>value.durability.confirmPreviouslyCommitted(file),
          }});
        const archive=await loadContextHistory(${JSON.stringify(catalog.root)},{archiveRoot:'retained-context',digest:stored.locator.sha256},value.keys.verificationKey);
        const head=await publishContextHistoryHead(value.authority,context.consumption,{
          request:value.request,archive,previous:value.previous,durability:value.durability,signal:abortSignal});
        record({kind:'history_head_published',runId:operationId,headPath:head.headPath,digest:head.archiveDigest});
        return {...stored,headOperationId:head.operationId};
      });
      record({kind:'history_persisted',locator:saved.locator,operationId:saved.operationId});
      return {schemaVersion:'stella.completion-receipt/v1',operationId,draftId:draft.draftId,draftHash:completionDraftHash(draft.text),responseKind,
        evidenceRef:draft.evidenceRef,writeOperationIds:[saved.operationId,saved.headOperationId],observedRevision:(await value.durability.diagnostics()).localRevision,generationId:value.generationId,persistenceStatus:'synchronized',checkedAt:new Date().toISOString()};},
    settled(runId,result,failure){void pending.get(runId)?.engine.dispose();pending.delete(runId);record({kind:'settled',runId,status:result?.delivery.status,failure});},
  });
} };
`);
let providerRequests = 0;
let otherProviderRequests = 0;
let compactingOther = false;
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes=Buffer.concat(chunks);
  const other=JSON.parse(bytes.toString("utf8")).model==="other";
  if(other)otherProviderRequests++;else providerRequests++;
  await writeFile(path.join(temp, other ? `other-model-input-${otherProviderRequests}.json` : `model-input-${providerRequests}.json`), bytes);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "context-probe", object: "chat.completion", created: 1, model: "probe",
    choices: [{ index: 0, message: { role: "assistant", content: other ?
      (compactingOther ? "SYNTHETIC_OTHER_SUMMARY" : "SYNTHETIC_OTHER_ANSWER") : "SYNTHETIC_MANAGED_CONTEXT_ANSWER" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
let gateway, client;
const listeners = new Set(), events = [];
try {
  await new Promise((resolve,reject) => {provider.once("error",reject);provider.listen(0,"127.0.0.1",resolve);});
  const configPath = path.join(state,"openclaw.json");
  await writeFile(configPath,JSON.stringify({gateway:{mode:"local"},agents:{ownership:"explicit",defaults:{userTimezone:"UTC",compaction:{keepRecentTokens:16},model:{primary:"stella-guarded/probe"}},entries:{probe:{workspace},other:{workspace:otherWorkspace,model:{primary:"synthetic-other/other"}}}},
    models:{providers:{"stella-guarded":{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:"openai-completions",apiKey:"synthetic-local-only",models:[{id:"probe",name:"probe",contextWindow:32768,maxTokens:512}]},
      "synthetic-other":{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:"openai-completions",apiKey:"synthetic-local-only",models:[{id:"other",name:"other",contextWindow:32768,maxTokens:512}]}}},
    plugins:{slots:{contextEngine:nativeControl?"legacy":"stella-core"},allow:["stella-core"],load:{paths:[plugin]},entries:{"stella-core":{enabled:true,hooks:{allowConversationAccess:true}}}},tools:{deny:["*"]}}),{mode:0o600});
  const env = {...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:configPath}; delete env.NODE_OPTIONS;
  gateway=await startExactHostGateway({cwd:temp,env,openclawBin:path.join(hostRoot,"openclaw.mjs"),diagnosticPrefixes:["context", "Context"]});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("context_probe_connection_timeout")),15000);
    client=new GatewayClient({url:`ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`,token:gateway.env.OPENCLAW_GATEWAY_TOKEN,env:gateway.env,
      clientName:"cli",mode:"cli",role:"operator",scopes:["operator.admin"],sharedStateMode:"read-only",deviceIdentity:null,
      onHelloOk(){clearTimeout(timer);resolve();},onConnectError(){clearTimeout(timer);reject(new Error("context_probe_connection_failed"));},
      onEvent(event){events.push(event);for(const listener of listeners)listener(event);}});client.start();
  });
  let failure;
  let result;
  try {if(!nativeControl)result=await runExactHostEvaluationChat({request:(method,params)=>client.request(method,params,{timeoutMs:35000}),
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
    {sessionKey:"agent:probe:main",message:"Synthetic current input",idempotencyKey:"managed-context",timeoutMs:60000});}
  catch(error){failure=error;}
  if(!nativeControl && !failure && !nativePrompt && !failPersistence){
    result=await runExactHostEvaluationChat({request:(method,params)=>client.request(method,params,{timeoutMs:35000}),
      subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
      {sessionKey:"agent:probe:main",message:"Continue the synthetic discussion",idempotencyKey:"managed-context-next",timeoutMs:60000});
  }
  for(const [index,message] of ["Other Agent initial input","Other Agent next input"].entries()){
    const other=await runExactHostEvaluationChat({request:(method,params)=>client.request(method,params,{timeoutMs:35000}),
      subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
      {sessionKey:"agent:other:main",message,idempotencyKey:`other-context-${index}`,timeoutMs:60000});
    assert.equal(other.text,"SYNTHETIC_OTHER_ANSWER");
  }
  assert.equal(otherProviderRequests,2);
  const otherInput=JSON.parse(await readFile(path.join(temp,"other-model-input-2.json"),"utf8"));
  assert.ok(otherInput.messages.some(message=>message.role==="system" && message.content.includes("SYNTHETIC_OTHER_BOOTSTRAP")));
  assert.ok(otherInput.messages.some(message=>message.role==="user" && message.content.includes("Other Agent initial input")));
  assert.ok(otherInput.messages.some(message=>message.role==="assistant" && message.content==="SYNTHETIC_OTHER_ANSWER"));
  assert.ok(otherInput.messages.some(message=>message.role==="user" && message.content.includes("Other Agent next input")));
  assert.ok(!JSON.stringify(otherInput).includes("SYNTHETIC_MANAGED_CONTEXT_ANSWER"));
  compactingOther=true;
  let compaction;
  try{compaction=await client.request("sessions.compact",{key:"agent:other:main",agentId:"other"},{timeoutMs:35000});}
  finally{compactingOther=false;}
  await writeFile(path.join(temp,"other-compaction.json"),JSON.stringify(compaction,null,2));
  assert.equal(compaction.ok,true);
  assert.equal(compaction.compacted,true);
  assert.ok(otherProviderRequests>2);
  const afterCompact=await runExactHostEvaluationChat({request:(method,params)=>client.request(method,params,{timeoutMs:35000}),
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
    {sessionKey:"agent:other:main",message:"Other Agent after compaction",idempotencyKey:"other-after-compact",timeoutMs:60000});
  assert.equal(afterCompact.text,"SYNTHETIC_OTHER_ANSWER");
  const compactedInput=await readFile(path.join(temp,`other-model-input-${otherProviderRequests}.json`),"utf8");
  assert.ok(compactedInput.includes("SYNTHETIC_OTHER_SUMMARY"));
  assert.ok(!compactedInput.includes("SYNTHETIC_MANAGED_CONTEXT_ANSWER"));
  await writeFile(path.join(temp,"host-diagnostics.log"),gateway.diagnostics());
  if(nativeControl){
    const report={hostVersion:host.version,scope:"native-context-control",productionMainVerified:false,otherAgentHistoryConsumed:true,otherAgentCompactionConsumed:true,otherProviderRequests,evidenceDirectory:temp};
    await writeFile(path.join(temp,"native-control.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }else{
  const observed=(await readFile(path.join(temp,"events.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.ok(observed.some(event=>event.kind==="engine_created"));
  if(nativePrompt){
    assert.ok(failure,"Unbound native memory must be rejected");assert.equal(providerRequests,0);
    const containsArtifact = messages => messages.some(message => {
      const text = typeof message.content === "string" ? message.content
        : Array.isArray(message.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      return text.includes(nativePrompt);
    });
    assert.ok(observed.some(event => event.kind === "assemble" && event.runId === "managed-context" &&
      containsArtifact(event.messages)), "The same native artifact must reach original Host context assembly");
    assert.ok(observed.some(event => event.kind === "consumption" && event.runId === "managed-context" &&
      containsArtifact(event.input.messages)), "The same native artifact must reach the final provider gate after Host fallback");
    assert.ok(observed.some(event => event.kind === "consumption_rejected" && event.runId === "managed-context" &&
      ["host_context_input_changed", "host_context_assembly_required"].includes(event.category)),
      "The final provider gate must reject this run's unbound input");
    assert.match(gateway.diagnostics(),/host_context_(input_changed|assembly_required)/);
  }else if(failPersistence){
    assert.ok(failure,"Archive failure must block delivery");
    assert.equal(providerRequests,1);
    assert.ok(observed.some(event=>event.kind==="persistence_failed"));
    assert.ok(!observed.some(event=>event.kind==="history_persisted" || event.kind==="settled" && event.status==="confirmed"));
    assert.ok(observed.some(event=>event.kind==="settled" && event.failure?.stage==="persist"));
    assert.ok(!events.some(event=>event.event==="chat" && event.payload?.sessionKey==="agent:probe:main" &&
      (event.payload?.state==="final" || JSON.stringify(event.payload).includes("SYNTHETIC_MANAGED_CONTEXT_ANSWER"))));
    const { assertMemoryTransactionReadable } = await import(moduleUrl("canghai/memory-transaction.js"));
    await assert.rejects(assertMemoryTransactionReadable(catalog.root),/memory_transaction_pending/);
  }else{
    if(failure)throw failure;
    assert.equal(result.text,"SYNTHETIC_MANAGED_CONTEXT_ANSWER");assert.equal(providerRequests,2);
    assert.equal(observed.filter(event=>event.kind==="history_restored").length,1);
    assert.equal(observed.filter(event=>event.kind==="history_persisted").length,2);
    const secondInput=JSON.parse(await readFile(path.join(temp,"model-input-2.json"),"utf8"));
    const users=secondInput.messages.filter(message=>message.role==="user");
    assert.equal(users.length,2);
    const envelope=JSON.parse(users[0].content.slice(users[0].content.indexOf("{")));
    assert.equal(envelope.kind,"derived_context");
    const historical=JSON.parse(envelope.text);
    assert.equal(historical.kind,"historical_conversation");
    assert.equal(historical.runId,"managed-context");
    assert.equal(historical.messages[0].role,"user");
    assert.ok(historical.messages[0].content.endsWith(" Synthetic current input"));
    assert.equal(historical.messages[1].role,"assistant");
    assert.equal(historical.messages[1].content[0].text,"SYNTHETIC_MANAGED_CONTEXT_ANSWER");
    assert.ok(users[1].content.endsWith(" Continue the synthetic discussion"));
    const publishedHeads=observed.filter(event=>event.kind==="history_head_published");
    assert.equal(publishedHeads.length,2);
    assert.notEqual(publishedHeads[0].digest,publishedHeads[1].digest);
    const sourceRevision=await git("-C",catalog.root,"rev-parse","HEAD");
    assert.equal(await git("--git-dir",remote,"rev-parse","refs/heads/main"),sourceRevision);
    const committedHead=JSON.parse(await git("-C",catalog.root,"show",`${sourceRevision}:${publishedHeads[1].headPath}`));
    assert.equal(committedHead.digest,publishedHeads[1].digest);
    assert.equal(committedHead.parentDigest,publishedHeads[0].digest);
    const persisted=observed.findIndex(event=>event.kind==="history_persisted");
    assert.ok(persisted>=0 && observed.findIndex(event=>event.kind==="settled" && event.status==="confirmed")>persisted);
    const { loadContextHistory, readContextHistory } = await import(moduleUrl("openclaw/host-context-history.js"));
    const history=await loadContextHistory(catalog.root,{archiveRoot:"retained-context",digest:observed[persisted].locator.sha256},keys.verificationKey);
    const snapshot=await readContextHistory(history,catalog.root);
    assert.ok(snapshot.dependencies.length>0);
    assert.equal(snapshot.input.messages.at(-1).content[0].text,"SYNTHETIC_MANAGED_CONTEXT_ANSWER");
  }
  const report={hostVersion:host.version,scope:"managed-context-host-seam",model:"synthetic-loopback",productionMainVerified:false,
    firstTurnConsumed:!nativePrompt,nativeArtifactRejected:Boolean(nativePrompt),providerRequests,
    durableHostTurnCommitted:observed.some(event=>event.kind==='turn_committed'),
    coreHistoryPersisted:observed.some(event=>event.kind==='history_persisted'),
    nextTurnRestored:observed.some(event=>event.kind==='history_restored'),
    nextTurnHistoryConsumed:!nativePrompt && !failPersistence,
    otherAgentHistoryConsumed:true,
    otherAgentCompactionConsumed:true,
    historyPersistenceFailureBlocked:failPersistence && !nativePrompt,
    durabilityScope:"synthetic-local-git-remote",
    productionRecoveryPointerVerified:false,
    ...(nativeArtifactSha256 ? {nativeArtifactSha256,nativeArtifactKind} : {}),
    evidenceDirectory:temp,catalogRoot:catalog.root,compilationRoot:source};
  await writeFile(path.join(temp,"managed-context.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }
}catch(error){
  await writeFile(path.join(temp,"failure.json"),JSON.stringify({category:String(error),diagnostics:gateway?.diagnostics(),events:events.filter(event=>event.event==="chat"),providerRequests},null,2));
  process.stderr.write(`Managed context evidence retained: ${temp}\n`);throw error;
}finally{
  const cleaned=await Promise.allSettled([Promise.resolve().then(()=>client?.stopAndWait({timeoutMs:2000})),Promise.resolve().then(()=>gateway?.stop()),
    Promise.resolve().then(async()=>{provider.closeAllConnections();if(provider.listening)await new Promise((resolve,reject)=>provider.close(error=>error?reject(error):resolve()));})]);
  if(cleaned.some(result=>result.status==="rejected")){process.exitCode=1;process.stderr.write(`Context probe cleanup failed: ${temp}\n`);}
}
