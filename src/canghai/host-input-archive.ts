import { createHash } from "node:crypto";
import type { HostInputSnapshot } from "../openclaw/host-input.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { isRecord } from "../shared/type-guards.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import { CatalogError, type CatalogEntry, type CatalogGroup, validMemoryRef } from "./catalog-reader.js";

export const HOST_INPUT_ARCHIVE_ADAPTER = "openclaw-transcript-2026.8.2";
export type ArchiveObject = { group: CatalogGroup; ref: VersionedRef; object: Record<string, unknown>; entry: CatalogEntry; bytes: string };
export type HostInputArchive = {
  sourceRef: VersionedRef; evidenceRefs: VersionedRef[]; coverageRef: VersionedRef;
  payload: { path: string; bytes: string; sha256: string }; objects: ArchiveObject[];
};
export function stableId(prefix: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest();
  // UUIDv8 is deterministic for this adapter's upstream identity, independent of file location.
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function relative(value: string): string {
  const result = value.replaceAll("\\", "/");
  if (!result || result.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":"))) throw new CatalogError("unsafe_archive_locator");
  return result;
}

/** A declared one-event export, not proof that all retained Host conversations were archived. */
export function prepareHostInputArchive(snapshot: HostInputSnapshot, input: {
  policyRef: VersionedRef; objectRoot: string; payloadRoot: string;
  speaker: { id: string | null; role: "owner" | "other" | "unknown" };
}): HostInputArchive {
  if (snapshot.hostVersion !== "2026.8.2" || !snapshot.agentId || !snapshot.sessionId || !snapshot.entryId || !validMemoryRef(input.policyRef) ||
      !["owner", "other", "unknown"].includes(input.speaker.role) || (input.speaker.role === "owner" && !input.speaker.id) ||
      snapshot.event.type !== "message" || snapshot.event.id !== snapshot.entryId || snapshot.event.parentId !== snapshot.parentId ||
      !isRecord(snapshot.event.message) || snapshot.event.message.role !== "user" ||
      typeof snapshot.event.timestamp !== "string" || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(snapshot.event.timestamp) || !Number.isFinite(Date.parse(snapshot.event.timestamp))) {
    throw new CatalogError("invalid_host_input_snapshot");
  }
  const objectRoot = relative(input.objectRoot);
  const payloadRoot = relative(input.payloadRoot);
  const identity = canonicalJson([HOST_INPUT_ARCHIVE_ADAPTER, snapshot.agentId, snapshot.sessionId, snapshot.entryId]);
  const sourceId = stableId("source", identity);
  const coverageId = stableId("coverage", identity);
  const capturedAt = snapshot.event.timestamp;
  const payloadBytes = canonicalJson({
    hostVersion: snapshot.hostVersion, agentId: snapshot.agentId, sessionId: snapshot.sessionId, sessionKey: snapshot.sessionKey,
    logicalTurnId: snapshot.logicalTurnId, generation: snapshot.generation, rawSeq: snapshot.rawSeq, event: snapshot.event,
  });
  const payloadHash = bytesVersion(payloadBytes);
  const payload = { path: `${payloadRoot}/${sourceId}/${payloadHash.slice(7)}.json`, bytes: payloadBytes, sha256: payloadHash };
  const objects: ArchiveObject[] = [];
  const add = (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[]): VersionedRef => {
    const version = objectVersion(object);
    const ref = { id: String(object.id), version };
    const versioned = { ...object, version };
    const bytes = canonicalJson(versioned);
    const entry: CatalogEntry = { ...ref, locator: { path: `${objectRoot}/${ref.id}/${version.slice(7)}.json`, sha256: bytesVersion(bytes) }, status: "current", dependencies };
    objects.push({ group, ref, object: versioned, entry, bytes });
    return ref;
  };
  const coverageRef = add("coverage", { schemaVersion: "stella.archive-coverage/v1", id: coverageId,
    adapterId: HOST_INPUT_ARCHIVE_ADAPTER, collectionId: snapshot.sessionId,
    scope: { agentIds: [snapshot.agentId], roots: [], branchPolicy: "declared_subset", declaredBranches: [snapshot.entryId] },
    upstreamSnapshot: canonicalJson({ generation: snapshot.generation, rawSeq: snapshot.rawSeq, entryId: snapshot.entryId }),
    fromCursor: snapshot.parentId, toCursor: snapshot.entryId, expectedCount: 1, retainedCount: 1, excludedByPolicyCount: 0,
    missingItems: [], checkedAt: capturedAt, completeForDeclaredScope: true }, []);
  const sourceRef = add("sources", { schemaVersion: "stella.memory-source/v1", id: sourceId,
    origin: { adapterId: HOST_INPUT_ARCHIVE_ADAPTER, collectionId: snapshot.sessionId, upstreamId: snapshot.entryId },
    payloads: [{ path: payload.path, mediaType: "application/json", bytes: Buffer.byteLength(payloadBytes), sha256: payloadHash }],
    capturedAt, policyRef: input.policyRef, coverageRef }, [input.policyRef, coverageRef]);
  const content = snapshot.event.message.content;
  let selections: Array<{ pointer: string; text: string }>;
  if (typeof content === "string") selections = [{ pointer: "/event/message/content", text: content }];
  else if (Array.isArray(content) && content.every((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")) {
    selections = content.map((part, index) => ({ pointer: `/event/message/content/${index}/text`, text: (part as { text: string }).text }));
  } else throw new CatalogError("archive_media_capability_unavailable");
  if (!selections.length || selections.map((selection) => selection.text).join("\n") !== snapshot.text) throw new CatalogError("host_input_text_mismatch");
  const evidenceRefs = selections.filter((selection) => selection.text.trim()).map((selection) => add("evidence", {
    schemaVersion: "stella.memory-evidence/v1", id: stableId("evidence", `${identity}:${selection.pointer}`), source: sourceRef,
    payloadSha256: payloadHash, selector: { kind: "json_pointer", value: selection.pointer }, speakerId: input.speaker.id,
    role: input.speaker.role, kind: "reported", occurredAt: null, authoredAt: null, capturedAt,
    independentOriginId: sourceId, derivedFrom: [], policyRef: input.policyRef,
  }, [sourceRef, input.policyRef]));
  if (!evidenceRefs.length) throw new CatalogError("empty_host_input");
  return { sourceRef, evidenceRefs, coverageRef, payload, objects };
}
