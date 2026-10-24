import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const evidence = await import(new URL("../../scripts/lib/experimental-owner-chat-evidence.mjs", import.meta.url).href);
const context = { packageRoot: "/synthetic/consumer/node_modules/@tower1229/stella-core", hostRoot: "/synthetic/consumer/node_modules/openclaw",
  artifact: "/synthetic/core.tgz", artifactSha256: "a".repeat(64), packageIntegrity: "sha512-synthetic-package",
  consumerLockSha256: "b".repeat(64), coreRevision: "c".repeat(40), buildIdentitySha256: "d".repeat(64) };
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const bootstrapTargets = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];

function validWork(common: any) {
  const policyRef = { id: "synthetic-policy", version: digest("work-policy") }, sourceRef = { id: "synthetic-source", version: digest("work-source") };
  const policies = [{ policyRef, rules: [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }], quotePolicy: "summarize_only" }];
  const binding = { agentId: "synthetic", repositoryRoot: "/synthetic/source", manifestPath: "synthetic-manifest.yaml" };
  const authorityA = { mode: "core_checkpoint", binding, revision: "1".repeat(40), token: "synthetic-A" };
  const authorityB = { ...authorityA, revision: "2".repeat(40), token: "synthetic-B" };
  const requests: any[] = [], allHttpRequests: any[] = [], providerWires: any[] = [], cases: any[] = [];
  const add = (kind: string, test: any, wire: any, metadata: any = {}) => {
    const index = requests.length + 1, body = JSON.stringify(wire), method = "/models/gemini-3.8-flash:streamGenerateContent?alt=sse", atUtc = "2026-10-24T09:00:00Z";
    requests.push({ index, kind, case: test.id, method, bytes: Buffer.byteLength(body), atUtc, ...metadata });
    allHttpRequests.push({ index, method: "POST", path: method, atUtc });
    providerWires.push({ index, body, sha256: digest(body).slice(7) });
  };
  for (const [offset, authority] of [authorityA, authorityB].entries()) {
    const id = offset ? "after" : "before", label = offset ? "B" : "A", sessionId = `synthetic-work-session-${label}`, runId = `synthetic-work-${id}`;
    const question = offset ? "SYNTHETIC_WORK_QUERY_B_7296: resume the current writing work after my correction, preserving its unresolved question."
      : "SYNTHETIC_WORK_QUERY_A_7296: resume my current writing work, including confirmed premises, proposals, rejected readings and open questions.";
    const ref = { id: "synthetic-writing-work", version: digest(`work-${label}`) };
    const work = { ref, record: { schemaVersion: "stella.ongoing-work/v1", id: ref.id, goal: `Synthetic current writing goal ${label}`,
      confirmedPremises: [{ text: "Confirmed premise", acceptance: "confirmed" }], candidateIdeas: [{ text: "Provisional idea", acceptance: "proposed" }],
      rejectedInterpretations: [{ text: "Rejected ending", acceptance: "rejected" }], openQuestions: [{ question: "Still open?", material: true }], nextStep: null } };
    const status = { authority, capabilities: { full_memory: false } }, expectedGeneration = `synthetic-generation-${label}`;
    const test = { id, created: { ok: true, runStarted: false, sessionId }, sent: { runId }, terminal: { runId, status: "ok" }, status,
      history: { sessionId, messages: [`SYNTHETIC_WORK_${label}_ANSWER_7296`] }, expectedWork: work, expectedGeneration,
      firstProviderIndex: requests.length + 1, lastProviderIndex: 0 };
    const original = { text: `Synthetic original payload ${label}`, usageConstraints: structuredClone(policies) };
    const contents = [{ role: "user", parts: [{ text: question }] }];
    add("agent", test, { contents }, { phase: 1 });
    for (let count = 0; count < (offset ? 2 : 1); count++) {
      const source = { request: question, requestHash: digest(question), sourceRef };
      add("source-policy", test, { contents: [{ role: "user", parts: [{ text: "Judge the semantic relationship between this request and exactly this source.\n" + JSON.stringify(source) }] }] },
        { requestHash: source.requestHash, sourceRef });
    }
    const selection = { question, requestHash: digest(question), candidates: [{ handle: "V1", group: "works", ref, record: work.record, originals: [original] }] };
    add("view-selector", test, { contents: [{ role: "user", parts: [{ text: "Select request-local Stella USER and MEMORY views.\n" + JSON.stringify(selection) }] }] },
      { requestHash: selection.requestHash, selectedWork: ref });
    const output = { works: [work], usageConstraints: [{ work: ref, policies: structuredClone(policies) }], exclusions: {}, generation: expectedGeneration,
      currentMemory: { userRequest: runId, checkpointRevision: authority.revision, checkpointToken: authority.token } };
    add("agent", test, { contents: [...contents, { role: "model", parts: [{ functionCall: { name: "stella_memory_data", args: { action: "work" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "stella_memory_data", response: { output: JSON.stringify(output) } } }] }] },
      { phase: 2, workVerified: ref, checkpointRevision: authority.revision });
    test.lastProviderIndex = requests.length; cases.push(test);
  }
  return { ...structuredClone(common), schemaVersion: "stella.checkpoint-work-installed/v1",
    installation: { ...structuredClone(common.installation), root: context.packageRoot, entry: context.packageRoot + "/dist/src/plugin.js",
      artifact: context.artifact, artifactSha256: context.artifactSha256, packageIntegrity: context.packageIntegrity,
      consumerLockSha256: context.consumerLockSha256, buildIdentitySha256: context.buildIdentitySha256,
      buildIdentity: { coreRevision: context.coreRevision, sourceClean: true }, fullInstalledTreeVerifiedByThisProbe: false,
      inspectedFiles: ["dist/src/plugin.js", "dist/src/openclaw/checkpoint-plugin-runtime.js", "dist/src/openclaw/checkpoint-agent-supply.js", "dist/src/openclaw/checkpoint-source-access.js"].map(path => ({ path, sha256: digest(path).slice(7) })) },
    fullMemoryAccepted: false, realModelAccepted: false, realMainAccepted: false, automaticCorrectionAccepted: false,
    configuration: { model: "google/gemini-3.8-flash", thinking: "low", extraLlmPermissions: false, requestArchive: false, providerBaseUrl: "http://127.0.0.1:12345" },
    syntheticClientIdentity: { clientName: "cli", mode: "cli", sourceRequesterId: "cli", privateKeyStorage: "memory_only", clientDeviceAuthTokenPersistence: false, humanProfileClaimed: false },
    boundaries: { twoFreshSessions: true, exactOriginalUserQuestionToSelector: true, modelSelectedWork: true, completeWorkRecordAndRefReachedNextAgentWire: true,
      candidateOriginalsNotForwardedToAgent: true, usageConstraintsInFinalAgentWire: true, currentWorkAfterTrustedCorrection: true, automaticHostCorrectionClaimed: false, full_memory: false },
    gatewayRuns: [structuredClone(common.gateway)], syntheticSourceRemoved: true, endedAtUtc: "2026-10-24T09:00:01Z",
    source: { initialRevision: authorityA.revision, workRef: cases[0].expectedWork.ref }, sourceFinalRevision: authorityB.revision,
    correction: { trigger: "trusted installed Core runtime.correctLocal with explicitly synthetic callbacks; not automatic Host learning", expected: authorityA,
      result: { persistenceStatus: "local_committed", disposition: "update", clarification: null, authority: authorityB, revision: authorityB.revision, generationId: cases[1].expectedGeneration } },
    trustedCorrectionCalls: ["proposal-stub", "verification-stub"].map(kind => ({ kind, transport: "local callback, not public Host LLM" })),
    requests, allHttpRequests, providerWires, cases };
}
function mutateWorkWire(reports: any, index: number, mutate: (body: any) => void) {
  const wire = reports.work.providerWires[index - 1], body = JSON.parse(wire.body); mutate(body);
  wire.body = JSON.stringify(body); wire.sha256 = digest(wire.body).slice(7); reports.work.requests[index - 1].bytes = Buffer.byteLength(wire.body);
}
function mutateWorkOutput(reports: any, index: number, mutate: (output: any) => void) {
  mutateWorkWire(reports, index, body => {
    const response = body.contents.flatMap((content: any) => content.parts).find((part: any) => part.functionResponse).functionResponse.response;
    const output = JSON.parse(response.output); mutate(output); response.output = JSON.stringify(output);
  });
}

