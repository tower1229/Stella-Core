import { manifestForItems } from "./archive-integrity.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRepositoryBytes } from "./catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { ingest, IngestError, type IngestItem, type IngestPorts, type IngestRequest } from "./ingest.js";

export const MATERIAL_ADAPTER = "stella-material-import/v1";

/** Provenance supplied by the upstream adapter, never inferred from document wording. */
export type MaterialProvenance =
  | { type: "unknown" }
  | { type: "authored"; authorId: string; role: "owner" | "other" | "external_author" }
  | { type: "generated"; producerId: string };

export type MaterialImport = {
  upstreamId: string;
  capturedAt: string;
  authoredAt?: string | null;
  provenance: MaterialProvenance;
  original: { mediaType: string; bytes: Uint8Array; sha256: string } | null;
  /** Only external adapters may explicitly report an unavailable original. */
  summary?: string;
  sourceUrl?: string;
  personalRelation?: string;
  skill?: VersionedRef;
  derivedFrom?: VersionedRef[];
  repository?: { revision: string; path: string };
};

export type MaterialIngestRequest = {
  operationId: string;
  expectedRevision: string;
  collectionId: string;
  entry: "files" | "skill" | "external" | "repository";
  snapshotId: string;
  resumeKey?: string;
  coverage?: IngestRequest["coverage"];
  materials: MaterialImport[];
  policyRef: VersionedRef;
  purpose: IngestRequest["purpose"];
};

