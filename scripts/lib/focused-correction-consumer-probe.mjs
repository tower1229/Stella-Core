import './module-audit.mjs';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { recordOwnedWorkState } from './sdk-owner-supervisor.mjs';
const root = await realpath(process.cwd());
const artifactRoot = path.join(root, 'node_modules/@tower1229/stella-core');
const results = { scope: 'focused_consumer_offline', groups: [], actualHostAccepted: false, realModelAccepted: false, fullMemoryAccepted: false };
let fixture, CatalogReader, objectVersion, canonicalJson, WORK_GOAL_B, CORRECT, MEMORY;
const expected = JSON.parse(await readFile('expected.json', 'utf8'));
const digest = b => createHash('sha256').update(b).digest('hex');
after(async () => {
  results.moduleAudit = globalThis[Symbol.for('stella.focused.consumer.audit')];
  await writeFile('consumer-result.json', JSON.stringify(results, null, 2));
  await recordOwnedWorkState({ status: 'complete' });
});

test('package artifact, actual entry and explicit public SDK peer resolve inside the consumer boundary', async () => {
  const main = await realpath(fileURLToPath(import.meta.resolve('@tower1229/stella-core')));
  assert.equal(main, path.join(artifactRoot, 'dist/src/plugin.js'));
  const metadata = JSON.parse(await readFile(path.join(artifactRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.main, './dist/src/plugin.js');
  const peer = JSON.parse(await readFile(path.join(root, 'node_modules/openclaw/package.json'), 'utf8'));
  assert.equal(peer.version, expected.sdkVersion); assert.equal(peer.version, '2026.10.8');
  const peerEntry = await realpath(fileURLToPath(import.meta.resolve('openclaw/plugin-sdk/plugin-entry')));
  assert.ok(peerEntry.startsWith(expected.sdkRoot + path.sep));
  for (const [file, hash] of Object.entries(expected.artifactFiles))
    assert.equal(digest(await readFile(path.join(artifactRoot, file))), hash, file);
  const entry = await import('@tower1229/stella-core');
  assert.equal(entry.default.id, 'stella-core'); assert.equal(typeof entry.default.register, 'function');
  ({ CatalogReader } = await import('@tower1229/stella-core/dist/src/canghai/catalog-reader.js'));
  ({ canonicalJson, objectVersion } = await import('@tower1229/stella-core/dist/src/canghai/content-version.js'));
  ({ CHECKPOINT_CORRECTION_TOOL: CORRECT, CHECKPOINT_MEMORY_TOOL: MEMORY } = await import('@tower1229/stella-core/dist/src/openclaw/checkpoint-agent-supply.js'));
  ({ fixture } = await import('./registered-fixture.mjs'));
  ({ WORK_GOAL_B } = await import('./checkpoint-work-fixture.mjs'));
  const audit = globalThis[Symbol.for('stella.focused.consumer.audit')];
  assert.ok(audit.files.includes(path.join(artifactRoot, 'dist/src/canghai/authorized-exact-readback.js')));
  results.groups.push({ group: 'artifact', passed: true, entry: 'node_modules/@tower1229/stella-core/dist/src/plugin.js', artifactFiles: Object.keys(expected.artifactFiles).length, sdkVersion: peer.version, workspaceModuleFallbacks: 0 });
});

test('installed primary registration commits once and reopens exact receipt target; retry only reads', { timeout: 120_000 }, async t => {
  assert.ok(fixture); const f = await fixture(t); await f.begin();
  const before = (await f.rpc('status')).payload.authority;
  const schema = f.tool(CORRECT).parameters;
  assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.properties, {});
  await assert.rejects(f.call(CORRECT, {}, { hook: false }), /scope_unavailable/);
  const result = (await f.call(CORRECT, {})).details;
  assert.equal(result.status, 'readback_verified'); assert.equal(result.correction.persistenceStatus, 'local_committed');
  assert.equal(result.readback.documents.length, 1);
  const doc = result.readback.documents[0], record = JSON.parse(doc.text);
  assert.equal(record.goal, WORK_GOAL_B); assert.equal(doc.target.ref.version, objectVersion(record));
  const reader = await CatalogReader.load(f.root, f.source.catalogPath), change = await reader.read(result.correction.changeRef, 'changes');
  assert.equal(change.operationId, result.correction.operationId); assert.deepEqual(change.targetRefs, [doc.target.ref]);
  assert.equal(canonicalJson(await reader.read(doc.target.ref, 'works')), doc.text);
  const head = await f.git('rev-parse', 'HEAD'); assert.equal(head, result.currentMemory.checkpointRevision);
  assert.notEqual(head, before.revision); assert.equal(await f.git('rev-list', '--count', `${f.revision}..HEAD`), '2');
  const inference = f.llmCalls.filter(call => call.purpose === 'stella-correction').length;
  assert.deepEqual((await f.call(CORRECT, {})).details, result);
  assert.equal(f.llmCalls.filter(call => call.purpose === 'stella-correction').length, inference);
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
  results.groups.push({ group: 'registered_correction', passed: true, archiveCommits: 1, correctionCommits: 1, operationId: result.correction.operationId, receiptRevision: head, exactTarget: doc.target, retryCorrectionInferenceCalls: 0, retryCommits: 0, configWrites: f.counts().configWrites });
});

test('missing permission and changed admitted grant refuse without protected payloads or business commits', { timeout: 120_000 }, async t => {
  assert.ok(fixture);
  for (const kind of ['missing', 'changed']) await t.test(kind, async t => {
    const f = await fixture(t, { emptyDescriptors: true }); await f.begin();
    const head = await f.git('rev-parse', 'HEAD');
    const grantPath = path.join(f.root, f.source.grantPath), admitted = await readFile(grantPath, 'utf8');
    if (kind === 'changed') await writeFile(grantPath, f.originalGrantBytes);
    const protectedRefs = new Set(JSON.parse(f.originalGrantBytes).descriptors.map(d => canonicalJson(d.sourceRef)));
    const read = CatalogReader.prototype.readPayload; let protectedReads = 0, returned = 0;
    t.mock.method(CatalogReader.prototype, 'readPayload', async function(...args) {
      if (protectedRefs.has(canonicalJson(args[0]))) protectedReads++; return read.apply(this, args);
    });
    try {
      await assert.rejects((async () => { const value = await f.call(MEMORY, { action: 'work' }); returned++; return value; })(),
        { category: kind === 'missing' ? 'personal_context_descriptor_required' : 'personal_context_access_changed' });
      await assert.rejects(f.call(CORRECT, {}), kind === 'missing' ? /descriptor_required/ : /personal_context_access_changed/);
      assert.equal(protectedReads, 0); assert.equal(returned, 0); assert.equal(await f.git('rev-parse', 'HEAD'), head);
      assert.equal(f.llmCalls.filter(call => call.purpose === 'stella-correction').length, 0);
      results.groups.push({ group: 'permission', case: kind, passed: true, protectedPayloadReads: protectedReads, documentsReturned: returned, businessCommits: 0 });
    } finally { await writeFile(grantPath, admitted); }
  });
});

// Regression probes adapted from the independent review; production still comes from the tgz main registration.
test('committed read failure and denied retries retain one receipt without another write', { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.begin(); f.control.denyReadback = true;
  const failed = (await f.call(CORRECT, {})).details;
  assert.equal(failed.status, 'readback_failed');
  assert.equal(failed.correction.persistenceStatus, 'local_committed');
  assert.equal(failed.readback.category, 'source_topic_unresolved');
  assert.deepEqual(failed.readback.documents, []);
  const head = await f.git('rev-parse', 'HEAD');
  assert.equal(head, failed.currentMemory.checkpointRevision);
  assert.equal(await f.git('rev-list', '--count', f.revision + '..HEAD'), '2');
  const inference = f.llmCalls.filter(call => call.purpose === 'stella-correction').length;
  const read = CatalogReader.prototype.readPayload; let payloadReads = 0;
  t.mock.method(CatalogReader.prototype, 'readPayload', async function(...args) { payloadReads++; return read.apply(this, args); });
  await assert.rejects(f.call(CORRECT, {}, { hook: false }), /scope_unavailable/);
  assert.equal(payloadReads, 0);
  const grantPath = path.join(f.root, f.source.grantPath), admitted = await readFile(grantPath, 'utf8');
  const modified = JSON.parse(admitted); modified.descriptors = [];
  f.control.denyReadback = false; await writeFile(grantPath, canonicalJson(modified));
  let denied;
  try {
    denied = (await f.call(CORRECT, {})).details;
    assert.equal(denied.status, 'readback_failed');
    assert.equal(denied.readback.category, 'personal_context_access_changed');
    assert.deepEqual(denied.correction, failed.correction);
    assert.deepEqual(denied.readback.documents, []);
    assert.equal(payloadReads, 0);
    assert.equal(await f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.llmCalls.filter(call => call.purpose === 'stella-correction').length, inference);
  } finally { await writeFile(grantPath, admitted); }
  const retried = (await f.call(CORRECT, {})).details;
  assert.equal(retried.status, 'readback_verified');
  assert.deepEqual(retried.correction, failed.correction); assert.deepEqual(retried.currentMemory, failed.currentMemory);
  const doc = retried.readback.documents[0]; assert.equal(JSON.parse(doc.text).goal, WORK_GOAL_B);
  assert.equal(objectVersion(JSON.parse(doc.text)), doc.target.ref.version);
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.llmCalls.filter(call => call.purpose === 'stella-correction').length, inference);
  assert.equal(f.counts().configWrites, 0);
  const reader = await CatalogReader.load(f.root, f.source.catalogPath);
  assert.deepEqual((await reader.read(failed.correction.changeRef, 'changes')).targetRefs, [doc.target.ref]);
  results.additionalChecks ??= {};
  results.additionalChecks.failedReadRetry = { status: 'passed', failedReadCategory: failed.readback.category,
    deniedRetryCategory: denied.readback.category, deniedRetryPayloadReads: 0, deniedRetryDocuments: 0,
    missingPermitPayloadReads: 0, totalCommits: 2, retryCommits: 0, retryCorrectionInferenceCalls: 0, exactReceipt: true };
});