function valid() {
  const common = { passed: true, hostIdentity: { root: context.hostRoot, version: "2026.8.2", fullTreeVerified: false },
    gateway: { exitCode: 0, signalCode: null }, installation: { packageRoot: context.packageRoot, directHostLoad: true, observerWrapper: false } };
  const authority = { revision: "a".repeat(40), token: "synthetic" };
  const status = { mode: "experimental_owner_chat", authority, ingress: { state: "local_committed" }, capabilities: { full_memory: false } };
  const rounds = Array.from({ length: 3 }, () => ({ terminal: { status: "ok" }, status, history: { sessionId: "same-synthetic-session" } }));
  const bootstrapSources = bootstrapTargets.map(target => ({ target, sha256: digest(`${target}: synthetic full bytes\n`), normalizedSha256: digest(`${target}: synthetic full bytes`) }));
  const skillSource = { name: "stella-initialization-probe", target: "skills/stella-initialization-probe/SKILL.md", sha256: digest("Synthetic complete managed skill text\n") };
  const wireProofs = Array.from({ length: 8 }, (_, offset) => {
    const index = offset + 1, hasSkill = ![1, 5].includes(index);
    return { index, systemField: "systemInstruction", bootstrapHashes: bootstrapSources.map(source => ({ target: source.target, sha256: source.normalizedSha256 })),
      bootstrapOrder: [...bootstrapTargets], contents: hasSkill
        ? [{ role: "user", parts: ["text"] }, { role: "model", parts: ["functionCall"] }, { role: "user", parts: ["functionResponse"] }]
        : [{ role: "user", parts: ["text"] }],
      skill: hasSkill ? { name: skillSource.name, sha256: skillSource.sha256, sourceSha256: skillSource.sha256, role: "user", contentIndex: 2 } : null };
  });
  const budget = (budgetMode: "file" | "total") => {
    const runId = `synthetic-budget-${budgetMode}-run`, sessionKey = `agent:synthetic:budget-${budgetMode}`;
    const planHash = digest(`Synthetic initialization operation ${budgetMode}`);
    const state = { pendingSha256: planHash, operationSha256: planHash, fenced: true, receiptPresent: false,
      files: [...bootstrapSources.map(source => ({ target: source.target, sha256: source.sha256 })), { target: skillSource.target, sha256: skillSource.sha256 }] };
    return { ...structuredClone(common), scenario: "materialization", budgetMode, rawProviderRequests: [], allHttpRequests: [],
      instructionBudget: { agentId: "synthetic", defaultFileLimit: 1, fileLimit: budgetMode === "file" ? 1 : 20000, totalLimit: budgetMode === "total" ? 1 : 150000 },
      budgetAgent: { attempted: true, runId, sessionKey, sent: { runId }, terminal: { runId, status: "error" },
        refusalObservation: { category: "initialization_pending", event: budgetMode === "file" ? "agent" : "chat", runId, sessionKey,
          payload: { runId, sessionKey, message: "Core initialization is pending" } } },
      budgetStateBefore: state, budgetStateAfter: structuredClone(state), budgetRefusal: {
        category: budgetMode === "file" ? "host_bootstrap_context_incomplete" : "host_bootstrap_context_missing",
        agentAttempted: true, agentBlockedCategory: "initialization_pending", originalFilesPreserved: true,
        sourceRevisionUnchanged: true, pendingOperationRetained: true, fenced: true, receiptPresent: false, bootstrapFilesWritten: 6 } };
  };
  return { continuous: { ...structuredClone(common), scenario: "continuous_chat", rawProviderRequests: Array.from({ length: 9 }, () => ({})),
    materialization: { materialized: { receipt: { files: Array(6).fill({}) } }, consumed: false },
    continuousProviderStarts: rounds.map(() => ({ checkpoint: authority })), continuousChat: { rounds, resets: 0,
      boundariesVerified: { oneArchivePerUserRequest: true, currentToolsServeRevisedB: true, noResetOrGatewayRestartDuringConversation: true } } },
    v3: { ...structuredClone(common), cases: [{ id: "allowed", terminal: { status: "ok" }, status },
      { id: "denied_use", terminal: { status: "ok" }, status },
      { id: "denied_audience", providerRequests: 0, status: { supply: { category: "private_context_audience_forbidden" } } }] },
    snapshotImport: { ...structuredClone(common), cases: [{ id: "allowed", terminal: { status: "ok" }, status, history: { sessionId: "same-snapshot-session" } },
      { id: "imported", terminal: { status: "ok" }, status, history: { sessionId: "same-snapshot-session", messages: ["SYNTHETIC_V3_IMPORTED_ANSWER"] } }, { id: "denied_audience", providerRequests: 0 }],
      requests: Array.from({ length: 44 }, () => ({})), snapshotImport: { consumed: false, capabilities: { full_memory: false } },
      snapshotImportBoundaries: { currentRequestReadsImportedVersion: true, sameSessionNextRequest: true, noResetDuringUpdate: true,
        staleExpectedRefused: true, authorityUnchangedAfterConflict: true, producerCandidateSeparateFromConsumerCommit: true, grantPredeclaredInFixture: true } },
    skill: { ...structuredClone(common), scenario: "materialization", budgetMode: "normal", rawProviderRequests: Array.from({ length: 8 }, (_, index) => ({ index: index + 1 })),
      allHttpRequests: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, method: "POST", path: "/synthetic-loopback" })),
      materialization: { materialized: { receipt: { files: Array(6).fill({}) } }, consumed: false },
      skillConsumption: { bootstrapSources, skillSource, wireProofs } }, budgetFile: budget("file"), budgetTotal: budget("total"), work: validWork(common) };
}
function rejects(mutate: (reports: any) => void) { const reports = valid(); mutate(reports); assert.throws(() => evidence.assertExperimentalReports(reports, context)); }

