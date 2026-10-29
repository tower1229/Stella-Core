import assert from "node:assert/strict";
import { verifyConsumerCliVersion } from "./acceptance-versions.mjs";

// A new report contract, not a version switch for either existing runner.
export const INSTALLED_CORRECTION_PROFILE = Object.freeze({
  id: "stella.installed-checkpoint-correction/openclaw-2026.10.8/v1",
  reportSchema: "stella.installed-checkpoint-correction-report/v1",
  hostVersion: "2026.10.8",
  scope: "registered correction tool: one update, committed receipt and exact readback",
  executionConnected: false,
});
const nonAcceptance = Object.freeze({ profileAccepted: false, hostExecutionAccepted: false,
  experimentalOwnerChatAccepted: false, fullMemoryAccepted: false, realModelAccepted: false,
  privateMainAccepted: false, formalConsumerAccepted: false, issue23Complete: false });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, category) => assert.ok(condition, `installed_correction_profile:${category}`);
const text = value => typeof value === "string" && value.trim().length > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const ref = value => record(value) && text(value.id) && typeof value.version === "string" && /^sha256:[a-f0-9]{64}$/.test(value.version);
const keys = (value, names, category) => {
  check(record(value), category);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `installed_correction_profile:${category}`);
};

/** Validate normalized observations against separately bound installation facts.
 * expected must come from the version/package checks, not from report itself.
 * identity functions must come from that exact installed Core artifact. This
 * pure checker does not authenticate captures, issue permits or accept a Host
 * run. Offline fixtures can exercise it without manufacturing Host evidence. */
