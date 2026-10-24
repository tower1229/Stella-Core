import assert from "node:assert/strict";

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

// These are public installed-Host observations, not a legacy code-identity receipt.
export function assertExperimentalReports(reports, { packageRoot, hostRoot }) {
  assert.deepEqual(Object.keys(reports).sort(), ["budgetFile", "budgetTotal", "continuous", "skill", "snapshotImport", "v3"]);
  for (const report of Object.values(reports)) {
    assert.equal(report.passed, true); assert.equal(report.error, undefined);
    for (const key of Object.keys(NON_ACCEPTANCE)) if (Object.hasOwn(report, key)) assert.equal(report[key], false, `Unexpected product acceptance: ${key}`);
    assert.equal(report.installation?.packageRoot ?? report.installation?.root, packageRoot);
    assert.equal(report.installation?.directHostLoad, true); assert.equal(report.installation?.observerWrapper, false);
    assert.equal(report.hostIdentity?.root, hostRoot); assert.equal(report.hostIdentity?.version, "2026.8.2");
    assert.equal(report.hostIdentity?.fullTreeVerified, false);
    assert.equal(report.gateway?.exitCode, 0); assert.equal(report.gateway?.signalCode, null);
  }
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
    managedSkillConsumption: "passed", instructionBudgetRefusal: "passed", full_memory: "not_accepted" };
}