test("experimental CI accepts only its installed Host scope and keeps complete capabilities unaccepted", () => {
  assert.equal(evidence.assertExperimentalReports(valid(), context).full_memory, "not_accepted");
  assert.deepEqual(evidence.NON_ACCEPTANCE, { fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false });
});
test("missing, running, failed or observer-only Host evidence cannot pass experimental CI", () => {
  rejects(reports => { delete reports.v3; });
  rejects(reports => { reports.continuous.passed = false; });
  rejects(reports => { reports.v3.error = "synthetic failure"; });
  rejects(reports => { reports.continuous.installation.directHostLoad = false; });
  rejects(reports => { reports.v3.installation.observerWrapper = true; });
  rejects(reports => { reports.v3.gateway.exitCode = null; });
  rejects(reports => { reports.continuous.gateway.exitCode = 1; });
});
test("different installed package or Host and unsupported acceptance claims are refused", () => {
  rejects(reports => { reports.v3.installation.packageRoot = "/different-package"; });
  rejects(reports => { reports.v3.hostIdentity.root = "/different-host"; });
  rejects(reports => { reports.continuous.hostIdentity.version = "2026.8.1"; });
  for (const key of Object.keys(evidence.NON_ACCEPTANCE)) rejects(reports => { reports.continuous[key] = true; });
  rejects(reports => { reports.v3.cases[0].status.capabilities.full_memory = true; });
});
test("partial rounds, reset conversation, missing wire and stale checkpoint evidence are refused", () => {
  rejects(reports => { reports.continuous.rawProviderRequests.pop(); });
  rejects(reports => { reports.continuous.continuousChat.rounds.pop(); });
  rejects(reports => { reports.continuous.continuousChat.resets = 1; });
  rejects(reports => { reports.continuous.continuousChat.rounds[2].history = { sessionId: "different-session" }; });
  rejects(reports => { reports.continuous.continuousProviderStarts[2] = { checkpoint: { revision: "stale", token: "stale" } }; });
  rejects(reports => { reports.continuous.continuousChat.boundariesVerified.currentToolsServeRevisedB = false; });
});
test("unverified bootstrap and missing policy refusal or audience leakage cannot pass", () => {
  rejects(reports => { reports.continuous.materialization.materialized.receipt.files.pop(); });
  rejects(reports => { reports.v3.cases.pop(); });
  rejects(reports => { reports.v3.cases[2].providerRequests = 1; });
  rejects(reports => { reports.v3.cases[2].status.supply.category = "unknown"; });
});

