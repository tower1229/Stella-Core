import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const EXPERIMENTAL_SCOPE = "experimental_owner_chat";
export const NON_ACCEPTANCE = Object.freeze({ fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false });

const BOOTSTRAP = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
const hash = value => assert.match(value, /^sha256:[a-f0-9]{64}$/);

function assertSkillConsumption(report) {
  assert.equal(report.scenario, "materialization"); assert.equal(report.budgetMode, "normal");
  assert.equal(report.rawProviderRequests?.length, 8); assert.equal(report.allHttpRequests?.length, 8);
  assert.equal(report.materialization?.materialized?.receipt?.files?.length, 6);
  const proof = report.skillConsumption;
  assert.equal(proof?.bootstrapSources?.length, 5);
  assert.deepEqual(proof.bootstrapSources.map(file => file.target).sort(), [...BOOTSTRAP].sort());
  for (const file of proof.bootstrapSources) { hash(file.sha256); hash(file.normalizedSha256); }
  assert.equal(proof.skillSource?.name, "stella-initialization-probe");
  assert.equal(proof.skillSource.target, "skills/stella-initialization-probe/SKILL.md"); hash(proof.skillSource.sha256);
  assert.equal(proof.wireProofs?.length, 8);
  for (const [offset, wire] of proof.wireProofs.entries()) {
    assert.equal(wire.index, offset + 1); assert.equal(wire.systemField, "systemInstruction");
    assert.equal(wire.bootstrapHashes?.length, 5);
    assert.deepEqual(wire.bootstrapHashes.map(file => file.target).sort(), [...BOOTSTRAP].sort());
    for (const file of wire.bootstrapHashes) assert.equal(file.sha256,
      proof.bootstrapSources.find(source => source.target === file.target).normalizedSha256);
    // Observe the complete native order without imposing one order on every Host.
    assert.deepEqual([...wire.bootstrapOrder].sort(), [...BOOTSTRAP].sort());
    assert.ok(wire.contents?.length); assert.equal(wire.contents[0].role, "user");
    for (const content of wire.contents) {
      assert.ok(["user", "model"].includes(content.role)); assert.ok(content.parts?.length);
      for (const kind of content.parts) assert.ok(["text", "functionCall", "functionResponse"].includes(kind));
      if (content.parts.includes("functionCall")) assert.equal(content.role, "model");
      if (content.parts.includes("functionResponse")) assert.equal(content.role, "user");
    }
    if ([2, 3, 4, 6, 7, 8].includes(wire.index)) {
      assert.equal(wire.skill?.name, proof.skillSource.name);
      assert.equal(wire.skill.sha256, proof.skillSource.sha256); assert.equal(wire.skill.sourceSha256, proof.skillSource.sha256);
      assert.equal(wire.skill.role, "user"); assert.ok(Number.isSafeInteger(wire.skill.contentIndex) && wire.skill.contentIndex >= 0);
      const content = wire.contents[wire.skill.contentIndex];
      assert.equal(content?.role, wire.skill.role); assert.ok(content.parts.includes("functionResponse"));
    } else assert.equal(wire.skill, null);
  }
}
function assertBudgetRefusal(report, mode) {
  assert.equal(report.scenario, "materialization"); assert.equal(report.budgetMode, mode);
  assert.equal(report.rawProviderRequests?.length, 0); assert.equal(report.allHttpRequests?.length, 0);
  assert.deepEqual(report.instructionBudget, { agentId: "synthetic", defaultFileLimit: 1,
    fileLimit: mode === "file" ? 1 : 20000, totalLimit: mode === "total" ? 1 : 150000 });
  const agent = report.budgetAgent, observation = agent?.refusalObservation;
  assert.equal(agent?.attempted, true); assert.ok(agent.runId && agent.sessionKey);
  assert.equal(agent.sent?.runId, agent.runId); assert.equal(agent.terminal?.runId, agent.runId);
  assert.equal(agent.terminal.status, "error");
  assert.equal(observation?.category, "initialization_pending");
  assert.equal(observation.runId, agent.runId); assert.equal(observation.sessionKey, agent.sessionKey);
  assert.ok(["agent", "chat"].includes(observation.event));
  assert.equal(observation.payload?.runId, agent.runId); assert.equal(observation.payload?.sessionKey, agent.sessionKey);
  assert.match(JSON.stringify(observation.payload), /initialization_pending|Core initialization is pending|Complete or recover Core initialization/);
  const before = report.budgetStateBefore, after = report.budgetStateAfter;
  assert.ok(before && after); assert.deepEqual(after, before);
  hash(after.pendingSha256); hash(after.operationSha256);
  assert.equal(after.fenced, true); assert.equal(after.receiptPresent, false); assert.equal(after.files?.length, 6);
  assert.deepEqual(after.files.map(file => file.target).sort(), [...BOOTSTRAP, "skills/stella-initialization-probe/SKILL.md"].sort());
  for (const file of after.files) hash(file.sha256);
  const proof = report.budgetRefusal;
  assert.equal(proof?.category, mode === "file" ? "host_bootstrap_context_incomplete" : "host_bootstrap_context_missing");
  assert.equal(proof.agentAttempted, true); assert.equal(proof.agentBlockedCategory, "initialization_pending");
  for (const key of ["originalFilesPreserved", "sourceRevisionUnchanged", "pendingOperationRetained", "fenced"]) assert.equal(proof[key], true);
  assert.equal(proof.receiptPresent, false); assert.equal(proof.bootstrapFilesWritten, 6);
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const workQuestions = [
  "SYNTHETIC_WORK_QUERY_A_7296: resume my current writing work, including confirmed premises, proposals, rejected readings and open questions.",
  "SYNTHETIC_WORK_QUERY_B_7296: resume the current writing work after my correction, preserving its unresolved question.",
];
const workTrigger = "trusted installed Core runtime.correctLocal with explicitly synthetic callbacks; not automatic Host learning";
const workFiles = ["dist/src/plugin.js", "dist/src/openclaw/checkpoint-plugin-runtime.js", "dist/src/openclaw/checkpoint-agent-supply.js", "dist/src/openclaw/checkpoint-source-access.js"];
const ref = value => { assert.ok(typeof value?.id === "string" && value.id); hash(value.version); };
const texts = wire => wire.contents.flatMap(content => content.parts ?? []).map(part => part.text).filter(value => typeof value === "string");

function assertInstalledIdentity(report, expected) {
  const installation = report.installation;
  assert.equal(installation?.packageRoot, expected.packageRoot); assert.equal(installation.root, expected.packageRoot);
  assert.equal(installation.entry, `${expected.packageRoot}/dist/src/plugin.js`);
  assert.equal(installation.directHostLoad, true); assert.equal(installation.observerWrapper, false);
  for (const name of ["artifactSha256", "consumerLockSha256", "buildIdentitySha256"]) {
    assert.match(expected[name], /^[a-f0-9]{64}$/); assert.equal(installation[name], expected[name]);
  }
  assert.equal(installation.artifact, expected.artifact); assert.equal(installation.packageIntegrity, expected.packageIntegrity);
  assert.deepEqual(installation.buildIdentity, { coreRevision: expected.coreRevision, sourceClean: true });
  assert.equal(installation.fullInstalledTreeVerifiedByThisProbe, false);
  assert.deepEqual(installation.inspectedFiles?.map(file => file.path).sort(), [...workFiles].sort());
  for (const file of installation.inspectedFiles) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.hostIdentity?.root, expected.hostRoot); assert.equal(report.hostIdentity.version, "2026.8.2");
  assert.equal(report.hostIdentity.fullTreeVerified, false);
}

