import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { parse, stringify } from "yaml";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { parseCangHaiRef } from "../dist/src/canghai/ref.js";
import { CatalogReader } from "../dist/src/canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../dist/src/canghai/content-version.js";
import { createBoundPraxisRuntime, loadPraxisRuntimeBinding } from "../dist/src/praxis/runtime-binding.js";
import { listSemanticRoutingCandidates } from "../dist/src/praxis/packet.js";

const { values } = parseArgs({ options: { staging: { type: "string" } } });
if (!values.staging) throw new Error("Required: --staging <inactive migration copy>");
const staging = await realpath(values.staging);
const migration = JSON.parse(await readFile(path.join(staging, "migration.json"), "utf8"));
const root = await realpath(path.join(staging, "canghai"));
if (migration.schemaVersion !== "stella.v2-source-staging/v1" || migration.activated !== false || await realpath(migration.root) !== root) {
  throw new Error("An explicit inactive v2 staging copy is required");
}
const git = (args) => promisify(execFile)("git", ["-C", root, ...args]);
if ((await git(["remote"])).stdout.trim() || (await git(["rev-parse", "HEAD"])).stdout.trim() !== migration.sourceRevision) {
  throw new Error("Staging revision changed or has a push remote");
}
const loaded = await loadConsciousness(root);
const profileRef = parseCangHaiRef(loaded.manifest.identity.runtimeProfileRef);
const profile = parse(await readFile(path.join(root, profileRef.relativePath), "utf8"));
const binding = await loadPraxisRuntimeBinding(loaded);
const reader = await CatalogReader.load(root, binding.catalogPath);
if (profile.contract_profile !== "alpha_praxis" || !Array.isArray(profile.memory?.required_views) ||
  profile.memory.required_views.length || reader.catalog.views.length) {
  throw new Error("Cannot retire a view used by the profile or catalog; full-memory migration requires its actual adapters");
}
const known = new Set(["bootstrap_projection", "memory_index", "vector_index", "embeddings", "memory_wiki", "framework_registry", "praxis_index"]);
if (!loaded.manifest.derived.rebuild.length || loaded.manifest.derived.rebuild.some((target) => !known.has(target))) {
  throw new Error("No known legacy Alpha view declaration to migrate");
}
const complete = async () => { throw new Error("This read-only mapping does not authorize new semantic action judgments"); };
const persist = async () => { throw new Error("This mapping cannot write business state"); };
const beforeMemory = await (await createBoundPraxisRuntime(loaded, binding, complete, persist)).listMemory();
const beforeCandidates = listSemanticRoutingCandidates({ ...loaded, praxisPlaybookItems: beforeMemory.learningItems }, beforeMemory.openEpisodes);
const relative = path.relative(root, await realpath(loaded.manifestPath));
if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("Manifest escaped the staging root");
const original = await readFile(path.join(root, relative));
const manifest = parse(original.toString("utf8"));
manifest.derived.rebuild = [];
const next = stringify(manifest);
const backup = "50_PersonalAgent/stella/v2-migration/manifest.pre-direct-read.yaml";
await mkdir(path.dirname(path.join(root, backup)), { recursive: true });
await writeFile(path.join(root, backup), original, { flag: "wx", mode: 0o600 });
await writeFile(path.join(root, relative), next);
const after = await loadConsciousness(root);
const afterMemory = await (await createBoundPraxisRuntime(after, await loadPraxisRuntimeBinding(after), complete, persist)).listMemory();
const afterCandidates = listSemanticRoutingCandidates({ ...after, praxisPlaybookItems: afterMemory.learningItems }, afterMemory.openEpisodes);
if (canonicalJson(loaded.bootstrapDocuments) !== canonicalJson(after.bootstrapDocuments) ||
  canonicalJson(beforeMemory) !== canonicalJson(afterMemory) || canonicalJson(beforeCandidates) !== canonicalJson(afterCandidates)) {
  throw new Error("Alpha direct-read migration changed cognitive inputs; do not activate this draft");
}
const report = { schemaVersion: "stella.alpha-view-plan-migration/v1", sourceRevision: migration.sourceRevision,
  priorManifestSha256: bytesVersion(original), newManifestSha256: bytesVersion(next), originalManifestRef: `path:${backup}`,
  retiredUnusedDeclarations: loaded.manifest.derived.rebuild, requiredViews: [],
  basis: "Current Alpha directly reads original cognitive documents, catalog, immutable Episode and learning records. No catalog view or profile required view is declared; source consumer audit and v2 state/candidate readback prove no current Alpha input changed.",
  documentsUnchanged: true, memoryUnchanged: true, candidatesUnchanged: true,
  fullMemoryAccepted: false, searchOrIndexCapabilityClaimed: false, activated: false };
await writeFile(path.join(staging, "view-plan-migration.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
