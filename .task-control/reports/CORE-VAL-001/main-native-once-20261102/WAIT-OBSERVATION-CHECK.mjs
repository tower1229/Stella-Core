// Instrumentation contract only; no Host import, real storage, listener or model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const fragments = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const helper = readFileSync(new URL('./WAIT-OBSERVATION.mjs', import.meta.url), 'utf8')
  .replace("import { channel } from 'node:diagnostics_channel';", '')
  .replaceAll('export function ', 'function ');
const collector = readFileSync(new URL('./WAIT-OBSERVATION-COLLECTOR.mjs', import.meta.url), 'utf8')
  .replace("import { channel } from 'node:diagnostics_channel';", '');
const results=[];
function env(enabled, throws=false) {
  const records=[];let calls=0;
  const ctx=vm.createContext({process:{env:{OPENCLAW_TRACE_PREMODEL_WAIT:enabled?'1':undefined}},
    performance:{now:()=>++calls},channel:()=>({hasSubscribers:true,publish:r=>{if(throws)throw new Error('synthetic observer failed');records.push({...r});}}),
    resolveRuntimeContextPromptOwner:()=>undefined,asOptionalObjectRecord:x=>x,
    isTextContentBlock:x=>x.type==='text',readModelPromptProjection:x=>x?.__openclaw?.modelPromptProjection?.text,
    resolveModelPromptText:p=>p.modelPrompt,AbortController});
  vm.runInContext(helper,ctx,{timeout:1000});return {ctx,records};
}
function gate(){let release;const promise=new Promise(r=>release=r);return{promise,release};}
const tick=()=>new Promise(r=>setImmediate(r));
function record(name){results.push({name,pass:true});}
{
  const {ctx,records}=env(false);assert.equal(ctx.enterWait('recorder.runtime'),undefined);ctx.exitWait(undefined);assert.equal(records.length,0);record('default_off_no_emission');
}
{
  const {ctx,records}=env(true);assert.equal(ctx.enterWait('untrusted/path'),undefined);const token=ctx.enterWait('recorder.runtime');ctx.exitWait(token);ctx.exitWait(token);
  assert.equal(records.length,2);assert.equal(records[0].id,records[1].id);assert.deepEqual(Object.keys(records[0]).sort(),['id','monotonicMs','phase','point','sequence']);assert.equal(records[1].phase,'exit');record('fixed_scalar_projection_and_paired_exit');
}
{
  const {ctx,records}=env(true);for(let i=0;i<100;i++)ctx.exitWait(ctx.enterWait('recorder.admission'));
  assert.equal(records.length,128);assert.equal(records.at(-1).phase,'limit');assert.equal(records.at(-1).incomplete,true);record('bounded_128_with_incomplete_marker');
}
{
  const {ctx}=env(true,true);assert.doesNotThrow(()=>ctx.exitWait(ctx.enterWait('projection.write')));record('observer_failure_does_not_escape');
}
function recorder(version, enabled, runtime, admission, onError){
  const e=env(enabled);Object.assign(e.ctx,{runtimePersistencePromise:runtime,admissionWrite:admission,handlePersistenceError:onError});
  vm.runInContext(fragments.recorder[version]+'\nglobalThis.wait = waitForRuntimePersistence;',e.ctx,{timeout:1000});return {...e,wait:e.ctx.wait};
}
{
  for(const version of ['original','candidate']){
    const a=gate(),b=gate();let done=false;
    const r=recorder(version,true,a.promise,b.promise,e=>{throw e;});const run=r.wait().then(()=>done=true);
    await tick();assert.equal(done,false);a.release();await tick();assert.equal(done,false);b.release();await run;
    if(version==='candidate')assert.deepEqual(r.records.map(x=>x.point+':'+x.phase),['recorder.runtime:enter','recorder.runtime:exit','recorder.admission:enter','recorder.admission:exit']);
  }record('recorder_original_order_and_physical_settlement_retained');
}
{
  for(const version of ['original','candidate']){
    const error=new Error('synthetic failure');let observed;
    const r=recorder(version,true,Promise.reject(error),undefined,e=>{observed=e;throw e;});await assert.rejects(r.wait(),e=>e===error);assert.equal(observed,error);
    if(version==='candidate'){assert.equal(r.records.at(-1).phase,'exit');assert.equal(JSON.stringify(r.records).includes('synthetic failure'),false);}
  }record('recorder_error_identity_and_existing_handler_retained');
}
function projection(version,enabled,params){const e=env(enabled);vm.runInContext(fragments.projection[version],e.ctx,{timeout:1000});e.ctx.installModelPromptProjection(params);return e;}
{
  for(const version of ['original','candidate']){
    const pending=gate(),controller=new AbortController(),error=new Error('synthetic cancel');let settled=false,reads=0;
    const session={agent:{}};const r=projection(version,true,{session,modelPrompt:'synthetic projected',transcriptPrompt:'synthetic input',shouldCapturePrompt:()=>true,recorder:{waitForRuntimePersistence:()=>pending.promise,getPersistedMessage:()=>{reads++;}}});
    const op=session.agent.transformContext([],controller.signal).then(()=>{throw new Error('unexpected success');},e=>{settled=true;assert.equal(e,error);});
    controller.abort(error);await tick();assert.equal(settled,false);assert.equal(reads,0);
    if(version==='candidate')assert.deepEqual(r.records.map(x=>x.phase),['enter']);pending.release();await op;assert.equal(reads,0);
    if(version==='candidate')assert.deepEqual(r.records.map(x=>x.phase),['enter','exit']);
  }record('observation_does_not_add_abort_race_or_release_pending_wait');
}
{
  for(const version of ['original','candidate']){
    const user={role:'user',content:'synthetic input',idempotencyKey:'synthetic'},session={agent:{}},controller=new AbortController();let writes=0;
    const r=projection(version,true,{session,modelPrompt:'synthetic projected',transcriptPrompt:'synthetic input',shouldCapturePrompt:()=>true,recorder:{waitForRuntimePersistence:async()=>{},getPersistedMessage:()=>user,captureModelPromptProjection:async text=>{writes++;return {...user,__openclaw:{modelPromptProjection:{text}}};}}});
    const out=await session.agent.transformContext([user],controller.signal);assert.equal(writes,1);assert.equal(out[0].__openclaw.modelPromptProjection.text,'synthetic projected');
    if(version==='candidate')assert.deepEqual(r.records.map(x=>x.point+':'+x.phase),['projection.recorder:enter','projection.recorder:exit','projection.write:enter','projection.write:exit']);
  }record('projection_output_and_single_write_unchanged');
}
{
  for(const version of ['original','candidate']){
    const e=env(true),pending=gate(),controller=new AbortController(),error=new Error('synthetic listener failure'),original={role:'toolResult'},replacement={role:'toolResult'};
    vm.runInContext(fragments.listener[version].trim().replace('async processEvents(', 'async function processEvents('),e.ctx,{timeout:1000});
    const event={type:'message_end',message:original},ctx={mutableState:{messages:[]},toolLoopRecoveryState:{},steeringQueue:{commit(){}},followUpQueue:{commit(){}},activeRun:{abortController:controller},listeners:[async actual=>{assert.equal(actual,event);await pending.promise;actual.message=replacement;throw error;} ]};
    let settled=false;const op=e.ctx.processEvents.call(ctx,event).then(()=>{throw new Error('unexpected success');},x=>{settled=true;assert.equal(x,error);});controller.abort();await tick();assert.equal(settled,false);pending.release();await op;assert.equal(ctx.mutableState.messages[0],replacement);
    if(version==='candidate')assert.deepEqual(e.records.map(x=>x.phase),['enter','exit']);
  }record('listener_error_finally_mutation_and_pending_ownership_unchanged');
}
{
  let subscriber;const lines=[];const ctx=vm.createContext({process:{env:{OPENCLAW_TRACE_PREMODEL_WAIT:'1'},stderr:{write:x=>lines.push(x)}},channel:()=>({subscribe:f=>subscriber=f})});
  vm.runInContext(collector,ctx,{timeout:1000});subscriber({phase:'enter',id:1,point:'recorder.runtime',monotonicMs:1,sequence:1,privateBody:'excluded'});subscriber({phase:'enter',id:2,point:'untrusted secret',monotonicMs:2,sequence:2});subscriber({phase:'unknown secret',sequence:3});assert.equal(lines.length,1);assert.equal(lines[0].includes('excluded'),false);record('collector_does_not_serialize_extra_fields_or_unrecognized_labels');
}
console.log(JSON.stringify({scope:'local observation-only regression, not a real-run reproduction or fix',tests:results.length,passed:results.length,results,hostImports:0,hostStarts:0,networkRequests:0,modelRequests:0,privateBodies:0},null,2));
