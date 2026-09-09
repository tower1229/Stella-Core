import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliveryLedger, type DeliveryEvidence, type DeliveryVersion } from "../src/acceptance/delivery-ledger.js";

const version: DeliveryVersion = { core: "1".repeat(40), artifact: "2".repeat(64), host: "3".repeat(64), harness: "4".repeat(64),
  source: "5".repeat(64), profile: "6".repeat(64), policy: "7".repeat(64), configuration: "8".repeat(64), model: "9".repeat(64), cases: "a".repeat(64), sourceClean: true };
const input = () => ({ version, checkedAt: "2026-09-09T04:00:00.000Z", evidence: [], preflight: null });

test("delivery report expands every work item and acceptance without claiming missing evidence passed", async () => {
  const report = await buildDeliveryLedger(input());
  assert.deepEqual(report.works.map(row => row.id), Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(2, "0")));
  assert.equal(new Set(report.acceptances.map(row => row.id)).size, 49);
  assert.equal(report.complete, false);
  assert.ok(report.works.every(row => row.status === "pending" && row.gaps.includes("evidence_missing")));
  assert.ok(report.acceptances.every(row => row.issues.length && row.cases.length && row.contract.sha256));
});

test("partial, expired, superseded, dirty and different-version evidence cannot complete delivery", async () => {
  const { createHash } = await import("node:crypto");
  const artifact = Buffer.from("synthetic public-interface test output");
  const sha = createHash("sha256").update(artifact).digest("hex");
  const evidence = { id: "b".repeat(64), target: "G-01", caseId: "spec6-G-01-synthetic_contract", environment: "synthetic_contract" as const,
    version, recordedAt: "2026-09-09T03:00:00.000Z", expiresAt: "2026-09-10T03:00:00.000Z", result: "passed" as const,
    artifactSha256: sha, supersedes: [] };
  const run = (record = evidence) => buildDeliveryLedger({ ...input(), evidence: [record], readEvidence: async () => artifact });
  const partial = await run();
  assert.equal(partial.acceptances[0]!.cases[0]!.result, "passed");
  assert.notEqual(partial.acceptances[0]!.status, "verified");
  assert.equal(partial.complete, false);
  for (const record of [{ ...evidence, expiresAt: "2026-09-09T03:30:00.000Z" },
    { ...evidence, version: { ...version, host: "f".repeat(64) } }, { ...evidence, version: { ...version, sourceClean: false } }]) {
    const result = await run(record);
    assert.equal(result.acceptances[0]!.cases[0]!.result, "not_executed");
    assert.equal(result.history.length, 1);
  }
  await assert.rejects(buildDeliveryLedger({ ...input(), evidence: [evidence], readEvidence: async () => Buffer.from("changed") }), /evidence_digest_mismatch/);
});

test("preflight separates unavailable acceptance, missing configuration and valid empty memory without exposing private fields", async () => {
  const preflight = { schemaVersion: "stella.main-readiness/v1", diagnosticOnly: true, behavioralAcceptance: "not_executed",
    capabilities: [{ id: "memory_lifecycle", required: true, placeholder: false, declaredPassed: true }],
    counts: { sources: 2, understandings: 0, works: 0 }, blockers: ["full_memory_acceptance_unavailable", "/private/user/raw-text"],
    modelRef: "private-provider/account", agentId: "private-person", sourceRevision: "private-source" };
  const report = await buildDeliveryLedger({ ...input(), preflight });
  assert.ok(report.preflight.gaps.includes("acceptance_not_implemented"));
  assert.ok(report.preflight.gaps.includes("configuration_missing"));
  assert.ok(report.preflight.collections.some(row => row.id === "works" && row.state === "valid_empty"));
  assert.equal(report.works.find(row => row.id === "19")!.status, "blocked");
  assert.equal(report.complete, false);
  assert.ok(!JSON.stringify(report).includes("private-"));
  assert.ok(!JSON.stringify(report).includes("/private/"));
});

test("contract edits cannot be silently reported as the pinned specification", async t => {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "delivery-contract-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs/contracts"), { recursive: true });
  for (const file of ["docs/10-DESIGN-BASELINE.md", "docs/04-OPENCLAW-INTEGRATION.md", "docs/contracts/MEMORY-LIFECYCLE.md"]) {
    await copyFile(file, path.join(root, file));
  }
  await writeFile(path.join(root, "docs/10-DESIGN-BASELINE.md"), "changed contract");
  await assert.rejects(buildDeliveryLedger({ ...input(), contractRoot: root }), /contract_version_mismatch/);
});

