// Diagnostic only: extract fixed official functions; no Host module is imported.
// Synthetic unresolved persistence, no session, listener, credentials or provider.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? '.');
const sourceHashes = {};
function extract(file, name) {
  const text = readFileSync(resolve(root, 'node_modules/openclaw/dist', file), 'utf8');
  sourceHashes[file] = createHash('sha256').update(text).digest('hex');
  const marker = `${name === 'releaseRuntimePluginWork' ? 'async ' : ''}function ${name}(`;
  const start = text.indexOf(marker);
  assert(start >= 0, `missing ${name}`);
  const end = text.indexOf('\n}', start) + 2;
  assert(end > start, `missing end ${name}`);
  return text.slice(start, end);
}
const context = vm.createContext({
  recordAgentCleanupFailure() { throw new Error('unexpected cleanup failure'); },
  hasRetainedPluginRuntimeCloseError() { throw new Error('unexpected release error'); },
  toErrorObject(value) { return value instanceof Error ? value : new Error(String(value)); },
});
const definitions = [
  'const OPENCLAW_ABORTABLE_WRAPPER = Symbol.for("openclaw.abortable.wrapper");',
  ...['createAbortableError', 'withAbortListener', 'abortable'].map(name => extract('abortable-Cd6QbDOo.mjs', name)),
  extract('builtin-openclaw-BxzDR6yL.mjs', 'createEmbeddedAttemptSessionSettleTracker'),
  extract('attempt-system-prompt-prepare-ChKsbjSh.mjs', 'installModelPromptProjection'),
  extract('runtime-plugins-B5lnDthu.mjs', 'releaseRuntimePluginWork'),
].join('\n');
vm.runInContext(definitions, context, { timeout: 1000 });
const { abortable, createEmbeddedAttemptSessionSettleTracker, installModelPromptProjection, releaseRuntimePluginWork } = context;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function runCase({ preAborted = false, cooperative = false }) {
  const controller = new AbortController();
  const pending = deferred();
  let reads = 0, resumedAfterWait = 0, physicalSettled = false, custodyReleased = 0;
  const session = { agent: {}, abort: async () => {} };
  if (preAborted) controller.abort(new Error('synthetic cancelled before projection'));
  const uninstall = installModelPromptProjection({
    session, transcriptPrompt: 'synthetic input', modelPrompt: 'synthetic projected input',
    shouldCapturePrompt: () => true,
    recorder: {
      waitForRuntimePersistence() {
        reads += 1;
        // Contrast only: this synthetic lower owner honors cancellation.
        // It does not prove that any real storage operation can be abandoned.
        return cooperative ? abortable(controller.signal, pending.promise) : pending.promise;
      },
      getPersistedMessage() { resumedAfterWait += 1; throw new Error('must not read after abort'); },
    },
  });
  const tracker = createEmbeddedAttemptSessionSettleTracker(session);
  const physical = tracker.trackPromptSettlePromise(session.agent.transformContext([], controller.signal));
  physical.then(() => { physicalSettled = true; }, () => { physicalSettled = true; });
  const outer = abortable(controller.signal, physical).then(() => 'success', e => e.name);
  if (!preAborted) controller.abort(new Error('synthetic cancellation'));
  assert.equal(await outer, 'AbortError');
  await tick();
  const join = tracker.buildAbortSettlePromise();
  const release = releaseRuntimePluginWork(async () => { await join; }, () => { custodyReleased += 1; });
  await tick();
  const beforeUnblock = { reads, physicalSettled, custodyReleased, resumedAfterWait };
  assert.equal(reads, 1);
  assert.equal(resumedAfterWait, 0);
  assert.equal(physicalSettled, cooperative);
  assert.equal(custodyReleased, cooperative ? 1 : 0);
  pending.resolve();
  await Promise.allSettled([physical, release]);
  await tick();
  assert.equal(physicalSettled, true);
  assert.equal(custodyReleased, 1);
  assert.equal(resumedAfterWait, 0);
  assert.equal(tracker.buildAbortSettlePromise(), null);
  uninstall();
  return { preAborted, cooperative, beforeUnblock, afterUnblock: { physicalSettled, custodyReleased, resumedAfterWait }, pass: true };
}
const cases = [];
for (const options of [{}, { preAborted: true }, { cooperative: true }]) cases.push(await runCase(options));
console.log(JSON.stringify({
  scope: 'synthetic exact-function mechanism reproduction, not actual-run root cause or Host integration',
  sourceHashes, cases, total: cases.length, pass: cases.filter(c => c.pass).length,
  hostModulesImported: 0, hostRequests: 0, providerRequests: 0, privatePayloads: 0,
  limitation: 'Does not identify which actual await hung; cooperative contrast does not cancel or certify any real storage work.',
}, null, 2));