/** Recheck complete saved wires, not only the probe's success flags. The local
 * between-session correction remains explicitly separate from Host execution. */
export function assertInstalledWorkReport(report, expected) {
  assert.equal(report.schemaVersion, "stella.checkpoint-work-installed/v1");
  assert.equal(report.passed, true); assert.equal(report.error, undefined); assert.equal(report.cancelled, undefined);
  assert.equal(report.providerError, undefined); assert.equal(report.providerDrainError, undefined);
  assertInstalledIdentity(report, expected);
  for (const key of ["fullMemoryAccepted", "realModelAccepted", "realMainAccepted", "automaticCorrectionAccepted"]) assert.equal(report[key], false);
  assert.deepEqual(report.boundaries, { twoFreshSessions: true, exactOriginalUserQuestionToSelector: true, modelSelectedWork: true,
    completeWorkRecordAndRefReachedNextAgentWire: true, candidateOriginalsNotForwardedToAgent: true, usageConstraintsInFinalAgentWire: true,
    currentWorkAfterTrustedCorrection: true, automaticHostCorrectionClaimed: false, full_memory: false });
  assert.equal(report.configuration?.model, "google/gemini-3.8-flash"); assert.equal(report.configuration.thinking, "low");
  assert.equal(report.configuration.extraLlmPermissions, false); assert.equal(report.configuration.requestArchive, false);
  const endpoint = new URL(report.configuration.providerBaseUrl);
  assert.equal(endpoint.protocol, "http:"); assert.equal(endpoint.hostname, "127.0.0.1");
  assert.equal(endpoint.username, ""); assert.equal(endpoint.password, "");
  const identity = report.syntheticClientIdentity;
  assert.equal(identity?.clientName, "cli"); assert.equal(identity.mode, "cli"); assert.equal(identity.sourceRequesterId, "cli");
  assert.equal(identity.privateKeyStorage, "memory_only"); assert.equal(identity.clientDeviceAuthTokenPersistence, false); assert.equal(identity.humanProfileClaimed, false);
  assert.ok(report.gatewayRuns?.length);
  for (const gateway of [...report.gatewayRuns, report.gateway]) { assert.equal(gateway?.exitCode, 0); assert.equal(gateway.signalCode, null); }
  assert.equal(report.syntheticSourceRemoved, true); assert.ok(report.endedAtUtc);
  const cases = report.cases;
  assert.deepEqual(cases?.map(test => test.id), ["before", "after"]);
  assert.ok(cases[0].history?.sessionId); assert.ok(cases[1].history?.sessionId);
  assert.notEqual(cases[0].history.sessionId, cases[1].history.sessionId);
  const correction = report.correction;
  assert.equal(correction?.trigger, workTrigger); assert.equal(correction.result?.persistenceStatus, "local_committed");
  assert.equal(correction.result.disposition, "update"); assert.equal(correction.result.clarification, null);
  assert.deepEqual(correction.expected, cases[0].status.authority); assert.deepEqual(correction.result.authority, cases[1].status.authority);
  assert.equal(report.source?.initialRevision, correction.expected.revision);
  assert.equal(report.sourceFinalRevision, correction.result.revision); assert.equal(correction.result.revision, correction.result.authority.revision);
  assert.notEqual(correction.result.authority.revision, correction.expected.revision); assert.notEqual(correction.result.authority.token, correction.expected.token);
  assert.deepEqual(correction.result.authority.binding, correction.expected.binding);
  assert.equal(correction.result.generationId, cases[1].expectedGeneration);
  assert.ok(report.trustedCorrectionCalls?.some(call => call.kind === "proposal-stub"));
  assert.ok(report.trustedCorrectionCalls.some(call => call.kind === "verification-stub"));
  for (const call of report.trustedCorrectionCalls) assert.equal(call.transport, "local callback, not public Host LLM");
  const requests = report.requests, wires = report.providerWires;
  assert.ok(requests?.length > 0 && requests.length <= 24); assert.equal(report.allHttpRequests?.length, requests.length); assert.equal(wires?.length, requests.length);
  for (const [offset, request] of requests.entries()) {
    const http = report.allHttpRequests[offset], saved = wires[offset];
    assert.equal(request.index, offset + 1); assert.equal(http.index, request.index); assert.equal(saved.index, request.index);
    assert.equal(http.method, "POST"); assert.equal(http.path, request.method); assert.equal(http.atUtc, request.atUtc);
    assert.match(request.method, /\/gemini-3\.8-flash:(?:streamGenerateContent|generateContent)(?:\?|$)/);
    assert.equal(saved.sha256, sha256(saved.body)); assert.equal(Buffer.byteLength(saved.body), request.bytes);
    assert.ok(Array.isArray(JSON.parse(saved.body).contents));
    assert.ok(["agent", "view-selector", "source-policy"].includes(request.kind));
    const owners = cases.filter(test => request.index >= test.firstProviderIndex && request.index <= test.lastProviderIndex);
    assert.equal(owners.length, 1); assert.equal(request.case, owners[0].id);
  }
  assert.equal(cases[0].firstProviderIndex, 1); assert.equal(cases[1].firstProviderIndex, cases[0].lastProviderIndex + 1);
  assert.equal(cases[1].lastProviderIndex, requests.length);
  for (const [offset, test] of cases.entries()) {
    const authority = test.status?.authority, work = test.expectedWork;
    assert.equal(test.created?.ok, true); assert.equal(test.created.runStarted, false); assert.equal(test.created.runId, undefined);
    assert.equal(test.created.sessionId, test.history.sessionId); assert.ok(test.sent?.runId);
    assert.equal(test.terminal?.runId, test.sent.runId); assert.equal(test.terminal.status, "ok");
    assert.equal(test.status.capabilities?.full_memory, false); assert.equal(authority?.mode, "core_checkpoint");
    assert.match(authority.revision, /^[a-f0-9]{40}$/); assert.ok(authority.token);
    ref(work?.ref); assert.equal(work.record?.schemaVersion, "stella.ongoing-work/v1");
    const window = requests.slice(test.firstProviderIndex - 1, test.lastProviderIndex);
    assert.equal(window.length, test.lastProviderIndex - test.firstProviderIndex + 1);
    const agents = window.filter(request => request.kind === "agent"), selectors = window.filter(request => request.kind === "view-selector");
    assert.equal(agents.length, 2); assert.deepEqual(agents.map(request => request.phase), [1, 2]); assert.equal(selectors.length, 1);
    assert.ok(window.some(request => request.kind === "source-policy"));
    assert.equal(agents[0].index, test.firstProviderIndex); assert.equal(agents[1].index, test.lastProviderIndex);
    const select = selectors[0], selectorWire = JSON.parse(wires[select.index - 1].body);
    const selectorPrompt = texts(selectorWire).find(value => value.startsWith("Select request-local Stella USER and MEMORY views."));
    assert.ok(selectorPrompt); const binding = JSON.parse(selectorPrompt.split("\n").at(-1));
    assert.equal(binding.question, workQuestions[offset]); assert.equal(binding.requestHash, `sha256:${sha256(workQuestions[offset])}`);
    assert.equal(select.requestHash, binding.requestHash); assert.deepEqual(select.selectedWork, work.ref);
    assert.equal(selectorWire.tools?.length ?? 0, 0); assert.equal(binding.candidates?.length, 1);
    const candidate = binding.candidates[0]; assert.equal(candidate.group, "works");
    assert.deepEqual(candidate.ref, work.ref); assert.deepEqual(candidate.record, work.record); assert.ok(candidate.originals?.length);
    const firstWire = JSON.parse(wires[agents[0].index - 1].body);
    assert.ok(texts(firstWire).some(text => text.includes(workQuestions[offset])));
    for (const request of window.filter(request => request.kind === "source-policy")) {
      const wire = JSON.parse(wires[request.index - 1].body), prompt = texts(wire).find(value => value.startsWith("Judge the semantic relationship between this request and exactly this source."));
      assert.ok(prompt); const source = JSON.parse(prompt.split("\n").at(-1));
      assert.equal(source.request, binding.question); assert.equal(source.requestHash, binding.requestHash); assert.equal(request.requestHash, binding.requestHash);
      assert.deepEqual(request.sourceRef, source.sourceRef); assert.equal(wire.tools?.length ?? 0, 0);
    }
    const final = agents[1], finalWire = JSON.parse(wires[final.index - 1].body), outputs = [];
    let toolCalls = 0;
    for (const content of finalWire.contents) for (const part of content.parts ?? []) {
      if (part.functionCall) { toolCalls++; assert.equal(content.role, "model"); assert.equal(part.functionCall.name, "stella_memory_data"); assert.deepEqual(part.functionCall.args, { action: "work" }); }
      if (part.functionResponse) {
        assert.equal(content.role, "user"); assert.equal(part.functionResponse.name, "stella_memory_data");
        const raw = part.functionResponse.response.output; outputs.push(typeof raw === "string" ? JSON.parse(raw) : raw);
      }
    }
    assert.equal(toolCalls, 1); assert.equal(outputs.length, 1); const supplied = outputs[0];
    assert.deepEqual(Object.keys(supplied).sort(), ["currentMemory", "exclusions", "generation", "usageConstraints", "works"]);
    assert.deepEqual(supplied.works, [work]); assert.deepEqual(Object.keys(supplied.works[0]).sort(), ["record", "ref"]);
    const policies = [...new Map(candidate.originals.flatMap(original => original.usageConstraints ?? []).map(policy => [JSON.stringify(policy), policy])).values()];
    assert.ok(policies.length); assert.deepEqual(supplied.usageConstraints, [{ work: work.ref, policies }]);
    for (const policy of policies) { ref(policy.policyRef); assert.equal(policy.quotePolicy, "summarize_only");
      assert.deepEqual(policy.rules, [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }]); }
    for (const agent of agents) {
      const body = wires[agent.index - 1].body;
      assert.ok(!body.includes("SYNTHETIC_ALLOWED_MEMORY_4931") && !body.includes("SYNTHETIC_WORK_CORRECTION_ORIGINAL_7296"), "Original marker leaked to Agent wire");
    }
    for (const original of candidate.originals) {
      assert.ok(typeof original.text === "string" && original.text);
      for (const agent of agents) assert.ok(!wires[agent.index - 1].body.includes(original.text), "Candidate original leaked to Agent wire");
    }
    assert.deepEqual(supplied.exclusions, {}); assert.equal(supplied.generation, test.expectedGeneration);
    assert.deepEqual(supplied.currentMemory, { userRequest: test.sent.runId, checkpointRevision: authority.revision, checkpointToken: authority.token });
    assert.deepEqual(final.workVerified, work.ref); assert.equal(final.checkpointRevision, authority.revision);
    assert.ok(JSON.stringify(test.history).includes(`SYNTHETIC_WORK_${offset ? "B" : "A"}_ANSWER_7296`));
    if (offset) assert.ok(!wires[final.index - 1].body.includes(cases[0].expectedWork.record.goal));
  }
  assert.deepEqual(report.source.workRef, cases[0].expectedWork.ref);
  assert.equal(cases[0].expectedWork.ref.id, cases[1].expectedWork.ref.id);
  assert.notEqual(cases[0].expectedWork.ref.version, cases[1].expectedWork.ref.version);
  assert.notEqual(cases[0].expectedWork.record.goal, cases[1].expectedWork.record.goal);
  for (const field of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"]) assert.deepEqual(cases[1].expectedWork.record[field], cases[0].expectedWork.record[field]);
}

