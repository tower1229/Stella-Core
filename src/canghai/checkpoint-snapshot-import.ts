import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { CatalogError, CatalogReader, parseMemoryCatalog, readRepositoryBytes, selectTextEvidence, validMemoryRef, type CatalogEntry, type MemoryCatalog } from "./catalog-reader.js";
import { bytesVersion, canonicalJson } from "./content-version.js";
import { readCheckpointCommittedDocument } from "./checkpoint-committed-document.js";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";
import { loadConsciousness, parseConsciousnessManifest } from "./manifest.js";
import { applyMemoryTransaction, readRecordedMemoryTransaction, type MemoryTransactionPlan } from "./memory-transaction.js";
import { parsePersonalContextAccess } from "./personal-context-access.js";
import type { CheckpointRecoveryRuntime, RecoveryAuthoritySnapshot } from "./recovery-authority-contract.js";
import { parseRuntimeProfile } from "./runtime-profile.js";
import { parseSourcePolicy } from "./source-policy.js";
import { sourceAccessKey } from "./source-access.js";
import { assertEvidenceSegment, segmentLocator, sourceSegments } from "./source-segments.js";
import { isRecord } from "../shared/type-guards.js";
import { loadPraxisRuntimeBinding } from "../praxis/runtime-binding.js";

const run = promisify(execFile), SHA = /^[a-f0-9]{40}$/;
const groups = ["sources", "evidence", "coverage"] as const;
const unchangedGroups = ["policies", "understandings", "works", "changes", "bundles", "views"] as const;
type Input = { root: string; manifestPath: string; hostVersion: string; candidateRoot: string; producerBaseRevision: string;
  candidateRevision: string; operationId: string; expected: RecoveryAuthoritySnapshot };
