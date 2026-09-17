import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CatalogError, parseMemoryCatalog, validMemoryRef, type CatalogEntry, type CatalogGroup, type MemoryCatalog } from "./catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "./content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { parseSourcePolicy } from "./source-policy.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import type { MemoryFileChange } from "./memory-transaction.js";

const run = promisify(execFile);
export const catalogGroups = ["sources", "evidence", "policies", "understandings", "works", "changes", "bundles", "coverage"] as const;
export const refKey = (ref: VersionedRef) => canonicalJson({ id: ref.id, version: ref.version });
export function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
export async function git(root: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], { maxBuffer: 20 * 1024 * 1024 })).stdout;
}
export async function blob(root: string, revision: string, file: string): Promise<Buffer | null> {
  check(/^[a-f0-9]{40}$/.test(revision) && file && !file.includes("\\") &&
    file.split("/").every(part => part && ![".", "..", ".git"].includes(part) && !part.includes(":")), "unsafe_locator");
  const tree = await git(root, "ls-tree", "-z", revision, "--", file);
  if (!tree) return null;
  check(/^100(644|755) blob [a-f0-9]{40}\t/.test(tree), "unsafe_locator");
  return (await run("git", ["-C", root, "cat-file", "blob", `${revision}:${file}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout;
}
export function record(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new CatalogError("invalid_record"); }
  check(isRecord(value), "invalid_record"); return value;
}
/** Rebuild dependency edges from persistent object bodies, not solely a cached graph. */
export function objectRefs(value: unknown): VersionedRef[] {
  if (validMemoryRef(value) && Object.keys(value).length === 2) return [{ id: value.id, version: value.version }];
  if (Array.isArray(value)) return value.flatMap(objectRefs);
  if (isRecord(value)) return Object.values(value).flatMap(objectRefs);
  return [];
}
export async function baseline(root: string, revision: string, catalogPath: string) {
  const bytes = await blob(root, revision, catalogPath);
  check(bytes, "catalog_unavailable");
  const catalog = parseMemoryCatalog(record(bytes));
  const objects = new Map<string, Record<string, unknown>>();
  for (const group of catalogGroups) for (const entry of catalog[group]) {
    if (entry.status === "removed") continue;
    const data = await blob(root, revision, entry.locator.path);
    check(data && bytesVersion(data) === entry.locator.sha256, "locator_digest_mismatch");
    const object = record(data);
    check(object.id === entry.id && objectVersion(object) === entry.version, "object_version_mismatch");
    objects.set(refKey(entry), object);
  }
  return { catalog, objects, bytes: bytes.toString("utf8") };
}

export async function prepareSourceChanges(input: {
  root: string; fromRevision: string; toRevision: string; catalog: MemoryCatalog;
  objects: Map<string, Record<string, unknown>>; objectRoot: string;
}) {
  const catalog = structuredClone(input.catalog);
  const files: MemoryFileChange[] = [];
  const objects = new Map(input.objects);
  const replacements = new Map<string, VersionedRef>();
  const changed = new Set<string>();
  const removedSourceIds: string[] = [];
  const additions: string[] = [];
  const moves = new Map<string, string>();
  const changedPaths = new Set<string>();
  const removedPaths: string[] = [];
  const delta = (await git(input.root, "diff", "--name-status", "-z", "--find-renames=100%", input.fromRevision, input.toRevision, "--")).split("\0");
  for (let i = 0; i < delta.length - 1;) {
    const status = delta[i++]!, old = delta[i++]!;
    changedPaths.add(old);
    if (status === "R100") moves.set(old, delta[i++]!);
    else if (status === "A") additions.push(old);
    else if (status === "D") removedPaths.push(old);
  }
  // Git similarity is a locator hint, not proof of Source identity. Equal-content moves must be unique.
  for (const [from, to] of moves) {
    const content = await blob(input.root, input.fromRevision, from);
    check(content, "source_unavailable");
    const digest = bytesVersion(content);
    const oldMatches = await Promise.all([...moves.keys(), ...removedPaths].map(async file => {
      const bytes = await blob(input.root, input.fromRevision, file); return bytes && bytesVersion(bytes) === digest;
    }));
    const newMatches = await Promise.all([...moves.values(), ...additions].map(async file => {
      const bytes = await blob(input.root, input.toRevision, file); return bytes && bytesVersion(bytes) === digest;
    }));
    check(oldMatches.filter(Boolean).length === 1 && newMatches.filter(Boolean).length === 1 && to, "ambiguous_source_move");
  }
  const unique = (refs: VersionedRef[]) => [...new Map(refs.map(ref => [refKey(ref), { id: ref.id, version: ref.version }])).values()];
  const rebind = (ref: VersionedRef) => replacements.get(refKey(ref)) ?? { id: ref.id, version: ref.version };
  const add = (group: CatalogGroup, value: Record<string, unknown>, dependencies: VersionedRef[], previous?: CatalogEntry) => {
    const version = objectVersion(value), ref = { id: String(value.id), version };
    const bytes = canonicalJson({ ...value, version });
    const file = `${input.objectRoot}/${encodeURIComponent(ref.id)}/${version.slice(7)}.json`;
    if (previous) {
      previous.status = "superseded"; changed.add(refKey(previous)); replacements.set(refKey(previous), ref);
    }
    const existing = catalog[group].find(entry => refKey(entry) === refKey(ref));
    check(existing?.status !== "removed", "source_removed");
    const entry: CatalogEntry = { ...ref, status: "current", locator: { path: file, sha256: bytesVersion(bytes) }, dependencies: unique(dependencies) };
    if (existing) Object.assign(existing, entry);
    else catalog[group].push(entry);
    objects.set(refKey(ref), { ...value, version }); files.push({ path: file, before: null, after: bytes });
    return ref;
  };
  for (const policy of catalog.policies.filter(entry => entry.status === "current")) {
    const bytes = await blob(input.root, input.toRevision, moves.get(policy.locator.path) ?? policy.locator.path);
    if (!bytes) { policy.status = "removed"; changed.add(refKey(policy)); continue; }
    if (bytesVersion(bytes) === policy.locator.sha256) {
      policy.locator.path = moves.get(policy.locator.path) ?? policy.locator.path;
      continue;
    }
    const next = record(bytes); check(next.id === policy.id, "source_identity_changed");
    parseSourcePolicy(next);
    if (objectVersion(next) === policy.version) {
      policy.locator = { path: moves.get(policy.locator.path) ?? policy.locator.path, sha256: bytesVersion(bytes) };
      objects.set(refKey(policy), next);
      continue;
    }
    const livePath = moves.get(policy.locator.path) ?? policy.locator.path;
    const nextRef = add("policies", next, objectRefs(next), policy);
    // The owner's file stays the live policy authority across repeated edits.
    files.pop();
    catalog.policies.find(entry => refKey(entry) === refKey(nextRef))!.locator = { path: livePath, sha256: bytesVersion(bytes) };
    objects.set(refKey(nextRef), next);
    // Preserve the sealed policy bytes at an immutable location; never overwrite the user's edit.
    const old = input.objects.get(refKey(policy))!;
    const oldBytes = canonicalJson(old), oldPath = `${input.objectRoot}/history/${encodeURIComponent(policy.id)}/${policy.version.slice(7)}.json`;
    policy.locator = { path: oldPath, sha256: bytesVersion(oldBytes) };
    files.push({ path: oldPath, before: null, after: oldBytes });
  }
  for (const source of catalog.sources.filter(entry => entry.status === "current")) {
    const old = input.objects.get(refKey(source))!;
    check(Array.isArray(old.payloads) && validMemoryRef(old.policyRef) && validMemoryRef(old.coverageRef), "invalid_source");
    const next = structuredClone(old);
    let removed = false, contentChanged = false, moved = false;
    next.payloads = await Promise.all(old.payloads.map(async (payload: unknown) => {
      check(isRecord(payload) && typeof payload.path === "string" && typeof payload.sha256 === "string", "invalid_payload");
      // Explicitly archived historical payloads are immutable; current eligibility remains catalog-owned.
      if (payload.revision !== undefined && !changedPaths.has(payload.path)) return payload;
      const target = moves.get(payload.path) ?? payload.path;
      const bytes = await blob(input.root, input.toRevision, target);
      if (!bytes) { removed = true; return payload; }
      moved ||= target !== payload.path;
      contentChanged ||= bytesVersion(bytes) !== payload.sha256;
      const { revision: _revision, ...currentPayload } = payload;
      return { ...currentPayload, path: target, bytes: bytes.length, sha256: bytesVersion(bytes) };
    }));
    next.policyRef = rebind(old.policyRef);
    if (Array.isArray(next.accessSegments)) next.accessSegments = next.accessSegments.map(segment => {
      check(isRecord(segment) && validMemoryRef(segment.policyRef), "invalid_source_segment");
      return { ...segment, policyRef: rebind(segment.policyRef) };
    });
    const dependencies = unique(objectRefs({ policyRef: next.policyRef, coverageRef: next.coverageRef, accessSegments: next.accessSegments ?? [] }));
    if (removed || dependencies.some(ref => catalog.policies.some(policy => refKey(policy) === refKey(ref) && policy.status === "removed"))) {
      source.status = "removed"; changed.add(refKey(source)); removedSourceIds.push(source.id); continue;
    }
    if (contentChanged) check(old.schemaVersion === "stella.memory-source/v1", "source_segment_reassessment_required");
    if (objectVersion(next) !== source.version) {
      add("sources", next, dependencies, source);
      // Pin historical originals to their actual retained revision, never to today's edited file.
      const historical = { ...old, payloads: old.payloads.map(payload => ({ ...(payload as Record<string, unknown>),
        revision: (payload as Record<string, unknown>).revision ?? input.fromRevision })) };
      const file = `${input.objectRoot}/history/${encodeURIComponent(source.id)}/${source.version.slice(7)}.json`;
      const retained = await blob(input.root, input.toRevision, file);
      const sealed = retained ? record(retained) : historical;
      check(objectVersion(sealed) === source.version && Array.isArray(sealed.payloads), "object_version_mismatch");
      for (const payload of sealed.payloads) {
        check(isRecord(payload) && typeof payload.revision === "string" && typeof payload.path === "string", "invalid_payload_revision");
        const bytes = await blob(input.root, payload.revision, payload.path);
        check(bytes && bytesVersion(bytes) === payload.sha256 && bytes.length === payload.bytes, "payload_digest_mismatch");
      }
      const bytes = retained?.toString("utf8") ?? canonicalJson(sealed);
      source.locator = { path: file, sha256: bytesVersion(bytes) }; files.push({ path: file, before: null, after: bytes });
      objects.set(refKey(source), sealed);
    } else if (moved) {
      // Paths do not participate in Source Version. Relocation retains exact Source identity.
      const bytes = canonicalJson(next), file = `${input.objectRoot}/locations/${encodeURIComponent(source.id)}/${bytesVersion(bytes).slice(7)}.json`;
      source.locator = { path: file, sha256: bytesVersion(bytes) }; files.push({ path: file, before: null, after: bytes }); objects.set(refKey(source), next);
    }
  }
  for (const entry of catalog.sources) if (removedSourceIds.includes(entry.id)) entry.status = "removed";
  for (const evidence of catalog.evidence.filter(entry => entry.status === "current")) {
    const old = input.objects.get(refKey(evidence))!;
    check(validMemoryRef(old.source) && validMemoryRef(old.policyRef), "invalid_evidence");
    const sourceRef = rebind(old.source), source = catalog.sources.find(entry => refKey(entry) === refKey(sourceRef));
    if (source?.status === "removed") { evidence.status = "removed"; changed.add(refKey(evidence)); continue; }
    const next = { ...old, source: sourceRef, policyRef: rebind(old.policyRef) };
    if (sourceRef.version !== old.source.version) {
      const sourceObject = objects.get(refKey(sourceRef))!;
      check(Array.isArray(sourceObject.payloads), "invalid_source");
      const oldSource = input.objects.get(refKey(old.source))!;
      check(Array.isArray(oldSource.payloads), "invalid_source");
      const index = oldSource.payloads.findIndex(payload => isRecord(payload) && payload.sha256 === old.payloadSha256);
      const payload: unknown = sourceObject.payloads[index];
      check(isRecord(payload), "payload_unavailable");
      if (payload.sha256 !== old.payloadSha256) {
        // An edited file is not automatically the old speaker's statement or the same fragment.
        check(typeof payload.bytes === "number" && payload.bytes > 0 && typeof payload.mediaType === "string" &&
          (payload.mediaType.startsWith("text/") || payload.mediaType === "application/json"), "source_evidence_adapter_required");
        Object.assign(next, { payloadSha256: payload.sha256, selector: { kind: "utf8_bytes", value: `0:${payload.bytes}` },
          role: "unknown", kind: "unknown", speakerId: null, authoredAt: null, occurredAt: null });
      }
    }
    if (objectVersion(next) !== evidence.version) add("evidence", next, objectRefs(next), evidence);
  }
  // Compute closure using both persisted bodies and catalog edges (including metadata).
  let grew = true;
  while (grew) {
    grew = false;
    for (const group of catalogGroups) for (const entry of input.catalog[group]) {
      if (entry.status !== "current" || changed.has(refKey(entry))) continue;
      const dependencies = [...entry.dependencies, ...(entry.metadataRef ? [entry.metadataRef] : []), ...objectRefs(input.objects.get(refKey(entry)))];
      if (dependencies.some(ref => changed.has(refKey(ref)))) { changed.add(refKey(entry)); grew = true; }
    }
  }
  for (const group of ["understandings", "works", "changes", "bundles"] as const) {
    for (const entry of catalog[group]) if (changed.has(refKey(entry))) entry.status = "superseded";
  }
  return { catalog, files, objects, changed, removedSourceIds, additions, add };
}
