// Exactly two native fault regressions, each with preserved R0 red and R1 green.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const helper = new URL('./core-wait-observation.mjs', import.meta.url).href;
const collector = new URL('./core-wait-observation-collector.mjs', import.meta.url).href;
const review = fileURLToPath(new URL('./original-red-probes/', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const cases = [
  {
    name: 'real-channel-subscriber-throws',
    green: `import {channel} from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
channel('openclaw.debug.pre-model-wait.v1').subscribe(()=>{throw Error('synthetic public observer failure')});
const before=[process.listenerCount('uncaughtException'),process.listenerCount('unhandledRejection')];
const m=await import(${JSON.stringify(helper)});
assert.equal(m.installObservationSink(()=>{throw Error('synthetic private observer failure')}),true);
let businessCallReturned=false;m.exitWait(m.enterWait('recorder.runtime'));businessCallReturned=true;
await new Promise(r=>setImmediate(r));
assert.equal(m.observationState().incomplete,true);
assert.deepEqual([process.listenerCount('uncaughtException'),process.listenerCount('unhandledRejection')],before);
process.stdout.write(JSON.stringify({businessCallReturned,captureIncomplete:m.observationState().incomplete,globalExceptionHandlersAdded:false})+'\\n');`
  },
  {
    name: 'collector-async-stderr-error',
    green: `import {Writable} from 'node:stream';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const before=[process.listenerCount('uncaughtException'),process.listenerCount('unhandledRejection'),process.stderr.listenerCount('error')];
let outputErrorEvents=0,writeCallbacks=0;
const ownedSink=new Writable({write(c,e,cb){setImmediate(()=>{writeCallbacks++;cb(Error('synthetic diagnostic stream failure'))})}});
ownedSink.on('error',()=>outputErrorEvents++);
fs.createWriteStream=(path,opts)=>{assert.equal(path,'');assert.equal(opts.fd,3);assert.equal(opts.autoClose,false);return ownedSink};syncBuiltinESMExports();
await import(${JSON.stringify(collector)});const m=await import(${JSON.stringify(helper)});
m.exitWait(m.enterWait('recorder.runtime'));
await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
assert.equal(m.observationState().incomplete,true);assert.equal(outputErrorEvents,1);assert.equal(writeCallbacks,1);
assert.deepEqual([process.listenerCount('uncaughtException'),process.listenerCount('unhandledRejection'),process.stderr.listenerCount('error')],before);
process.stdout.write(JSON.stringify({businessCallReturned:true,captureIncomplete:m.observationState().incomplete,outputErrorEvents,writeCallbacks,globalExceptionHandlersAdded:false,sharedStderrHandlerAdded:false})+'\\n');`
  }
];
function execute(code) {
  const result=spawnSync(process.execPath,['--input-type=module','-'],{
    input:code,encoding:'utf8',env:{PATH:'/usr/bin:/bin',OPENCLAW_TRACE_PREMODEL_WAIT:'1'},timeout:5000,maxBuffer:131072,
    stdio:['pipe','pipe','pipe','pipe']
  });
  assert.equal(result.error,undefined);
  return {status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr};
}
const results=[];
for(const item of cases){
  const redSource=readFileSync(review+item.name+'.mjs','utf8');
  const red=execute(redSource);assert.equal(red.status,1);assert.equal(red.signal,null);assert.match(red.stdout, /"businessCallReturned":true/);
  const green=execute(item.green);assert.equal(green.status,0,green.stderr);assert.equal(green.signal,null);assert.equal(green.stderr,'');
  const business=JSON.parse(green.stdout.trim().replace(/\\n$/,''));assert.equal(business.businessCallReturned,true);assert.equal(business.captureIncomplete,true);
  results.push({name:item.name,red:{sourceSha256:sha(redSource),actualExitCode:red.status,signal:red.signal,stdout:red.stdout,stderrSha256:sha(red.stderr),errorObserved:red.stderr.includes('synthetic')},
    green:{sourceSha256:sha(item.green),actualExitCode:green.status,signal:green.signal,stdout:green.stdout,stderr:green.stderr,business},
    adaptation:item.name==='collector-async-stderr-error'?'Same real Node Writable asynchronous callback/error fault, now injected into the dedicated diagnostic output instead of shared stderr.':'Legacy real diagnostics channel no longer receives events; a throwing private sink is independently exercised in the same process.'});
}
const out={scope:'two native observation-fault regressions only; not Host/root-cause acceptance',node:process.version,tests:2,redExpectedFailures:2,greenPass:2,results,hostStarts:0,listeners:0,networkRequests:0,modelRequests:0,privatePayloads:0};
writeFileSync(fileURLToPath(new URL('./NATIVE-FAULT-RESULT.json',import.meta.url)),JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(out,null,2));