test("explicit snapshot import needs actual next-request and conflict evidence", () => {
  rejects(reports => { delete reports.snapshotImport; });
  rejects(reports => { reports.snapshotImport.snapshotImportBoundaries.staleExpectedRefused = false; });
  rejects(reports => { reports.snapshotImport.snapshotImportBoundaries.currentRequestReadsImportedVersion = false; });
  rejects(reports => { reports.snapshotImport.requests.pop(); });
  rejects(reports => { reports.snapshotImport.snapshotImport.capabilities.full_memory = true; });
  rejects(reports => { reports.snapshotImport.cases[1].history.sessionId = "another-session"; });
  rejects(reports => { reports.snapshotImport.cases[1].history.messages = ["old-answer"]; });
});

test("skill and budget reports must retain the same direct installed Host and completed process scope", () => {
  for (const name of ["skill", "budgetFile", "budgetTotal"]) {
    rejects(reports => { delete reports[name]; });
    rejects(reports => { reports[name].installation.observerWrapper = true; });
    rejects(reports => { reports[name].gateway.exitCode = null; });
    rejects(reports => { reports[name].fullMemoryAccepted = true; });
  }
  rejects(reports => { reports.skill.installation.packageRoot = "/another-installed-package"; });
});

test("managed skill consumption requires complete matching bootstrap hashes and a recorded full order", () => {
  rejects(reports => { reports.skill.rawProviderRequests.pop(); });
  rejects(reports => { reports.skill.allHttpRequests.pop(); });
  rejects(reports => { reports.skill.skillConsumption.bootstrapSources.pop(); });
  rejects(reports => { reports.skill.skillConsumption.wireProofs.pop(); });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[0].bootstrapHashes.pop(); });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[0].bootstrapHashes[0].sha256 = digest("Incomplete wire text"); });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[0].bootstrapHashes[4].target = "AGENTS.md"; });
  rejects(reports => { reports.skill.skillConsumption.bootstrapSources[0].normalizedSha256 = digest("Different expected source text"); });
  rejects(reports => { delete reports.skill.skillConsumption.wireProofs[0].bootstrapOrder; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[0].bootstrapOrder[4] = "AGENTS.md"; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[0].systemField = "contents"; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[7].index = 7; });
});