type Ports = { authority: CheckpointRecoveryRuntime; commit(paths: string[], operationId: string): Promise<void>; signal?: AbortSignal };
function check(value: unknown, category = "snapshot_import_invalid"): asserts value { if (!value) throw new CatalogError(category); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const refKey = (ref: { id: string; version: string }) => canonicalJson([ref.id, ref.version]);
function relative(value: string): string {
  check(typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !/[. ]$/.test(part)), "snapshot_import_path_invalid");
  return value;
}
const below = (file: string, directory: string) => relative(file).startsWith(relative(directory) + "/");
function without(object: Record<string, unknown>, keys: string[]) { return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key))); }
function object(value: unknown): Record<string, unknown> { check(isRecord(value)); return value; }
function timestamp(value: unknown) { return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
function gitPort(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C" });
  return async (...args: string[]) => {
    try { return (await run("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false",
      "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-C", root, ...args], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 })).stdout; }
    catch { throw new CatalogError("snapshot_import_git_invalid"); }
  };
}
async function canonicalRepository(root: string) {
  check(path.isAbsolute(root) && path.resolve(root) === root && await realpath(root) === root, "snapshot_import_path_invalid");
  const stats = await lstat(root), metadata = await lstat(path.join(root, ".git"));
  check(stats.isDirectory() && !stats.isSymbolicLink() && !metadata.isSymbolicLink(), "snapshot_import_path_invalid");
  const git = gitPort(root);
  check((await git("rev-parse", "--show-toplevel")).trim() === root, "snapshot_import_path_invalid");
  const common = await realpath(path.resolve(root, (await git("rev-parse", "--git-common-dir")).trim()));
  try { await lstat(path.join(common, "objects/info/alternates")); throw new CatalogError("snapshot_import_shared_objects"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  return { git, common };
}
async function optionalBlob(root: string, revision: string, file: string): Promise<string | null> {
  const git = gitPort(root), entry = await git("ls-tree", "-z", revision, "--", ":(literal)" + relative(file));
  return entry ? readCheckpointCommittedDocument(root, revision, file) : null;
}
async function unchangedObjectBytes(root: string, revision: string, reader: CatalogReader, entry: CatalogEntry) {
  const bytes = await readCheckpointCommittedDocument(root, revision, entry.locator.path);
  check(bytesVersion(bytes) === entry.locator.sha256 && bytes === (await readRepositoryBytes(reader.root, entry.locator.path)).toString("utf8"), "snapshot_import_original_changed");
}
/** Data-only import into an existing authority. Local object/ref staging is preparation,
 * not consumer publication; only the existing journal/commit/CAS/fence publishes data.
 */
export async function importCheckpointSnapshot(input: Input, ports: Ports) {
  const selected = structuredClone(input), authority = ports.authority, commit = ports.commit, signal = ports.signal;
  check(SHA.test(selected.producerBaseRevision) && SHA.test(selected.candidateRevision) && selected.producerBaseRevision !== selected.candidateRevision &&
    /^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(selected.operationId));
  const { root, manifestPath, candidateRoot, expected } = selected;
  relative(manifestPath);
  check(expected.mode === "core_checkpoint" && authority.mode === "core_checkpoint" && expected.binding.repositoryRoot === root &&
    expected.binding.manifestPath === manifestPath && SHA.test(expected.revision), "snapshot_import_binding_mismatch");
  const active = () => signal?.throwIfAborted(); active();
  const currentRepo = await canonicalRepository(root), candidateRepo = await canonicalRepository(candidateRoot);
  check(root !== candidateRoot && currentRepo.common !== candidateRepo.common, "snapshot_import_shared_objects");
  const candidate = candidateRepo.git, base = selected.producerBaseRevision, revision = selected.candidateRevision;
  const candidateClean = async () => {
    active(); check((await candidate("rev-parse", "HEAD")).trim() === revision, "snapshot_import_candidate_changed");
    check((await candidate("status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")).trim() === "" &&
      (await candidate("ls-files", "-v", "-z")).split("\0").filter(Boolean).every(value => value.startsWith("H ")), "snapshot_import_candidate_dirty");
  };
  await candidateClean(); await candidate("merge-base", "--is-ancestor", base, revision);
  const loaded = await loadConsciousness(candidateRoot, manifestPath, { recoveryRevision: revision, coreVersion: "3.0.0-alpha.0",
    openclawVersion: selected.hostVersion, dataMode: "managed_durable_write" });
  const binding = await loadPraxisRuntimeBinding(loaded, { sourceSupplyOnly: true });
  const reader = await CatalogReader.load(candidateRoot, binding.catalogPath);
  const beforeBytes = await readCheckpointCommittedDocument(candidateRoot, base, binding.catalogPath);
  const afterBytes = await readCheckpointCommittedDocument(candidateRoot, revision, binding.catalogPath);
  check(afterBytes === (await readRepositoryBytes(candidateRoot, binding.catalogPath)).toString("utf8"), "snapshot_import_candidate_changed");
  const before = parseMemoryCatalog(JSON.parse(beforeBytes)), after = reader.catalog;
  check(after.parentGenerationId === before.generationId && after.generationId !== before.generationId, "snapshot_import_generation_invalid");
  for (const group of unchangedGroups) check(same(before[group], after[group]), "snapshot_import_protected_catalog_changed");
  const expectedCatalog = await readCheckpointCommittedDocument(root, expected.revision, binding.catalogPath);
  check(expectedCatalog === beforeBytes, "snapshot_import_catalog_conflict");
  // The consumer may have its own manifest/grant overlay, but not different runtime paths/purpose.
  const currentManifest = parseConsciousnessManifest(await readCheckpointCommittedDocument(root, expected.revision, manifestPath));
  check(currentManifest.identity.runtimeProfileRef === loaded.manifest.identity.runtimeProfileRef, "snapshot_import_binding_mismatch");
  const profilePath = relative(currentManifest.identity.runtimeProfileRef.replace(/^path:/, ""));
  const currentProfile = await readCheckpointCommittedDocument(root, expected.revision, profilePath);
  check(currentProfile === await readCheckpointCommittedDocument(candidateRoot, base, profilePath) &&
    await readCheckpointCommittedDocument(root, expected.revision, binding.configPath) === await readCheckpointCommittedDocument(candidateRoot, base, binding.configPath), "snapshot_import_binding_mismatch");
  parseRuntimeProfile(parseYaml(currentProfile));
  const access = binding.personalContextAccessPath ? parsePersonalContextAccess(JSON.parse(await readCheckpointCommittedDocument(root, expected.revision, binding.personalContextAccessPath))) : undefined;
  const objectGroups = ["sources", "evidence", "coverage", "policies", "understandings", "works", "changes", "bundles"] as const;
  const oldPaths = new Set(objectGroups.flatMap(group => before[group].map(entry => entry.locator.path)));
  const imported = new Map<string, string>(), newEntries: Array<{ group: typeof groups[number]; entry: CatalogEntry; previous: CatalogEntry }> = [];
  const addFile = async (file: string) => {
    check(below(file, binding.archive.objectRoot) || below(file, binding.archive.payloadRoot), "snapshot_import_scope_changed");
    check(!oldPaths.has(file) && await optionalBlob(candidateRoot, base, file) === null && await optionalBlob(root, expected.revision, file) === null, "snapshot_import_immutable_path_conflict");
    const bytes = await readCheckpointCommittedDocument(candidateRoot, revision, file);
    // This bounded importer handles UTF-8 data only; never round-trip binary through a lossy string.
    check(Buffer.from(bytes, "utf8").equals(await readRepositoryBytes(candidateRoot, file)), "snapshot_import_binary_unsupported");
    const existing = imported.get(file); check(existing === undefined || existing === bytes, "snapshot_import_path_conflict"); imported.set(file, bytes);
  };
  for (const group of [...groups, "policies"] as const) {
    for (const entry of before[group]) {
      const retained = after[group].find(value => refKey(value) === refKey(entry));
      check(retained && same(without(retained as unknown as Record<string, unknown>, ["status"]), without(entry as unknown as Record<string, unknown>, ["status"])) &&
        (retained.status === entry.status || entry.status === "current" && retained.status === "superseded" && after[group].some(value => value.id === entry.id && value.status === "current" && value.version !== entry.version)), "snapshot_import_original_changed");
      await unchangedObjectBytes(root, expected.revision, reader, entry);
      await reader.read(retained, group, "historical");
    }
    if (group === "policies") continue;
    for (const entry of after[group].filter(value => !before[group].some(old => refKey(old) === refKey(value)))) {
      const previous = before[group].find(value => value.id === entry.id && value.status === "current");
      check(previous && entry.status === "current" && below(entry.locator.path, binding.archive.objectRoot) &&
        same(entry.metadataRef ?? null, previous.metadataRef ?? null), "snapshot_import_new_identity");
      await addFile(entry.locator.path); newEntries.push({ group, entry, previous });
    }
  }
  check(newEntries.length > 0 && newEntries.length < 60);
  for (const { group, entry, previous } of newEntries) {
    const value = await reader.read(entry, group), old = object(JSON.parse(await readCheckpointCommittedDocument(root, expected.revision, previous.locator.path)));
    if (group === "sources") {
      check(["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(value.schemaVersion)) && isRecord(value.origin) &&
        validMemoryRef(value.policyRef) && validMemoryRef(value.coverageRef) && timestamp(value.capturedAt) && Array.isArray(value.payloads) && value.payloads.length > 0 &&
        same(without(value, ["version", "capturedAt", "payloads", "coverageRef", "accessSegments"]), without(old, ["version", "capturedAt", "payloads", "coverageRef", "accessSegments"])) &&
        value.coverageRef.id === object(old.coverageRef).id, "snapshot_import_source_changed");
      const segments = sourceSegments(value), policy = parseSourcePolicy(await reader.read(value.policyRef, "policies"));
      const dependencies = [...new Map([value.policyRef, value.coverageRef, ...segments.map(segment => segment.policyRef)].map(ref => [refKey(ref), ref])).values()];
      check(same(entry.dependencies, dependencies), "snapshot_import_dependency_invalid");
      check(same(segments.map(segment => segment.policyRef), sourceSegments(old).map(segment => segment.policyRef)), "snapshot_import_source_changed");
      const targets = segments.length ? segments.map(segment => ({ sourceRef: { id: entry.id, version: entry.version }, policyRef: segment.policyRef, segment: segmentLocator(segment) })) : [{ sourceRef: { id: entry.id, version: entry.version }, policyRef: value.policyRef }];
      if (policy.restrictions || segments.length) check(access && targets.every(target => access.descriptors.some(descriptor => sourceAccessKey(descriptor) === sourceAccessKey(target))), "snapshot_import_descriptor_required");
      for (const item of value.payloads) {
        const payload = object(item); check(typeof payload.path === "string" && typeof payload.sha256 === "string" && below(payload.path, binding.archive.payloadRoot), "snapshot_import_payload_invalid");
        await addFile(payload.path); await reader.readPayload(entry, payload.sha256);
      }
      check(reader.eligible(entry), "snapshot_import_dependency_invalid");
    } else if (group === "evidence") {
      check(value.schemaVersion === "stella.memory-evidence/v1" && validMemoryRef(value.source) && validMemoryRef(value.policyRef) && typeof value.payloadSha256 === "string" &&
        same(without(value, ["version", "source", "capturedAt", "payloadSha256", "selector"]), without(old, ["version", "source", "capturedAt", "payloadSha256", "selector"])) &&
        value.source.id === object(old.source).id && timestamp(value.capturedAt), "snapshot_import_attribution_changed");
      const source = await reader.read(value.source, "sources"); assertEvidenceSegment(sourceSegments(source), value);
      const payload = await reader.readPayload(value.source, value.payloadSha256); selectTextEvidence(payload.bytes, value.selector);
      check(same(entry.dependencies, [value.source, value.policyRef, ...Array.isArray(value.derivedFrom) ? value.derivedFrom : []]), "snapshot_import_dependency_invalid");
    } else {
      check(same(entry.dependencies, previous.dependencies), "snapshot_import_dependency_invalid");
      check(value.schemaVersion === "stella.archive-coverage/v1" && timestamp(value.checkedAt) && isRecord(value.scope) && isRecord(old.scope) &&
        same(without(value, ["version", "scope", "upstreamSnapshot", "fromCursor", "toCursor", "checkedAt"]), without(old, ["version", "scope", "upstreamSnapshot", "fromCursor", "toCursor", "checkedAt"])) &&
        same(without(value.scope, ["roots"]), without(old.scope, ["roots"])) && Array.isArray(value.scope.roots) && value.scope.roots.every(file => typeof file === "string" && below(file, binding.archive.payloadRoot)), "snapshot_import_coverage_changed");
    }
  }
  const changes = (await candidate("diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", base, revision)).split("\0").filter(Boolean);
  check(changes.length % 2 === 0 && changes.length === (imported.size + 1) * 2, "snapshot_import_scope_changed");
  for (let i = 0; i < changes.length; i += 2) check(changes[i + 1] === binding.catalogPath ? changes[i] === "M" : changes[i] === "A" && imported.has(changes[i + 1]!), "snapshot_import_scope_changed");
  const operations = path.posix.join(path.posix.dirname(binding.catalogPath), "operations"), journalPath = `${operations}/${selected.operationId}.checkpoint.json`;
  const receiptPath = `${operations}/${selected.operationId}.snapshot.json`;
  const receipt = canonicalJson({ schemaVersion: "stella.checkpoint-snapshot-import/v1", operationId: selected.operationId, candidateRoot,
    producerBaseRevision: base, candidateRevision: revision, generationId: after.generationId, files: [...imported].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({ path: file, sha256: bytesVersion(bytes) })) });
  check(!imported.has(receiptPath) && !imported.has(journalPath), "snapshot_import_path_conflict");
  const plan: MemoryTransactionPlan = { operationId: selected.operationId, journalPath,
    recoveryCheckpoint: { binding: expected.binding, expected: { revision: expected.revision, token: expected.token } }, files: [
      ...[...imported].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({ path: file, before: null, after: bytes })),
      { path: binding.catalogPath, before: beforeBytes, after: afterBytes }, { path: receiptPath, before: null, after: receipt },
    ] };
  check(plan.files.length <= 64 && await optionalBlob(root, expected.revision, receiptPath) === null && await optionalBlob(root, expected.revision, journalPath) === null, "snapshot_import_operation_conflict");
  return withExclusiveFileLock(path.join(root, ".stella-memory-transaction.json"), async () => {
    active(); await candidateClean();
    let recorded: MemoryTransactionPlan | undefined;
    try { recorded = await readRecordedMemoryTransaction(root, selected.operationId, journalPath); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT") && !(error instanceof Error && "category" in error && error.category === "pending_transaction_not_found")) throw error; }
    if (recorded) check(same(recorded, plan), "snapshot_import_operation_conflict");
    else {
      await authority.assertCurrent(expected);
      check((await currentRepo.git("rev-parse", "HEAD")).trim() === expected.revision && (await readRepositoryBytes(root, binding.catalogPath)).toString("utf8") === beforeBytes, "snapshot_import_catalog_conflict");
      await loadConsciousness(root, manifestPath, { recoveryRevision: expected.revision, coreVersion: "3.0.0-alpha.0", openclawVersion: selected.hostVersion, dataMode: "managed_durable_write" });
      active();
      // One local exact ref retains F/other candidate ancestry. It does not publish authority or alter HEAD/index.
      const pin = `refs/stella/imports/${revision}`;
      let pinned = "";
      try { pinned = (await currentRepo.git("show-ref", "--verify", "--hash", pin)).trim(); } catch (error) { if (!(error instanceof CatalogError)) throw error; }
      if (pinned) check(pinned === revision, "snapshot_import_operation_conflict");
      else await currentRepo.git("fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--", candidateRoot, `${revision}:${pin}`);
      await authority.assertCurrent(expected); active();
    }
    const applied = await applyMemoryTransaction(root, plan, {
      recovery: { authority, expected, async assertPublication(accepted) {
        active(); await authority.assertCurrent(accepted);
        const live = await CatalogReader.load(root, binding.catalogPath);
        check(live.catalog.generationId === after.generationId && live.catalogHash === bytesVersion(afterBytes), "snapshot_import_publication_changed");
        for (const { group, entry } of newEntries) {
          const value = await live.read(entry, group);
          if (group === "sources") for (const item of value.payloads as Array<Record<string, unknown>>) await live.readPayload(entry, String(item.sha256));
        }
        for (const entry of before.policies) { await unchangedObjectBytes(root, expected.revision, live, entry); parseSourcePolicy(await live.read(entry, "policies")); }
        if (binding.personalContextAccessPath) check(await readCheckpointCommittedDocument(root, expected.revision, binding.personalContextAccessPath) ===
          (await readRepositoryBytes(root, binding.personalContextAccessPath)).toString("utf8"), "snapshot_import_grant_changed");
        await live.assertCurrent(); active();
      } },
      async validate() { active(); await authority.assertCurrent(expected); },
      persist: commit, async confirmPreviouslyCommitted() { throw new CatalogError("checkpoint_replay_adapter_required"); },
    }, signal);
    check(applied.authority, "checkpoint_publication_receipt_missing");
    return { ...applied, candidateRevision: revision, generationId: after.generationId };
  });
}