test('module audit rejects ESM and CJS symlinks escaping the consumer', async () => {
  const { symlink } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runChild = promisify(execFile), harness = path.join(root, 'harness'), parent = path.dirname(root);
  for (const kind of ['mjs', 'cjs']) {
    const outside = path.join(parent, 'review-forbidden.' + kind);
    await writeFile(outside, "globalThis.REVIEW_FORBIDDEN_EXECUTED=true;\n");
    await symlink(outside, path.join(harness, 'review-symlink.' + kind));
  }
  const child = path.join(harness, 'review-audit-child.mjs');
  await writeFile(child, [
    "import './module-audit.mjs';",
    "import assert from 'node:assert/strict'; import { createRequire } from 'node:module';",
    "try {",
    "if (process.argv[2] === 'mjs') await import('./review-symlink.mjs');",
    "else createRequire(import.meta.url)('./review-symlink.cjs');",
    "assert.fail('outside module accepted');",
    "} catch (error) { assert.equal(error.message,'FOCUSED_CONSUMER_MODULE_OUTSIDE_BOUNDARY'); }",
    "assert.notEqual(globalThis.REVIEW_FORBIDDEN_EXECUTED,true);",
    "assert.equal(globalThis[Symbol.for('stella.focused.consumer.audit')].denied.length,1);",
    "console.log('review audit denied before execution');"
  ].join('\n'));
  for (const kind of ['mjs', 'cjs']) {
    const { stdout } = await runChild(process.execPath, [child, kind], { cwd: root, env: process.env, timeout: 15_000 });
    assert.equal(stdout.trim(), 'review audit denied before execution');
  }
  results.additionalChecks ??= {};
  results.additionalChecks.symlinkAudit = { status: 'passed', esmDeniedBeforeExecution: true, cjsDeniedBeforeExecution: true };
});
