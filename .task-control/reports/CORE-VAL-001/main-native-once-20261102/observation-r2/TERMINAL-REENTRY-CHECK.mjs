// One deterministic independent counterexample, replayed against R1 and R2.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const original = readFileSync(new URL('./INDEPENDENT-COUNTEREXAMPLE.mjs', import.meta.url), 'utf8');
const originalRoot = 'file:///var/folders/3g/sbd2x9l51tb9gkn_k1y2j_7w0000gn/T/core-wait-observation-r1-independent-20261102-uB7lmx/';
const sha = x => createHash('sha256').update(x).digest('hex');
function run(root) {
  let code = original;
  for (const name of ['core-wait-observation-collector.mjs', 'core-wait-observation.mjs']) {
    const from = originalRoot + name;
    assert.equal(code.split(from).length, 2);
    code = code.replace(from, new URL(name, root).href);
  }
  const p = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: code, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', OPENCLAW_TRACE_PREMODEL_WAIT: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 131072
  });
  assert.equal(p.error, undefined); assert.equal(p.status, 0, p.stderr);
  assert.equal(p.signal, null); assert.equal(p.stderr, '');
  return { codeSha256: sha(code), actualExit: p.status, signal: p.signal, stdout: p.stdout,
    stderr: p.stderr, fd3: p.output[3], finalInternalState: JSON.parse(p.stdout.trim()).stateAfterLateWork,
    records: p.output[3].trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) };
}
const red = run(new URL('../observation-r1/', import.meta.url));
assert.equal(red.records.length, 1);
assert.deepEqual(red.records[0], { phase: 'capture_terminal', incomplete: false, emitted: 0 });
assert.equal(red.finalInternalState.incomplete, true);
assert.equal(red.finalInternalState.emitted, 2);
const green = run(new URL('./', import.meta.url));
assert.deepEqual(green.records.map(x => x.phase), ['enter', 'exit']);
assert.equal(green.records[0].id, green.records[1].id);
assert.ok(green.records.every(x => x.point === 'recorder.runtime'));
assert.equal(green.finalInternalState.incomplete, false);
assert.equal(green.finalInternalState.emitted, 2);
assert.equal(green.records.some(x => x.phase === 'capture_terminal'), false);
const result = {
  scope: 'one deterministic late-beforeExit-work regression; no real Host/root-cause test',
  node: process.version, counterexampleSha256: sha(original), importPathsOnlyRebound: true,
  cases: 1, originalFalseCompletenessReproduced: true, r2PrematureCompletenessRemoved: true,
  red, green, captureCompleteness: 'not_attested_even_with_exit0_closed_pipe_and_paired_spans',
  internalIncompleteFalseMeans: 'no observer fault recorded; not proof of complete capture',
  hostStarts: 0, sandboxCalls: 0, networkRequests: 0, modelRequests: 0, privatePayloads: 0
};
writeFileSync(new URL('./TERMINAL-REENTRY-RESULT.json', import.meta.url), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
