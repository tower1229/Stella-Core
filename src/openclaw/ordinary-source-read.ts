import path from "node:path";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { satisfies } from "semver";
import { parse as parseYaml } from "yaml";
import { Type } from "typebox";
import { CatalogError, CatalogReader, readRepositoryBytes, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import type { SourceAccessDescriptor } from "../canghai/source-access.js";
import { sourceSegments, assertEvidenceSegment, segmentLocator, type SegmentLocator } from "../canghai/source-segments.js";
import { MAX_CANGHAI_DOCUMENT_BYTES, parseConsciousnessManifest } from "../canghai/manifest.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { EpisodeEvidenceResolver, evidenceTemporallyEligible, type EvidencePurpose } from "../praxis/episode-evidence.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { isRecord } from "../shared/type-guards.js";

export const SOURCE_READ_TOOL = "stella_source_read";
export const MAX_SOURCE_LIST_BYTES = 128 * 1024;
export type SourceReadBinding = Readonly<{ root: string; manifestPath: string; revision: string }>;
/** Supplied by an existing trusted request/source-processing adapter, never tool
 * arguments or plugin config. Root selection and owner status do not mint it. */
export type SourceReadAdmission = {
  assertCurrent(): void | Promise<void>;
  /** Return the existing, processing-authorized leaf descriptor. false is an
   * explicit scope exclusion, never an arbitrary error or a grant to read text. */
  assertMetadata(reader: CatalogReader, ref: VersionedRef): Promise<SourceAccessDescriptor | false>;
  purpose: EvidencePurpose;
};
const run = promisify(execFile);
const check: (ok: unknown, code: string) => asserts ok = (ok, code) => { if (!ok) throw new CatalogError(code); };
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
function relative(v: unknown): string {
  check(text(v) && !path.isAbsolute(v) && !v.includes("\\") && !v.includes(":") &&
    !v.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"), "source_binding_invalid");
  const ref = parseCangHaiRef(`path:${v}`);
  check(!ref.fragment && ref.relativePath === v && !v.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"), "source_binding_invalid");
  return v;
}
export function parseSourceReadBinding(value: unknown): SourceReadBinding {
  check(isRecord(value), "source_binding_invalid");
  const v = structuredClone(value);
  check(Object.keys(v).sort().join() === "manifestPath,revision,root" && text(v.root) && path.isAbsolute(v.root) &&
    path.normalize(v.root) === v.root && typeof v.revision === "string" && /^[a-f0-9]{40}$/.test(v.revision), "source_binding_invalid");
  return Object.freeze({ root: v.root, manifestPath: relative(v.manifestPath), revision: v.revision });
}
const refSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 512 }), version: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }) }, { additionalProperties: false });
export const SOURCE_READ_PARAMETERS = Type.Union([
  Type.Object({ action: Type.Literal("list"), cursor: Type.Optional(Type.Object({ catalogHash: Type.String(), offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read"), ref: refSchema }, { additionalProperties: false }),
]);
function parameters(value: unknown) {
  check(isRecord(value), "source_arguments_invalid");
  const v = structuredClone(value);
  if (v.action === "read") {
    check(Object.keys(v).sort().join() === "action,ref" && validMemoryRef(v.ref) && Object.keys(v.ref).sort().join() === "id,version", "source_arguments_invalid");
    return { action: "read" as const, ref: { id: v.ref.id, version: v.ref.version } };
  }
  check(v.action === "list" && Object.keys(v).every(k => k === "action" || k === "cursor"), "source_arguments_invalid");
  const c = v.cursor;
  check(c === undefined || isRecord(c) && Object.keys(c).sort().join() === "catalogHash,offset" &&
    typeof c.catalogHash === "string" && /^sha256:[a-f0-9]{64}$/.test(c.catalogHash) && Number.isSafeInteger(c.offset) && Number(c.offset) >= 0, "source_arguments_invalid");
  return { action: "list" as const, cursor: c as { catalogHash: string; offset: number } | undefined };
}
function pathRef(raw: string) {
  try { const ref = parseCangHaiRef(raw); check(!ref.fragment, "source_reference_fragment_unsupported"); return relative(ref.relativePath); }
  catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("source_reference_invalid"); }
}
const timestamp = (v: unknown, nullable = false) => nullable && v === null || typeof v === "string" && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(v) && Number.isFinite(Date.parse(v));

/** One invocation, no retained reader/qualification across requests. This narrow
 * loader reads only the chosen manifest/profile/catalog, not all consciousness
 * references, bootstrap files or capability acceptance records. */
export async function executeOrdinarySourceRead(input: {
  binding: SourceReadBinding; agentId: string; hostVersion: string; parameters: unknown;
  admission: SourceReadAdmission; signal?: AbortSignal;
}) {
  const { agentId, hostVersion, signal } = input;
  const binding = parseSourceReadBinding(input.binding), args = parameters(input.parameters);
  const originalGuard = input.admission.assertCurrent.bind(input.admission);
  const metadata = input.admission.assertMetadata.bind(input.admission);
  const supplied = input.admission.purpose;
  check(typeof supplied.sourceAccess === "function", "source_access_context_required");
  const sourceAccess = supplied.sourceAccess.bind(supplied);
  const purpose: EvidencePurpose = { ...structuredClone({ readPurpose: supplied.readPurpose, derivePurpose: supplied.derivePurpose,
    deliveryScope: supplied.deliveryScope, evidenceCutoff: supplied.evidenceCutoff, trustedAdapters: supplied.trustedAdapters,
    ...(supplied.eventWindow ? { eventWindow: supplied.eventWindow } : {}) }),
    sourceAccess: async (...args) => {
      await guard(); const decision = await sourceAccess(...args); await guard(); return decision;
    }, ...(signal ? { signal } : {}) };
  const guard = async () => { signal?.throwIfAborted(); await originalGuard(); signal?.throwIfAborted(); };
  await guard();
  check(await realpath(binding.root) === binding.root, "source_root_not_canonical"); await guard();
  // Keep the selected checkout fixed and clean. No git mutations or network.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = async (args: string[]) => {
    await guard();
    const result = await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-C", binding.root, ...args],
      { env, maxBuffer: 2 * 1024 * 1024 });
    await guard(); return result.stdout;
  };
  const pin = async (file: string, hash: string, at = binding.revision) => {
    await guard();
    const { stdout } = await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", binding.root,
      "cat-file", "blob", `${at}:${relative(file)}`], { env, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    await guard(); check(bytesVersion(stdout) === hash, "source_git_blob_mismatch"); return stdout;
  };
  const revision = async () => {
    check((await git(["rev-parse", "HEAD"])).trim() === binding.revision, "source_revision_mismatch");
    check((await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) === "", "source_repository_dirty");
  };
  await revision();
  const document = async (file: string) => {
    await guard(); const b = await readRepositoryBytes(binding.root, file); await guard();
    check(b.length <= MAX_CANGHAI_DOCUMENT_BYTES, "source_document_capacity");
    return { bytes: b, text: new TextDecoder("utf-8", { fatal: true }).decode(b), hash: bytesVersion(b) };
  };
  const manifestBytes = await document(binding.manifestPath), manifest = parseConsciousnessManifest(manifestBytes.text);
  await pin(binding.manifestPath, manifestBytes.hash);
  check(satisfies("3.0.0-alpha.0", manifest.compatibility.stellaCore, { includePrerelease: true }) &&
    satisfies(hostVersion, manifest.compatibility.openclaw, { includePrerelease: true }), "source_compatibility_mismatch");
  const profilePath = pathRef(manifest.identity.runtimeProfileRef);
  check(manifest.runtimeState.runtimeProfileRef === undefined || pathRef(manifest.runtimeState.runtimeProfileRef) === profilePath, "source_profile_reference_conflict");
  const profileBytes = await document(profilePath), profile = parseRuntimeProfile(parseYaml(profileBytes.text));
  await pin(profilePath, profileBytes.hash);
  check(profile.agent_id === agentId && profile.memory !== undefined, "source_profile_binding_mismatch");
  const catalogPath = pathRef(profile.memory.catalog_ref), reader = await CatalogReader.load(binding.root, catalogPath); await guard();
  await pin(catalogPath, reader.catalogHash);
  const resolver = new EpisodeEvidenceResolver(reader, purpose, async () => { throw new CatalogError("source_read_does_not_run_models"); });
  const pinned = new Set<string>();
  const pinRef = async (ref: VersionedRef): Promise<void> => {
    const key = `${ref.id}:${ref.version}`;
    if (pinned.has(key)) return;
    const e = reader.entry(ref); await pin(e.locator.path, e.locator.sha256); pinned.add(key);
    for (const dependency of [...e.dependencies, ...(e.metadataRef ? [e.metadataRef] : [])]) await pinRef(dependency);
  };
  const current = async () => {
    await guard(); await reader.assertCurrent(); await guard();
    check((await document(binding.manifestPath)).hash === manifestBytes.hash && (await document(profilePath)).hash === profileBytes.hash, "source_binding_changed");
    await revision();
  };
  const snapshot = { revision: binding.revision, generationId: reader.catalog.generationId, catalogHash: reader.catalogHash,
    manifestHash: manifestBytes.hash, profileHash: profileBytes.hash, scope: "selected_manifest_catalog" as const };
  if (args.action === "list") {
    check(!args.cursor || args.cursor.catalogHash === reader.catalogHash, "source_cursor_stale");
    const entries = reader.catalog.evidence.filter(e => e.status === "current" && reader.eligible(e));
    const offset = args.cursor?.offset ?? 0; check(offset <= entries.length, "source_cursor_invalid");
    const items: Array<{ ref: VersionedRef; sourceRef: VersionedRef; policyRef: VersionedRef; description: string; segment?: SegmentLocator;
      role: unknown; kind: unknown; occurredAt: unknown; authoredAt: unknown; capturedAt: unknown }> = [];
    let excludedByScopeOnPage = 0, excludedByTimeOnPage = 0, scanned = 0;
    const page = entries.slice(offset, offset + 32);
    const listed = () => ({ status: "listed" as const, ...snapshot, items,
      nextCursor: offset + scanned < entries.length ? { catalogHash: reader.catalogHash, offset: offset + scanned } : null,
      excludedByScopeOnPage, excludedByTimeOnPage, descriptionUse: "untrusted_locator_not_evidence" as const,
      semanticSelection: "not_performed" as const, questionSufficiency: "not_assessed" as const });
    for (const entry of page) {
      const ref = { id: entry.id, version: entry.version };
      await guard();
      const allowed = await metadata(reader, ref); await guard();
      if (allowed === false) { excludedByScopeOnPage++; scanned++; continue; }
      // Snapshot before another await; never release arbitrary grant fields or
      // substitute original text when a reviewed description is unavailable.
      const descriptor = structuredClone(allowed);
      check(isRecord(descriptor) && validMemoryRef(descriptor.sourceRef) && validMemoryRef(descriptor.policyRef) &&
        typeof descriptor.description === "string" && descriptor.description.trim() && descriptor.description.length <= 8_000,
      "source_descriptor_unavailable");
      await pinRef(ref);
      const e = await reader.read(ref, "evidence"); await guard();
      check(validMemoryRef(e.source) && validMemoryRef(e.policyRef) && ["owner", "other", "assistant", "tool", "external_author", "unknown"].includes(String(e.role)) &&
        ["direct_observation", "reported", "inference", "quotation", "unknown"].includes(String(e.kind)) && timestamp(e.occurredAt, true) &&
        timestamp(e.authoredAt, true) && timestamp(e.capturedAt), "invalid_evidence");
      if (!evidenceTemporallyEligible(e, purpose)) { excludedByTimeOnPage++; scanned++; continue; }
      const source = await reader.read(e.source, "sources"); await guard();
      const segment = assertEvidenceSegment(sourceSegments(source), e);
      check(descriptor.sourceRef.id === e.source.id && descriptor.sourceRef.version === e.source.version &&
        descriptor.policyRef.id === e.policyRef.id && descriptor.policyRef.version === e.policyRef.version &&
        canonicalJson(descriptor.segment ?? null) === canonicalJson(segment ? segmentLocator(segment) : null),
      "source_descriptor_mismatch");
      items.push({ ref, sourceRef: { id: e.source.id, version: e.source.version },
        policyRef: { id: e.policyRef.id, version: e.policyRef.version }, ...(segment ? { segment: segmentLocator(segment) } : {}),
        description: descriptor.description, role: e.role, kind: e.kind, occurredAt: e.occurredAt, authoredAt: e.authoredAt, capturedAt: e.capturedAt });
      scanned++;
      if (Buffer.byteLength(JSON.stringify(listed()), "utf8") > MAX_SOURCE_LIST_BYTES) {
        items.pop(); scanned--;
        check(items.length > 0, "source_list_output_capacity");
        break; // Resume at this complete item, never truncate or silently skip it.
      }
    }
    await current();
    const result = listed();
    check(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SOURCE_LIST_BYTES, "source_list_output_capacity");
    return result;
  }
  const allowed = await metadata(reader, args.ref); await guard();
  check(allowed !== false, "source_descriptor_scope_denied");
  await pinRef(args.ref);
  const original = await resolver.readEvidence(args.ref, guard); await guard();
  check(Buffer.byteLength(original.text, "utf8") <= 128 * 1024, "source_output_capacity");
  const e = await reader.read(args.ref, "evidence");
  check(validMemoryRef(e.source), "invalid_evidence");
  const source = await reader.read(e.source, "sources");
  check(Array.isArray(source.payloads), "invalid_source");
  const payload = source.payloads.find(p => isRecord(p) && p.sha256 === e.payloadSha256);
  check(isRecord(payload) && typeof payload.path === "string" && typeof payload.sha256 === "string", "invalid_payload");
  check(payload.revision === undefined || typeof payload.revision === "string" && /^[a-f0-9]{40}$/.test(payload.revision), "invalid_payload_revision");
  const pinnedPayload = await pin(payload.path, payload.sha256, payload.revision as string | undefined);
  if (isRecord(e.selector) && e.selector.kind === "utf8_bytes" && typeof e.selector.value === "string") {
    const [start, end] = e.selector.value.split(":").map(Number);
    check(Buffer.from(original.text, "utf8").equals(pinnedPayload.subarray(start, end)), "source_text_representation_unverified");
  }
  await current();
  check(isRecord(e.selector) && typeof e.selector.kind === "string" && typeof e.selector.value === "string", "invalid_selector");
  return { status: "read" as const, ...snapshot, original, sourceRef: { id: e.source.id, version: e.source.version },
    locator: { payloadSha256: e.payloadSha256, selector: { kind: e.selector.kind, value: e.selector.value } }, authorConfirmation: false, publisher: false };
}

export function sourceReadFailure(error: unknown): string {
  return error instanceof CatalogError && /^[a-z][a-z0-9_]{0,95}$/.test(error.category) ? error.category : "source_read_failed";
}
