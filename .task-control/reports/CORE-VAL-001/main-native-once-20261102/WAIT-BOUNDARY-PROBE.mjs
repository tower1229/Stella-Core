// Exact-function, synthetic-dependency diagnostic. No Host module import/network/storage.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const base = resolve(process.argv[2] ?? '.', 'node_modules/openclaw/dist');
const hashes = {}, spans = [];
function source(file) {
  const s = readFileSync(resolve(base, file), 'utf8');
  hashes[file] = createHash('sha256').update(s).digest('hex');
  return s;
}
function cut(file, marker, closing) {
  const s = source(file), start = s.indexOf(marker);
  assert(start >= 0, marker);
  const end = s.indexOf(closing, start) + closing.length;
  assert(end > start);
  spans.push({ file, marker, line: s.slice(0, start).split('\n').length });
  return s.slice(start, end);
}
function fn(file, name, async = false) { return cut(file, `${async ? 'async ' : ''}function ${name}(`, '\n}'); }
function method(file, marker, name) {
  const s = cut(file, '\t' + marker, '\n\t}').trim();
  return s.replace(/^(async )?[^ (]+/, (_, a = '') => `${a}function ${name}`);
}
const core = 'agent-core-D7okjbP7.mjs', session = 'settings-manager-2KjnbEXR.mjs';
const prompt = 'attempt-system-prompt-prepare-ChKsbjSh.mjs';
const builtin = 'builtin-openclaw-BxzDR6yL.mjs';
const aborts = 'abortable-Cd6QbDOo.mjs';
const projection = fn(prompt, 'installModelPromptProjection');
const needle = 'if (params.shouldCapturePrompt()) {\n\t\t\tawait params.recorder?.waitForRuntimePersistence();';
assert.equal(projection.split(needle).length, 2);
const patchedProjection = projection.replace(needle, 'if (params.shouldCapturePrompt()) {\n\t\t\tassertCurrent();\n\t\t\tawait params.recorder?.waitForRuntimePersistence();').replace('function installModelPromptProjection(', 'function installPatchedProjection(');
const recorderWait = cut('user-turn-transcript-DuAfBkUt.mjs', '\tconst waitForRuntimePersistence = async () => {', '\n\t};');
let providerTripwires = 0;
const sandbox = vm.createContext({
  AbortController, AbortSignal, Error, Date, Set, Reflect,
  takePromptCompactionRequestBudget: () => undefined,
  toErrorObject: x => x instanceof Error ? x : new Error(String(x)),
  recordAgentCleanupFailure: () => { throw new Error('unexpected cleanup failure'); },
  hasRetainedPluginRuntimeCloseError: () => { throw new Error('unexpected retained-close error'); },
  isOpenClawSystemUpdateMessage: () => false,
  isActiveTurnTainted: () => false,
  withAssistantTurnTaint: x => x,
  orderSystemUpdateMessages: x => x,
  getInternalSyncSteeringGetter: () => undefined,
  getInternalSteeringQueueObserver: () => undefined,
  resolveRuntimeContextPromptOwner: () => undefined,
  asOptionalObjectRecord: x => x && typeof x === 'object' ? x : undefined,
  isTextContentBlock: x => x?.type === 'text',
  readModelPromptProjection: x => x?.__openclaw?.modelPromptProjection?.text,
  resolveAgentCoreStreamFn: () => { providerTripwires++; throw new Error('PROVIDER TRIPWIRE'); },
});
const definitions = [
  'const OPENCLAW_ABORTABLE_WRAPPER = Symbol.for("openclaw.abortable.wrapper");',
  'const INTERRUPTED_TURN_GUIDANCE = "synthetic interruption";',
  ...['createAbortableError','withAbortListener','abortable'].map(n => fn(aborts,n)),
  fn(builtin,'createEmbeddedAttemptSessionSettleTracker'),
  fn('runtime-plugins-B5lnDthu.mjs','releaseRuntimePluginWork',true),
  ...['getSteeringAtCheckpoint','createStreamedSteeringConfig','createFailureMessage','isTurnHandoffAbort','normalizeCoreContextMessages'].map(n => fn(core,n)),
  ...['appendInterruptedTurnMessage','runAgentLoop','runLoop','streamAgentResponse'].map(n => fn(core,n,true)),
  fn(prompt,'resolveModelPromptText'), projection, patchedProjection,
  `function makeRecorderWait(runtimePersistencePromise, admissionWrite) { const handlePersistenceError = e => { throw e; }; ${recorderWait} return waitForRuntimePersistence; }`,
  ...[
    ['async runWithLifecycle(executor)', 'agentRunWithLifecycle'],
    ['async processEvents(event)', 'agentProcessEvents'],
    ['async handleRunFailure(error, aborted)', 'agentHandleRunFailure'],
    ['finishRun()', 'agentFinishRun'],
    ['abort(reason)', 'agentAbort'],
    ['waitForIdle()', 'agentWaitForIdle'],
    ['async runPromptMessages(messages, options = {})', 'agentRunPromptMessages'],
    ['createContextSnapshot()', 'agentCreateContextSnapshot'],
  ].map(([m,n]) => method(core,m,n)),
  method(session,'async abort(reason)','sessionAbort'),
  method(session,'async prompt(text, options)','sessionPrompt'),
].join('\n');
vm.runInContext(definitions, sandbox, { timeout: 1000 });
const tick = () => new Promise(r => setImmediate(r));
function gate() { let release; const promise = new Promise(r => release = r); return { promise, release }; }
function makeAgent() {
  const queue = { commit() {}, restore() {} };
  const a = { mutableState: { messages: [], model: { id: 'synthetic', provider: 'none', api: 'none' }, tools: [], systemPrompt: 'synthetic', isStreaming: false, pendingToolCalls: new Set() }, listeners: new Set(), toolLoopRecoveryState: {}, steeringQueue: queue, followUpQueue: queue };
  for (const [key, name] of Object.entries({ runWithLifecycle:'agentRunWithLifecycle', processEvents:'agentProcessEvents', handleRunFailure:'agentHandleRunFailure', finishRun:'agentFinishRun', abort:'agentAbort', waitForIdle:'agentWaitForIdle', runPromptMessages:'agentRunPromptMessages', createContextSnapshot:'agentCreateContextSnapshot' })) a[key] = sandbox[name];
  Object.defineProperties(a,{ state:{get:()=>a.mutableState},signal:{get:()=>a.activeRun?.abortController.signal} });
  a.createLoopConfig = () => ({model:a.state.model,transformContext:a.transformContext,convertToLlm:x=>x});
  return a;
}
const syntheticUser = () => ({role:'user', content:'synthetic input',idempotencyKey:'synthetic-request'});
async function loopCase(kind) {
  const a=makeAgent(), external=new AbortController(), pending=gate(), entered=gate(), terminal=gate(), terminalEntered=gate();
  const events=[];let physicalSettled=false, abortSettled=false, released=0, writes=0, readsAfterAbort=0;
  const user=syntheticUser();
  const sessionObject={agent:a,abortRetry(){}};
  sessionObject.abort=sandbox.sessionAbort;
  const tracker=sandbox.createEmbeddedAttemptSessionSettleTracker(sessionObject);
  const wait=sandbox.makeRecorderWait(kind==='runtime_persistence'?pending.promise:undefined,kind==='admission_write'?pending.promise:undefined);
  sandbox.installModelPromptProjection({session:sessionObject,transcriptPrompt:'synthetic input',modelPrompt:'synthetic projected input',shouldCapturePrompt:()=>true,
    recorder:{waitForRuntimePersistence:()=>{if(kind==='runtime_persistence'||kind==='admission_write')entered.release();return wait();},
      getPersistedMessage:()=>user,
      captureModelPromptProjection:async text=>{writes++;entered.release();if(kind==='projection_write')await pending.promise;return {...user,__openclaw:{modelPromptProjection:{text}}};}},
    withTranscriptWrite:run=>run(),
    assertCurrent:()=>{if(external.signal.aborted)readsAfterAbort++;}
  });
  a.listeners.add(async event=>{
    events.push(event.type + (event.message?.role?':'+event.message.role:''));
    if((kind==='user_persistence'||kind==='terminal_after_cancel')&&event.type==='message_end'&&event.message.role==='user') {writes++;entered.release();await pending.promise;}
    if(kind==='terminal_after_cancel'&&event.type==='agent_end'){terminalEntered.release();await terminal.promise;}
  });
  const physical=tracker.trackPromptSettlePromise(a.runPromptMessages([user]));
  physical.then(()=>physicalSettled=true,()=>physicalSettled=true);
  const visible=sandbox.abortable(external.signal,physical).then(()=> 'ok',e=>e.name);
  await entered.promise;
  external.abort(new Error('synthetic deadline'));
  const abort=tracker.abortActiveSession(external.signal.reason);abort.then(()=>abortSettled=true,()=>abortSettled=true);
  assert.equal(await visible,'AbortError');await tick();
  const observation={isStreaming:a.state.isStreaming,physicalSettled,abortSettled};
  assert.deepEqual(observation,{isStreaming:true,physicalSettled:false,abortSettled:false});
  const close=sandbox.releaseRuntimePluginWork(()=>tracker.buildAbortSettlePromise(),()=>released++);
  await tick();assert.equal(released,0);
  pending.release();
  let terminalObservation;
  if(kind==='terminal_after_cancel') {await terminalEntered.promise;await tick();terminalObservation={isStreaming:a.state.isStreaming,physicalSettled,abortSettled,released};assert.deepEqual(terminalObservation,{isStreaming:true,physicalSettled:false,abortSettled:false,released:0});terminal.release();}
  await Promise.all([physical,abort,close]);await tick();
  assert.equal(a.state.isStreaming,false);assert.equal(released,1);assert.equal(readsAfterAbort,0);
  return {kind,observation,terminalObservation,final:{physicalSettled,abortSettled,released,isStreaming:a.state.isStreaming},events,writes,pass:true};
}
async function preflightContrast(){
  const a=makeAgent(),pending=gate(),entered=gate();let physicalSettled=false;
  const s={agent:a,model:a.state.model,sessionModelRegistry:{hasConfiguredAuth:()=>true},currentExtensionRunner:{hasHandlers:()=>false,emitBeforeAgentStart:async()=>{entered.release();await pending.promise;}},expandPrompt:x=>x,findLastAssistantMessage:()=>undefined,pendingNextTurnMessages:[],createUserMessage:text=>({role:'user',content:text}),abortRetry(){},runAgentPrompt:async()=>{throw new Error('synthetic already-cancelled admission');}};
  sandbox.resolvePendingRuntimeContextReplay=()=>({persistedUserIndex:-1,replayPersistedCarrier:false,pendingContextMessages:[]});
  const raw=sandbox.sessionPrompt.call(s,'synthetic input',{});
  const physical=raw.then(()=>physicalSettled=true,()=>physicalSettled=true);
  await Promise.race([entered.promise,raw.then(()=>{throw new Error('preflight unexpectedly completed before barrier');})]);await sandbox.sessionAbort.call(s,new Error('synthetic deadline'));
  const observation={isStreaming:a.state.isStreaming,physicalSettled,sessionAbortReturned:true};
  assert.deepEqual(observation,{isStreaming:false,physicalSettled:false,sessionAbortReturned:true});pending.release();await physical;
  return {kind:'before_agent_start_preflight',observation,pass:true,interpretation:'Can retain a prompt but alone cannot explain the actual still-streaming flag.'};
}
async function preAbortRegression(patched, during=false){
  const controller=new AbortController(),pending=gate(),entered=gate();let waits=0,reads=0,settled=false;
  if(!during)controller.abort(new Error('synthetic pre-aborted'));
  const sessionObject={agent:{}};
  const install=patched?sandbox.installPatchedProjection:sandbox.installModelPromptProjection;
  install({session:sessionObject,modelPrompt:'synthetic projection',transcriptPrompt:'synthetic input',shouldCapturePrompt:()=>true,recorder:{waitForRuntimePersistence(){waits++;entered.release();return pending.promise;},getPersistedMessage(){reads++;throw new Error('late read');}}});
  const op=sessionObject.agent.transformContext([],controller.signal).then(()=>settled=true,()=>settled=true);
  if(during){await entered.promise;controller.abort(new Error('synthetic in-flight abort'));}
  await tick();const before={waits,settled,reads};
  assert.deepEqual(before,patched&&!during?{waits:0,settled:true,reads:0}:{waits:1,settled:false,reads:0});
  pending.release();await op;assert.equal(reads,0);
  return {patched,during,before,pass:true,meetsPreAbortedNoNewWait:before.waits===0};
}
async function uncancelledRegression(patched){
  const controller=new AbortController(),user=syntheticUser();let waits=0,captures=0;
  const sessionObject={agent:{state:{messages:[user]}}};
  (patched?sandbox.installPatchedProjection:sandbox.installModelPromptProjection)({session:sessionObject,modelPrompt:'synthetic projection',transcriptPrompt:'synthetic input',shouldCapturePrompt:()=>true,recorder:{waitForRuntimePersistence:async()=>{waits++;},getPersistedMessage:()=>user,captureModelPromptProjection:async text=>{captures++;return {...user,__openclaw:{modelPromptProjection:{text}}};}}});
  const result=await sessionObject.agent.transformContext([user],controller.signal);
  assert.equal(result[0].__openclaw.modelPromptProjection.text,'synthetic projection');assert.equal(waits,1);assert.equal(captures,1);
  return {patched,uncancelled:true,waits,captures,pass:true};
}
const watchdog=setTimeout(()=>{throw new Error('synthetic probe watchdog');},4000);
try{
  const paths=[];paths.push(await preflightContrast());
  for(const kind of ['user_persistence','runtime_persistence','admission_write','projection_write','terminal_after_cancel'])paths.push(await loopCase(kind));
  const repair=[];for(const [patched,during] of [[false,false],[true,false],[false,true],[true,true]])repair.push(await preAbortRegression(patched,during));
  repair.push(await uncancelledRegression(false),await uncancelledRegression(true));
  assert.equal(providerTripwires,0);
  console.log(JSON.stringify({scope:'exact official functions, controlled synthetic dependencies; no actual-run root-cause proof',sourceHashes:hashes,extractedSpans:spans,paths,repair,providerBoundaryReached:providerTripwires,hostModuleImports:0,networkRequests:0,privatePayloads:0,limits:'No real worker, transcript store, provider, 90-second timer or Host generation. Terminal-listener pending is injected after cancellation and is not itself an explanation for the initial stall. Candidate only prevents new wait when cancellation precedes entry; in-flight physical settlement intentionally unchanged.'},null,2));
}finally{clearTimeout(watchdog);}
