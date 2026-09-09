import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogReader, type CatalogGroup, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { objectVersion, canonicalJson, bytesVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";

export async function personalMemoryFixture(t: { after(fn: () => Promise<void>): void }, interpretationRules = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-personal-views-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
  const put = async (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[] = []) => {
    const ref = { id: String(object.id), version: objectVersion(object) }, file = `${ref.id}-${ref.version.slice(7)}.json`;
    const body = canonicalJson(object);
    await writeFile(path.join(root, file), body);
    catalog[group].push({ ...ref, status: "current", dependencies, locator: { path: file, sha256: bytesVersion(body) } });
    return ref;
  };
  const now = "2026-09-01T00:00:00Z";
  const policy = await put("policies", { schemaVersion: interpretationRules ? "stella.source-policy/v3" : "stella.source-policy/v1", id: "policy", ownerId: "owner",
    ...(interpretationRules ? { restrictions: { sensitivity: "private", quotePolicy: "summarize_only", allowedScenarios: ["writing"], forbiddenScenarios: [] },
      usageRules: { access: [], interpretation: [{ id: "preserve_author_intent", requirement: "Preserve the owner's unresolved question, not an uplifting ending." }] } } : {}),
    readPurposes: ["retrieve"], derivePurposes: ["answer"], deliveryScopes: ["synthetic/model"], retention: "retain", authorityEvidenceRefs: [] });
  const coverage = await put("coverage", { schemaVersion: "stella.archive-coverage/v1", id: "coverage",
    adapterId: "synthetic", collectionId: "one", upstreamSnapshot: "one",
    scope: { agentIds: ["main"], roots: [], branchPolicy: "declared_subset", declaredBranches: ["one"] },
    fromCursor: null, toCursor: "one", expectedCount: 1, retainedCount: 1, excludedByPolicyCount: 0,
    missingItems: [], checkedAt: now, completeForDeclaredScope: true });
  const payload = JSON.stringify({ report: "我希望这篇文章保留疑问，不要替我加上励志结尾。" });
  await writeFile(path.join(root, "payload.json"), payload);
  const source = await put("sources", { schemaVersion: "stella.memory-source/v1", id: "source",
    origin: { adapterId: "synthetic", collectionId: "one", upstreamId: "one" },
    payloads: [{ path: "payload.json", mediaType: "application/json", bytes: Buffer.byteLength(payload), sha256: bytesVersion(payload) }],
    capturedAt: now, policyRef: policy, coverageRef: coverage }, [policy, coverage]);
  const evidence = await put("evidence", { schemaVersion: "stella.memory-evidence/v1", id: "evidence", source,
    payloadSha256: bytesVersion(payload), selector: { kind: "json_pointer", value: "/report" },
    role: "owner", speakerId: "owner", kind: "reported", independentOriginId: "one", derivedFrom: [],
    occurredAt: null, authoredAt: now, capturedAt: now, policyRef: policy }, [source, policy]);
  const understanding = await put("understandings", { schemaVersion: "stella.understanding/v1", id: "understanding",
    kind: "owner_statement", status: "active", statement: "本篇文章保留未决问题。",
    scope: { workIds: ["work"], contexts: [], domains: ["writing"], global: false },
    supportRefs: [evidence], counterRefs: [], dependencyRefs: [], originChangeId: "change", createdAt: now, updatedAt: now }, [evidence]);
  await put("changes", { schemaVersion: "stella.learning-change/v1", id: "change", operationId: "change",
    algorithmVersion: "synthetic", modelRef: "synthetic/model", promptVersion: "one", inputRefs: [evidence], targetRefs: [understanding],
    changes: [{ kind: "create", before: null, after: understanding, supportRefs: [evidence], counterRefs: [] }],
    rationale: "Synthetic authored premise", disposition: "update" }, [evidence, understanding]);
  const work = { schemaVersion: "stella.ongoing-work/v1", id: "work", kind: "writing", status: "active", goal: "继续共同梳理文章",
    sourceRefs: [source], confirmedPremises: [{ id: "p", text: "保留疑问", evidenceRefs: [evidence], acceptance: "confirmed" }],
    candidateIdeas: [{ id: "c", text: "尝试开放式收束", evidenceRefs: [evidence], acceptance: "proposed" }],
    rejectedInterpretations: [{ id: "r", text: "升华为励志结尾", evidenceRefs: [evidence], acceptance: "rejected" }],
    openQuestions: [{ id: "q", question: "最后一个论证是否成立？", evidenceRefs: [evidence], material: true }],
    nextStep: null, lastAppliedChangeId: null, createdAt: now, updatedAt: now };
  const workRef = await put("works", work, [source, evidence]);
  const save = () => writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  await save();
  const resolver = () => CatalogReader.load(root, "catalog.json").then(reader => new EpisodeEvidenceResolver(reader, {
    readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "synthetic/model", evidenceCutoff: "2026-09-08T00:00:00Z",
    trustedAdapters: { user_report: ["synthetic"], tool_observation: [], system_event: [] },
    ...(interpretationRules ? { sourceAccess: async () => ({ judgment: { scenarios: ["writing"], trigger: "user_requested" as const,
      topicRequested: true, topicExplicitlyNamed: true, presentation: "summary" as const }, quoteGrants: [] }) } : {}),
  }, async () => { throw new Error("No semantic action inference"); }));
  return { root, catalog, put, save, resolver, source, evidence, understanding, work, workRef };
}