export function validateInstalledCorrectionReport(report, expected, identity) {
  check(record(report) && record(expected), "report_required");
  check(typeof identity?.canonicalJson === "function" && typeof identity.objectVersion === "function", "artifact_identity_functions_required");
  check(report.schemaVersion === INSTALLED_CORRECTION_PROFILE.reportSchema &&
    report.profileId === INSTALLED_CORRECTION_PROFILE.id, "profile_mismatch");
  for (const [name, value] of Object.entries(nonAcceptance)) check(report[name] === value, `unearned_acceptance:${name}`);
  check(report.evidenceKind === "offline_contract_fixture", "host_capture_not_connected");
  check(report.cancelled === false && report.exitCode === 0 && report.signal === null, "execution_incomplete");

  const versions = expected.versions;
  check(record(versions) && versions.targetHostVersion === INSTALLED_CORRECTION_PROFILE.hostVersion &&
    versions.workspaceSdkVersion === INSTALLED_CORRECTION_PROFILE.hostVersion, "version_mismatch");
  check(record(versions.consumer), "consumer_not_installed");
  const consumer = versions.consumer;
  check(consumer.metadataVerified === true && consumer.cliVerified === true &&
    consumer.hostVersion === versions.targetHostVersion && consumer.lockedHostVersion === versions.targetHostVersion &&
    consumer.cliHostVersion === versions.targetHostVersion && consumer.corePackageVersion === versions.corePackageVersion,
  "consumer_version_mismatch");
  // Reuse the existing strict CLI parser without mutating the caller's facts.
  verifyConsumerCliVersion(structuredClone(versions), report.hostVersionOutput);
  assert.deepEqual(report.versions, versions, "installed_correction_profile:observed_versions_mismatch");
  for (const name of ["artifactSha256", "consumerLockSha256", "sourceManifestSha256"]) {
    check(digest(expected[name]) && report[name] === expected[name], `identity_mismatch:${name}`);
  }
  check(revision(expected.coreRevision) && report.coreRevision === expected.coreRevision && report.sourceClean === true, "source_mismatch");
  assert.deepEqual(report.buildIdentity, { coreRevision: expected.coreRevision, sourceClean: true }, "installed_correction_profile:build_mismatch");
  const installed = report.installation;
  check(record(installed) && text(expected.packageRoot) && text(expected.hostRoot) && expected.packageRoot !== expected.hostRoot,
    "installation_required");
  check(installed.packageRoot === expected.packageRoot && installed.entry === `${expected.packageRoot}/dist/src/plugin.js` &&
    installed.hostRoot === expected.hostRoot && installed.sdkRoot === expected.hostRoot &&
    installed.directHostLoad === true && installed.observerWrapper === false &&
    installed.artifactSha256 === expected.artifactSha256 && installed.consumerLockSha256 === expected.consumerLockSha256,
  "installation_mismatch");

  const run = report.request, committed = report.committed;
  check(record(run) && [run.agentId, run.sessionId, run.sessionKey, run.runId, run.senderId].every(text) &&
    /^sha256:[a-f0-9]{64}$/.test(run.requestHash) && digest(run.sourceGrantSha256) &&
    run.senderIsOwner === true && run.chatType === "direct", "request_context_required");
  check(record(report.archive) && report.archive.runId === run.runId && report.archive.requestHash === run.requestHash &&
    ref(report.archive.ownerEvidenceRef) && revision(report.archive.revision), "archive_binding_mismatch");
  check(record(committed) && record(committed.receipt) && revision(committed.revision), "committed_receipt_required");
  const receipt = committed.receipt;
  keys(receipt, ["operationId", "disposition", "clarification", "changeRef", "persistenceStatus"], "receipt_shape");
  check(text(receipt.operationId) && receipt.disposition === "update" && receipt.clarification === null &&
    receipt.persistenceStatus === "local_committed" && ref(receipt.changeRef), "receipt_not_committed_update");
  check(record(committed.target) && committed.target.group === "works" && ref(committed.target.ref), "target_required");
  assert.deepEqual(committed.change, { operationId: receipt.operationId, changeRef: receipt.changeRef,
    targetRefs: [committed.target.ref] }, "installed_correction_profile:change_binding_mismatch");
  check(committed.revision !== report.archive.revision, "correction_revision_not_advanced");
  check(Array.isArray(report.attempts) && report.attempts.length >= 1 && report.attempts.length <= 2, "attempts_required");
  const calls = new Set(); let initialInferenceCalls;
  for (const attempt of report.attempts) {
    check(record(attempt) && record(attempt.beforeTool) && record(attempt.execute), "tool_context_required");
    const hook = attempt.beforeTool, execute = attempt.execute;
    for (const context of [hook, execute]) {
      check(["agentId", "sessionId", "sessionKey"].every(name => context[name] === run[name]) &&
        text(context.toolCallId) && context.toolName === "stella_memory_correct" &&
        context.requesterSenderId === run.senderId && context.senderIsOwner === true &&
        context.abortSignalPresent === true && context.aborted === false,
      "tool_context_mismatch");
    }
    // The hook has runId; the executor is linked by its actual call-id argument
    // and factory session/requester, not an invented factory-context runId.
    check(hook.runId === run.runId && attempt.sourceGrantSha256 === run.sourceGrantSha256, "run_or_grant_mismatch");
    check(hook.toolCallId === execute.toolCallId && !calls.has(hook.toolCallId), "tool_call_replayed"); calls.add(hook.toolCallId);
    keys(execute.parameters, [], "tool_arguments_not_empty");
    const output = attempt.output;
    keys(output, ["correction", "status", "readback", "currentMemory"], "output_shape");
    assert.deepEqual(output.correction, receipt, "installed_correction_profile:committed_receipt_changed");
    keys(output.currentMemory, ["userRequest", "checkpointRevision", "checkpointToken"], "current_memory_shape");
    check(output.currentMemory.userRequest === run.runId && output.currentMemory.checkpointRevision === committed.revision &&
      text(output.currentMemory.checkpointToken) && output.currentMemory.checkpointToken === committed.checkpointToken, "current_memory_mismatch");
    if (output.status === "readback_verified") {
      keys(output.readback, ["status", "documents"], "verified_readback_shape");
      check(output.readback.status === "verified" && Array.isArray(output.readback.documents) && output.readback.documents.length === 1, "verified_document_required");
      const document = output.readback.documents[0]; keys(document, ["target", "text"], "document_shape");
      assert.deepEqual(document.target, committed.target, "installed_correction_profile:target_mismatch");
      check(typeof document.text === "string", "document_required");
      const object = JSON.parse(document.text);
      check(record(object) && object.id === committed.target.ref.id && object.schemaVersion === "stella.ongoing-work/v1" &&
        identity.canonicalJson(object) === document.text && identity.objectVersion(object) === committed.target.ref.version,
      "object_version_mismatch");
      assert.deepEqual(attempt.diskReadback, { revision: committed.revision, document }, "installed_correction_profile:disk_readback_mismatch");
    } else {
      check(output.status === "readback_failed", "readback_status_unknown");
      keys(output.readback, ["status", "category", "documents"], "failed_readback_shape");
      check(output.readback.status === "failed" && text(output.readback.category), "failed_readback_category_required");
      assert.deepEqual(output.readback.documents, [], "installed_correction_profile:failed_readback_released_documents");
      check(attempt.diskReadback === null, "failed_readback_claims_disk_success");
    }
    const counters = attempt.counters;
    check(record(counters) && counters.archiveCommits === 1 && counters.correctionCommits === 1 &&
      Number.isSafeInteger(counters.correctionInferenceCalls) && counters.correctionInferenceCalls > 0,
    "write_counts_mismatch");
    initialInferenceCalls ??= counters.correctionInferenceCalls;
    check(counters.correctionInferenceCalls === initialInferenceCalls, "retry_reinferred");
  }
  return { schemaVersion: "stella.installed-correction-offline-validation/v1", profileId: INSTALLED_CORRECTION_PROFILE.id,
    evidenceConsistency: "validated", observedOutcome: report.attempts.at(-1).output.status,
    persistenceStatus: "local_committed", ...nonAcceptance,
    executionBlocker: "Host capture and runner are not connected; report consistency is not authenticated Host execution" };
}