export async function ingestMaterials(input: MaterialIngestRequest, ports: IngestPorts) {
  input = structuredClone(input);
  if (!input.snapshotId?.trim() || !Array.isArray(input.materials) || !input.materials.length || input.materials.length > 32 ||
    !["files", "skill", "external", "repository"].includes(input.entry) ||
    new Set(input.materials.map(material => material.upstreamId)).size !== input.materials.length) {
    throw new IngestError("invalid_material_import");
  }
  const items: IngestItem[] = input.materials.map((material) => {
    const provenance = material.provenance;
    if (!isRecord(provenance) || !["unknown", "authored", "generated"].includes(provenance.type) ||
      provenance.type === "authored" && (!provenance.authorId?.trim() || !["owner", "other", "external_author"].includes(provenance.role)) ||
      provenance.type === "generated" && !provenance.producerId?.trim()) throw new IngestError("invalid_material_provenance");
    if (material.authoredAt != null && (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(material.authoredAt) ||
      !Number.isFinite(Date.parse(material.authoredAt)))) throw new IngestError("invalid_material_time");
    if (material.original !== null && (!(material.original?.bytes instanceof Uint8Array) ||
      bytesVersion(material.original.bytes) !== material.original.sha256)) throw new IngestError("material_original_mismatch");
    if (material.original === null && (input.entry !== "external" || !material.summary?.trim() ||
      material.provenance.type !== "generated")) throw new IngestError("material_original_missing");
    if (input.entry === "external") {
      let url: URL;
      try { url = new URL(material.sourceUrl ?? ""); } catch { throw new IngestError("external_source_required"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
        !material.personalRelation?.trim()) throw new IngestError("external_source_required");
    }
    if (input.entry === "skill" && (!material.skill?.id.trim() ||
      !/^sha256:[a-f0-9]{64}$/.test(material.skill.version))) throw new IngestError("skill_version_required");
    const role = provenance.type === "authored" ? provenance.role : provenance.type === "generated" ? "assistant" : "unknown";
    const speakerId = provenance.type === "authored" ? provenance.authorId : provenance.type === "generated" ? provenance.producerId : null;
    const kind = provenance.type === "generated" ? "inference" : provenance.type === "authored" ? "reported" : "unknown";
    return {
      upstreamId: material.upstreamId, role, speakerId, kind,
      text: material.original ? canonicalJson({ originalSha256: material.original.sha256 }) : material.summary!,
      capturedAt: material.capturedAt, authoredAt: material.authoredAt ?? null, occurredAt: null,
      parentUpstreamId: null,
      derivedFrom: material.derivedFrom ?? [],
      textIsEvidence: material.original === null,
      envelope: { schemaVersion: "stella.material-import/v1", provenance, entry: input.entry,
        skill: material.skill ?? null, originalSha256: material.original?.sha256 ?? null, derivedFrom: material.derivedFrom ?? [],
        sourceUrl: material.sourceUrl ?? null, personalRelation: material.personalRelation ?? null,
        repository: material.repository ?? null,
        originalAvailability: material.original ? "retained" : "unavailable" },
      attachments: [{ upstreamId: `${material.upstreamId}#original`, mediaType: material.original?.mediaType ?? "application/octet-stream",
        bytes: material.original?.bytes, externalUrl: material.original ? null : material.sourceUrl, evidenceKind: kind }],
    };
  });
  return ingest({ operationId: input.operationId, expectedRevision: input.expectedRevision,
    adapterId: MATERIAL_ADAPTER, collectionId: input.collectionId, cursor: input.coverage?.fromCursor ?? null,
    ...(input.resumeKey ? { resumeKey: input.resumeKey } : {}),
    policyRef: input.policyRef, purpose: input.purpose, items,
    coverage: input.coverage ?? { manifest: manifestForItems(items), branchPolicy: "declared_subset", declaredBranches: items.map(item => item.upstreamId),
      upstreamSnapshot: input.snapshotId, fromCursor: null, toCursor: input.snapshotId, expectedCount: items.length },
  }, ports);
}

const run = promisify(execFile);

/** Ingestion leg of synchronization for explicitly mapped committed files. Stable IDs survive moves.
 * Existing understanding reassessment/deletion propagation remains the synchronize coordinator's job.
 */
export async function synchronizeRepositoryImports(input: {
  operationId: string; expectedRevision: string; sourceRevision: string; collectionId: string;
  capturedAt: string; policyRef: VersionedRef; purpose: IngestRequest["purpose"];
  files: Array<{ upstreamId: string; relativePath: string; sha256: string; mediaType: string;
    provenance: MaterialProvenance; authoredAt?: string | null }>;
}, ports: IngestPorts) {
  input = structuredClone(input);
  if (!/^[a-f0-9]{40}$/.test(input.sourceRevision) || !input.files.length) throw new IngestError("invalid_repository_import");
  const materials: MaterialImport[] = [];
  for (const file of input.files) {
    if (!file.relativePath || file.relativePath.includes("\\") || file.relativePath.split("/").some(part =>
      !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes(":"))) {
      throw new IngestError("invalid_repository_import");
    }
    let bytes: Buffer;
    try {
      const tree = await run("git", ["-C", ports.reader.root, "ls-tree", "-z", input.sourceRevision, "--", file.relativePath]);
      if (!/^100(644|755) blob [a-f0-9]{40}\t[^\0]+\0$/.test(tree.stdout)) throw new Error("not a regular committed file");
      bytes = (await run("git", ["-C", ports.reader.root, "cat-file", "blob", `${input.sourceRevision}:${file.relativePath}`],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch { throw new IngestError("source_unavailable"); }
    if (bytesVersion(bytes) !== file.sha256) throw new IngestError("repository_source_changed");
    let current: Buffer;
    try { current = await readRepositoryBytes(ports.reader.root, file.relativePath); }
    catch { throw new IngestError("source_unavailable"); }
    if (!bytes.equals(current)) throw new IngestError("repository_source_changed");
    materials.push({ upstreamId: file.upstreamId, capturedAt: input.capturedAt, authoredAt: file.authoredAt,
      provenance: file.provenance, original: { bytes, sha256: file.sha256, mediaType: file.mediaType },
      repository: { revision: input.sourceRevision, path: file.relativePath } });
  }
  return ingestMaterials({ operationId: input.operationId, expectedRevision: input.expectedRevision,
    collectionId: input.collectionId, entry: "repository", snapshotId: input.sourceRevision, materials,
    policyRef: input.policyRef, purpose: input.purpose }, ports);
}
