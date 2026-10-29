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
let fixture, CatalogReader, validMemoryRef, objectVersion, canonicalJson, bytesVersion, WORK_GOAL_B, CORRECT, MEMORY;
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
  ({ CatalogReader, validMemoryRef } = await import('@tower1229/stella-core/dist/src/canghai/catalog-reader.js'));
  ({ canonicalJson, objectVersion, bytesVersion } = await import('@tower1229/stella-core/dist/src/canghai/content-version.js'));
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

test('packaged next requests and same-process re-registration bind fresh runs to the corrected version', { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.begin();
  const originalInputHash = bytesVersion(f.event.ctx.Body), session = { key: f.agent.sessionKey, id: f.agent.sessionId };
  const corrected = (await f.call(CORRECT, {})).details;
  assert.equal(corrected.status, 'readback_verified');
  assert.equal(corrected.correction.persistenceStatus, 'local_committed');
  const target = corrected.readback.documents[0].target.ref;
  assert.notEqual(f.source.workRecord.goal, WORK_GOAL_B);
  assert.equal(objectVersion(JSON.parse(corrected.readback.documents[0].text)), target.version);
  const oldTool = f.tool(MEMORY), oldPermit = await f.permit(MEMORY, { action: 'work' });
  const inference = f.llmCalls.filter(call => call.purpose === 'stella-correction').length;
  const requests = [];
  for (const reopen of [false, true]) {
    const previousRun = f.event.runId, before = (await f.rpc('status')).payload.authority, calls = f.llmCalls.length;
    await f.next(reopen);
    assert.notEqual(f.event.runId, previousRun);
    assert.notEqual(f.event.runId, corrected.currentMemory.userRequest);
    assert.equal(f.agent.sessionKey, session.key); assert.equal(f.agent.sessionId, session.id);
    const head = await f.git('rev-parse', 'HEAD');
    const current = (await f.call(MEMORY, { action: 'work' })).details;
    assert.equal(current.currentMemory.userRequest, f.event.runId);
    assert.equal(current.works.length, 1); assert.deepEqual(current.works[0].ref, target);
    assert.equal(current.works[0].record.goal, WORK_GOAL_B);
    assert.equal(objectVersion(current.works[0].record), target.version);
    for (const field of ['confirmedPremises', 'candidateIdeas', 'rejectedInterpretations', 'openQuestions', 'nextStep']) {
      assert.deepEqual(current.works[0].record[field], f.source.workRecord[field]);
      if (Array.isArray(f.source.workRecord[field])) assert.ok(f.source.workRecord[field].length > 0, field);
    }
    const checkpoint = (await f.rpc('status')).payload.authority;
    assert.equal(current.currentMemory.checkpointRevision, checkpoint.revision); assert.equal(checkpoint.revision, head);
    assert.notEqual(checkpoint.token, before.token);
    const sourceCalls = f.llmCalls.slice(calls).filter(call => call.purpose === 'stella-source-access');
    assert.ok(sourceCalls.length > 0);
    for (const call of sourceCalls) {
      const data = JSON.parse(String(call.messages[0].content).split('\n').at(-1));
      assert.equal(data.requestHash, bytesVersion(f.event.ctx.Body)); assert.notEqual(data.requestHash, originalInputHash);
    }
    await assert.rejects(oldTool.execute(oldPermit, { action: 'work' }, f.controller.signal), /scope_unavailable/);
    assert.equal(f.llmCalls.filter(call => call.purpose === 'stella-correction').length, inference);
    assert.equal(await f.git('rev-parse', 'HEAD'), head, 'new request reads and refused old permits do not write');
    requests.push({ sameProcessReregistered: reopen, runId: f.event.runId, userRequest: current.currentMemory.userRequest,
      checkpointRevision: checkpoint.revision, exactTarget: current.works[0].ref, sourceAccessDecisions: sourceCalls.length,
      currentInputHash: bytesVersion(f.event.ctx.Body), oldPermitRefused: true, correctionInferenceCalls: 0, businessCommits: 0 });
  }
  assert.equal(await f.git('rev-list', '--count', f.revision + '..HEAD'), '4', 'three ingress archives and one correction');
  assert.equal(await f.git('status', '--porcelain'), ''); assert.equal(f.counts().configWrites, 0);
  results.requestFreshness = { status: 'passed', receiptRevision: corrected.currentMemory.checkpointRevision,
    correctedRun: corrected.currentMemory.userRequest, requests, archiveCommits: 3, correctionCommits: 1,
    candidateCounterevidenceAndOpenFieldsPreserved: true, crossProcessRecoveryTested: false };
});