test("bootstrap order is observed rather than prescribed as one universal Host order", () => {
  const reports = valid();
  for (const wire of reports.skill.skillConsumption.wireProofs) wire.bootstrapOrder.reverse();
  assert.equal(evidence.assertExperimentalReports(reports, context).full_memory, "not_accepted");
});

test("skill body proof must appear in exactly the current tool-response wires with exact source hashes", () => {
  for (const index of [2, 3, 4, 6, 7, 8]) rejects(reports => { reports.skill.skillConsumption.wireProofs[index - 1].skill = null; });
  for (const index of [1, 5]) rejects(reports => {
    const proof = reports.skill.skillConsumption.wireProofs[index - 1], complete = reports.skill.skillConsumption.wireProofs[1];
    proof.contents = structuredClone(complete.contents); proof.skill = structuredClone(complete.skill);
  });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].skill.sha256 = digest("Truncated skill body"); });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].skill.sourceSha256 = digest("Other skill source"); });
  rejects(reports => { reports.skill.skillConsumption.skillSource.sha256 = digest("Replaced source"); });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].skill.role = "model"; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].skill.contentIndex = 0; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].skill.contentIndex = 100; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].skill.contentIndex = 1.5; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].contents[1].role = "user"; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].contents[2].role = "model"; });
  rejects(reports => { reports.skill.skillConsumption.wireProofs[1].contents[2].parts = ["text"]; });
});