const correctionPrefixes = {
  "source-policy": "Judge the semantic relationship between this request and exactly this source.",
  "view-selector": "Select request-local Stella USER and MEMORY views.",
  "correction-proposal": "Propose one evidence-bound correction or useful work-state update for Stella.",
  "correction-verification": "Independently verify this proposed correction against the exact owner originals and existing state.",
  "source-interpretation": "Independently check the derived artifact against every supplied source interpretation requirement.",
};
const promptBinding = (wire, prefix) => {
  const prompt = texts(wire).find(text => text.startsWith(prefix)); assert.ok(prompt);
  return JSON.parse(prompt.split("\n").at(-1));
};
const correctionParts = saved => JSON.parse(saved.responseBody).candidates[0].content.parts;
const correctionVerdict = saved => JSON.parse(correctionParts(saved).map(part => part.text ?? "").join(""));
const sameRef = (a, b) => a?.id === b?.id && a?.version === b?.version;

/** Agent-selected, same-session correction. All semantic calls are captured Host
 * requests. This proves the protocol/transaction mechanism, not model quality. */
export function assertInstalledCorrectionReport(report, expected) {
  assert.equal(report.schemaVersion, "stella.checkpoint-correction-installed/v1");
  assert.equal(report.passed, true); assert.equal(report.error, undefined); assert.equal(report.cancelled, undefined);
  assert.equal(report.providerError, undefined); assert.equal(report.providerDrainError, undefined);
  assertInstalledIdentity(report, expected);
  for (const key of ["fullMemoryAccepted", "realModelAccepted", "realMainAccepted"]) assert.equal(report[key], false);
  assert.equal(report.automaticCorrectionMechanismVerified, true); assert.equal(report.trustedCorrectionCalls, undefined);
  assert.deepEqual(report.boundaries, { sameOwnerSameSession: true, resets: 0, userRequests: 3, ownerArchiveWrites: 3, semanticWrites: 1,
    greetingDoesNotCorrect: true, currentHostArchiveEvidenceUsedByCorrection: true, modelSelectedCorrectionTool: true,
    publicHostSemanticCompletionsOnly: true, sameRoundWorkUsesReturnedCAS: true, nextRequestWorkRemainsCorrected: true,
    authorialDistinctionsPreserved: true, usageConstraintsReachAgent: true, historyMayRetainPastValues: true,
    full_memory: false, realSemanticQualityAccepted: false });
  assert.equal(report.configuration?.requestArchive, "local"); assert.equal(report.configuration.agentCorrection, "tool");
  assert.equal(report.configuration.model, "google/gemini-3.8-flash"); assert.equal(report.configuration.thinking, "low");
  assert.equal(report.configuration.extraLlmPermissions, false);
  const endpoint = new URL(report.configuration.providerBaseUrl);
  assert.equal(endpoint.protocol, "http:"); assert.equal(endpoint.hostname, "127.0.0.1"); assert.equal(endpoint.username, ""); assert.equal(endpoint.password, "");
  const identity = report.syntheticClientIdentity;
  assert.equal(identity?.clientName, "cli"); assert.equal(identity.mode, "cli"); assert.equal(identity.sourceRequesterId, "cli");
  assert.equal(identity.privateKeyStorage, "memory_only"); assert.equal(identity.clientDeviceAuthTokenPersistence, false); assert.equal(identity.humanProfileClaimed, false);
  assert.ok(report.gatewayRuns?.length); for (const gateway of [...report.gatewayRuns, report.gateway]) { assert.equal(gateway?.exitCode, 0); assert.equal(gateway.signalCode, null); }
  assert.equal(report.syntheticSourceRemoved, true); assert.ok(report.endedAtUtc);
  const cases = report.cases, requests = report.requests, wires = report.providerWires;
  assert.deepEqual(cases?.map(test => test.id), ["greeting", "correction", "next"]);
  assert.equal(report.createdSession?.ok, true); assert.equal(report.createdSession.runStarted, false);
  assert.ok(report.createdSession.sessionId); assert.equal(new Set(cases.map(test => test.history?.sessionId)).size, 1);
  for (const test of cases) assert.equal(test.history?.sessionId, report.createdSession.sessionId);
  assert.equal(new Set(cases.map(test => test.sessionKey)).size, 1); assert.ok(cases[0].sessionKey);
  assert.equal(new Set(cases.map(test => test.sent?.runId)).size, 3);
  assert.ok(requests?.length > 0 && requests.length <= 32); assert.equal(report.allHttpRequests?.length, requests.length); assert.equal(wires?.length, requests.length);
  for (const [offset, request] of requests.entries()) {
    const http = report.allHttpRequests[offset], wire = wires[offset];
    assert.equal(request.index, offset + 1); assert.equal(http.index, request.index); assert.equal(wire.index, request.index);
    assert.equal(http.method, "POST"); assert.equal(http.path, request.method); assert.equal(http.atUtc, request.atUtc);
    assert.match(request.method, /\/gemini-3\.8-flash:(?:streamGenerateContent|generateContent)(?:\?|$)/);
    assert.equal(wire.sha256, sha256(wire.body)); assert.equal(Buffer.byteLength(wire.body), request.bytes);
    assert.equal(wire.responseSha256, sha256(wire.responseBody)); assert.ok(correctionParts(wire)?.length);
    assert.ok(request.kind === "agent" || Object.hasOwn(correctionPrefixes, request.kind));
    const owners = cases.filter(test => request.index >= test.firstProviderIndex && request.index <= test.lastProviderIndex);
    assert.equal(owners.length, 1); assert.equal(request.case, owners[0].id);
  }
  assert.equal(cases[0].firstProviderIndex, 1); assert.equal(cases[2].lastProviderIndex, requests.length);
  const currentMemory = (value, test, authority) => assert.deepEqual(value,
    { userRequest: test.sent.runId, checkpointRevision: authority.revision, checkpointToken: authority.token });
  for (const [offset, test] of cases.entries()) {
    const correcting = test.id === "correction", after = test.after, before = test.before, start = test.agentStart;
    assert.ok(test.sent?.runId); assert.equal(test.terminal?.runId, test.sent.runId); assert.equal(test.terminal.status, "ok");
    if (offset) { assert.deepEqual(before.authority, cases[offset - 1].after.authority); assert.equal(test.firstProviderIndex, cases[offset - 1].lastProviderIndex + 1); }
    else assert.equal(before.authority.revision, report.source.initialRevision);
    for (const snapshot of [before, start, after]) {
      assert.equal(snapshot.authority?.mode, "core_checkpoint"); assert.match(snapshot.authority.revision, /^[a-f0-9]{40}$/); assert.ok(snapshot.authority.token);
      assert.equal(snapshot.status?.capabilities?.full_memory, false); assert.deepEqual(snapshot.status.authority, snapshot.authority);
      ref(snapshot.work?.ref); assert.equal(snapshot.work.record?.schemaVersion, "stella.ongoing-work/v1");
      assert.ok(snapshot.catalog.policies.some(policy => sameRef(policy, report.source.originalWorkPolicyRef) && policy.status === "current"));
    }
    assert.notEqual(start.authority.token, before.authority.token); assert.equal(start.authority.revision, test.archiveCommit);
    assert.equal(test.ownerArchiveWrites, 1); assert.equal(test.semanticWrites, correcting ? 1 : 0);
    assert.deepEqual(test.gitCommits, correcting ? [test.archiveCommit, test.semanticCommit] : [test.archiveCommit]);
    assert.equal(after.status.ingress?.state, "local_committed"); assert.equal(after.status.ingress.runId, test.sent.runId); assert.equal(after.status.ingress.revision, test.archiveCommit);
    assert.equal(test.archive?.runId, test.sent.runId); assert.equal(test.archive.requestHash, `sha256:${sha256(test.input)}`);
    ref(test.archive.sourceRef); ref(test.archive.evidenceRef); assert.deepEqual(test.archive.policyRef, report.source.archivePolicyRef);
    assert.ok(!sameRef(report.source.archivePolicyRef, report.source.originalWorkPolicyRef));
    for (const [group, target] of [["sources", test.archive.sourceRef], ["evidence", test.archive.evidenceRef]]) {
      assert.ok(!before.catalog[group].some(entry => sameRef(entry, target))); assert.ok(start.catalog[group].some(entry => sameRef(entry, target) && entry.status === "current"));
    }
    for (const group of ["sources", "evidence", "coverage"]) assert.equal(after.catalog[group].length - before.catalog[group].length, 1);
    const added = after.files.filter(file => !before.files.includes(file)), archives = added.filter(file => file.endsWith(".archive.json")), changes = added.filter(file => file.endsWith(".correction.json"));
    assert.equal(archives.length, 1); assert.equal(archives[0], `${after.status.ingress.operationId}.archive.json`); assert.equal(changes.length, correcting ? 1 : 0);
    assert.equal(after.catalog.changes.length - before.catalog.changes.length, correcting ? 1 : 0);
    const window = requests.slice(test.firstProviderIndex - 1, test.lastProviderIndex), kinds = kind => window.filter(request => request.kind === kind);
    const agents = kinds("agent"); assert.equal(agents.length, offset === 0 ? 1 : correcting ? 3 : 2);
    assert.deepEqual(agents.map(agent => agent.phase), Array.from({ length: agents.length }, (_, index) => index + 1));
    assert.equal(agents[0].index, test.firstProviderIndex); assert.equal(agents.at(-1).index, test.lastProviderIndex);
    assert.ok(texts(JSON.parse(wires[agents[0].index - 1].body)).some(text => text.includes(test.input)));
    assert.equal(kinds("view-selector").length, offset === 0 ? 0 : 1); assert.equal(kinds("source-policy").length > 0, offset !== 0);
    for (const kind of ["correction-proposal", "correction-verification", "source-interpretation"]) assert.equal(kinds(kind).length, correcting ? 1 : 0);
    for (const request of window.filter(request => request.kind !== "agent")) {
      const wire = JSON.parse(wires[request.index - 1].body), binding = promptBinding(wire, correctionPrefixes[request.kind]);
      assert.equal(wire.tools?.length ?? 0, 0); const verdict = correctionVerdict(wires[request.index - 1]);
      if (request.kind === "source-policy") { assert.equal(binding.request, test.input); assert.equal(binding.requestHash, test.archive.requestHash);
        assert.deepEqual(request.sourceRef, binding.sourceRef); assert.equal(verdict.requestHash, binding.requestHash); assert.ok(!wires[request.index - 1].body.includes("SYNTHETIC_ALLOWED_MEMORY_4931")); }
      else if (request.kind === "view-selector") { assert.equal(binding.question, test.input); assert.equal(binding.requestHash, test.archive.requestHash);
        assert.equal(binding.candidates?.length, 1); const candidate = binding.candidates[0];
        assert.equal(candidate.group, "works"); assert.deepEqual(candidate.ref, after.work.ref); assert.deepEqual(candidate.record, after.work.record);
        assert.deepEqual(request.selectedWork, after.work.ref); assert.deepEqual(verdict, { requestHash: binding.requestHash, selections: [{ handle: candidate.handle, view: "memory" }] }); }
      else if (request.kind === "source-interpretation") { assert.equal(binding.data.request, test.input); assert.ok(binding.data.requirements.some(rule => rule.id === "keep_scope"));
        assert.equal(verdict.bindingHash, binding.bindingHash); assert.deepEqual(verdict.checks, binding.data.requirements.map(rule => ({ handle: rule.handle, satisfied: true }))); }
      else { assert.equal(binding.requestHash, test.archive.requestHash); assert.equal(binding.ownerEvidence?.length, 1);
        assert.deepEqual(binding.ownerEvidence[0].ref, test.archive.evidenceRef); assert.equal(binding.ownerEvidence[0].text, test.input);
        if (request.kind === "correction-proposal") { assert.equal(binding.request, test.input); assert.deepEqual(request.ownerEvidenceRef, test.archive.evidenceRef); assert.equal(verdict.disposition, "update"); assert.equal(verdict.requestHash, binding.requestHash); }
        else { assert.equal(verdict.requestHash, binding.requestHash); assert.equal(verdict.proposalHash, binding.proposalHash); assert.equal(verdict.valid, true); } }
    }
    const requestedCalls = agents.map(agent => correctionParts(wires[agent.index - 1]).filter(part => part.functionCall).map(part => part.functionCall));
    assert.deepEqual(requestedCalls, offset === 0 ? [[]] : correcting ? [[{ name: "stella_memory_correct", args: {} }], [{ name: "stella_memory_data", args: { action: "work" } }], []]
      : [[{ name: "stella_memory_data", args: { action: "work" } }], []]);
    const outputs = name => {
      const final = JSON.parse(wires[agents.at(-1).index - 1].body), values = [];
      for (const content of final.contents) for (const part of content.parts ?? []) if (part.functionResponse?.name === name) {
        assert.equal(content.role, "user"); const value = part.functionResponse.response.output; values.push(typeof value === "string" ? JSON.parse(value) : value); }
      return values;
    };
    if (correcting) {
      const correction = test.correction, receipt = correction?.receipt;
      assert.deepEqual(Object.keys(receipt).sort(), ["changeRef", "clarification", "disposition", "operationId", "persistenceStatus"]);
      assert.equal(receipt.persistenceStatus, "local_committed"); assert.equal(receipt.disposition, "update"); assert.equal(receipt.clarification, null); ref(receipt.changeRef);
      assert.equal(changes[0], `${receipt.operationId}.correction.json`); assert.ok(after.catalog.changes.some(entry => sameRef(entry, receipt.changeRef)));
      assert.deepEqual(after.authority, correction.authority); assert.equal(test.semanticCommit, after.authority.revision);
      assert.notEqual(after.authority.token, start.authority.token); assert.notEqual(after.authority.revision, start.authority.revision);
      currentMemory(correction.currentMemory, test, after.authority);
      const supplied = outputs("stella_memory_correct").at(-1); assert.deepEqual(supplied, { correction: receipt, currentMemory: correction.currentMemory });
      assert.deepEqual(agents[1].correctionVerified, receipt.changeRef);
    } else { assert.equal(test.correction, undefined); assert.equal(test.semanticCommit, undefined); assert.deepEqual(after.authority, start.authority); }
    if (offset !== 0) {
      const supplied = outputs("stella_memory_data").at(-1); assert.deepEqual(Object.keys(supplied).sort(), ["currentMemory", "exclusions", "generation", "usageConstraints", "works"]);
      assert.deepEqual(supplied.works, [after.work]); assert.deepEqual(Object.keys(supplied.works[0]).sort(), ["record", "ref"]);
      assert.deepEqual(supplied.exclusions, {}); assert.equal(supplied.generation, after.catalog.generationId); currentMemory(supplied.currentMemory, test, after.authority);
      assert.deepEqual(supplied.usageConstraints, [{ work: after.work.ref, policies: [{ policyRef: report.source.originalWorkPolicyRef,
        quotePolicy: "summarize_only", rules: [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }] }] }]);
      assert.ok(!JSON.stringify(supplied).includes("SYNTHETIC_ALLOWED_MEMORY_4931") && !JSON.stringify(supplied).includes("SYNTHETIC_WORK_CORRECTION_ORIGINAL_7296"));
      assert.deepEqual(agents.at(-1).workVerified, after.work.ref); assert.equal(agents.at(-1).checkpointRevision, after.authority.revision);
    }
  }
  assert.deepEqual(cases[0].after.work, cases[0].before.work); assert.notDeepEqual(cases[1].after.work.ref, cases[1].before.work.ref);
  assert.notEqual(cases[1].after.work.record.goal, cases[1].before.work.record.goal); assert.deepEqual(cases[2].after.work, cases[1].after.work);
  for (const field of ["confirmedPremises", "candidateIdeas", "rejectedInterpretations", "openQuestions", "nextStep"]) assert.deepEqual(cases[1].after.work.record[field], cases[1].before.work.record[field]);
  assert.equal(report.sourceFinalRevision, cases[2].after.authority.revision);
}

