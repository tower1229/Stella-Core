// Bounded diagnosis of the installed 2026.10.9 distribution. No Host, private
// data, credentials, service, network or model calls. Not a production adapter.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '.'), dist = path.join(root, 'node_modules/openclaw/dist');
const pins = new Map(), checks = [];
async function source(file) {
  const bytes = await readFile(path.join(dist, file));
  pins.set(file, createHash('sha256').update(bytes).digest('hex'));
  return bytes.toString('utf8');
}
async function fn(file, name, globals) {
  const text = await source(file), marker = `function ${name}(`, start = text.indexOf(marker);
  assert.ok(start >= 0); const end = text.indexOf('\n}', start); assert.ok(end > start);
  const code = (text.slice(start - 6, start) === 'async ' ? 'async ' : '') + text.slice(start, end + 2);
  return vm.runInNewContext(`(${code})`, globals);
}
const runtime = {}, registration = { pluginId: 'memory-core', capability: { runtime } };
const core = await source('extensions/memory-core/index.js');
const registrationBody = core.slice(core.indexOf('api.registerMemoryCapability({'), core.indexOf('for (const contract of [MEMORY_SEARCH_TOOL_CONTRACT'));
assert.match(registrationBody, /runtime: memoryRuntime/); assert.ok(!registrationBody.includes('providerRuntime'));
checks.push('memory-core registers runtime, not providerRuntime');
const getRegistration = await fn('memory-state-YBTzZa6s.mjs', 'getMemoryCapabilityRegistration', { getMemoryCapability: () => registration });
assert.equal(getRegistration().capability.runtime, runtime); assert.equal(getRegistration().capability.runtime, getRegistration().capability.runtime);
checks.push('public registration projection preserves runtime identity');
const kind = await fn('memory-state-YBTzZa6s.mjs', 'resolveLoadedMemoryProviderKind', { getMemoryCapability: () => registration });
assert.equal(kind({}), 'legacy');
let resolutions = 0;
const audience = { kind: 'owner-private', agentId: 'main' };
const resolveAudience = await fn('embedded-agent-DoEPu8ye.mjs', 'resolveEmbeddedAttemptMemoryAudience', {
  resolveLoadedMemoryProviderKind: kind, retainedAudience() {},
  resolveMemoryAudienceFromEntry: async () => { resolutions++; return { status: 'granted', audience, release() {} }; },
});
const params = { agentId: 'main', sessionKey: 'agent:main:synthetic', sessionId: 'synthetic', senderIsOwner: true,
  admission: { storePath: '/synthetic/not-accessed', entry: {} } };
assert.equal((await resolveAudience(params)).memoryAudience, undefined); assert.equal(resolutions, 0);
registration.capability.providerRuntime = {};
assert.equal((await resolveAudience(params)).memoryAudience, audience); assert.equal(resolutions, 1);
delete registration.capability.providerRuntime;
checks.push('ordinary memory omits audience; native provider positive control resolves it');
const project = await fn('openclaw-tools-CSSYZDKR.mjs', 'resolveOpenClawPluginToolInputs', {
  resolveSessionAgentIds: () => ({ sessionAgentId: 'main' }), resolveWorkspaceRoot: x => x,
  modelKey: (p, m) => `${p}/${m}`, normalizeDeliveryContext: () => undefined,
  normalizeConversationReadInvocationOrigin: () => undefined,
});
const context = project({ options: { runSessionKey: params.sessionKey, sessionId: params.sessionId,
  workspaceDir: '/synthetic', senderIsOwner: true, modelProvider: 'google', modelId: 'gemini-3.8-flash' },
  resolvedConfig: {}, runtimeConfig: {} }).context;
assert.equal(context.memoryAudience, undefined); assert.equal(context.assertMemoryAudienceCurrent, undefined);
assert.equal(context.requesterSenderId, undefined); assert.equal(context.senderIsOwner, true);
assert.equal(context.activeModel.modelRef, 'google/gemini-3.8-flash');
checks.push('official factory projection retains optional audience and trusted owner fields');
const blocked = await fn('agent-tools.before-tool-call-CQkX3nOj.mjs', 'buildBlockedToolResult', {
  recordPreExecutionBlockedToolCall() {}, preExecutionBlockedToolResults: new WeakSet(),
});
assert.equal(blocked({ reason: 'synthetic' }).details.status, 'blocked');
checks.push('before-tool-call denial is blocked, distinct from observed Core failed envelope');
await source('tool-search-BorBxVGT.mjs');
const { r: ToolSearchRuntime } = await import(pathToFileURL(path.join(dist, 'tool-search-BorBxVGT.mjs')));
let targetCalls = 0;
const tool = { name: 'stella_source_read', description: 'Synthetic dispatcher probe', parameters: { type: 'object' },
  async execute(callId, args) {
    targetCalls++; assert.equal(context.memoryAudience, undefined); assert.equal(context.senderIsOwner, true);
    assert.equal(callId, 'tool_call:synthetic-parent:stella_source_read:1'); assert.deepEqual(args, { action: 'list' });
    return { content: [], details: { status: 'synthetic-target-reached' } };
  } };
const entry = { id: 'openclaw:stella-core:stella_source_read', name: tool.name, source: 'openclaw', sourceName: 'stella-core', tool };
const catalog = { entries: [entry], counterScope: 'synthetic', callCount: 0, searchCount: 0, describeCount: 0 };
const dispatcher = new ToolSearchRuntime({ config: {}, runtimeConfig: {}, catalogRef: { current: catalog } }, {});
const result = await dispatcher.executeEntry(catalog, entry, { action: 'list' }, { parentToolCallId: 'synthetic-parent' });
assert.equal(result.result.details.status, 'synthetic-target-reached'); assert.equal(targetCalls, 1); assert.equal(catalog.callCount, 1);
checks.push('official dispatcher invokes original target closure and generates nested call identity');
console.log(JSON.stringify({ sdk: JSON.parse(await readFile(path.join(dist, '../package.json'), 'utf8')).version,
  checks, passed: checks.length, pins: Object.fromEntries(pins), limits: [
    'Function extracts use synthetic dependencies; dispatcher test isolates executeEntry without live Host hooks.',
    'No live request-context snapshot was captured in the prior run; this proves a deterministic contract mismatch, not every conjunct of its shared error.',
    'No live Host, model, native session admission, device authentication or real source consumption is proven.'
  ] }, null, 2));
