import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConsciousnessLoadError, loadConsciousness } from "../dist/src/canghai/manifest.js";
import { STELLA_CORE_COMPATIBILITY_VERSION } from "../dist/src/plugin.js";
import { ALPHA_HOST_VERSION } from "../dist/src/acceptance/exact-host-evidence.js";

// A read-only migration diagnostic. Never starts a Gateway, changes the source,
// removes unsupported configuration, grants source access, or activates a profile.
const { values } = parseArgs({ options: {
  "canghai-root": { type: "string" }, revision: { type: "string" },
} });
if (!values["canghai-root"] || !/^[a-f0-9]{40}$/.test(values.revision ?? "")) {
  throw new Error("Required: --canghai-root <clean repository> --revision <full SHA>");
}
const run = promisify(execFile);
const coreRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = await realpath(values["canghai-root"]);
const git = async (root, args) => (await run("git", ["-c", "core.fsmonitor=false", "-C", root, ...args])).stdout.trim();
async function assertSource() {
  if (await git(sourceRoot, ["rev-parse", "HEAD"]) !== values.revision ||
    await git(sourceRoot, ["status", "--porcelain"])) throw new Error("source_revision_or_cleanliness_changed");
}
await assertSource();
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "stella-private-preflight-"));
const save = (name, value) => writeFile(path.join(evidenceRoot, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
const configRelative = "50_PersonalAgent/openclaw/openclaw.json";
const configBytes = await readFile(path.join(sourceRoot, configRelative));
const stateRoot = path.join(evidenceRoot, "host-state");
await mkdir(stateRoot, { mode: 0o700 });
const env = { ...process.env, OPENCLAW_STATE_DIR: stateRoot,
  OPENCLAW_CONFIG_PATH: path.join(sourceRoot, configRelative), OPENCLAW_NO_RESPAWN: "1" };
const hostBin = path.join(coreRoot, "node_modules/openclaw/openclaw.mjs");
const json5 = createRequire(pathToFileURL(hostBin))("json5");
const hostVersion = JSON.parse(await readFile(path.join(coreRoot, "node_modules/openclaw/package.json"), "utf8")).version;
if (hostVersion !== ALPHA_HOST_VERSION) throw new Error("openclaw_version_mismatch");
let hostResult;
try {
  hostResult = await run(process.execPath, [hostBin, "config", "validate", "--json"], { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
} catch (error) {
  if (error.code !== 1 || typeof error.stdout !== "string") throw new Error("host_config_validation_unavailable");
  hostResult = error;
}
let hostValidation;
try { hostValidation = JSON.parse(hostResult.stdout); }
catch { throw new Error("host_config_validation_invalid_response"); }
if (typeof hostValidation.valid !== "boolean") throw new Error("host_config_validation_invalid_response");
await save("host-config-validation.private.json", hostValidation);
let config;
try { config = json5.parse(configBytes.toString("utf8")); }
catch { throw new Error("source_config_parse_failed_diagnostics_saved"); }
if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("source_config_invalid_root");
let manifest;
try {
  await loadConsciousness(sourceRoot, "50_PersonalAgent/stella/manifest.yaml", {
    recoveryRevision: values.revision, coreVersion: STELLA_CORE_COMPATIBILITY_VERSION,
    openclawVersion: hostVersion, dataMode: "read_only",
  });
  manifest = { valid: true };
} catch (error) {
  if (!(error instanceof ConsciousnessLoadError)) throw new Error("manifest_inspection_unavailable");
  manifest = { valid: false, category: error.category };
}
let policyResult;
try {
  policyResult = await run(process.execPath, [path.join(coreRoot, "scripts/plan-source-policy-migration.mjs"), sourceRoot, values.revision],
    { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
} catch (error) {
  if (error.code !== 2 || typeof error.stdout !== "string") throw new Error("source_policy_inspection_unavailable");
  policyResult = error;
}
const policyPlan = JSON.parse(policyResult.stdout);
await save("source-policy-plan.private.json", policyPlan);
await assertSource();
if (!configBytes.equals(await readFile(path.join(sourceRoot, configRelative)))) throw new Error("source_config_changed");
const blockers = [
  ...(!hostValidation.valid ? ["openclaw_config_migration_required"] : []),
  ...(!manifest.valid ? [manifest.category] : []),
  ...(!config.plugins?.entries?.["stella-core"]?.enabled ? ["stella_plugin_not_enabled"] : []),
  ...(policyPlan.blockers.length ? ["source_metadata_invalid"] : []),
  "source_policy_semantic_review_required", "private_host_lifecycle_not_verified",
];
// Ignored build outputs are not proven by Git cleanliness. Bind their bytes
// separately; this diagnostic does not certify their relationship to HEAD.
const buildHash = createHash("sha256");
async function hashBuild(directory, relative = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name), name = `${relative}${entry.name}`;
    if (entry.isDirectory()) await hashBuild(file, `${name}/`);
    else if (entry.isFile()) buildHash.update(JSON.stringify([name, createHash("sha256").update(await readFile(file)).digest("hex")]));
    else throw new Error("unsupported_build_entry");
  }
}
await hashBuild(path.join(coreRoot, "dist"));
const report = {
  schemaVersion: "stella.private-source-preflight/v1", scope: "migration_diagnostic",
  coreRevision: await git(coreRoot, ["rev-parse", "HEAD"]), coreClean: !(await git(coreRoot, ["status", "--porcelain"])),
  sourceRevision: values.revision, sourceClean: true, hostVersion,
  buildArtifactSha256: buildHash.digest("hex"), buildSourceBindingVerified: false,
  configSha256: createHash("sha256").update(configBytes).digest("hex"),
  hostConfigValid: hostValidation.valid, hostConfigIssueCount: hostValidation.issues?.length ?? 0,
  manifest, sourcePolicyScope: policyPlan.scope,
  sourceCount: policyPlan.plans.length, sourceMetadataBlockers: policyPlan.blockers.length,
  semanticReviewPerformed: false, readyToActivate: false, privateHostVerified: false,
  gatewayStarted: false, modelRequests: 0, sourceChanged: false, productionChanged: false, blockers,
};
await save("preflight.json", report);
console.log(JSON.stringify({ evidenceRoot, ...report }, null, 2));
process.exitCode = 2; // Diagnostic completion is not migration or runtime acceptance.
