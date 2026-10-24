import assert from "node:assert/strict";

export const EXPERIMENTAL_SCOPE = "experimental_owner_chat";
export const NON_ACCEPTANCE = Object.freeze({ fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false });

// These are public installed-Host observations, not a legacy code-identity receipt.
export function assertExperimentalReports(reports, { packageRoot, hostRoot }) {
  assert.deepEqual(Object.keys(reports).sort(), ["continuous", "snapshotImport", "v3"]);
  for (const report of Object.values(reports)) {
    assert.equal(report.passed, true); assert.equal(report.error, undefined);
    for (const key of Object.keys(NON_ACCEPTANCE)) if (Object.hasOwn(report, key)) assert.equal(report[key], false, `Unexpected product acceptance: ${key}`);
    assert.equal(report.installation?.packageRoot ?? report.installation?.root, packageRoot);
    assert.equal(report.installation?.directHostLoad, true); assert.equal(report.installation?.observerWrapper, false);
    assert.equal(report.hostIdentity?.root, hostRoot); assert.equal(report.hostIdentity?.version, "2026.8.2");
    assert.equal(report.hostIdentity?.fullTreeVerified, false);
    assert.equal(report.gateway?.exitCode, 0); assert.equal(report.gateway?.signalCode, null);
  }
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
    v3PaginationAndPolicy: "passed", explicitSnapshotImport: "passed", unauthorizedAudience: "passed", full_memory: "not_accepted" };
}
