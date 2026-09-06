import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogReader, parseMemoryCatalog, selectTextEvidence, type CatalogGroup, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver, type EvidencePurpose } from "../src/praxis/episode-evidence.js";
import type { EpisodeV2, VersionedRef } from "../src/praxis/episode-v2.js";
import { EpisodeRepository } from "../src/praxis/episode-repository.js";

const now = "2026-09-06T00:00:00Z";
const purpose: EvidencePurpose = { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "gemini-evaluation", evidenceCutoff: now,
  trustedAdapters: { user_report: ["synthetic-host"], tool_observation: ["synthetic-tool"], system_event: ["synthetic-system"] } };
const emptyCatalog = (): MemoryCatalog => ({ schemaVersion: "stella.memory-catalog/v1", generationId: "generation-synthetic", parentGenerationId: null,
  sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] });
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { role?: string; kind?: string; authoredAt?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-original-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = emptyCatalog();
  const put = async (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[] = []) => {
    const version = objectVersion(object);
    const file = `${String(object.id)}.json`;
    const body = `${JSON.stringify({ ...object, version }, null, 2)}\n`;
    await writeFile(path.join(root, file), body);
    const ref = { id: String(object.id), version };
    catalog[group].push({ ...ref, locator: { path: file, sha256: bytesVersion(body) }, status: "current", dependencies });
    return ref;
  };
  const policy = await put("policies", { schemaVersion: "stella.source-policy/v1", id: "policy-synthetic", ownerId: "owner-synthetic",
    readPurposes: ["alpha"], derivePurposes: ["alpha"], deliveryScopes: ["gemini-evaluation"], retention: "retain", authorityEvidenceRefs: [] });
  const coverage = await put("coverage", { schemaVersion: "stella.archive-coverage/v1", id: "coverage-synthetic",
    adapterId: "synthetic-host", collectionId: "synthetic-session", upstreamSnapshot: "synthetic-snapshot",
    scope: { agentIds: ["synthetic-agent"], roots: [], branchPolicy: "declared_subset", declaredBranches: ["synthetic-branch"] },
    fromCursor: null, toCursor: "synthetic-message", expectedCount: 1, retainedCount: 1, excludedByPolicyCount: 0,
    missingItems: [], checkedAt: now, completeForDeclaredScope: true });
  const payload = Buffer.from(JSON.stringify({ report: "我已经询问了时间，对方确认周末有空。", assistant: "The model imagines a different action." }), "utf8");
  await writeFile(path.join(root, "original.json"), payload);
  const source = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "source-synthetic",
    origin: { adapterId: "synthetic-host", collectionId: "synthetic-session", upstreamId: "synthetic-message" },
    payloads: [{ path: "original.json", mediaType: "application/json", bytes: payload.length, sha256: bytesVersion(payload) }],
    capturedAt: now, policyRef: policy, coverageRef: coverage }, [policy, coverage]);
  const evidence = await put("evidence", { schemaVersion: "stella.memory-evidence/v1", id: "evidence-synthetic", source,
    payloadSha256: bytesVersion(payload), selector: { kind: "json_pointer", value: "/report" },
    speakerId: "owner-synthetic", role: options.role ?? "owner", kind: options.kind ?? "reported", occurredAt: null,
    authoredAt: options.authoredAt ?? now, capturedAt: now, independentOriginId: "event-synthetic", derivedFrom: [], policyRef: policy }, [source, policy]);
  const save = () => writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  await save();
  const actual: NonNullable<EpisodeV2["actual"]> = { action: "询问了时间", occurredAt: null, recordedAt: now, source: "user_report", evidenceRefs: [evidence] };
  return { root, catalog, save, put, source, evidence, actual };
}
const verdict = (actual: NonNullable<EpisodeV2["actual"]>, supported = true) => ({ text: JSON.stringify({
  supported, action: actual.action, occurredAt: actual.occurredAt, source: actual.source, evidenceRefs: actual.evidenceRefs, rationale: "Synthetic semantic verdict" }) });

test("evidence resolver rereads a genuine selected source span before semantic verification", async (t) => {
  const { root, actual } = await fixture(t);
  let calls = 0;
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async ({ prompt }) => {
    calls++;
    assert.match(prompt, /我已经询问了时间/);
    assert.doesNotMatch(prompt, /model imagines a different action/);
    return verdict(actual);
  });
  assert.equal(await resolver.verifyActionEvidence(actual), true);
  assert.equal(calls, 1);
});

