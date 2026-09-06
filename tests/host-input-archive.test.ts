import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHostInputArchive, HOST_INPUT_ARCHIVE_ADAPTER } from "../src/canghai/host-input-archive.js";
import { CatalogReader, type MemoryCatalog } from "../src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { EpisodeEvidenceResolver } from "../src/praxis/episode-evidence.js";
import type { HostInputSnapshot } from "../src/openclaw/host-input.js";
import { persistHostInputArchive } from "../src/canghai/archive-writer.js";
import { GitCangHaiDurability } from "../src/canghai/durability.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const now = "2026-09-06T00:00:00Z";
const policy = { schemaVersion: "stella.source-policy/v1", id: "policy-synthetic", ownerId: "owner-synthetic",
  readPurposes: ["alpha"], derivePurposes: ["alpha"], deliveryScopes: ["synthetic"], retention: "retain", authorityEvidenceRefs: [] };
const policyRef = { id: policy.id, version: objectVersion(policy) };
const config = { policyRef, objectRoot: "memory/objects", payloadRoot: "experience/conversations", speaker: { id: "owner-synthetic", role: "owner" as const } };
function snapshot(): HostInputSnapshot {
  return { schemaVersion: "stella.host-input-snapshot/v1", hostVersion: "2026.8.2", agentId: "synthetic", sessionId: "session-synthetic",
    sessionKey: "agent:synthetic:test", entryId: "message-synthetic", logicalTurnId: "logical-synthetic", generation: "generation-synthetic", rawSeq: 3,
    parentId: "parent-synthetic", text: "原始报告。\n第二段原话。", event: { type: "message", id: "message-synthetic", parentId: "parent-synthetic", timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "原始报告。" }, { type: "text", text: "第二段原话。" }], timestamp: 1 } } };
}
test("Host archive retains the exact event and separate original spans with one independent origin", () => {
  const input = snapshot();
  const archive = prepareHostInputArchive(input, config);
  assert.deepEqual(JSON.parse(archive.payload.bytes).event, input.event);
  const evidence = archive.objects.filter((object) => object.group === "evidence");
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0]!.object.independentOriginId, evidence[1]!.object.independentOriginId);
  assert.deepEqual(evidence.map((object) => object.object.selector), [
    { kind: "json_pointer", value: "/event/message/content/0/text" }, { kind: "json_pointer", value: "/event/message/content/1/text" }]);
  assert.equal(evidence[0]!.object.occurredAt, null);
  assert.equal(evidence[0]!.object.authoredAt, null);
  const coverage = archive.objects.find((object) => object.group === "coverage")!.object;
  assert.equal(coverage.expectedCount, 1);
  assert.deepEqual(coverage.scope, { agentIds: [input.agentId], roots: [], branchPolicy: "declared_subset", declaredBranches: [input.entryId] });
  assert.deepEqual(prepareHostInputArchive(input, config), archive);
});
test("archive identity follows the Host event rather than identical text or storage path", () => {
  const first = prepareHostInputArchive(snapshot(), config);
  const moved = prepareHostInputArchive(snapshot(), { ...config, payloadRoot: "moved/conversations" });
  assert.deepEqual(moved.sourceRef, first.sourceRef);
  const other = snapshot();
  other.entryId = "other-event"; other.event.id = "other-event";
  assert.notEqual(prepareHostInputArchive(other, config).sourceRef.id, first.sourceRef.id);
});
test("archive refuses rewritten text, media omission and missing owner identity", () => {
  assert.throws(() => prepareHostInputArchive({ ...snapshot(), text: "Model invented report" }, config), /host_input_text_mismatch/);
  assert.throws(() => prepareHostInputArchive(snapshot(), { ...config, objectRoot: "../outside" }), /unsafe_archive_locator/);
  assert.throws(() => prepareHostInputArchive(snapshot(), { ...config, objectRoot: ".git/objects" }), /unsafe_archive_locator/);
  assert.throws(() => prepareHostInputArchive(snapshot(), { ...config, speaker: { id: null, role: "owner" } }), /invalid_host_input_snapshot/);
  const media = snapshot();
  media.event.message = { role: "user", content: [{ type: "image", data: "synthetic" }] };
  assert.throws(() => prepareHostInputArchive(media, config), /archive_media_capability_unavailable/);
});
test("materialized Host source is readable by the real catalog and evidence resolver", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-host-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = prepareHostInputArchive(snapshot(), config);
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "catalog-synthetic", parentGenerationId: null,
    sources: [], evidence: [], coverage: [], policies: [], understandings: [], works: [], changes: [], bundles: [], views: [] };
  const policyBytes = canonicalJson({ ...policy, version: policyRef.version });
  await writeFile(path.join(root, "policy.json"), policyBytes);
  catalog.policies.push({ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } });
  for (const object of archive.objects) {
    const file = path.join(root, object.entry.locator.path);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, object.bytes);
    catalog[object.group].push(object.entry);
  }
  const payload = path.join(root, archive.payload.path);
  await mkdir(path.dirname(payload), { recursive: true }); await writeFile(payload, archive.payload.bytes);
  await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  const resolver = new EpisodeEvidenceResolver(await CatalogReader.load(root, "catalog.json"), {
    readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic", evidenceCutoff: now,
    trustedAdapters: { user_report: [HOST_INPUT_ARCHIVE_ADAPTER], tool_observation: [], system_event: [] },
  }, async () => { throw new Error("No semantic model needed for original span retrieval"); });
  assert.deepEqual(await Promise.all(archive.evidenceRefs.map(async (ref) => (await resolver.readEvidence(ref)).text)), ["原始报告。", "第二段原话。"]);
});

