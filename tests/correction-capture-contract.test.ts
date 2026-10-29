import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { before, after } from "node:test";
import { canonicalJson, objectVersion, bytesVersion } from "../src/canghai/content-version.js";
import { createCheckpointObservation, checkpointHostObservationTag, CHECKPOINT_OBSERVATION_PREFIX } from "../src/openclaw/checkpoint-observation.js";

const { validateCorrectionCaptureFixture: validate } = await import(new URL("../../scripts/lib/correction-capture-contract.mjs", import.meta.url).href);
const { verifyReusedConsumerIdentity } = await import(new URL("../../scripts/lib/reused-consumer-identity.mjs", import.meta.url).href);
const { sha256, treeManifest, sourceIdentity } = await import(new URL("../../scripts/lib/package-evidence.mjs", import.meta.url).href);
const oldProfile = await import(new URL("../../scripts/lib/installed-correction-profile.mjs", import.meta.url).href);
const artifact = { canonicalJson, objectVersion, checkpointHostObservationTag }, exec = promisify(execFile);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const put = async (file: string, value: unknown) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
let root: string, installed: any;
const previousDiagnostics = process.env.OPENCLAW_DIAGNOSTICS;
before(async () => {
  delete process.env.OPENCLAW_DIAGNOSTICS;
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-capture-identity-")));
  const sourceRoot = path.join(root, "source"), consumerRoot = path.join(root, "consumer"), hostRoot = path.join(root, "sdk");
  const packageRoot = path.join(consumerRoot, "node_modules/@tower1229/stella-core"), sdkEntry = path.join(hostRoot, "entry.js");
  const metadata = { name: "@tower1229/stella-core", version: "0.1.0-alpha.0", type: "module", main: "./dist/src/plugin.js", dependencies: {},
    devDependencies: { openclaw: "2026.10.8" }, openclaw: { build: { openclawVersion: "2026.10.8", pluginSdkVersion: "2026.10.8" } } };
  await put(path.join(sourceRoot, "package.json"), metadata);
  await put(path.join(sourceRoot, "package-lock.json"), { packages: { "": metadata, "node_modules/openclaw": { version: "2026.10.8" } } });
  const git = (...args: string[]) => exec("git", args, { cwd: sourceRoot,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  await git("init", "--quiet"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic capture identity");
  const source = await sourceIdentity(sourceRoot);
  await put(path.join(packageRoot, "package.json"), metadata);
  await put(path.join(packageRoot, "dist/build-identity.json"), { coreRevision: source.coreRevision, sourceClean: true });
  await mkdir(path.join(packageRoot, "dist/src")); await writeFile(path.join(packageRoot, "dist/src/plugin.js"), "throw Error('NO_INSTALLED_PRODUCT_IMPORT');");
  await put(path.join(consumerRoot, "package.json"), { private: true, type: "module" });
  await put(path.join(hostRoot, "package.json"), { name: "openclaw", version: "2026.10.8", exports: { "./plugin-sdk/plugin-entry": "./entry.js" } });
  await writeFile(sdkEntry, "throw Error('NO_INSTALLED_SDK_IMPORT');"); await symlink(hostRoot, path.join(consumerRoot, "node_modules/openclaw"), "dir");
  const artifactPath = path.join(root, "opaque-artifact.tgz"); await writeFile(artifactPath, "SYNTHETIC_OPAQUE_ARTIFACT");
  installed = await verifyReusedConsumerIdentity({ sourceRoot, consumerRoot, hostRoot, artifactPath }, { coreRevision: source.coreRevision,
    sourceManifestSha256: source.digest, sourceLockSha256: sha256(await readFile(path.join(sourceRoot, "package-lock.json"))),
    artifactSha256: sha256(await readFile(artifactPath)), coreManifestSha256: (await treeManifest(packageRoot)).digest,
    hostPackageSha256: sha256(await readFile(path.join(hostRoot, "package.json"))), sdkEntrySha256: sha256(await readFile(sdkEntry)), dependencyManifests: {} });
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (previousDiagnostics === undefined) delete process.env.OPENCLAW_DIAGNOSTICS; else process.env.OPENCLAW_DIAGNOSTICS = previousDiagnostics;
});

function fixture(): any {
  const rows: any[] = [], observer = createCheckpointObservation({ config: { diagnostics: { flags: ["stella.core.observe"] } },
    logger: { info() {}, warn() {}, error() {}, debug(line: string) { rows.push(JSON.parse(line.slice(CHECKPOINT_OBSERVATION_PREFIX.length))); } } });
  const work = { schemaVersion: "stella.ongoing-work/v1", id: "synthetic-work", goal: "SYNTHETIC_CORRECTED_BODY", openQuestions: ["synthetic unresolved"], candidateIdeas: ["synthetic candidate"] };
  const target = { id: work.id, version: objectVersion(work) }, changeRef = { id: "synthetic-change", version: "sha256:" + "c".repeat(64) };
  const receipt = { operationId: "synthetic-operation", disposition: "update", clarification: null, changeRef, persistenceStatus: "local_committed" };
  const requests: any[] = [], lifecycle: any[] = [], gatewayInstanceId = "controller-owned-gateway";
  for (let index = 0; index < 2; index++) {
    const runId = `host-run-${index + 1}`, toolCallId = `host-call-${index + 1}`, toolName = index === 0 ? "stella_memory_correct" : "stella_memory_data";
    const context = { agentId: "synthetic-agent", sessionId: "host-session", sessionKey: "agent:synthetic:main", requesterSenderId: "host-owner", senderIsOwner: true };
    const signal = new AbortController().signal, factoryLabel = observer.factory(toolName, context);
    observer.hook(toolName, { agentId: context.agentId, sessionId: context.sessionId, sessionKey: context.sessionKey,
      runId, toolCallId, requester: { senderId: context.requesterSenderId, senderIsOwner: true }, abortSignal: signal });
    observer.execute(toolName, factoryLabel, toolCallId, signal);
    // A pure observer fixture, not an actual Core grant mutation or Host call.
    observer.retired(runId, { grants: 1, toolPermits: 0, wasActive: true, grantRemoved: true }, () => ({ grants: 0, activeGrants: 0, preparations: 0, toolPermits: 0 }));
    const checkpoint = { source: "disk.checkpoint", revision: (index === 0 ? "2" : "3").repeat(40), token: `checkpoint-${index + 1}` };
    const document = { target: { group: "works", ref: target }, text: canonicalJson(work) };
    const details = index === 0 ? { correction: receipt, status: "readback_verified", readback: { status: "verified", documents: [document] },
      currentMemory: { userRequest: runId, checkpointRevision: checkpoint.revision, checkpointToken: checkpoint.token } }
      : { works: [{ ref: target, record: work }], currentMemory: { userRequest: runId, checkpointRevision: checkpoint.revision, checkpointToken: checkpoint.token } };
    const requestHash = bytesVersion(`synthetic input ${index}`);
    requests.push({ ack: { source: "gateway.agent_ack", runId }, input: { source: "controller.synthetic_input", requestHash },
      grant: { source: "disk.source_grant", sha256: "d".repeat(64) },
      archive: { source: "disk.owner_archive", runId, requestHash, revision: index === 0 ? "1".repeat(40) : checkpoint.revision,
        ownerEvidenceRef: { id: `synthetic-input-${index}`, version: "sha256:" + String(index + 1).repeat(64) } },
      beforeTool: { source: "host.before_tool_call", runId, toolCallId, toolName, agentId: context.agentId, sessionId: context.sessionId, sessionKey: context.sessionKey,
        requester: { senderId: context.requesterSenderId, senderIsOwner: true }, params: index === 0 ? {} : { action: "work" }, abortSignalPresent: true, aborted: false },
      afterTool: { source: "host.after_tool_call", runId, toolCallId, toolName, result: { content: [{ type: "text", text: canonicalJson(details) }], details } },
      agentEnd: { source: "host.agent_end", runId, success: true }, checkpoint,
      sourceAccess: { source: "stub.source_access_request", requestHash },
      disk: index === 0 ? { source: "disk.correction_readback", revision: checkpoint.revision,
        change: { operationId: receipt.operationId, changeRef, targetRefs: [target] }, document }
        : { source: "disk.next_request_readback", revision: checkpoint.revision, ref: target, record: work },
      counters: { source: "controller.disk_and_stub_counts", archiveCommits: index + 1, correctionCommits: 1, correctionInferenceCalls: 1 } });
    lifecycle.push({ source: "controller.submit", request: index + 1, gatewayInstanceId },
      { source: "controller.retirement_observed", runId, observerId: rows[0].observerId, coreSequence: rows.at(-1).sequence });
  }
  return { schemaVersion: "stella.correction-capture-contract/v1", evidenceKind: "offline_capture_contract_fixture",
    binding: { installationManifestSha256: installed.installationManifestSha256, observerId: rows[0].observerId, gatewayInstanceId, directHostLoad: true, observerWrapper: false },
    execution: { source: "controller.execution", cancelled: false, exitCode: 0, signal: null }, requests, coreObservations: rows, lifecycle };
}
const run = (capture: any, identity = installed, functions = artifact) => validate(JSON.stringify(capture), JSON.stringify(identity), functions);
const payload = (capture: any, index = 0) => { const value = capture.requests[index].afterTool.result; value.content = [{ type: "text", text: canonicalJson(value.details) }]; };

test("capture associations consume the first verifier result and actual observer shape, with every gate false", () => {
  const f = fixture(), before = JSON.stringify(f), result = run(f);
  assert.equal(result.evidenceConsistency, "validated_capture_contract"); assert.equal(result.installationManifestSha256, installed.installationManifestSha256);
  assert.equal(result.associations.length, 2); assert.equal(result.factoryFactsSource, "core.factory via execute.factoryLabel");
  assert.equal(result.executeRunSource, "host.before_tool_call via actual callId");
  for (const name of ["cliVerified", "hostExecutionAccepted", "profileAccepted", "formalConsumerAccepted", "fullMemoryAccepted", "realModelAccepted"]) assert.equal(result[name], false);
  assert.equal(JSON.stringify(f), before); assert.ok(!JSON.stringify(result).includes("SYNTHETIC_CORRECTED_BODY"));
  assert.ok(!JSON.stringify(result).includes("host-owner")); assert.ok(!JSON.stringify(result).includes("host-session"));
  f.lifecycle.push({ source: "controller.shutdown_started", gatewayInstanceId: f.binding.gatewayInstanceId }); assert.equal(run(f).profileAccepted, false);
});

test("installation facts must remain separately bound, not replaced by a capture or source-lock digest", async t => {
  for (const kind of ["capture digest", "manifest mutation", "source lock substituted", "invented consumer lock", "self-claimed acceptance", "missing identity", "wrapper"] as const)
    await t.test(kind, () => {
      const f = copy(fixture()), identity = copy(installed);
      if (kind === "capture digest") f.binding.installationManifestSha256 = "a".repeat(64);
      else if (kind === "manifest mutation") identity.installationManifest.coreRevision = "a".repeat(40);
      else if (kind === "source lock substituted") f.binding.installationManifestSha256 = identity.installationManifest.sourceLockSha256;
      else if (kind === "invented consumer lock") identity.consumerLock = identity.installationManifest.sourceLockSha256;
      else if (kind === "self-claimed acceptance") identity.hostExecutionAccepted = true;
      else if (kind === "missing identity") delete identity.installationManifest;
      else f.binding.observerWrapper = true;
      assert.throws(() => run(f, identity));
    });
});

test("missing or cross-source Host facts never borrow factory identity or inferred run ids", async t => {
  const cases: Array<[string, (f: any) => void]> = [
    ["missing requester", f => { delete f.requests[0].beforeTool.requester; }], ["not owner", f => { f.requests[0].beforeTool.requester.senderIsOwner = false; }],
    ["missing run", f => { delete f.requests[0].beforeTool.runId; }], ["ack wrong run", f => { f.requests[0].ack.runId = "other"; }],
    ["cross call", f => { f.requests[1].beforeTool.toolCallId = f.requests[0].beforeTool.toolCallId; }],
    ["different session", f => { f.requests[1].beforeTool.sessionId = "other"; }], ["different owner", f => { f.requests[1].beforeTool.requester.senderId = "other"; }],
    ["missing abort", f => { delete f.requests[0].beforeTool.abortSignalPresent; }], ["aborted", f => { f.requests[0].beforeTool.aborted = true; }],
    ["injected params", f => { f.requests[0].beforeTool.params = { authority: "forged" }; }],
    ["after wrong run", f => { f.requests[0].afterTool.runId = "other"; }], ["after wrong call", f => { f.requests[0].afterTool.toolCallId = "other"; }],
    ["raw source renamed", f => { f.requests[0].beforeTool.source = "factory"; }], ["payload changed", f => { f.requests[0].afterTool.result.content[0].text = "other"; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => { const f = copy(fixture()); change(f); assert.throws(() => run(f)); });
});

test("nonce, sequence, exact source shape and one-to-one call associations reject ambiguity", async t => {
  const cases: Array<[string, (f: any) => void]> = [
    ["other observer", f => { f.coreObservations[1].observerId = "other"; }], ["wrong nonce", f => { f.binding.observerId = "other"; }],
    ["wrong run tag", f => { f.coreObservations[1].runTag = "a".repeat(64); }], ["wrong call domain", f => { f.coreObservations[2].callTag = f.coreObservations[1].runTag; }],
    ["duplicate sequence", f => { f.coreObservations[1].sequence = 1; }], ["missing row", f => { f.coreObservations.splice(1, 1); }],
    ["duplicate factory", f => { f.coreObservations[4].factoryLabel = f.coreObservations[0].factoryLabel; }],
    ["invented factory run", f => { f.coreObservations[0].runId = "host-run-1"; }], ["invented execute owner", f => { f.coreObservations[2].senderIsOwner = true; }],
    ["missing factory tag", f => { f.coreObservations[0].requesterTag = null; }], ["different hook tag", f => { f.coreObservations[1].sessionTag = "a".repeat(64); }],
    ["paired second principal", f => { f.coreObservations[4].requesterTag = f.coreObservations[5].requesterTag = "a".repeat(64); }],
    ["opaque aborted", f => { f.coreObservations[2].aborted = { privateBody: "synthetic" }; }],
    ["ambiguous execute", f => { const row = copy(f.coreObservations[2]); row.sequence = f.coreObservations.length + 1; f.coreObservations.push(row); }],
    ["cross run alias", f => { f.requests[1].ack.runId = f.requests[0].ack.runId; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => { const f = copy(fixture()); change(f); assert.throws(() => run(f)); });
});

test("cancellation, wait-only or shutdown cannot substitute for the real Core retirement observation", async t => {
  const cases: Array<[string, (f: any) => void]> = [
    ["cancel exit0", f => { f.execution.cancelled = true; }], ["signal", f => { f.execution.signal = "SIGTERM"; }], ["exit failure", f => { f.execution.exitCode = 1; }],
    ["failed agent end", f => { f.requests[0].agentEnd.success = false; }], ["wrong end run", f => { f.requests[0].agentEnd.runId = "other"; }],
    ["old marker source", f => { f.coreObservations[3].source = "request-retired"; }], ["wrong count scope", f => { f.coreObservations[3].countScope = "gateway"; }],
    ["active grant left", f => { f.coreObservations[3].after.activeGrants = 1; }], ["pending preparation", f => { f.coreObservations[3].after.preparations = 1; }],
    ["not active before", f => { f.coreObservations[3].before.wasActive = false; }],
    ["wait as retirement", f => { f.lifecycle[1].source = "agent.wait"; }], ["wrong retirement row", f => { f.lifecycle[1].coreSequence = 8; }],
    ["next submit too early", f => { [f.lifecycle[1], f.lifecycle[2]] = [f.lifecycle[2], f.lifecycle[1]]; }],
    ["shutdown before retirement", f => { f.lifecycle.splice(1, 0, { source: "controller.shutdown_started", gatewayInstanceId: f.binding.gatewayInstanceId }); }],
    ["shutdown between requests", f => { f.lifecycle.splice(2, 0, { source: "controller.shutdown_started", gatewayInstanceId: f.binding.gatewayInstanceId }); }],
    ["other gateway", f => { f.lifecycle[2].gatewayInstanceId = "another process"; }], ["missing final retirement", f => { f.lifecycle.pop(); }],
  ];
  for (const [name, change] of cases) await t.test(name, () => { const f = copy(fixture()); change(f); assert.throws(() => run(f)); });
});

test("C1 second request hooks must follow prior retirement while factories may be precreated", async t => {
  const reorder = (order: number[]) => {
    const f = copy(fixture()), original = f.coreObservations;
    f.coreObservations = order.map((index, offset) => ({ ...original[index], sequence: offset + 1 }));
    for (let index = 0; index < 2; index++) {
      const tag = checkpointHostObservationTag(f.binding.observerId, "run", f.requests[index].ack.runId);
      f.lifecycle[index * 2 + 1].coreSequence = f.coreObservations.find((row: any) => row.source === "retirement" && row.runTag === tag).sequence;
    }
    return f;
  };
  const cases: Array<[string, number[], number[]]> = [
    ["hook and execute before retirement", [0, 1, 2, 4, 5, 6, 3, 7], [5, 6, 7]],
    ["entire second block before first", [4, 5, 6, 7, 0, 1, 2, 3], [2, 3, 8]],
    ["hook before retirement but execute after", [0, 1, 2, 5, 3, 4, 6, 7], [4, 7, 5]],
  ];
  for (const [name, order, expected] of cases) await t.test(`C1 ${name}`, () => {
    const f = reorder(order), callTag = checkpointHostObservationTag(f.binding.observerId, "call", f.requests[1].beforeTool.toolCallId);
    assert.deepEqual([f.coreObservations.find((row: any) => row.source === "before_tool_call" && row.callTag === callTag).sequence,
      f.coreObservations.find((row: any) => row.source === "execute" && row.callTag === callTag).sequence, f.lifecycle[1].coreSequence], expected);
    assert.throws(() => run(f), /next_hook_before_previous_retirement/);
  });
  await t.test("C1 future memory factory may be created before first retirement", () => {
    const f = reorder([0, 4, 1, 2, 3, 5, 6, 7]);
    const factory = f.coreObservations.find((row: any) => row.source === "factory" && row.tool === "stella_memory_data");
    assert.ok(factory.sequence < f.lifecycle[1].coreSequence);
    assert.equal(run(f).evidenceConsistency, "validated_capture_contract"); assert.equal(run(f).hostExecutionAccepted, false);
  });
});

test("receipt, exact readback and next-request freshness remain separate from historical outputs", async t => {
  const cases: Array<[string, (f: any) => void]> = [
    ["not committed", f => { f.requests[0].afterTool.result.details.correction.persistenceStatus = "failed"; payload(f); }],
    ["readback failed", f => { f.requests[0].afterTool.result.details.status = "readback_failed"; payload(f); }],
    ["documents object", f => { const v = f.requests[0].afterTool.result.details.readback.documents; f.requests[0].afterTool.result.details.readback.documents = { 0: v[0], length: 1 }; payload(f); }],
    ["wrong object", f => { f.requests[0].afterTool.result.details.readback.documents[0].text = canonicalJson({ id: "other" }); payload(f); }],
    ["wrong change target", f => { f.requests[0].disk.change.targetRefs = []; }], ["wrong disk revision", f => { f.requests[0].disk.revision = "f".repeat(40); }],
    ["old userRequest", f => { f.requests[1].afterTool.result.details.currentMemory.userRequest = "host-run-1"; payload(f, 1); }],
    ["old checkpoint", f => { f.requests[1].checkpoint = copy(f.requests[0].checkpoint); }],
    ["old permission judgment", f => { f.requests[1].sourceAccess.requestHash = f.requests[0].input.requestHash; }],
    ["repeated correction", f => { f.requests[1].counters.correctionCommits = 2; }], ["reinferred", f => { f.requests[1].counters.correctionInferenceCalls++; }],
    ["new object version", f => { f.requests[1].afterTool.result.details.works[0].ref.version = "sha256:" + "e".repeat(64); payload(f, 1); }],
    ["wrong archive input", f => { f.requests[1].archive.requestHash = f.requests[0].input.requestHash; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => { const f = copy(fixture()); change(f); assert.throws(() => run(f)); });
});

test("new synthetic contract rejects host relabels and leaves the old offline profile closed", () => {
  const f = fixture(); f.evidenceKind = "host_capture"; assert.throws(() => run(f), /offline_contract_only/);
  f.evidenceKind = "offline_capture_contract_fixture"; f.hostExecutionAccepted = true; assert.throws(() => run(f), /capture_shape/);
  assert.throws(() => validate({}, JSON.stringify(installed), artifact), /bounded_json_required/);
  assert.throws(() => validate(" ".repeat(1024 * 1024 + 1), JSON.stringify(installed), artifact), /bounded_json_required/);
  assert.throws(() => run(fixture(), installed, {} as any), /artifact_functions_required/);
  assert.equal(oldProfile.INSTALLED_CORRECTION_PROFILE.executionConnected, false);
  assert.throws(() => oldProfile.validateInstalledCorrectionReport({ schemaVersion: oldProfile.INSTALLED_CORRECTION_PROFILE.reportSchema,
    profileId: oldProfile.INSTALLED_CORRECTION_PROFILE.id, evidenceKind: "host_capture", profileAccepted: false, hostExecutionAccepted: false,
    experimentalOwnerChatAccepted: false, fullMemoryAccepted: false, realModelAccepted: false, privateMainAccepted: false,
    formalConsumerAccepted: false, issue23Complete: false }, {}, artifact), /host_capture_not_connected/);
});
