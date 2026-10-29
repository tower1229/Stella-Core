import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, objectVersion } from "../src/canghai/content-version.js";

const profile = await import(new URL("../../scripts/lib/installed-correction-profile.mjs", import.meta.url).href);
const legacy = await import(new URL("../../scripts/lib/acceptance-versions.mjs", import.meta.url).href);
const { collectPackageShards } = await import(new URL("../../scripts/lib/package-shards.mjs", import.meta.url).href);
const { assertExperimentalReports } = await import(new URL("../../scripts/lib/experimental-owner-chat-evidence.mjs", import.meta.url).href);
const sha = (digit: string) => digit.repeat(64), rev = (digit: string) => digit.repeat(40);
const identity = { canonicalJson, objectVersion };
function fixture(): { report: any; expected: any } {
  const versions = { targetHostVersion: "2026.10.8", workspaceSdkVersion: "2026.10.8", corePackageVersion: "0.1.0-alpha.0",
    consumer: { hostVersion: "2026.10.8", corePackageVersion: "0.1.0-alpha.0", lockedHostVersion: "2026.10.8",
      cliHostVersion: "2026.10.8", metadataVerified: true, cliVerified: true } };
  const expected = { versions, coreRevision: rev("a"), sourceManifestSha256: sha("b"), artifactSha256: sha("c"),
    consumerLockSha256: sha("d"), packageRoot: "/synthetic-consumer/node_modules/@tower1229/stella-core", hostRoot: "/synthetic-consumer/node_modules/openclaw" };
  const work = { schemaVersion: "stella.ongoing-work/v1", id: "synthetic-writing-work", kind: "writing", status: "active",
    goal: "Preserve the synthetic author's unresolved ending.", sourceRefs: [], confirmedPremises: [], candidateIdeas: [],
    rejectedInterpretations: [], openQuestions: [], nextStep: null };
  const target = { group: "works", ref: { id: work.id, version: objectVersion(work) } };
  const receipt = { operationId: "synthetic-correction-operation", disposition: "update", clarification: null,
    changeRef: { id: "synthetic-learning-change", version: `sha256:${sha("e")}` }, persistenceStatus: "local_committed" };
  const request = { agentId: "synthetic", sessionId: "synthetic-session", sessionKey: "agent:synthetic:direct",
    runId: "synthetic-run", requestHash: `sha256:${sha("f")}`, senderId: "cli", senderIsOwner: true, chatType: "direct", sourceGrantSha256: sha("1") };
  const context = { agentId: request.agentId, sessionId: request.sessionId, sessionKey: request.sessionKey,
    toolCallId: "synthetic-call-1", toolName: "stella_memory_correct", requesterSenderId: request.senderId,
    senderIsOwner: true, abortSignalPresent: true, aborted: false };
  const document = { target, text: canonicalJson(work) }, committedRevision = rev("2"), checkpointToken = "synthetic-checkpoint-token";
  return { expected, report: { schemaVersion: profile.INSTALLED_CORRECTION_PROFILE.reportSchema, profileId: profile.INSTALLED_CORRECTION_PROFILE.id,
    evidenceKind: "offline_contract_fixture", profileAccepted: false, hostExecutionAccepted: false, experimentalOwnerChatAccepted: false,
    fullMemoryAccepted: false, realModelAccepted: false, privateMainAccepted: false, formalConsumerAccepted: false, issue23Complete: false,
    cancelled: false, exitCode: 0, signal: null, versions: structuredClone(versions), hostVersionOutput: "OpenClaw 2026.10.8 (synthetic)",
    coreRevision: expected.coreRevision, sourceClean: true, buildIdentity: { coreRevision: expected.coreRevision, sourceClean: true },
    sourceManifestSha256: expected.sourceManifestSha256, artifactSha256: expected.artifactSha256, consumerLockSha256: expected.consumerLockSha256,
    installation: { packageRoot: expected.packageRoot, entry: `${expected.packageRoot}/dist/src/plugin.js`, hostRoot: expected.hostRoot,
      sdkRoot: expected.hostRoot, directHostLoad: true, observerWrapper: false, artifactSha256: expected.artifactSha256, consumerLockSha256: expected.consumerLockSha256 },
    request, archive: { runId: request.runId, requestHash: request.requestHash, revision: rev("3"),
      ownerEvidenceRef: { id: "synthetic-owner-input", version: `sha256:${sha("4")}` } },
    committed: { revision: committedRevision, checkpointToken, receipt, target,
      change: { operationId: receipt.operationId, changeRef: receipt.changeRef, targetRefs: [target.ref] } },
    attempts: [{ sourceGrantSha256: request.sourceGrantSha256, beforeTool: { ...context, runId: request.runId }, execute: { ...context, parameters: {} },
      output: { correction: structuredClone(receipt), status: "readback_verified", readback: { status: "verified", documents: [document] },
        currentMemory: { userRequest: request.runId, checkpointRevision: committedRevision, checkpointToken } },
      diskReadback: { revision: committedRevision, document: structuredClone(document) },
      counters: { archiveCommits: 1, correctionCommits: 1, correctionInferenceCalls: 2 } }] } };
}
const validate = (f: ReturnType<typeof fixture>) => profile.validateInstalledCorrectionReport(f.report, f.expected, identity);
function failRead(f: ReturnType<typeof fixture>) {
  const attempt = f.report.attempts[0]; attempt.output.status = "readback_failed";
  attempt.output.readback = { status: "failed", category: "source_topic_unresolved", documents: [] }; attempt.diskReadback = null;
}
function retry(f: ReturnType<typeof fixture>) {
  const attempt = structuredClone(f.report.attempts[0]); attempt.beforeTool.toolCallId = attempt.execute.toolCallId = "synthetic-call-2";
  f.report.attempts.push(attempt); return attempt;
}

