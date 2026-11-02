import fs from 'node:fs/promises';
import {setup} from './compiled/tests/device-review-fixture.mjs';
import {CatalogReader} from './compiled/src/canghai/catalog-reader.js';
const results=[];const deviceRequester='openclaw-device:'+'a'.repeat(64);
const originalRead=CatalogReader.prototype.readPayload;let payloadReads=0;
CatalogReader.prototype.readPayload=async function(...args){payloadReads++;return originalRead.apply(this,args)};
async function run(name,requester,scope){const clean=[];try{
 const f=await setup({after(cb){clean.push(cb)}},undefined,()=>scope,requester);payloadReads=0;
 const turn=f.turn(name,{ctx:{SenderId:requester},factory:{requesterSenderId:requester}});turn.dispatch();
 const requesterFacts={senderId:requester,senderIsOwner:true};const hook=turn.hook('list-'+name,{requester:requesterFacts});
 const list=await turn.tool.execute('list-'+name,{action:'list'});
 turn.hook('read-'+name,{requester:requesterFacts});const read=await turn.tool.execute('read-'+name,{action:'read',ref:f.refs[0]});
 const isDevice=requester.startsWith('openclaw-device:');
 results.push({name,grantPrincipalKind:isDevice?'device':'profile',gatewayScopePresent:scope!==undefined,attestedDevicePresent:false,hookBlocked:hook?.block===true,listStatus:list.details.status,listCode:list.details.code,readStatus:read.details.status,readCode:read.details.code,bodyReturned:typeof read.details.original?.text==='string',payloadReads,syntheticCompletions:f.modelCalls(),pass:isDevice?list.isError===true&&read.isError===true&&payloadReads===0:list.details.status==='listed'&&read.details.status==='read'});
 turn.end();
}catch(error){results.push({name,harnessError:String(error),pass:false})}finally{for(const c of clean.reverse())await c()}}
await run('missing-gateway-device-looking-transport',deviceRequester,undefined);
await run('normal-gateway-device-looking-transport',deviceRequester,{client:{connId:'synthetic-normal-channel',internal:{authenticatedOperator:true}},isWebchatConnect:()=>false,hasCurrentClientAuthority:()=>true});
await run('ordinary-explicit-profile-control','synthetic-requester',undefined);
CatalogReader.prototype.readPayload=originalRead;
const result={sdk:'2026.10.9',scope:'actual registered plugin/hook/factory, synthetic grant/source/Host facts; no Host or real model',tests:results.length,pass:results.filter(x=>x.pass).length,fail:results.filter(x=>!x.pass).length,results};await fs.writeFile(new URL('./PROBES.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