test("archive transaction survives pointer failure, exact replay, later generations and clean Git restore", async (t) => {
  const run = promisify(execFile);
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-archive-transaction-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "work");
  const remote = path.join(parent, "remote.git");
  await run("git", ["init", "--bare", "--quiet", remote]);
  await run("git", ["init", "--quiet", "-b", "synthetic-alpha", root]);
  await run("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await run("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  const policyBytes = canonicalJson({ ...policy, version: policyRef.version });
  await writeFile(path.join(root, "policy.json"), policyBytes);
  const catalog: MemoryCatalog = { schemaVersion: "stella.memory-catalog/v1", generationId: "generation-base", parentGenerationId: null,
    sources: [], evidence: [], coverage: [], policies: [{ ...policyRef, status: "current", dependencies: [], locator: { path: "policy.json", sha256: bytesVersion(policyBytes) } }],
    understandings: [], works: [], changes: [], bundles: [], views: [] };
  await writeFile(path.join(root, "catalog.json"), canonicalJson(catalog));
  await run("git", ["-C", root, "add", "policy.json", "catalog.json"]);
  await run("git", ["-C", root, "commit", "--quiet", "-m", "Synthetic baseline"]);
  await run("git", ["-C", root, "remote", "add", "origin", remote]);
  await run("git", ["-C", root, "push", "--quiet", "origin", "HEAD:refs/heads/synthetic-alpha"]);
  const reader = await CatalogReader.load(root, "catalog.json");
  const archive = prepareHostInputArchive(snapshot(), config);
  let fail = true;
  const createPorts = () => {
    const durability = new GitCangHaiDurability({ root, remote: "origin", branch: "synthetic-alpha",
      criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0,
      async onRevision() { if (fail) throw new Error("Synthetic pointer failure"); } });
    return { async persist(paths: string[], operation: string) { await durability.syncCritical(paths, operation); },
      confirmPreviouslyCommitted: (operationPath: string) => durability.confirmPreviouslyCommitted(operationPath) };
  };
  const input = { reader, archive, operationId: "op-archive", purpose: { readPurpose: "alpha", derivePurpose: "alpha", deliveryScope: "synthetic" } };
  await assert.rejects(persistHostInputArchive(input, createPorts()), /Synthetic pointer failure/);
  const { stdout: committed } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  fail = false;
  const ports = createPorts();
  const first = await persistHostInputArchive(input, ports);
  assert.equal((await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout, committed);
  const secondSnapshot = snapshot();
  secondSnapshot.entryId = "second-message"; secondSnapshot.event.id = "second-message"; secondSnapshot.logicalTurnId = "second-logical";
  const second = await persistHostInputArchive({ ...input, reader: await CatalogReader.load(root, "catalog.json"), operationId: "op-second",
    archive: prepareHostInputArchive(secondSnapshot, config) }, ports);
  assert.notEqual(second.generationId, first.generationId);
  const { stdout: secondHead } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  assert.deepEqual(await persistHostInputArchive(input, ports), first);
  assert.equal((await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout, secondHead);
  const clone = path.join(parent, "restored");
  await run("git", ["clone", "--quiet", "--branch", "synthetic-alpha", remote, clone]);
  const restored = await CatalogReader.load(clone, "catalog.json");
  const original = await restored.readPayload(first.sourceRef, archive.payload.sha256);
  assert.equal(original.bytes.toString("utf8"), archive.payload.bytes);
  await assert.rejects(persistHostInputArchive({ ...input, archive: prepareHostInputArchive(secondSnapshot, config) }, ports), /archive_operation_conflict/);
  await assert.rejects(persistHostInputArchive({ ...input, operationId: "op-stale" }, ports), /stale_generation/);
  await assert.rejects(persistHostInputArchive({ ...input, operationId: "op-denied", reader: await CatalogReader.load(root, "catalog.json"),
    purpose: { ...input.purpose, deliveryScope: "unauthorized" } }, ports), /archive_permission_denied/);
});
