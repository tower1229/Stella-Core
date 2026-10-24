import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSupplySource } from "./checkpoint-agent-supply-fixture.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { validateOngoingWork } from "../src/praxis/personal-views.js";
import type { MemoryCatalog } from "../src/canghai/catalog-reader.js";

export const WORK_MODEL = "google/gemini-3.8-flash";
export const WORK_ID = "synthetic-writing-work";
export const WORK_GOAL_A = "SYNTHETIC_WORK_A_7296: continue examining the open writing argument";
export const WORK_GOAL_B = "SYNTHETIC_WORK_B_7296: preserve the question and check the argument first";
export const WORK_CORRECTION = `SYNTHETIC_WORK_CORRECTION_ORIGINAL_7296: Change the writing goal to ${WORK_GOAL_B}; keep the confirmed, proposed, rejected and open items distinct.`;
export const WORK_QUESTIONS = [
  "SYNTHETIC_WORK_QUERY_A_7296: resume my current writing work, including confirmed premises, proposals, rejected readings and open questions.",
  "SYNTHETIC_WORK_QUERY_B_7296: resume the current writing work after my correction, preserving its unresolved question.",
] as const;

/** New synthetic source only. Existing public fixture builders are not changed.
 * The real installed plugin must still obtain Host identity and enforce the grant.
 */
export async function createCheckpointWorkSource() {
  const source = await createAgentSupplySource({ materialization: true, policyContext: "allow" });
  const catalog = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8")) as MemoryCatalog;
  const binding = JSON.parse(await readFile(path.join(source.root, "50_PersonalAgent/stella/praxis-binding.json"), "utf8"));
  assert.equal(catalog.sources.length, 1); assert.equal(catalog.evidence.length, 1);
  assert.equal(catalog.works.length, 0); assert.equal(catalog.understandings.length, 0);
  const ref = (value: { id: string; version: string }) => ({ id: value.id, version: value.version });
  const sourceRef = ref(catalog.sources[0]!), evidenceRef = ref(catalog.evidence[0]!);
  const at = "2020-01-01T00:00:00Z";
  const workRecord = { schemaVersion: "stella.ongoing-work/v1", id: WORK_ID, kind: "writing", status: "active", goal: WORK_GOAL_A,
    sourceRefs: [sourceRef],
    confirmedPremises: [{ id: "confirmed-question", text: "Preserve the unresolved question.", evidenceRefs: [evidenceRef], acceptance: "confirmed" }],
    candidateIdeas: [{ id: "proposed-ending", text: "Try an open ending without declaring agreement.", evidenceRefs: [evidenceRef], acceptance: "proposed" }],
    rejectedInterpretations: [{ id: "rejected-inspiration", text: "Do not replace the author's question with an uplifting ending.", evidenceRefs: [evidenceRef], acceptance: "rejected" }],
    openQuestions: [{ id: "open-argument", question: "Does the last argument actually follow?", evidenceRefs: [evidenceRef], material: true }],
    nextStep: null, lastAppliedChangeId: null, createdAt: at, updatedAt: at };
  const dependencies = validateOngoingWork(workRecord);
  const workRef = { id: WORK_ID, version: objectVersion(workRecord) }, workBytes = canonicalJson(workRecord);
  const workPath = `30_PersonalData/memory/objects/${WORK_ID}/${workRef.version.slice(7)}.json`;
  await mkdir(path.dirname(path.join(source.root, workPath)), { recursive: true });
  await writeFile(path.join(source.root, workPath), workBytes);
  catalog.works.push({ ...workRef, status: "current", dependencies: [...new Map(dependencies.map(value => [canonicalJson(value), value])).values()],
    locator: { path: workPath, sha256: bytesVersion(workBytes) } });

  // Pre-archived synthetic owner correction supports the later trusted Core-only
  // correction call. It is not a Host-generated message or automatic trigger.
  const correctionRequest = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-work-correction-source",
    sessionKey: "agent:synthetic:work-correction-source", senderId: "cli", senderIsOwner: true,
    chatType: "direct", prompt: WORK_CORRECTION }, "synthetic-work-correction-source-run");
  const correction = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request: correctionRequest, capturedAt: at },
    { ...binding.archive, ownerId: "owner-fixture" });
  for (const file of [{ path: correction.payload.path, bytes: correction.payload.bytes },
    ...correction.objects.map(object => ({ path: object.entry.locator.path, bytes: object.bytes }))]) {
    await mkdir(path.dirname(path.join(source.root, file.path)), { recursive: true });
    await writeFile(path.join(source.root, file.path), file.bytes);
  }
  for (const object of correction.objects) catalog[object.group].push(object.entry);
  const grantPath = "50_PersonalAgent/stella/checkpoint-access.json";
  const grant = JSON.parse(await readFile(path.join(source.root, grantPath), "utf8"));
  grant.requesterIds = ["cli"]; grant.modelRefs = [WORK_MODEL]; grant.viewProcessingModelRefs = [WORK_MODEL];
  grant.descriptors.push({ sourceRef: correction.sourceRef, policyRef: binding.archive.policyRef,
    description: "Reviewed synthetic owner correction to the writing goal, preserving unresolved questions and authorial distinctions." });
  await writeFile(path.join(source.root, grantPath), canonicalJson(grant));
  catalog.parentGenerationId = catalog.generationId; catalog.generationId = "synthetic-writing-work-A";
  await writeFile(path.join(source.root, source.catalogPath), canonicalJson(catalog));
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false",
    "-c", "diff.autoRefreshIndex=false", "-C", source.root, ...args], { timeout: 15_000 })).stdout.trim();
  assert.equal(await git("remote"), "");
  await git("add", "--", source.catalogPath, grantPath, workPath, correction.payload.path, ...correction.objects.map(object => object.entry.locator.path));
  await git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "[synthetic] add current writing work and exact processing grant");
  assert.equal(await git("status", "--porcelain"), "");
  return { ...source, revision: await git("rev-parse", "HEAD"), binding, workRef, workRecord, evidenceRef,
    correctionEvidenceRef: correction.evidenceRefs[0]!, correctionRequest, grantPath };
}