test('packaged re-registration reloads reduced synthetic descriptors before protected reads', { timeout: 120_000 }, async t => {
  const { applyMemoryTransaction } = await import('@tower1229/stella-core/dist/src/canghai/memory-transaction.js');
  const { openLocalCheckpointRecovery } = await import('@tower1229/stella-core/dist/src/canghai/local-checkpoint-recovery.js');
  const f = await fixture(t); await f.begin();
  const corrected = (await f.call(CORRECT, {})).details; assert.equal(corrected.status, 'readback_verified');
  const oldTool = f.tool(MEMORY), oldPermit = await f.permit(MEMORY, { action: 'work' });
  await f.hooks.get('agent_end')({}, f.agent);
  const before = (await f.rpc('status')).payload.authority;
  const grantPath = f.source.grantPath, grantBytes = await readFile(path.join(f.root, grantPath), 'utf8');
  const reduced = JSON.parse(grantBytes); assert.ok(reduced.descriptors.length > 0); reduced.descriptors = [];
  const authority = await openLocalCheckpointRecovery({ stateDirectory: f.config.checkpointStateDirectory, binding: before.binding });
  await applyMemoryTransaction(f.root, { operationId: 'synthetic-packaged-reduce-descriptors',
    journalPath: '30_PersonalData/memory/operations/synthetic-packaged-reduce-descriptors.json',
    recoveryCheckpoint: { binding: before.binding, expected: { revision: before.revision, token: before.token } },
    files: [{ path: grantPath, before: grantBytes, after: canonicalJson(reduced) }] }, {
    recovery: { authority, expected: before, assertPublication: accepted => authority.assertCurrent(accepted) },
    validate: () => authority.assertCurrent(before),
    async persist(paths) { await f.git('add', '--', ...paths); await f.git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', '[synthetic] reduce packaged descriptors', '--', ...paths); },
    async confirmPreviouslyCommitted() { throw new Error('Exact synthetic checkpoint publication required'); },
  });
  const inference = f.llmCalls.filter(call => call.purpose === 'stella-correction').length;
  const oldRun = f.event.runId; await f.next(true); assert.notEqual(f.event.runId, oldRun);
  const admitted = (await f.rpc('status')).payload.authority, head = await f.git('rev-parse', 'HEAD');
  assert.equal(admitted.revision, head); assert.notEqual(admitted.token, before.token);
  const reader = await CatalogReader.load(f.root, f.source.catalogPath);
  const change = await reader.read(corrected.correction.changeRef, 'changes'), ownerInputs = new Set();
  for (const ref of change.inputRefs) {
    const evidence = await reader.read(ref, 'evidence'); assert.ok(validMemoryRef(evidence.source));
    const source = await reader.read(evidence.source, 'sources'); assert.ok(validMemoryRef(source.policyRef));
    const policy = await reader.read(source.policyRef, 'policies');
    assert.equal(policy.schemaVersion, 'stella.source-policy/v1'); assert.equal(policy.retention, 'retain');
    assert.ok(policy.readPurposes.includes(f.source.binding.purpose.readPurpose)); ownerInputs.add(canonicalJson(evidence.source));
  }
  const protectedSources = new Set(JSON.parse(grantBytes).descriptors.map(entry => canonicalJson(entry.sourceRef)));
  let protectedPayloadReads = 0, ownerInputPayloadReads = 0, documentsReturned = 0;
  const payload = CatalogReader.prototype.readPayload;
  t.mock.method(CatalogReader.prototype, 'readPayload', async function(...args) {
    const key = canonicalJson(args[0]);
    if (protectedSources.has(key)) protectedPayloadReads++;
    else { assert.ok(ownerInputs.has(key), 'other payload must be an independently permitted owner-input dependency'); ownerInputPayloadReads++; }
    return payload.apply(this, args);
  });
  await assert.rejects((async () => { const value = await f.call(MEMORY, { action: 'work' }); documentsReturned++; return value; })(),
    { category: 'personal_context_descriptor_required' });
  await assert.rejects(oldTool.execute(oldPermit, { action: 'work' }, f.controller.signal), /scope_unavailable/);
  assert.equal(protectedPayloadReads, 0); assert.equal(documentsReturned, 0); assert.equal(ownerInputPayloadReads, 1);
  assert.equal(f.event.ctx.SenderId, 'cli'); assert.equal(f.tool(MEMORY).name, MEMORY);
  assert.equal(f.llmCalls.filter(call => call.purpose === 'stella-correction').length, inference);
  assert.equal(await f.git('rev-parse', 'HEAD'), head); assert.equal(await f.git('status', '--porcelain'), '');
  assert.equal(await f.git('rev-list', '--count', f.revision + '..HEAD'), '4', 'two archives, one correction and explicit permission reduction');
  assert.equal(f.counts().configWrites, 0);
  results.reducedPermissionFreshness = { status: 'passed', newRun: f.event.runId, checkpointRevision: admitted.revision,
    errorCategory: 'personal_context_descriptor_required', protectedPayloadReads, documentsReturned, ownerInputPayloadReads,
    measurementWindow: 'after new request admission, through memory call and refused old permit', oldPermitRefused: true,
    archiveCommits: 2, correctionCommits: 1, explicitSyntheticPermissionReductionCommits: 1, retryCommits: 0,
    correctionInferenceCallsAfterAdmission: 0, sameProcessReregistered: true, crossProcessRecoveryTested: false };
});
