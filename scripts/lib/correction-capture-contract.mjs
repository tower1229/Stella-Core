import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const check = (value, category) => assert.ok(value, `correction_capture_contract:${category}`);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const ref = value => record(value) && text(value.id) && typeof value.version === "string" && /^sha256:[a-f0-9]{64}$/.test(value.version);
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash("sha256").update(value).digest("hex");
const keys = (value, expected, category) => {
  check(record(value), category);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `correction_capture_contract:${category}`);
};
const parse = value => { check(typeof value === "string" && Buffer.byteLength(value) <= 1024 * 1024, "bounded_json_required"); return JSON.parse(value); };
const falseFlags = ["cliVerified", "hostExecutionAccepted", "profileAccepted", "formalConsumerAccepted", "fullMemoryAccepted", "realModelAccepted"];
const correct = "stella_memory_correct", memory = "stella_memory_data";
const identityKeys = ["agentTag", "sessionTag", "sessionKeyTag", "requesterTag", "senderIsOwner"];
function observation(row, observerId, sequence) {
  const base = ["schemaVersion", "observerId", "sequence", "source"];
  check(record(row) && row.schemaVersion === "stella.checkpoint-observation/v1" && row.observerId === observerId && row.sequence === sequence, "observer_or_sequence_mismatch");
  if (row.source === "retirement") {
    keys(row, [...base, "runTag", "countScope", "before", "after"], "retirement_shape");
    check(digest(row.runTag) && row.countScope === "config-and-host-state-supply-scope", "retirement_scope");
    keys(row.before, ["grants", "toolPermits", "wasActive", "grantRemoved"], "retirement_before");
    keys(row.after, ["grants", "activeGrants", "preparations", "toolPermits"], "retirement_after");
    check(count(row.before.grants) && count(row.before.toolPermits) && typeof row.before.wasActive === "boolean" && typeof row.before.grantRemoved === "boolean" &&
      Object.values(row.after).every(count), "retirement_counts");
    return;
  }
  check(row.tool === correct || row.tool === memory, "unknown_core_tool");
  if (row.source === "factory") keys(row, [...base, "tool", "factoryLabel", ...identityKeys], "factory_shape");
  else if (row.source === "before_tool_call") keys(row, [...base, "tool", ...identityKeys, "runTag", "callTag", "abortSignalPresent", "aborted"], "core_hook_shape");
  else { check(row.source === "execute", "unknown_core_source"); keys(row, [...base, "tool", "factoryLabel", "callTag", "abortSignalPresent", "aborted"], "execute_shape"); }
  if (row.source === "factory" || row.source === "execute") check(Number.isSafeInteger(row.factoryLabel) && row.factoryLabel > 0, "factory_label_required");
  if (row.source !== "execute") check(identityKeys.slice(0, 4).every(key => row[key] === null || digest(row[key])) && (row.senderIsOwner === null || typeof row.senderIsOwner === "boolean"), "identity_projection_shape");
  if (row.source !== "factory") check(digest(row.callTag) && (row.source !== "before_tool_call" || digest(row.runTag)) &&
    typeof row.abortSignalPresent === "boolean" && (row.aborted === null || typeof row.aborted === "boolean"), "signal_or_call_shape");
}

/** Pure synthetic capture-contract checker. identityJson is supplied separately
 * from verifyReusedConsumerIdentity, never extracted from captureJson. The
 * injected pure functions must later be audited as actual installed artifact
 * exports. Neither JSON consistency nor a caller's source labels authenticate
 * a Host, an installation, callback provenance or permission. No gate opens. */
