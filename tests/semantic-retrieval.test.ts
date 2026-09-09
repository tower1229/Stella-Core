import { prepareQuestionEvidence } from "../src/praxis/question-evidence.js";
import { prepareHostRequestArchive, HOST_REQUEST_ARCHIVE_ADAPTER } from "../src/canghai/host-request-archive.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CatalogReader, parseMemoryCatalog, CatalogError } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import { retrieveCatalogEvidence, type SemanticRetrievalConfig } from "../src/canghai/semantic-retrieval.js";
import type { SourceAccessDescriptor } from "../src/canghai/source-access.js";

const config: SemanticRetrievalConfig = { schemaVersion: "stella.semantic-retrieval/v1", pageSize: 16, maxRounds: 2, maxSelected: 4, maxOriginalChars: 96000 };
test("semantic retrieval searches beyond 64 entries and follows original-driven leads without lexical ranking or silent truncation", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-retrieval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, bytes: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes); };
  const policy = { schemaVersion: "stella.source-policy/v1", id: "policy", ownerId: "owner", readPurposes: ["read"], derivePurposes: ["derive"], deliveryScopes: ["direct"], retention: "retain", authorityEvidenceRefs: [] };
  const policyRef = { id: policy.id, version: objectVersion(policy) }, policyBytes = canonicalJson(policy);
  await put("policy.json", policyBytes);
  const catalog = parseMemoryCatalog({ schemaVersion: "stella.memory-catalog/v1", generationId: "one", parentGenerationId: null, sources: [], evidence: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [], policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } }] });
  const descriptors: SourceAccessDescriptor[] = [];
  for (let index = 1; index <= 65; index++) {
    const bytes = `Synthetic observation ${index}`; await put(`original-${index}.txt`, bytes);
    const imported = await prepareRepositorySource({ root, collectionId: "fixture", sourceId: String(index), relativePath: `original-${index}.txt`, expectedSha256: bytesVersion(bytes), capturedAt: "2026-09-01T00:00:00Z", objectRoot: "objects", policyRef });
    for (const object of imported.objects) { await put(object.entry.locator.path, object.bytes); catalog[object.group].push(object.entry); }
    descriptors.push({ sourceRef: imported.sourceRef, policyRef, description: `Synthetic descriptor ${index}` });
  }
  await put("catalog.json", canonicalJson(catalog));
  const reader = await CatalogReader.load(root, "catalog.json");
  const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "read", derivePurpose: "derive", deliveryScope: "direct", evidenceCutoff: "2026-09-09T00:00:00Z", trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } }, async () => { throw new Error("No action judgment"); });
  let pages = 0, reviews = 0;
  const input = { question: "Follow the evidence", resolver, descriptors, ownerId: "owner", modelRef: "synthetic/model", config, assertProcessingCurrent: async () => {} };
  const result = await retrieveCatalogEvidence({ ...input, complete: async ({ prompt }) => {
    const data = JSON.parse(prompt.split("\n").at(-1)!);
    if (data.candidates) {
      pages++;
      const target = reviews === 0 ? "E1" : "E65";
      return { provider: "synthetic", model: "model", text: JSON.stringify({ selected: data.candidates.some((c: { handle: string }) => c.handle === target) ? [target] : [] }) };
    }
    reviews++;
    assert.equal(data.originals[0].original.text, "Synthetic observation 1");
    if (reviews === 2) assert.equal(data.originals[1].original.text, "Synthetic observation 65");
    return { provider: "synthetic", model: "model", text: JSON.stringify({ stopped: reviews === 2, nextIntents: reviews === 2 ? [] : ["Check the later counterevidence"], reason: "Synthetic bounded decision" }) };
  } });
  assert.equal(pages, 10); assert.equal(result.refs.length, 2); assert.equal(result.coverage.notSelectedCount, 63);
  assert.equal(result.coverage.scope, "configured_catalog_only");
  await assert.rejects(retrieveCatalogEvidence({ ...input, complete: async () => ({ provider: "synthetic", model: "model", text: '{"selected":["E65"]}' }) }), /invalid_retrieval_selection/);
  await assert.rejects(retrieveCatalogEvidence({ ...input, complete: async () => ({ provider: "other", model: "model", text: '{"selected":[]}' }) }), /retrieval_model_mismatch/);
  await assert.rejects(retrieveCatalogEvidence({ ...input, config: { ...config, maxRounds: 1 }, complete: async ({ prompt }) => ({ provider: "synthetic", model: "model", text: JSON.stringify(prompt.startsWith("Select") ? { selected: [] } : { stopped: false, nextIntents: ["Unresolved lead"], reason: "More context needed" }) }) }), /retrieval_round_budget_exhausted/);
  await assert.rejects(retrieveCatalogEvidence({ ...input, descriptors: [], complete: async () => { throw new Error("Must fail before model"); } }), /retrieval_descriptor_required/);
  const readEvidence = resolver.readEvidence.bind(resolver);
  let selectedReads = 0;
  resolver.readEvidence = async ref => { if (++selectedReads === 3) throw new CatalogError("permission_denied"); return readEvidence(ref); };
  await assert.rejects(prepareQuestionEvidence({ requestId: "revoked", revision: "a".repeat(40), question: input.question, priorContext: "", resolver,
    route: { mode: "ordinary", responseKind: "answer", evidenceStatus: "sufficient", materialUnknowns: [], domains: ["general"], needsTwin: false, needsFramework: false, needsReality: false, needsExternalResearch: false },
    retrieval: { descriptors, modelRef: input.modelRef, ownerId: "owner", config, assertProcessingCurrent: input.assertProcessingCurrent },
    complete: async ({ prompt: query }) => {
      const data = JSON.parse(query.split("\n").at(-1)!);
      return { provider: "synthetic", model: "model", text: JSON.stringify(data.candidates ?
        { selected: data.candidates.some((c: { handle: string }) => c.handle === "E1") ? ["E1"] : [] } :
        { stopped: true, nextIntents: [], reason: "Synthetic stop" }) };
    } }), /permission_denied/);
  resolver.readEvidence = readEvidence;
  let calls = 0;
  await assert.rejects(retrieveCatalogEvidence({ ...input, assertProcessingCurrent: async () => { if (calls) throw new CatalogError("personal_context_access_changed"); }, complete: async () => { calls++; return { provider: "synthetic", model: "model", text: '{"selected":[]}' }; } }), /personal_context_access_changed/);
  const prompt = "Synthetic authenticated request";
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", capturedAt: "2026-09-01T00:00:00Z",
    request: { agentId: "fixture", sessionId: "s", sessionKey: "agent:fixture:s", runId: "r", prompt, requestHash: bytesVersion(prompt), senderId: "owner", senderIsOwner: true, chatType: "direct" } },
    { policyRef, objectRoot: "objects", payloadRoot: "payloads", ownerId: "owner" });
  await put(archive.payload.path, archive.payload.bytes);
  for (const object of archive.objects) { await put(object.entry.locator.path, object.bytes); catalog[object.group].push(object.entry); }
  catalog.generationId = "two"; await put("catalog.json", canonicalJson(catalog));
  const archivedReader = await CatalogReader.load(root, "catalog.json");
  const archivedResolver = new EpisodeEvidenceResolver(archivedReader, { ...resolver.purpose, trustedAdapters: { user_report: [HOST_REQUEST_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] } }, async () => { throw new Error("No judgment"); });
  const archivedResult = await retrieveCatalogEvidence({ ...input, resolver: archivedResolver, complete: async ({ prompt: query }) => {
    const data = JSON.parse(query.split("\n").at(-1)!);
    if (data.candidates) {
      const host = data.candidates.find((candidate: { handle: string }) => candidate.handle === "E66");
      if (host) assert.match(host.description, /Synthetic authenticated request/);
      return { provider: "synthetic", model: "model", text: JSON.stringify({ selected: host ? ["E66"] : [] }) };
    }
    return { provider: "synthetic", model: "model", text: JSON.stringify({ stopped: true, nextIntents: [], reason: "Synthetic bounded stop" }) };
  } });
  assert.deepEqual(archivedResult.refs, archive.evidenceRefs);

});