test("source labels cannot turn assistant or inferred content into an actual action", async (t) => {
  for (const options of [{ role: "assistant" }, { kind: "inference" }]) {
    const { root, actual } = await fixture(t, options);
    const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => { throw new Error("Must not call model"); });
    await assert.rejects(resolver.verifyActionEvidence(actual), /unsupported_actual_evidence/);
  }
});

test("semantic ambiguity remains unsupported and invented evidence refs fail", async (t) => {
  const { root, actual } = await fixture(t);
  const reader = await CatalogReader.load(root, "catalog.json");
  assert.equal(await new EpisodeEvidenceResolver(reader, purpose, async () => verdict(actual, false)).verifyActionEvidence(actual), false);
  await assert.rejects(new EpisodeEvidenceResolver(reader, purpose, async () => verdict({ ...actual, evidenceRefs: [{ id: "invented", version: actual.evidenceRefs[0]!.version }] })).verifyActionEvidence(actual), /invalid_action_verdict/);
});

test("future evidence and unauthorized delivery are rejected before model access", async (t) => {
  const { root, actual } = await fixture(t, { authoredAt: "2026-09-07T00:00:00Z" });
  const reader = await CatalogReader.load(root, "catalog.json");
  const never = async () => { throw new Error("Must not call model"); };
  await assert.rejects(new EpisodeEvidenceResolver(reader, purpose, never).verifyActionEvidence(actual), /evidence_after_cutoff/);
  await assert.rejects(new EpisodeEvidenceResolver(reader, { ...purpose, deliveryScope: "unauthorized" }, never).verifyActionEvidence(actual), /permission_denied/);
});

test("deleted source blocks original text and dependent evidence without fetching history", async (t) => {
  const { root, source, evidence, catalog, save } = await fixture(t);
  catalog.sources[0]!.status = "removed";
  await save();
  const reader = await CatalogReader.load(root, "catalog.json");
  assert.equal(reader.eligible(evidence), false);
  await assert.rejects(reader.read(source, "sources", "historical"), /source_removed/);
  await assert.rejects(reader.read(evidence, "evidence"), /evidence_not_currently_eligible/);
});

test("catalog and source mutation during model judgment revoke write eligibility", async (t) => {
  const first = await fixture(t);
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(first.root, "catalog.json"), purpose, async () => {
    await writeFile(path.join(first.root, "original.json"), "Changed original");
    return verdict(first.actual);
  });
  await assert.rejects(resolver.verifyActionEvidence(first.actual), /payload_digest_mismatch/);
  const second = await fixture(t);
  const changed = new EpisodeEvidenceResolver(await CatalogReader.load(second.root, "catalog.json"), purpose, async () => {
    second.catalog.generationId = "another-generation";
    await second.save();
    return verdict(second.actual);
  });
  await assert.rejects(changed.verifyActionEvidence(second.actual), /stale_generation/);
});

test("reference versions and locator byte hashes are verified independently", async (t) => {
  const { root, catalog, evidence, save } = await fixture(t);
  const file = path.join(root, catalog.evidence[0]!.locator.path);
  const object = JSON.parse(await readFile(file, "utf8"));
  object.role = "assistant";
  const changed = JSON.stringify(object);
  await writeFile(file, changed);
  catalog.evidence[0]!.locator.sha256 = bytesVersion(changed);
  await save();
  const reader = await CatalogReader.load(root, "catalog.json");
  await assert.rejects(reader.read(evidence), /object_version_mismatch/);
});

test("canonical versions ignore source location but retain payload content and semantic dependencies", () => {
  const source = { schemaVersion: "stella.memory-source/v1", id: "source", payloads: [{ path: "old.txt", revision: "a".repeat(40), sha256: bytesVersion("content"), mediaType: "text/plain", bytes: 7 }] };
  assert.equal(objectVersion(source), objectVersion({ ...source, version: "ignored", payloads: [{ ...source.payloads[0], path: "new.txt", revision: "b".repeat(40) }] }));
  assert.notEqual(objectVersion(source), objectVersion({ ...source, payloads: [{ ...source.payloads[0], sha256: bytesVersion("changed") }] }));
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), '{"a":[2,3],"b":1}');
  assert.throws(() => canonicalJson({ value: Infinity }));
  assert.throws(() => canonicalJson(new Array(2)));
});

