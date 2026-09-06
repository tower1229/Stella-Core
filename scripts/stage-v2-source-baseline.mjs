import { execFile } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { parseCangHaiRef } from "../dist/src/canghai/ref.js";
import { CatalogReader, readRepositoryBytes } from "../dist/src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson, objectVersion } from "../dist/src/canghai/content-version.js";
import { prepareRepositorySource } from "../dist/src/canghai/repository-source.js";
import { planLegacyEpisodeQuarantine, quarantineLegacyEpisodes } from "../dist/src/praxis/legacy-migration.js";
import { EpisodeEvidenceResolver } from "../dist/src/praxis/episode-evidence.js";

const { values } = parseArgs({ options: { "source-root": { type: "string" }, revision: { type: "string" } } });
if (!values["source-root"] || !/^[a-f0-9]{40}$/.test(values.revision ?? "")) throw new Error("Required: --source-root <repository> --revision <full SHA>");
const run = promisify(execFile);
const sourceRoot = path.resolve(values["source-root"]);
const git = (root, args) => run("git", ["-C", root, ...args]);
const sourceStatus = (await git(sourceRoot, ["status", "--porcelain"])).stdout.trim();
if (sourceStatus || (await git(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim() !== values.revision) throw new Error("Source must be clean at the explicit revision");
const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "stella-v2-baseline-"));
const root = path.join(stagingRoot, "canghai");
await run("git", ["clone", "--no-local", sourceRoot, root]);
await git(root, ["checkout", "--detach", values.revision]);
// Remove the source remote from this preparation copy: this script never pushes or activates it.
await git(root, ["remote", "remove", "origin"]);
const loaded = await loadConsciousness(root, "50_PersonalAgent/stella/manifest.yaml", {
  recoveryRevision: values.revision, coreVersion: "3.0.0-alpha.0", openclawVersion: "2026.8.2", dataMode: "read_only",
});
const catalogPath = "30_PersonalData/memory/catalog.json";
try { await stat(path.join(root, catalogPath)); throw new Error("Existing catalog requires an explicit incremental migration"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const capturedAt = new Date().toISOString();
const policy = { schemaVersion: "stella.source-policy/v1", id: "policy-alpha-authorized-evaluation",
  ownerId: `owner-of:${loaded.manifest.sourceBaseline.repository}`, readPurposes: ["alpha_praxis"], derivePurposes: ["alpha_praxis"],
  deliveryScopes: ["host-chat"], retention: "retain", authorityEvidenceRefs: [] };
const policyRef = { id: policy.id, version: objectVersion(policy) };
const policyBytes = canonicalJson({ ...policy, version: policyRef.version });
const catalog = { schemaVersion: "stella.memory-catalog/v1", generationId: `migration-${values.revision}`, parentGenerationId: null,
  sources: [], evidence: [], policies: [{ ...policyRef, status: "current", dependencies: [],
    locator: { path: "30_PersonalData/memory/evaluation-policy.json", sha256: bytesVersion(policyBytes) } }],
  understandings: [], works: [], changes: [], bundles: [], coverage: [], views: [] };
await mkdir(path.join(root, "30_PersonalData/memory"), { recursive: true });
await writeFile(path.join(root, catalog.policies[0].locator.path), policyBytes, { flag: "wx", mode: 0o600 });
const selected = new Map();
// Structural references only. No keyword-based interpretation of the contents or their author.
for (const document of loaded.bootstrapDocuments) {
  if (document.field !== "identity.runtimeProfileRef") selected.set(document.ref, document.field);
}
for (const reference of loaded.requiredReferences) {
  if (reference.field.startsWith("frameworks.sources[")) selected.set(reference.ref, reference.field);
}
const mapping = [];
for (const [ref, field] of selected) {
  const parsed = parseCangHaiRef(ref);
  if (parsed.fragment) throw new Error("Source selection needs an explicit fragment adapter");
  const bytes = await readRepositoryBytes(root, parsed.relativePath);
  const prepared = await prepareRepositorySource({ root, collectionId: loaded.manifest.sourceBaseline.repository,
    sourceId: `initial-import:${parsed.relativePath}`, relativePath: parsed.relativePath, expectedSha256: bytesVersion(bytes),
    capturedAt, policyRef, objectRoot: "30_PersonalData/memory/objects" });
  for (const object of prepared.objects) {
    await mkdir(path.dirname(path.join(root, object.entry.locator.path)), { recursive: true });
    await writeFile(path.join(root, object.entry.locator.path), object.bytes, { flag: "wx", mode: 0o600 });
    catalog[object.group].push(object.entry);
  }
  mapping.push({ field, routingRef: ref, sourceRef: prepared.sourceRef, evidenceRefs: prepared.evidenceRefs,
    disposition: "preserved_unknown_not_activated" });
}
await writeFile(path.join(root, catalogPath), canonicalJson(catalog), { flag: "wx", mode: 0o600 });
const episodeRoot = path.join(root, parseCangHaiRef(loaded.manifest.praxis.episodeRootRef).relativePath);
const quarantinePlan = await planLegacyEpisodeQuarantine(episodeRoot);
const quarantine = await quarantineLegacyEpisodes(episodeRoot, quarantinePlan);
const reader = await CatalogReader.load(root, catalogPath);
const resolver = new EpisodeEvidenceResolver(reader, { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat",
  evidenceCutoff: capturedAt, trustedAdapters: { user_report: [], tool_observation: [], system_event: [] } },
  async () => { throw new Error("Source staging cannot make semantic action claims"); });
for (const entry of reader.catalog.evidence) {
  const evidence = await resolver.readEvidence(entry);
  if (evidence.role !== "unknown" || evidence.kind !== "unknown" || evidence.occurredAt !== null || evidence.authoredAt !== null) {
    throw new Error("Source staging unexpectedly promoted provenance");
  }
}
await reader.assertCurrent();
await writeFile(path.join(stagingRoot, "migration.json"), JSON.stringify({
  schemaVersion: "stella.v2-source-staging/v1", sourceRevision: values.revision, capturedAt, mapping, quarantine,
  catalogPath, root, activated: false, profileMigrated: false, originalDataChanged: false,
  scope: "registered cognitive sources only; not full personal corpus, runtime migration, verified authorship, learning or acceptance",
  remaining: ["review provenance and source policies", "map runtime profile and portable registries", "import authorized original case evidence", "validate actual learning and recovery"],
}, null, 2), { flag: "wx", mode: 0o600 });
if ((await git(sourceRoot, ["status", "--porcelain"])).stdout.trim() ||
  (await git(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim() !== values.revision) throw new Error("Source changed during staging");
console.log(JSON.stringify({ stagingRoot, sourceCount: catalog.sources.length, quarantinedCount: quarantine.quarantinedCount,
  activatedCount: 0, originalDataChanged: false, scope: "staging-only" }));