export function validateCorrectionCaptureFixture(captureJson, identityJson, artifact) {
  const capture = parse(captureJson), installation = parse(identityJson);
  check(record(installation) && installation.schemaVersion === "stella.reused-consumer-identity/v1" &&
    installation.identityConsistency === "validated_reused_installation" && record(installation.installationManifest) &&
    installation.consumerLock === null && installation.installationManifest.consumerLock === null && falseFlags.every(name => installation[name] === false) &&
    digest(installation.installationManifestSha256) && hash(JSON.stringify(installation.installationManifest)) === installation.installationManifestSha256,
  "independent_installation_required");
  for (const name of ["checkpointHostObservationTag", "canonicalJson", "objectVersion"]) check(typeof artifact?.[name] === "function", "artifact_functions_required");
  keys(capture, ["schemaVersion", "evidenceKind", "binding", "execution", "requests", "coreObservations", "lifecycle"], "capture_shape");
  check(capture.schemaVersion === "stella.correction-capture-contract/v1" && capture.evidenceKind === "offline_capture_contract_fixture", "offline_contract_only");
  keys(capture.binding, ["installationManifestSha256", "observerId", "gatewayInstanceId", "directHostLoad", "observerWrapper"], "binding_shape");
  const { observerId, gatewayInstanceId } = capture.binding;
  check(capture.binding.installationManifestSha256 === installation.installationManifestSha256 && text(observerId) && text(gatewayInstanceId) &&
    capture.binding.directHostLoad === true && capture.binding.observerWrapper === false, "installation_or_loader_binding");
  keys(capture.execution, ["source", "cancelled", "exitCode", "signal"], "execution_shape");
  check(capture.execution.source === "controller.execution" && capture.execution.cancelled === false && capture.execution.exitCode === 0 && capture.execution.signal === null, "execution_incomplete");
  check(Array.isArray(capture.requests) && capture.requests.length === 2 && Array.isArray(capture.coreObservations) &&
    capture.coreObservations.length > 0 && capture.coreObservations.length <= 128, "two_requests_and_core_rows_required");
  const rows = capture.coreObservations;
  rows.forEach((row, index) => observation(row, observerId, index + 1));
  const one = (source, predicate) => { const matches = rows.filter(row => row.source === source && predicate(row)); check(matches.length === 1, `missing_or_ambiguous:${source}`); return matches[0]; };
  const factories = rows.filter(row => row.source === "factory");
  check(new Set(factories.map(row => row.factoryLabel)).size === factories.length, "duplicate_factory_label");
  const runIds = new Set(), callIds = new Set(), associations = [];
  let firstHook, firstCoreIdentity, receiptTarget, receipt, firstCheckpoint, priorInference;
  for (const [index, request] of capture.requests.entries()) {
    keys(request, ["ack", "input", "grant", "archive", "beforeTool", "afterTool", "agentEnd", "checkpoint", "sourceAccess", "disk", "counters"], "request_shape");
    const hook = request.beforeTool, after = request.afterTool, expectedTool = index === 0 ? correct : memory;
    keys(request.ack, ["source", "runId"], "ack_shape");
    const runId = request.ack.runId;
    check(request.ack.source === "gateway.agent_ack" && text(runId) && !runIds.has(runId), "run_ack_required"); runIds.add(runId);
    keys(hook, ["source", "runId", "toolCallId", "toolName", "agentId", "sessionId", "sessionKey", "requester", "params", "abortSignalPresent", "aborted"], "host_hook_shape");
    keys(hook.requester, ["senderId", "senderIsOwner"], "host_requester_shape");
    check(hook.source === "host.before_tool_call" && hook.runId === runId && hook.toolName === expectedTool &&
      [hook.toolCallId, hook.agentId, hook.sessionId, hook.sessionKey, hook.requester.senderId].every(text) && hook.requester.senderIsOwner === true &&
      hook.abortSignalPresent === true && hook.aborted === false && !callIds.has(hook.toolCallId), "host_tool_context_required"); callIds.add(hook.toolCallId);
    if (firstHook) check(["agentId", "sessionId", "sessionKey"].every(key => hook[key] === firstHook[key]) && hook.requester.senderId === firstHook.requester.senderId, "session_or_requester_changed");
    firstHook ??= hook;
    assert.deepEqual(hook.params, index === 0 ? {} : { action: "work" }, "correction_capture_contract:tool_parameters");
    const runTag = artifact.checkpointHostObservationTag(observerId, "run", runId), callTag = artifact.checkpointHostObservationTag(observerId, "call", hook.toolCallId);
    check(digest(runTag) && digest(callTag), "artifact_tag_invalid");
    const observedHook = one("before_tool_call", row => row.runTag === runTag && row.callTag === callTag);
    if (index > 0) check(observedHook.sequence > associations[index - 1].retirementSequence, "next_hook_before_previous_retirement");
    const execute = one("execute", row => row.callTag === callTag), factory = one("factory", row => row.factoryLabel === execute.factoryLabel);
    check([observedHook, execute, factory].every(row => row.tool === expectedTool) && factory.sequence < execute.sequence && observedHook.sequence < execute.sequence &&
      factory.senderIsOwner === true && observedHook.senderIsOwner === true && identityKeys.slice(0, 4).every(key => digest(factory[key]) && factory[key] === observedHook[key]) &&
      observedHook.abortSignalPresent === true && observedHook.aborted === false && execute.abortSignalPresent === true && execute.aborted === false, "core_source_association");
    if (firstCoreIdentity) check(identityKeys.every(key => factory[key] === firstCoreIdentity[key]), "same_observer_identity_changed");
    firstCoreIdentity ??= factory;
    keys(after, ["source", "runId", "toolCallId", "toolName", "result"], "host_after_shape");
    check(after.source === "host.after_tool_call" && after.runId === runId && after.toolCallId === hook.toolCallId && after.toolName === expectedTool, "host_after_mismatch");
    keys(after.result, ["content", "details"], "tool_result_shape");
    const output = after.result.details;
    check(record(output), "tool_details_required");
    assert.deepEqual(after.result.content, [{ type: "text", text: artifact.canonicalJson(output) }], "correction_capture_contract:tool_payload_mismatch");
    keys(request.checkpoint, ["source", "revision", "token"], "checkpoint_shape");
    check(request.checkpoint.source === "disk.checkpoint" && revision(request.checkpoint.revision) && text(request.checkpoint.token), "checkpoint_required");
    assert.deepEqual(output.currentMemory, { userRequest: runId, checkpointRevision: request.checkpoint.revision, checkpointToken: request.checkpoint.token }, "correction_capture_contract:current_request_binding");
    keys(request.input, ["source", "requestHash"], "input_shape");
    check(request.input.source === "controller.synthetic_input" && typeof request.input.requestHash === "string" && /^sha256:[a-f0-9]{64}$/.test(request.input.requestHash), "input_hash_required");
    keys(request.grant, ["source", "sha256"], "grant_shape"); check(request.grant.source === "disk.source_grant" && digest(request.grant.sha256), "grant_snapshot_required");
    keys(request.sourceAccess, ["source", "requestHash"], "source_access_shape");
    check(request.sourceAccess.source === "stub.source_access_request" && request.sourceAccess.requestHash === request.input.requestHash, "source_access_request_mismatch");
    keys(request.archive, ["source", "runId", "requestHash", "revision", "ownerEvidenceRef"], "archive_shape");
    check(request.archive.source === "disk.owner_archive" && request.archive.runId === runId && request.archive.requestHash === request.input.requestHash &&
      revision(request.archive.revision) && ref(request.archive.ownerEvidenceRef), "archive_binding");
    keys(request.counters, ["source", "archiveCommits", "correctionCommits", "correctionInferenceCalls"], "counter_shape");
    check(request.counters.source === "controller.disk_and_stub_counts" && request.counters.archiveCommits === index + 1 && request.counters.correctionCommits === 1 &&
      count(request.counters.correctionInferenceCalls) && request.counters.correctionInferenceCalls > 0, "commit_counts");
    priorInference ??= request.counters.correctionInferenceCalls; check(request.counters.correctionInferenceCalls === priorInference, "repeated_correction_inference");
    const disk = request.disk;
    if (index === 0) {
      keys(output, ["correction", "status", "readback", "currentMemory"], "correction_output_shape");
      receipt = output.correction;
      keys(receipt, ["operationId", "disposition", "clarification", "changeRef", "persistenceStatus"], "receipt_shape");
      check(text(receipt.operationId) && receipt.disposition === "update" && receipt.clarification === null && ref(receipt.changeRef) && receipt.persistenceStatus === "local_committed" &&
        output.status === "readback_verified" && record(output.readback) && output.readback.status === "verified" && Array.isArray(output.readback.documents) && output.readback.documents.length === 1, "committed_readback_required");
      const document = output.readback.documents[0]; keys(document, ["target", "text"], "document_shape");
      keys(document.target, ["group", "ref"], "target_shape"); check(document.target.group === "works" && ref(document.target.ref) && typeof document.text === "string", "work_target_required");
      const work = JSON.parse(document.text);
      check(record(work) && work.id === document.target.ref.id && work.schemaVersion === "stella.ongoing-work/v1" && artifact.canonicalJson(work) === document.text && artifact.objectVersion(work) === document.target.ref.version, "exact_object_version");
      keys(disk, ["source", "revision", "change", "document"], "correction_disk_shape");
      check(disk.source === "disk.correction_readback" && disk.revision === request.checkpoint.revision && disk.revision !== request.archive.revision, "receipt_revision_binding");
      assert.deepEqual(disk.document, document, "correction_capture_contract:disk_document_mismatch");
      assert.deepEqual(disk.change, { operationId: receipt.operationId, changeRef: receipt.changeRef, targetRefs: [document.target.ref] }, "correction_capture_contract:learning_change_mismatch");
      receiptTarget = document.target.ref; firstCheckpoint = request.checkpoint;
    } else {
      check(request.input.requestHash !== capture.requests[0].input.requestHash && request.checkpoint.revision === request.archive.revision &&
        request.checkpoint.revision !== firstCheckpoint.revision && request.checkpoint.token !== firstCheckpoint.token, "next_request_not_fresh");
      check(Array.isArray(output.works) && output.works.length === 1 && record(output.works[0]), "next_work_required");
      const work = output.works[0]; assert.deepEqual(work.ref, receiptTarget, "correction_capture_contract:next_target_mismatch");
      check(record(work.record) && work.record.id === receiptTarget.id && artifact.objectVersion(work.record) === receiptTarget.version, "next_object_version");
      keys(disk, ["source", "revision", "ref", "record"], "next_disk_shape");
      check(disk.source === "disk.next_request_readback" && disk.revision === request.checkpoint.revision, "next_disk_revision");
      assert.deepEqual({ ref: disk.ref, record: disk.record }, { ref: work.ref, record: work.record }, "correction_capture_contract:next_disk_mismatch");
    }
    keys(request.agentEnd, ["source", "runId", "success"], "agent_end_shape");
    check(request.agentEnd.source === "host.agent_end" && request.agentEnd.runId === runId && request.agentEnd.success === true, "normal_agent_end_required");
    const retirement = one("retirement", row => row.runTag === runTag);
    check(retirement.sequence > execute.sequence && retirement.before.wasActive === true && retirement.before.grantRemoved === true && retirement.before.grants === 1 &&
      Object.values(retirement.after).every(value => value === 0), "normal_core_retirement_required");
    associations.push({ runTag, callTag, factoryLabel: factory.factoryLabel, retirementSequence: retirement.sequence });
  }
  check(rows.filter(row => row.source === "before_tool_call").length === 2 && rows.filter(row => row.source === "execute").length === 2 && rows.filter(row => row.source === "retirement").length === 2, "unassociated_core_events");
  const submit = index => ({ source: "controller.submit", request: index + 1, gatewayInstanceId });
  const retired = index => ({ source: "controller.retirement_observed", runId: capture.requests[index].ack.runId, observerId, coreSequence: associations[index].retirementSequence });
  const timeline = [submit(0), retired(0), submit(1), retired(1)];
  check(Array.isArray(capture.lifecycle), "lifecycle_required");
  if (capture.lifecycle.length === 5) timeline.push({ source: "controller.shutdown_started", gatewayInstanceId });
  assert.deepEqual(capture.lifecycle, timeline, "correction_capture_contract:retirement_gate_or_shutdown_order");
  return { schemaVersion: "stella.correction-capture-contract-validation/v1", evidenceKind: "offline_capture_contract_fixture",
    evidenceConsistency: "validated_capture_contract", installationManifestSha256: installation.installationManifestSha256,
    observerId, associations, factoryFactsSource: "core.factory via execute.factoryLabel", executeRunSource: "host.before_tool_call via actual callId",
    cliVerified: false, hostExecutionAccepted: false, profileAccepted: false, formalConsumerAccepted: false, fullMemoryAccepted: false, realModelAccepted: false,
    executionBlocker: "Synthetic association only; callback provenance, actual artifact imports, Host runner and final provider consumption are not authenticated." };
}
