import { CatalogError, type CatalogGroup } from "./catalog-reader.js";
import { canonicalJson, bytesVersion, objectVersion } from "./content-version.js";
import { stableId, type HostInputArchive } from "./host-input-archive.js";
import { snapshotTurnRequest, type BoundTurnRequest } from "../openclaw/turn-request.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

export const HOST_REQUEST_ARCHIVE_ADAPTER = "openclaw-reply-dispatch-2026.8.2";
export type HostRequestSnapshot = { schemaVersion: "stella.host-request-snapshot/v1"; request: BoundTurnRequest; capturedAt: string };

/** Exact authenticated ingress body, not a fabricated transcript event or admission receipt. */
export function prepareHostRequestArchive(snapshot: HostRequestSnapshot, input: {
  policyRef: VersionedRef; objectRoot: string; payloadRoot: string; ownerId: string;
}): HostInputArchive {
  const request = snapshotTurnRequest(snapshot.request, snapshot.request.runId);
  if (snapshot.schemaVersion !== "stella.host-request-snapshot/v1" || canonicalJson(request) !== canonicalJson(snapshot.request) ||
    !request.senderIsOwner || !request.senderId || request.chatType !== "direct" || !input.ownerId ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.capturedAt) || !Number.isFinite(Date.parse(snapshot.capturedAt))) {
    throw new CatalogError("invalid_host_request_snapshot");
  }
  for (const root of [input.objectRoot, input.payloadRoot]) if (!root || root.includes("\\") || root.split("/").some(part =>
    !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":"))) throw new CatalogError("unsafe_archive_locator");
  const identity = canonicalJson([HOST_REQUEST_ARCHIVE_ADAPTER, request.agentId, request.sessionKey, request.runId]);
  const sourceId = stableId("source", identity), coverageId = stableId("coverage", identity);
  const payloadBytes = canonicalJson(snapshot), payloadHash = bytesVersion(payloadBytes);
  const payload = { path: `${input.payloadRoot}/${sourceId}/${payloadHash.slice(7)}.json`, bytes: payloadBytes, sha256: payloadHash };
  const objects: HostInputArchive["objects"] = [];
  const add = (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[]) => {
    const ref = { id: String(object.id), version: objectVersion(object) }, versioned = { ...object, version: objectVersion(object) };
    const bytes = canonicalJson(versioned);
    objects.push({ group, ref, object: versioned, bytes, entry: { ...ref, status: "current", dependencies,
      locator: { path: `${input.objectRoot}/${ref.id}/${ref.version.slice(7)}.json`, sha256: bytesVersion(bytes) } } });
    return ref;
  };
  const coverageRef = add("coverage", { schemaVersion: "stella.archive-coverage/v1", id: coverageId,
    adapterId: HOST_REQUEST_ARCHIVE_ADAPTER, collectionId: request.sessionKey,
    scope: { agentIds: [request.agentId], roots: [], branchPolicy: "declared_subset", declaredBranches: [request.runId] },
    upstreamSnapshot: request.requestHash, fromCursor: null, toCursor: request.runId, expectedCount: 1, retainedCount: 1,
    excludedByPolicyCount: 0, missingItems: [], checkedAt: snapshot.capturedAt, completeForDeclaredScope: true }, []);
  const sourceRef = add("sources", { schemaVersion: "stella.memory-source/v1", id: sourceId,
    origin: { adapterId: HOST_REQUEST_ARCHIVE_ADAPTER, collectionId: request.sessionKey, upstreamId: request.runId },
    payloads: [{ path: payload.path, mediaType: "application/json", bytes: Buffer.byteLength(payloadBytes), sha256: payloadHash }],
    capturedAt: snapshot.capturedAt, policyRef: input.policyRef, coverageRef }, [input.policyRef, coverageRef]);
  const evidenceRef = add("evidence", { schemaVersion: "stella.memory-evidence/v1", id: stableId("evidence", identity), source: sourceRef,
    payloadSha256: payloadHash, selector: { kind: "json_pointer", value: "/request/prompt" }, role: "owner", speakerId: input.ownerId,
    kind: "reported", independentOriginId: sourceId, derivedFrom: [], occurredAt: null, authoredAt: null,
    capturedAt: snapshot.capturedAt, policyRef: input.policyRef }, [sourceRef, input.policyRef]);
  return { sourceRef, evidenceRefs: [evidenceRef], coverageRef, payload, objects };
}
