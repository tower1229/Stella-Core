import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../src/canghai/content-version.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import type { createAgentSupplySource } from "./checkpoint-agent-supply-fixture.js";

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args])).stdout.trim();
export const IMPORTED_MARKER = "SYNTHETIC_EXPLICIT_SNAPSHOT_ENTRY_18";

/** Test-only producer, never a grant writer in the import API. Both exact Source
 * versions are deliberately reviewed before initializing this synthetic consumer.
 */
export async function prepareSnapshotImportFixture(source: Awaited<ReturnType<typeof createAgentSupplySource>>, candidateRoot: string) {
  const before = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8"));
  const oldEntry = before.sources.at(-1); assert.ok(oldEntry);
  const oldSource = JSON.parse(await readFile(path.join(source.root, oldEntry.locator.path), "utf8"));
  const original = JSON.parse(await readFile(path.join(source.root, oldSource.payloads[0].path), "utf8"));
  const request = snapshotTurnRequest({ ...original.request, prompt: IMPORTED_MARKER }, original.request.runId);
  const revised = prepareHostRequestArchive({ ...original, request }, { ...source.binding.archive, policyRef: oldSource.policyRef, ownerId: "owner-fixture" });
  assert.equal(revised.sourceRef.id, oldEntry.id);
  const grantPath = "50_PersonalAgent/stella/checkpoint-access.json";
  const grant = JSON.parse(await readFile(path.join(source.root, grantPath), "utf8"));
  const descriptor = grant.descriptors.find((d: { sourceRef: { id: string; version: string } }) => d.sourceRef.id === oldEntry.id && d.sourceRef.version === oldEntry.version);
  assert.ok(descriptor); grant.descriptors.push({ ...descriptor, sourceRef: revised.sourceRef });
  await writeFile(path.join(source.root, grantPath), canonicalJson(grant));
  await git(source.root, "add", "--", grantPath); await git(source.root, "commit", "--quiet", "-m", "[synthetic] explicitly review both snapshot versions before initialization");
  const producerBaseRevision = await git(source.root, "rev-parse", "HEAD");
  await git(source.root, "clone", "--no-hardlinks", source.root, candidateRoot);
  const after = structuredClone(before);
  for (const object of revised.objects) {
    const current = after[object.group].find((entry: { id: string; status: string }) => entry.id === object.ref.id && entry.status === "current");
    assert.ok(current); current.status = "superseded"; after[object.group].push(object.entry);
  }
  after.parentGenerationId = before.generationId; after.generationId = "synthetic-explicit-snapshot-B";
  for (const file of [{ path: revised.payload.path, bytes: revised.payload.bytes }, ...revised.objects.map(o => ({ path: o.entry.locator.path, bytes: o.bytes })),
    { path: source.catalogPath, bytes: canonicalJson(after) }]) {
    await mkdir(path.dirname(path.join(candidateRoot, file.path)), { recursive: true });
    await writeFile(path.join(candidateRoot, file.path), file.bytes);
  }
  await git(candidateRoot, "add", "--", source.catalogPath, revised.payload.path, ...revised.objects.map(o => o.entry.locator.path));
  await git(candidateRoot, "-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "[synthetic] fixed second data projection without grant changes");
  const candidateRevision = await git(candidateRoot, "rev-parse", "HEAD");
  assert.equal(await git(source.root, "status", "--porcelain"), ""); assert.equal(await git(candidateRoot, "status", "--porcelain"), "");
  return { candidateRoot, producerBaseRevision, candidateRevision, sourceRef: revised.sourceRef, evidenceRef: revised.evidenceRefs[0]!, marker: IMPORTED_MARKER };
}
