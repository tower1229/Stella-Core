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
export type CheckpointWorkSegmentCase = "separate-allowed" | "parent-denied" | "direct-B" | "derived-B" |
  "missing-parent-descriptor" | "missing-fragment-descriptor" | "wrong-descriptor" | "uncovered" | "cross-segment" | "wrong-policy";

/** New synthetic source only. Existing public fixture builders are not changed.
 * The real installed plugin must still obtain Host identity and enforce the grant.
 */
export async function createCheckpointWorkSource(options: { segmented?: boolean; segmentCase?: CheckpointWorkSegmentCase } = {}) {
  const source = await createAgentSupplySource({ materialization: true, policyContext: "allow" });
  const catalog = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8")) as MemoryCatalog;
  const binding = JSON.parse(await readFile(path.join(source.root, "50_PersonalAgent/stella/praxis-binding.json"), "utf8"));
  assert.equal(catalog.sources.length, 1); assert.equal(catalog.evidence.length, 1);
  assert.equal(catalog.works.length, 0); assert.equal(catalog.understandings.length, 0);
  const ref = (value: { id: string; version: string }) => ({ id: value.id, version: value.version });
  const segmentFiles: string[] = [];
  let segmented: { sourceRef: ReturnType<typeof ref>; allowedEvidenceRef: ReturnType<typeof ref>; deniedEvidenceRef: ReturnType<typeof ref>;
    allowedPayloadSha256: string; deniedPayloadSha256: string; deniedMarker: string } | undefined;
  if (options.segmented) {
    const previousSource = ref(catalog.sources[0]!);
    const baseSource = JSON.parse(await readFile(path.join(source.root, catalog.sources[0]!.locator.path), "utf8"));
    const baseEvidence = JSON.parse(await readFile(path.join(source.root, catalog.evidence[0]!.locator.path), "utf8"));
    const policyEntry = catalog.policies.find(entry => entry.id === baseSource.policyRef.id && entry.version === baseSource.policyRef.version)!;
    const parentPolicy = JSON.parse(await readFile(path.join(source.root, policyEntry.locator.path), "utf8"));
    const put = async (group: "sources" | "evidence" | "policies", object: Record<string, unknown>, dependencies: ReturnType<typeof ref>[]) => {
      delete object.version;
      const next = { id: String(object.id), version: objectVersion(object) }, bytes = canonicalJson(object);
      const file = `30_PersonalData/memory/objects/${next.id}/${next.version.slice(7)}.json`;
      await mkdir(path.dirname(path.join(source.root, file)), { recursive: true }); await writeFile(path.join(source.root, file), bytes);
      catalog[group].push({ ...next, status: "current", dependencies, locator: { path: file, sha256: bytesVersion(bytes) } });
      segmentFiles.push(file); return next;
    };
    const deniedPolicy = await put("policies", { ...parentPolicy, id: "synthetic-work-fragment-B-policy", readPurposes: [], derivePurposes: [] }, []);
    const parentRef = options.segmentCase === "parent-denied"
      ? await put("policies", { ...parentPolicy, id: "synthetic-parent-read-denied", readPurposes: [] }, []) : baseSource.policyRef;
    const fragmentRef = options.segmentCase
      ? await put("policies", { ...parentPolicy, id: "synthetic-fragment-A-policy" }, []) : parentRef;
    const allowedText = "SYNTHETIC_WORK_FRAGMENT_A: preserve the open writing question.";
    const deniedMarker = "SYNTHETIC_WORK_FRAGMENT_B_DENIED_BODY";
    const a = { path: "30_PersonalData/memory/payloads/synthetic-work-fragment-A.txt", bytes: Buffer.byteLength(allowedText), sha256: bytesVersion(allowedText), mediaType: "text/plain" };
    const b = { path: "30_PersonalData/memory/payloads/synthetic-work-fragment-B.txt", bytes: Buffer.byteLength(deniedMarker), sha256: bytesVersion(deniedMarker), mediaType: "text/plain" };
    for (const [payload, text] of [[a, allowedText], [b, deniedMarker]] as const) {
      await mkdir(path.dirname(path.join(source.root, payload.path)), { recursive: true }); await writeFile(path.join(source.root, payload.path), text); segmentFiles.push(payload.path);
    }
    const segmentA = { payloadSha256: a.sha256, start: 0, end: options.segmentCase === "cross-segment" ? Math.floor(a.bytes / 2) : a.bytes };
    const segmentB = { payloadSha256: b.sha256, start: 0, end: b.bytes };
    catalog.sources = []; catalog.evidence = [];
    const sourceRef = await put("sources", { ...baseSource, schemaVersion: "stella.memory-source/v2", policyRef: parentRef, payloads: [a, b],
      accessSegments: [{ ...segmentA, policyRef: fragmentRef },
        ...(options.segmentCase === "cross-segment" ? [{ payloadSha256: a.sha256, start: segmentA.end, end: a.bytes, policyRef: deniedPolicy }] : []),
        { ...segmentB, policyRef: deniedPolicy }] },
    [...new Map([parentRef, baseSource.coverageRef, deniedPolicy, fragmentRef].map(value => [canonicalJson(value), value])).values()]);
    const deniedEvidenceRef = await put("evidence", { ...baseEvidence, id: "synthetic-work-fragment-B", source: sourceRef,
      policyRef: deniedPolicy, payloadSha256: b.sha256, selector: { kind: "utf8_bytes", value: `0:${b.bytes}` }, derivedFrom: [] }, [sourceRef, deniedPolicy]);
    const evidencePolicy = options.segmentCase === "wrong-policy" ? deniedPolicy : fragmentRef;
    const derivedFrom = options.segmentCase === "derived-B" ? [deniedEvidenceRef] : [];
    const allowedEvidenceRef = await put("evidence", { ...baseEvidence, id: "synthetic-work-fragment-A", source: sourceRef,
      policyRef: evidencePolicy, payloadSha256: a.sha256, selector: { kind: "utf8_bytes", value: `0:${a.bytes}` }, derivedFrom }, [sourceRef, evidencePolicy, ...derivedFrom]);
    catalog.evidence.reverse(); // Work's normal first Evidence remains A.
    const file = path.join(source.root, "50_PersonalAgent/stella/checkpoint-access.json"), grant = JSON.parse(await readFile(file, "utf8"));
    grant.descriptors = grant.descriptors.filter((entry: { sourceRef: ReturnType<typeof ref> }) => canonicalJson(entry.sourceRef) !== canonicalJson(previousSource));
    // A descriptor supplies reviewed context, not read permission: B's explicit
    // policy still denies read/derive even when that context is available.
    const descriptors = [...new Map([parentRef, fragmentRef].map(policyRef => [canonicalJson(policyRef), { sourceRef, policyRef,
      segment: options.segmentCase === "wrong-descriptor" ? { ...segmentA, end: segmentA.end - 1 } : segmentA,
      description: "Reviewed synthetic A fragment for the writing question." }])).values()]
      .filter(descriptor => options.segmentCase !== "missing-parent-descriptor" || canonicalJson(descriptor.policyRef) !== canonicalJson(parentRef))
      .filter(descriptor => options.segmentCase !== "missing-fragment-descriptor" || canonicalJson(descriptor.policyRef) !== canonicalJson(fragmentRef));
    grant.descriptors.push(...descriptors,
      { sourceRef, policyRef: deniedPolicy, segment: segmentB, description: "Synthetic B fragment with explicit read and derive denial." });
    await writeFile(file, canonicalJson(grant));
    segmented = { sourceRef, allowedEvidenceRef, deniedEvidenceRef, allowedPayloadSha256: a.sha256, deniedPayloadSha256: b.sha256, deniedMarker };
  }
  const sourceRef = ref(catalog.sources[0]!), evidenceRef = options.segmentCase === "direct-B" ? segmented!.deniedEvidenceRef : ref(catalog.evidence[0]!);
  const at = "2020-01-01T00:00:00Z";
  const workRecord = { schemaVersion: "stella.ongoing-work/v1", id: WORK_ID, kind: "writing", status: "active", goal: WORK_GOAL_A,
    sourceRefs: [sourceRef],
    confirmedPremises: [{ id: "confirmed-question", text: "Preserve the unresolved question.", evidenceRefs: [evidenceRef], acceptance: "confirmed" }],
    candidateIdeas: [{ id: "proposed-ending", text: "Try an open ending without declaring agreement.", evidenceRefs: [evidenceRef], acceptance: "proposed" }],
    rejectedInterpretations: [{ id: "rejected-inspiration", text: "Do not replace the author's question with an uplifting ending.", evidenceRefs: [evidenceRef], acceptance: "rejected" }],
    openQuestions: [{ id: "open-argument", question: "Does the last argument actually follow?", evidenceRefs: [evidenceRef], material: true }],
    nextStep: null, lastAppliedChangeId: null, createdAt: at, updatedAt: at };
  if (options.segmentCase === "uncovered") {
    workRecord.confirmedPremises = []; workRecord.candidateIdeas = []; workRecord.rejectedInterpretations = []; workRecord.openQuestions = [];
  }
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
  await git("add", "--", source.catalogPath, grantPath, workPath, correction.payload.path, ...correction.objects.map(object => object.entry.locator.path), ...segmentFiles);
  await git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "[synthetic] add current writing work and exact processing grant");
  assert.equal(await git("status", "--porcelain"), "");
  return { ...source, revision: await git("rev-parse", "HEAD"), binding, workRef, workRecord, evidenceRef,
    correctionEvidenceRef: correction.evidenceRefs[0]!, correctionRequest, grantPath, segmented };
}