test("budget refusal evidence binds a completed actual attempt to its public initialization rejection", () => {
  for (const name of ["budgetFile", "budgetTotal"]) {
    rejects(reports => { delete reports[name].instructionBudget; });
    rejects(reports => { delete reports[name].instructionBudget.fileLimit; });
    rejects(reports => { reports[name].instructionBudget.agentId = "another-agent"; });
    rejects(reports => { reports[name].instructionBudget.defaultFileLimit = 20000; });
    rejects(reports => { delete reports[name].budgetAgent; });
    rejects(reports => { reports[name].budgetAgent.attempted = false; });
    rejects(reports => { delete reports[name].budgetAgent.runId; });
    rejects(reports => { delete reports[name].budgetAgent.sessionKey; });
    rejects(reports => { delete reports[name].budgetAgent.sent; });
    rejects(reports => { reports[name].budgetAgent.sent.runId = "another-accepted-run"; });
    rejects(reports => { delete reports[name].budgetAgent.terminal; });
    rejects(reports => { delete reports[name].budgetAgent.terminal.runId; });
    rejects(reports => { reports[name].budgetAgent.terminal.runId = "another-terminal-run"; });
    rejects(reports => { delete reports[name].budgetAgent.terminal.status; });
    rejects(reports => { reports[name].budgetAgent.terminal.status = "timeout"; });
    rejects(reports => { reports[name].budgetAgent.terminal.status = "ok"; });
    rejects(reports => { delete reports[name].budgetAgent.refusalObservation; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.event = "unknown-event"; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.category = "unrelated-refusal"; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.runId = "another-run"; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.sessionKey = "agent:synthetic:another-session"; });
    rejects(reports => { delete reports[name].budgetAgent.refusalObservation.payload; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.payload.runId = "another-payload-run"; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.payload.sessionKey = "agent:synthetic:another-payload-session"; });
    rejects(reports => { reports[name].budgetAgent.refusalObservation.payload.message = "An unrelated operation failed"; });
  }
});

test("budget refusal preserves actual pending operation and complete original file state after the attempt", () => {
  for (const name of ["budgetFile", "budgetTotal"]) {
    rejects(reports => { delete reports[name].budgetStateBefore; });
    rejects(reports => { delete reports[name].budgetStateAfter; });
    rejects(reports => { reports[name].budgetStateAfter.pendingSha256 = digest("A different pending operation"); });
    rejects(reports => { reports[name].budgetStateAfter.files[0].sha256 = digest("Changed original after blocked attempt"); });
    rejects(reports => { reports[name].budgetStateAfter.fenced = false; });
    for (const key of ["pendingSha256", "operationSha256"]) rejects(reports => {
      reports[name].budgetStateBefore[key] = "invalid-plan-hash"; reports[name].budgetStateAfter[key] = "invalid-plan-hash";
    });
    rejects(reports => { reports[name].budgetStateBefore.fenced = reports[name].budgetStateAfter.fenced = false; });
    rejects(reports => { reports[name].budgetStateBefore.receiptPresent = reports[name].budgetStateAfter.receiptPresent = true; });
    rejects(reports => { reports[name].budgetStateBefore.files.pop(); reports[name].budgetStateAfter.files.pop(); });
    rejects(reports => { reports[name].budgetStateBefore.files[5].target = reports[name].budgetStateAfter.files[5].target = "AGENTS.md"; });
    rejects(reports => { reports[name].budgetStateBefore.files[0].sha256 = reports[name].budgetStateAfter.files[0].sha256 = "invalid-file-hash"; });
  }
});

