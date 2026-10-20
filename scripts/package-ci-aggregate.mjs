import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceIdentity, sha256 } from "./lib/package-evidence.mjs";
import { loadPreparedPackage } from "./lib/prepared-package.mjs";
import { collectPackageShards, PACKAGE_PLAN_VERSION, PACKAGE_PROBE_NAMES, PACKAGE_SHARDS } from "./lib/package-shards.mjs";
import { alignHostMemoryEvidence } from "./lib/host-memory-evidence.mjs";

assert.equal(process.argv.length, 4, "Usage: node scripts/package-ci-aggregate.mjs <download-directory> <output-directory>");
const root = fileURLToPath(new URL("../", import.meta.url));
const input = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const receipt = { schemaVersion: "stella.package-ci-aggregate/v1", planVersion: PACKAGE_PLAN_VERSION, status: "failed",
  expectedProbes: PACKAGE_PROBE_NAMES, expectedShards: Object.keys(PACKAGE_SHARDS),
  fullMemoryAccepted: false, privateMainAccepted: false, realModelAccepted: false, issue23Complete: false };
try {
  const source = await sourceIdentity(root);
  const prepared = await loadPreparedPackage(path.join(input, "stella-prepared"), root, source);
  const receipts = [], receiptFiles = [];
  // Inspect all downloaded shard artifacts, including unexpected and duplicate
  // artifacts; never select just the green subset or silently omit a directory.
  for (const name of (await readdir(input)).filter(name => name.startsWith("stella-shard-")).sort()) {
    const file = path.join(input, name, "receipt.json"), bytes = await readFile(file);
    const shardReceipt = JSON.parse(bytes);
    assert.equal(name, `stella-shard-${shardReceipt.shard}`, "Shard artifact name mismatch");
    receipts.push(shardReceipt); receiptFiles.push({ artifact: name, sha256: sha256(bytes) });
  }
  const jobResults = JSON.parse(process.env.STELLA_CI_JOB_RESULTS ?? "null");
  assert.ok(jobResults, "CI job conclusions are required");
  Object.assign(receipt, { coreRevision: source.coreRevision, sourceManifestSha256: source.digest,
    artifactSha256: prepared.artifactSha256, preparedSha256: prepared.preparedSha256, hostVersion: prepared.hostVersion,
    jobResults, receiptFiles, receivedShards: receipts.map(item => ({ shard: item.shard, status: item.status, probes: item.probes?.length })) });
  const probes = collectPackageShards(prepared, receipts, jobResults);
  const hostMemoryEvidence = alignHostMemoryEvidence({ ...prepared.declarations, probes,
    coreRevision: source.coreRevision, artifactSha256: prepared.artifactSha256 });
  Object.assign(receipt, { status: "passed", probes, hostMemoryEvidence, passedProbes: probes.length });
} catch (error) {
  receipt.error = String(error.stack ?? error); process.exitCode = 1;
}
await writeFile(path.join(output, "aggregate.json"), JSON.stringify(receipt, null, 2));
process.stdout.write(`${JSON.stringify(receipt)}\n`);