test("10.8 profile validates the current committed/verified shape without accepting any Host or complete gate", () => {
  const f = fixture(), before = structuredClone(f), result = validate(f);
  assert.equal(result.evidenceConsistency, "validated"); assert.equal(result.observedOutcome, "readback_verified");
  assert.equal(result.persistenceStatus, "local_committed"); assert.equal(profile.INSTALLED_CORRECTION_PROFILE.executionConnected, false);
  for (const name of ["profileAccepted", "hostExecutionAccepted", "experimentalOwnerChatAccepted", "fullMemoryAccepted", "realModelAccepted", "privateMainAccepted", "formalConsumerAccepted", "issue23Complete"])
    assert.equal(result[name], false, name);
  assert.equal(result.status, undefined); assert.deepEqual(f, before);
});

test("committed read failure is valid failure evidence; recovery and retry keep the exact committed receipt", () => {
  const f = fixture(); failRead(f); const failed = validate(f);
  assert.equal(failed.observedOutcome, "readback_failed"); assert.equal(failed.persistenceStatus, "local_committed"); assert.equal(failed.profileAccepted, false);
  const recovered = retry(f), success = fixture().report.attempts[0];
  recovered.output = success.output; recovered.diskReadback = success.diskReadback;
  assert.equal(validate(f).observedOutcome, "readback_verified");
  const repeated = fixture(); retry(repeated); assert.equal(validate(repeated).observedOutcome, "readback_verified");
});