// These are public installed-Host observations, not a legacy code-identity receipt.
export function assertExperimentalReports(reports, expected) {
  const { packageRoot, hostRoot } = expected;
  assert.deepEqual(Object.keys(reports).sort(), ["budgetFile", "budgetTotal", "continuous", "correction", "skill", "snapshotImport", "v3", "work"]);
  for (const report of Object.values(reports)) {
    assert.equal(report.passed, true); assert.equal(report.error, undefined);
    for (const key of Object.keys(NON_ACCEPTANCE)) if (Object.hasOwn(report, key)) assert.equal(report[key], false, `Unexpected product acceptance: ${key}`);
    assert.equal(report.installation?.packageRoot ?? report.installation?.root, packageRoot);
    assert.equal(report.installation?.directHostLoad, true); assert.equal(report.installation?.observerWrapper, false);
    assert.equal(report.hostIdentity?.root, hostRoot); assert.equal(report.hostIdentity?.version, "2026.8.2");
    assert.equal(report.hostIdentity?.fullTreeVerified, false);
    assert.equal(report.gateway?.exitCode, 0); assert.equal(report.gateway?.signalCode, null);
  }
  assertInstalledWorkReport(reports.work, expected);
  assertInstalledCorrectionReport(reports.correction, expected);
  assertSkillConsumption(reports.skill); assertBudgetRefusal(reports.budgetFile, "file"); assertBudgetRefusal(reports.budgetTotal, "total");
  const chat = reports.continuous, rounds = chat.continuousChat?.rounds;
  assert.equal(chat.scenario, "continuous_chat"); assert.equal(rounds?.length, 3);
  assert.equal(chat.rawProviderRequests?.length, 9); assert.equal(chat.continuousChat.resets, 0);
  assert.equal(new Set(rounds.map(round => round.history?.sessionId)).size, 1);
  assert.ok(rounds[0].history.sessionId);
  assert.equal(chat.continuousChat.boundariesVerified?.oneArchivePerUserRequest, true);
  assert.equal(chat.continuousChat.boundariesVerified?.currentToolsServeRevisedB, true);
  assert.equal(chat.continuousChat.boundariesVerified?.noResetOrGatewayRestartDuringConversation, true);
  assert.equal(chat.materialization?.materialized?.receipt?.files?.length, 6);
  assert.equal(chat.materialization.consumed, false);
  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index], started = chat.continuousProviderStarts?.[index]?.checkpoint;
    assert.equal(round.terminal?.status, "ok"); assert.equal(round.status?.mode, EXPERIMENTAL_SCOPE);
    assert.equal(round.status.ingress?.state, "local_committed"); assert.equal(round.status.capabilities?.full_memory, false);
    assert.ok(started?.revision && started?.token);
    assert.equal(started.revision, round.status.authority?.revision); assert.equal(started.token, round.status.authority?.token);
  }
  assert.deepEqual(reports.v3.cases?.map(test => test.id), ["allowed", "denied_use", "denied_audience"]);
  for (const test of reports.v3.cases.slice(0, 2)) {
    assert.equal(test.terminal?.status, "ok"); assert.equal(test.status?.capabilities?.full_memory, false);
  }
  assert.equal(reports.v3.cases[2].providerRequests, 0);
  assert.equal(reports.v3.cases[2].status?.supply?.category, "private_context_audience_forbidden");
  const snapshot = reports.snapshotImport;
  assert.deepEqual(snapshot.cases?.map(test => test.id), ["allowed", "imported", "denied_audience"]);
  assert.equal(snapshot.requests?.length, 44);
  assert.deepEqual(snapshot.snapshotImportBoundaries, { currentRequestReadsImportedVersion: true, sameSessionNextRequest: true,
    noResetDuringUpdate: true, staleExpectedRefused: true, authorityUnchangedAfterConflict: true,
    producerCandidateSeparateFromConsumerCommit: true, grantPredeclaredInFixture: true });
  assert.equal(snapshot.snapshotImport?.consumed, false); assert.equal(snapshot.snapshotImport?.capabilities?.full_memory, false);
  assert.equal(snapshot.cases[1].terminal?.status, "ok"); assert.equal(snapshot.cases[2].providerRequests, 0);
  assert.ok(snapshot.cases[0].history?.sessionId);
  assert.equal(snapshot.cases[1].history?.sessionId, snapshot.cases[0].history.sessionId);
  assert.ok(JSON.stringify(snapshot.cases[1].history).includes("SYNTHETIC_V3_IMPORTED_ANSWER"));
  return { initialization: "passed", continuousOwnerChat: "passed", localInputArchive: "passed", nextRequestFreshness: "passed",
    v3PaginationAndPolicy: "passed", explicitSnapshotImport: "passed", unauthorizedAudience: "passed",
    managedSkillConsumption: "passed", instructionBudgetRefusal: "passed", readOnlyWorkContinuation: "passed", agentSelectedCorrectionMechanism: "passed", automaticSemanticQuality: "not_accepted", automaticHostCorrection: "not_accepted", full_memory: "not_accepted" };
}
