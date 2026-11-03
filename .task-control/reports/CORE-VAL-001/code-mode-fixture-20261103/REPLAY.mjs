import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSingleSourceTestBoundary as oldBoundary } from '../single-source-test-prep-20261102/frozen/scripts/lib/single-source-test-boundary.mjs';
import { createSingleSourceTestBoundary as repaired, singleSourceCodeModeProgram } from '../../../../scripts/lib/single-source-test-boundary.mjs';
const text='Synthetic regression only';
const seed={agentId:'main',sessionKey:'synthetic',sessionId:'synthetic-id',requestSha256:createHash('sha256').update(text).digest('hex'),ref:{id:'synthetic-fragment',version:'sha256:'+'a'.repeat(64)}};
const rows=[];
for(const [name,create] of [['original',oldBoundary],['candidate',repaired]]) {
 const receipts=[],abort=new AbortController(),gate=create(seed,{onChange:s=>receipts.push(s)});
 gate.observeDispatch({runId:'synthetic-run',sessionKey:seed.sessionKey,ctx:{AgentId:'main',SessionKey:seed.sessionKey,ChatType:'direct',rawText:text}},{dispatchKind:'agent',abortSignal:abort.signal});
 const ctx={...seed,runId:'synthetic-run',toolName:'exec',toolCallId:'synthetic-control',abortSignal:abort.signal,toolKind:'code_mode_exec',toolInputKind:'javascript'};
 const response=gate.beforeTool({toolName:'exec',toolCallId:ctx.toolCallId,runId:ctx.runId,toolKind:ctx.toolKind,toolInputKind:ctx.toolInputKind,params:{code:singleSourceCodeModeProgram(seed.ref)}},ctx);
 const denied=gate.beforeTool({toolName:'web_fetch',toolCallId:'bad',runId:ctx.runId,params:{}},{...ctx,toolName:'web_fetch',toolCallId:'bad'});
 rows.push({name,outerBlocked:response?.block===true,reason:response?.blockReason??null,deniedToolBlocked:denied.block===true,transitionReceipts:receipts.length,lastReceiptDenials:receipts.at(-1)?.denials??null});
}
assert.equal(rows[0].reason,'test_other_tool_forbidden');assert.equal(rows[0].transitionReceipts,0);
assert.equal(rows[1].outerBlocked,false);assert.equal(rows[1].lastReceiptDenials,1);
assert.ok(rows.every(x=>x.deniedToolBlocked));
console.log(JSON.stringify({kind:'same synthetic regression, historical red and candidate green',rows,providerCalls:0,sourceIO:0,hostStarted:false},null,2));
