import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const evidence = await import(new URL("../../scripts/lib/experimental-owner-chat-evidence.mjs", import.meta.url).href);
const context = { packageRoot: "/synthetic/consumer/node_modules/@tower1229/stella-core", hostRoot: "/synthetic/consumer/node_modules/openclaw" };
function valid() {
  const common = { passed: true, hostIdentity: { root: context.hostRoot, version: "2026.8.2", fullTreeVerified: false },
    gateway: { exitCode: 0, signalCode: null }, installation: { packageRoot: context.packageRoot, directHostLoad: true, observerWrapper: false } };
  const authority = { revision: "a".repeat(40), token: "synthetic" };
  const status = { mode: "experimental_owner_chat", authority, ingress: { state: "local_committed" }, capabilities: { full_memory: false } };
  const rounds = Array.from({ length: 3 }, () => ({ terminal: { status: "ok" }, status, history: { sessionId: "same-synthetic-session" } }));
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
        staleExpectedRefused: true, authorityUnchangedAfterConflict: true, producerCandidateSeparateFromConsumerCommit: true, grantPredeclaredInFixture: true } } };
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