test("budget refusals need the actual initialization boundary and zero total HTTP attempts", () => {
  for (const name of ["budgetFile", "budgetTotal"]) {
    rejects(reports => { reports[name].budgetRefusal.category = name === "budgetFile" ? "host_bootstrap_context_missing" : "host_bootstrap_context_incomplete"; });
    rejects(reports => { reports[name].budgetMode = "normal"; });
    rejects(reports => { reports[name].rawProviderRequests.push({ index: 1 }); });
    rejects(reports => { reports[name].allHttpRequests.push({ method: "POST", path: "/synthetic-title-helper" }); });
    rejects(reports => { delete reports[name].allHttpRequests; });
    rejects(reports => { reports[name].budgetRefusal.agentAttempted = false; });
    rejects(reports => { reports[name].budgetRefusal.agentBlockedCategory = "unknown"; });
    rejects(reports => { reports[name].budgetRefusal.originalFilesPreserved = false; });
    rejects(reports => { reports[name].budgetRefusal.sourceRevisionUnchanged = false; });
    rejects(reports => { reports[name].budgetRefusal.pendingOperationRetained = false; });
    rejects(reports => { reports[name].budgetRefusal.fenced = false; });
    rejects(reports => { reports[name].budgetRefusal.receiptPresent = true; });
    rejects(reports => { reports[name].budgetRefusal.bootstrapFilesWritten = 0; });
  }
});

test("work is a seventh required same-package report without claiming automatic Host learning", () => {
  const accepted = evidence.assertExperimentalReports(valid(), context);
  assert.equal(accepted.readOnlyWorkContinuation, "passed"); assert.equal(accepted.automaticHostCorrection, "not_accepted");
  rejects(reports => { delete reports.work; });
  rejects(reports => { reports.work.installation.artifactSha256 = "e".repeat(64); });
  rejects(reports => { reports.work.installation.packageIntegrity = "another-integrity"; });
  rejects(reports => { reports.work.installation.consumerLockSha256 = "e".repeat(64); });
  rejects(reports => { reports.work.installation.buildIdentity.coreRevision = "e".repeat(40); });
  rejects(reports => { reports.work.installation.buildIdentity.sourceClean = false; });
  rejects(reports => { reports.work.installation.inspectedFiles.pop(); });
  rejects(reports => { reports.work.installation.observerWrapper = true; });
  rejects(reports => { reports.work.automaticCorrectionAccepted = true; });
  rejects(reports => { reports.work.correction.trigger = "automatic Host correction"; });
  rejects(reports => { reports.work.trustedCorrectionCalls[0].transport = "public Host LLM"; });
});

test("work consumption requires new sessions and the accepted current A to B correction tuple", () => {
  rejects(reports => { reports.work.cases.pop(); });
  rejects(reports => { reports.work.cases[1].history.sessionId = reports.work.cases[0].history.sessionId; });
  rejects(reports => { reports.work.cases[1].created.runStarted = true; });
  rejects(reports => { reports.work.cases[1].terminal.runId = "another-run"; });
  rejects(reports => { reports.work.cases[1].terminal.status = "timeout"; });
  rejects(reports => { reports.work.correction.result.authority.token = reports.work.correction.expected.token; });
  rejects(reports => { reports.work.correction.result.persistenceStatus = "synchronized"; });
  rejects(reports => { reports.work.boundaries.currentWorkAfterTrustedCorrection = false; });
  rejects(reports => { reports.work.cases[1].status.capabilities.full_memory = true; });
});