test("selectors enforce UTF-8 boundaries, JSON pointer escapes and real nodes", () => {
  const bytes = Buffer.from("甲乙");
  assert.equal(selectTextEvidence(bytes, { kind: "utf8_bytes", value: "0:3" }), "甲");
  assert.throws(() => selectTextEvidence(bytes, { kind: "utf8_bytes", value: "1:3" }), /invalid_utf8/);
  assert.throws(() => selectTextEvidence(bytes, { kind: "utf8_bytes", value: "0:7" }), /invalid_selector/);
  const json = Buffer.from(JSON.stringify({ "a/b": { "~": ["真实片段"] } }));
  assert.equal(selectTextEvidence(json, { kind: "json_pointer", value: "/a~1b/~0/0" }), "真实片段");
  assert.throws(() => selectTextEvidence(json, { kind: "json_pointer", value: "/a~1b/~0/00" }), /invalid_selector/);
  assert.throws(() => selectTextEvidence(json, { kind: "json_pointer", value: "/missing" }), /selector_unavailable/);
});

test("catalog rejects duplicate current identities and missing collections", async (t) => {
  const { catalog } = await fixture(t);
  assert.throws(() => parseMemoryCatalog({ ...catalog, coverage: undefined }), /invalid_catalog/);
  assert.throws(() => parseMemoryCatalog({ ...catalog, sources: [...catalog.sources, { ...catalog.sources[0]!, version: bytesVersion("other") }] }), /ambiguous_current_version/);
});

test("real evidence resolver gates the v2 write and persists only a supported closure", async (t) => {
  const { root, actual, evidence } = await fixture(t);
  let supported = false;
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => verdict(actual, supported));
  const repository = new EpisodeRepository(root, "episodes", {
    resolveHistorical: (ref) => resolver.resolveHistorical(ref), resolveEvidence: (ref) => resolver.resolveEvidence(ref),
    resolveLearning: (ref) => resolver.resolveLearning(ref), verifyActionEvidence: (claim) => resolver.verifyActionEvidence(claim),
    isCurrentlyEligible: (episode) => resolver.isCurrentlyEligible(episode), async persist() {},
  });
  const open: EpisodeV2 = { schemaVersion: "stella.praxis-episode/v2", id: "praxis-evidence-bound", status: "open",
    createdAt: now, updatedAt: now, recoveryPriority: "important", historicalInputRefs: [evidence], provenance: {},
    situation: { summary: "Synthetic social decision", domains: ["social"], observations: [] } };
  const opened = await repository.apply({ operationId: "op-open", expectedVersion: null, episode: open });
  const recommended: EpisodeV2 = { ...open, status: "recommended", decision: { recommendation: "Synthetic earlier advice", rationale: [] } };
  const advised = await repository.apply({ operationId: "op-advice", expectedVersion: opened.version, episode: recommended });
  const closed: EpisodeV2 = { ...recommended, status: "closed", actual,
    outcome: { result: "Synthetic reported response", observations: [], observedAt: now, evidenceRefs: [evidence] },
    learning: { algorithmVersion: "synthetic-test", predictionAssessment: "unresolved", evidenceRefs: [evidence], twin: [], praxis: [] } };
  const operation = { operationId: "op-close", expectedVersion: advised.version, episode: closed };
  await assert.rejects(repository.apply(operation), /unsupported_actual_action/);
  assert.equal((await repository.read(open.id)).episode.status, "recommended");
  supported = true;
  assert.equal((await repository.apply(operation)).episode.status, "closed");
  assert.equal((await repository.read(open.id)).episode.actual?.occurredAt, null);
});

test("learning resolves a scoped strategy and its exact supported LearningChange", async (t) => {
  const { root, evidence, put, save } = await fixture(t);
  const strategy = await put("understandings", { schemaVersion: "stella.understanding/v1", id: "strategy-synthetic",
    statement: "Synthetic context-scoped strategy", kind: "strategy", status: "active",
    scope: { workIds: [], contexts: ["synthetic-context"], domains: ["social"], global: false },
    supportRefs: [evidence], counterRefs: [], dependencyRefs: [evidence], originChangeId: "change-synthetic", createdAt: now, updatedAt: now }, [evidence]);
  await put("changes", { schemaVersion: "stella.learning-change/v1", id: "change-synthetic", operationId: "op-learning",
    algorithmVersion: "synthetic-learning-v2", modelRef: "synthetic-model", promptVersion: "synthetic-prompt-v2",
    inputRefs: [evidence], targetRefs: [strategy], changes: [{ kind: "create", before: null, after: strategy, supportRefs: [evidence], counterRefs: [] }],
    disposition: "update", rationale: "Synthetic evidence supports this scoped strategy" }, [evidence, strategy]);
  await save();
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), purpose, async () => ({ text: "unused" }));
  await resolver.resolveLearning(strategy);
  await assert.rejects(resolver.resolveLearning(evidence), /reference_unavailable/);
});