test("only complete current evidence can satisfy the ledger; feedback and historical replacements remain separate", async () => {
  const { createHash } = await import("node:crypto");
  const baseline = await buildDeliveryLedger(input());
  const artifact = Buffer.from("synthetic interface acceptance receipt");
  const sha = createHash("sha256").update(artifact).digest("hex");
  const evidence = [...baseline.works, ...baseline.acceptances].flatMap(row => row.cases.map(c => ({
    id: createHash("sha256").update(c.caseId).digest("hex"), target: row.id, caseId: c.caseId, environment: c.environment,
    version, recordedAt: "2026-09-09T03:00:00.000Z", expiresAt: "2026-09-10T03:00:00.000Z", result: "passed" as const,
    artifactSha256: sha, supersedes: [] as string[] })));
  const preflight = { schemaVersion: "stella.main-readiness/v1", diagnosticOnly: true, behavioralAcceptance: "not_executed",
    capabilities: ["memory_access", "memory_lifecycle", "source_access_context", "semantic_retrieval", "ongoing_work",
      "framework_learning", "external_research", "uniform_sampling", "weread_gateway", "public_ask_batch", "automation_delivery", "host_initialization"]
      .map(id => ({ id, required: true, placeholder: false, declaredPassed: false })),
    counts: { sources: 1, understandings: 0, works: 0 }, blockers: [] };
  const run = (records: DeliveryEvidence[] = evidence) => buildDeliveryLedger({ ...input(), preflight, evidence: records, readEvidence: async () => artifact });
  assert.equal((await run()).complete, true);
  assert.equal((await run(evidence.slice(1))).complete, false);
  const old = { ...evidence[0]!, id: "e".repeat(64), recordedAt: "2026-09-08T01:00:00.000Z", result: "failed" as const };
  const current = { ...evidence[0]!, supersedes: [old.id] };
  const replaced = await run([old, current, ...evidence.slice(1)]);
  assert.equal(replaced.complete, true);
  assert.equal(replaced.history.find(record => record.id === old.id)!.validity, "superseded");
  assert.equal(replaced.naturalFeedback.length, 0);
  await assert.rejects(run([evidence[0]!, evidence[0]!]), /duplicate_delivery_evidence/);
  assert.equal((await run([old, ...evidence])).complete, false);
  const future = { ...current, id: "f".repeat(64), recordedAt: "2026-09-09T05:00:00.000Z" };
  assert.equal((await run([old, ...evidence, future])).complete, false);
  const otherVersion = { ...current, id: "f".repeat(64), version: { ...version, host: "f".repeat(64) } };
  assert.equal((await run([old, ...evidence, otherVersion])).complete, false);
});


test("a missing memory catalog is unavailable rather than a valid empty collection", async () => {
  const report = await buildDeliveryLedger({ ...input(), preflight: { schemaVersion: "stella.main-readiness/v1", diagnosticOnly: true,
    behavioralAcceptance: "not_executed", capabilities: [], counts: { sources: 0, understandings: 0, works: 0 }, blockers: ["memory_catalog_missing"] } });
  assert.ok(report.preflight.collections.every(row => row.state === "unavailable"));
});

test("public blockers retain actionable categories and work ownership while unknown private text stays private", async () => {
  const report = await buildDeliveryLedger({ ...input(), preflight: { schemaVersion: "stella.main-readiness/v1", diagnosticOnly: true,
    behavioralAcceptance: "not_executed", capabilities: [], counts: { sources: 0, understandings: 0, works: 0 },
    blockers: ["model_route_mismatch:router", "host_initialization_not_ready", "capability_acceptance_missing:weread_gateway", "private-person/path"] } });
  assert.ok(report.preflight.diagnostics.some(item => item.category === "model_route_mismatch:router" && item.workIds.includes("32")));
  assert.ok(report.works.find(row => row.id === "27")!.gaps.includes("capability_acceptance_missing:weread_gateway"));
  assert.ok(report.works.find(row => row.id === "31")!.unblockConditions.some(value => value.includes("initialization")));
  assert.ok(!JSON.stringify(report).includes("private-person"));
});