test("work CI checks complete real Agent wire output, exact source constraints and original isolation", () => {
  rejects(reports => { reports.work.providerWires.pop(); });
  rejects(reports => { reports.work.providerWires[0].sha256 = "f".repeat(64); });
  rejects(reports => { mutateWorkOutput(reports, 4, output => { delete output.usageConstraints; }); });
  rejects(reports => { mutateWorkOutput(reports, 9, output => { output.usageConstraints[0].policies[0].rules = []; }); });
  rejects(reports => { mutateWorkOutput(reports, 9, output => { output.usageConstraints[0].policies[0].quotePolicy = "allow_quote"; }); });
  rejects(reports => { mutateWorkOutput(reports, 9, output => { output.usageConstraints[0].work = reports.work.cases[0].expectedWork.ref; }); });
  rejects(reports => { mutateWorkOutput(reports, 4, output => { output.works[0].originals = []; }); });
  rejects(reports => { mutateWorkOutput(reports, 9, output => { output.works[0].record.goal = "wrong current goal"; }); });
  rejects(reports => { mutateWorkOutput(reports, 4, output => { output.currentMemory.userRequest = "another-run"; }); });
  rejects(reports => { mutateWorkWire(reports, 4, body => { body.contents[2].role = "model"; }); });
  rejects(reports => { mutateWorkWire(reports, 4, body => { body.contents[1].role = "user"; }); });
  rejects(reports => { mutateWorkWire(reports, 4, body => { body.contents[2].parts = [{ text: "No real tool response" }]; }); });
  rejects(reports => { mutateWorkWire(reports, 4, body => { body.contents.push({ role: "user", parts: [{ text: "SYNTHETIC_WORK_CORRECTION_ORIGINAL_7296\n\"quoted original\"" }] }); }); });
  rejects(reports => { mutateWorkWire(reports, 3, body => {
    const part = body.contents[0].parts[0], binding = JSON.parse(part.text.split("\n").at(-1)); binding.question = "model-authored alternate question";
    part.text = "Select request-local Stella USER and MEMORY views.\n" + JSON.stringify(binding);
  }); });
});

test("work HTTP closure, cleanup and read-only principal boundaries cannot be replaced by success flags", () => {
  rejects(reports => { reports.work.allHttpRequests.push({ index: 10, method: "POST", path: "/title-helper" }); });
  rejects(reports => { reports.work.requests[4].case = "before"; });
  rejects(reports => { reports.work.requests[5].kind = "local-correction-stub"; });
  rejects(reports => { reports.work.cases[0].lastProviderIndex++; });
  rejects(reports => { reports.work.providerDrainError = { message: "late callback" }; });
  rejects(reports => { reports.work.gatewayRuns[0].exitCode = 1; });
  rejects(reports => { reports.work.syntheticSourceRemoved = false; });
  rejects(reports => { reports.work.configuration.requestArchive = true; });
  rejects(reports => { reports.work.configuration.extraLlmPermissions = true; });
  rejects(reports => { reports.work.configuration.providerBaseUrl = "https://external.example.invalid"; });
  rejects(reports => { reports.work.syntheticClientIdentity.humanProfileClaimed = true; });
  rejects(reports => { reports.work.syntheticClientIdentity.clientDeviceAuthTokenPersistence = true; });
});

test("probe SIGTERM waits for its registered child cleanup and preserves a failed cancellation", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "stella-probe-cancel-"));
  const helper = new URL("../../scripts/lib/isolated-probe-host.mjs", import.meta.url).href;
  const script = path.join(temp, "cancel.mjs"), result = path.join(temp, "result.json");
  await writeFile(script, `import {spawn} from 'node:child_process'; import {once} from 'node:events'; import {writeFile} from 'node:fs/promises';
import {onProbeCancellation} from ${JSON.stringify(helper)};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
let signal;onProbeCancellation(value=>{signal=value},async()=>{const exit=once(child,'exit');child.kill('SIGTERM');await exit;await writeFile(${JSON.stringify(result)},JSON.stringify({signal,childExitObserved:child.exitCode!==null||child.signalCode!==null,passed:false}));});
console.log('ready');setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data"); child.kill("SIGTERM");
    const [code] = await exited; assert.equal(code, 1);
    assert.deepEqual(JSON.parse(await readFile(result, "utf8")), { signal: "SIGTERM", childExitObserved: true, passed: false });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } await rm(temp, { recursive: true, force: true }); }
});
