import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const evidence = await import(new URL("../../scripts/lib/experimental-owner-chat-evidence.mjs", import.meta.url).href);
const context = { packageRoot: "/synthetic/consumer/node_modules/@tower1229/stella-core", hostRoot: "/synthetic/consumer/node_modules/openclaw" };
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const bootstrapTargets = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];

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
      skillConsumption: { bootstrapSources, skillSource, wireProofs } }, budgetFile: budget("file"), budgetTotal: budget("total") };
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