test("uninstalled, inconsistent or cancelled observations fail closed", async t => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["consumer null", f => { f.expected.versions.consumer = f.report.versions.consumer = null; }],
    ["consumer absent", f => { delete f.expected.versions.consumer; }],
    ["old target", f => { f.expected.versions.targetHostVersion = "2026.8.2"; }],
    ["wrong workspace SDK", f => { f.expected.versions.workspaceSdkVersion = "2026.10.7"; }],
    ...["hostVersion", "lockedHostVersion", "cliHostVersion", "corePackageVersion", "metadataVerified", "cliVerified"].map(name =>
      [`consumer ${name}`, (f: ReturnType<typeof fixture>) => { f.expected.versions.consumer[name] = "wrong"; }] as [string, (f: ReturnType<typeof fixture>) => void]),
    ["different observed versions", f => { f.report.versions.consumer.lockedHostVersion = "2026.8.2"; }],
    ["wrong CLI", f => { f.report.hostVersionOutput = "OpenClaw 2026.8.2"; }],
    ["CLI diagnostic impersonates version", f => { f.report.hostVersionOutput = "warning: expected 2026.10.8"; }],
    ...["artifactSha256", "consumerLockSha256", "sourceManifestSha256", "coreRevision"].map(name =>
      [`wrong ${name}`, (f: ReturnType<typeof fixture>) => { f.report[name] = sha("9"); }] as [string, (f: ReturnType<typeof fixture>) => void]),
    ["wrong build source", f => { f.report.buildIdentity.coreRevision = rev("9"); }],
    ["dirty source", f => { f.report.sourceClean = false; }],
    ["workspace SDK escape", f => { f.report.installation.sdkRoot = "/synthetic-workspace/node_modules/openclaw"; }],
    ["source entry fallback", f => { f.report.installation.entry = "/synthetic-workspace/src/plugin.ts"; }],
    ["installed artifact mismatch", f => { f.report.installation.artifactSha256 = sha("9"); }],
    ["installed lock mismatch", f => { f.report.installation.consumerLockSha256 = sha("9"); }],
    ["observer wrapper", f => { f.report.installation.observerWrapper = true; }],
    ["cancelled with exit zero", f => { f.report.cancelled = true; }],
    ["signal with exit zero", f => { f.report.signal = "SIGTERM"; }],
    ["failed exit", f => { f.report.exitCode = 1; }],
    ["claims actual Host capture", f => { f.report.evidenceKind = "host_capture"; }],
    ["old profile", f => { f.report.profileId = "stella.experimental-owner-chat-ci/v1"; }],
    ["unearned profile pass", f => { f.report.profileAccepted = true; }],
    ["unearned complete pass", f => { f.report.fullMemoryAccepted = true; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const f = fixture(); mutate(f); assert.throws(() => validate(f)); });
});

test("owner or session alone never substitutes for matching request, hook, executor and archive evidence", async t => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ...["runId", "sessionId", "sessionKey", "senderId", "sourceGrantSha256"].map(name =>
      [`missing ${name}`, (f: ReturnType<typeof fixture>) => { delete f.report.request[name]; }] as [string, (f: ReturnType<typeof fixture>) => void]),
    ["not owner", f => { f.report.request.senderIsOwner = false; }],
    ["not direct", f => { f.report.request.chatType = "group"; }],
    ["wrong archive input", f => { f.report.archive.requestHash = `sha256:${sha("9")}`; }],
    ["wrong hook run", f => { f.report.attempts[0].beforeTool.runId = "other-run"; }],
    ["missing hook run", f => { delete f.report.attempts[0].beforeTool.runId; }],
    ["missing requester", f => { delete f.report.attempts[0].beforeTool.requesterSenderId; }],
    ["missing call id", f => { delete f.report.attempts[0].beforeTool.toolCallId; }],
    ["wrong executor session", f => { f.report.attempts[0].execute.sessionId = "other-session"; }],
    ["different executor call", f => { f.report.attempts[0].execute.toolCallId = "other-call"; }],
    ["different source grant", f => { f.report.attempts[0].sourceGrantSha256 = sha("9"); }],
    ["cancelled tool", f => { f.report.attempts[0].execute.aborted = true; }],
    ["missing abort context", f => { delete f.report.attempts[0].beforeTool.abortSignalPresent; }],
    ["argument authority injection", f => { f.report.attempts[0].execute.parameters = { authority: {} }; }],
    ["replayed call id", f => { const a = retry(f); a.beforeTool.toolCallId = a.execute.toolCallId = "synthetic-call-1"; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const f = fixture(); mutate(f); assert.throws(() => validate(f)); });
});

