import { bytesVersion, canonicalJson } from "./content-version.js";
import { CatalogError } from "./catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import type { IngestItem } from "./ingest.js";

/** An upstream declaration, independent of which items have actually arrived. */
export type ArchiveManifest = {
  schemaVersion: "stella.archive-manifest/v1";
  items: Array<{
    upstreamId: string;
    textSha256: string | null;
    unavailable?: boolean;
    attachments: Array<{ upstreamId: string; sha256: string | null; unavailable?: boolean }>;
  }>;
};
export type ArchiveGap = { upstreamId: string; reason: string; retryable: boolean };

const check: (value: unknown) => asserts value = (value) => {
  if (!value) throw new CatalogError("invalid_archive_manifest");
};
const digest = (value: unknown) => value === null || typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

export function parseArchiveManifest(value: unknown): ArchiveManifest {
  check(isRecord(value) && value.schemaVersion === "stella.archive-manifest/v1" && Array.isArray(value.items));
  check(value.items.length > 0 && value.items.length <= 32);
  const ids = new Set<string>();
  const items = value.items.map((item) => {
    check(isRecord(item) && typeof item.upstreamId === "string" && item.upstreamId.trim() &&
      !ids.has(item.upstreamId) && digest(item.textSha256) && Array.isArray(item.attachments));
    ids.add(item.upstreamId);
    const attachmentIds = new Set<string>();
    const attachments = item.attachments.map((attachment) => {
      check(isRecord(attachment) && typeof attachment.upstreamId === "string" && attachment.upstreamId.trim() &&
        !attachmentIds.has(attachment.upstreamId) && digest(attachment.sha256));
      check(attachment.unavailable === undefined || typeof attachment.unavailable === "boolean");
      attachmentIds.add(attachment.upstreamId);
      return { upstreamId: attachment.upstreamId, sha256: attachment.sha256 as string | null,
        ...(attachment.unavailable === undefined ? {} : { unavailable: attachment.unavailable }) };
    });
    check(item.unavailable === undefined || typeof item.unavailable === "boolean");
    return { ...(item.unavailable === undefined ? {} : { unavailable: item.unavailable }), upstreamId: item.upstreamId, textSha256: item.textSha256 as string | null, attachments };
  });
  const parsed: ArchiveManifest = { schemaVersion: "stella.archive-manifest/v1", items };
  check(canonicalJson(parsed) === canonicalJson(value));
  return parsed;
}

/** Snapshot adapters declare their explicit batch; paged adapters supply their own manifest. */
export function manifestForItems(items: IngestItem[]): ArchiveManifest {
  return parseArchiveManifest({ schemaVersion: "stella.archive-manifest/v1", items: items.map(item => ({
    upstreamId: item.upstreamId, textSha256: bytesVersion(item.text),
    attachments: (item.attachments ?? []).map(attachment => ({ upstreamId: attachment.upstreamId,
      sha256: null, ...(attachment.externalUrl ? { unavailable: true } : {}) })),
  })) });
}

export function inspectManifestItems(manifest: ArchiveManifest, items: IngestItem[]): ArchiveGap[] {
  parseArchiveManifest(manifest);
  check(new Set(items.map(item => item.upstreamId)).size === items.length);
  check(items.every(item => manifest.items.some(expected => expected.upstreamId === item.upstreamId)));
  const gaps: ArchiveGap[] = [];
  for (const expected of manifest.items) {
    const item = items.find(candidate => candidate.upstreamId === expected.upstreamId);
    if (!item) {
      gaps.push({ upstreamId: expected.upstreamId, reason: "source_missing", retryable: !expected.unavailable });
      continue;
    }
    if (expected.textSha256 === null) gaps.push({ upstreamId: expected.upstreamId, reason: "original_digest_unknown", retryable: false });
    else check(bytesVersion(item.text) === expected.textSha256);
    const attachments = item.attachments ?? [];
    check(new Set(attachments.map(attachment => attachment.upstreamId)).size === attachments.length);
    check(attachments.every(attachment => expected.attachments.some(declaration => declaration.upstreamId === attachment.upstreamId)));
    for (const declaration of expected.attachments) {
      const actual = attachments.find(attachment => attachment.upstreamId === declaration.upstreamId);
      if (!actual || actual.bytes == null) {
        gaps.push({ upstreamId: declaration.upstreamId, reason: "attachment_missing", retryable: !declaration.unavailable && !actual?.externalUrl });
      } else if (declaration.sha256 === null) {
        // Bytes may arrive after an upstream declared a pending attachment.
        continue;
      } else check(bytesVersion(actual.bytes) === declaration.sha256);
    }
  }
  return gaps;
}