test("receipt, exact readback, failure payload and retry invariants reject superficially green reports", async t => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["JSON non-array documents with ignored extra body", f => {
      const document = f.report.attempts[0].output.readback.documents[0];
      f.report.attempts[0].output.readback.documents = { 0: document, length: 1, unverifiedDocument: { text: "synthetic unchecked extra body" } };
      f.report = JSON.parse(JSON.stringify(f.report));
    }],
    ["JSON archive Evidence version array", f => {
      f.report.archive.ownerEvidenceRef.version = [f.report.archive.ownerEvidenceRef.version];
      f.report = JSON.parse(JSON.stringify(f.report));
    }],
    ["JSON committed receipt and changeRef version array", f => {
      const version = f.report.committed.receipt.changeRef.version;
      f.report.committed.receipt.changeRef.version = [version];
      f.report.attempts[0].output.correction.changeRef.version = [version];
      f.report = JSON.parse(JSON.stringify(f.report));
    }],
    ["old response without readback", f => { delete f.report.attempts[0].output.status; delete f.report.attempts[0].output.readback; }],
    ["commit failed", f => { f.report.committed.receipt.persistenceStatus = "failed"; }],
    ["non-update outside this profile", f => { f.report.committed.receipt.disposition = "no_change"; }],
    ["missing operation", f => { delete f.report.committed.receipt.operationId; }],
    ["changed receipt", f => { f.report.attempts[0].output.correction.operationId = "different"; }],
    ["wrong change target", f => { f.report.committed.change.targetRefs[0].version = `sha256:${sha("9")}`; }],
    ["wrong current request", f => { f.report.attempts[0].output.currentMemory.userRequest = "other-run"; }],
    ["wrong current checkpoint", f => { f.report.attempts[0].output.currentMemory.checkpointRevision = rev("9"); }],
    ["wrong current token", f => { f.report.attempts[0].output.currentMemory.checkpointToken = "other-token"; }],
    ["no documents", f => { f.report.attempts[0].output.readback.documents = []; }],
    ["target version mismatch", f => { f.report.attempts[0].output.readback.documents[0].target.ref.version = `sha256:${sha("9")}`; }],
    ["payload changed", f => { f.report.attempts[0].output.readback.documents[0].text = '{"goal":"different"}'; }],
    ["disk read from latest", f => { f.report.attempts[0].diskReadback.revision = rev("9"); }],
    ["unknown result", f => { f.report.attempts[0].output.status = "ok"; }],
    ["failed read leaks body", f => { const d = f.report.attempts[0].output.readback.documents; failRead(f); f.report.attempts[0].output.readback.documents = d; }],
    ["failed read leaks metadata", f => { failRead(f); f.report.attempts[0].output.readback.locator = "private/path"; }],
    ["failed read no category", f => { failRead(f); delete f.report.attempts[0].output.readback.category; }],
    ["failed read claims disk success", f => { const d = f.report.attempts[0].diskReadback; failRead(f); f.report.attempts[0].diskReadback = d; }],
    ["retry rewrites", f => { retry(f).counters.correctionCommits = 2; }],
    ["retry reinfers", f => { retry(f).counters.correctionInferenceCalls = 4; }],
    ["second archive", f => { f.report.attempts[0].counters.archiveCommits = 2; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const f = fixture(); mutate(f); assert.throws(() => validate(f)); });
});

test("new consistency output cannot satisfy either legacy gate and the old 8.2 barrier still rejects 10.8", () => {
  const f = fixture(), result = validate(f);
  assert.throws(() => legacy.assertLegacyProbesMigrated(f.expected.versions), /legacy_probes_not_migrated/);
  assert.throws(() => collectPackageShards(result, [], {}));
  assert.throws(() => assertExperimentalReports(result, {}));
  assert.throws(() => profile.validateInstalledCorrectionReport(f.report, f.expected), /artifact_identity_functions_required/);
});
