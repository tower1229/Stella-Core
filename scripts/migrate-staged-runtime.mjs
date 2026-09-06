import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { parse, stringify } from "yaml";
import { bytesVersion, canonicalJson } from "../dist/src/canghai/content-version.js";
import { CatalogReader } from "../dist/src/canghai/catalog-reader.js";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { loadPraxisRuntimeBinding } from "../dist/src/praxis/runtime-binding.js";
import { parseCangHaiRef } from "../dist/src/canghai/ref.js";
import { alphaCapabilityDraft } from "./lib/alpha-capability-draft.mjs";

const { values } = parseArgs({ options: { staging: { type: "string" } } });
if (!values.staging) throw new Error("Required: --staging <source staging directory>");
const staging = await realpath(values.staging);
const migration = JSON.parse(await readFile(path.join(staging, "migration.json"), "utf8"));
const root = await realpath(path.join(staging, "canghai"));
if (migration.schemaVersion !== "stella.v2-source-staging/v1" || await realpath(migration.root) !== root ||
  migration.activated !== false) throw new Error("An explicit inactive source staging copy is required");
const run = promisify(execFile);
const git = (args) => run("git", ["-C", root, ...args]);
if ((await git(["remote"])).stdout.trim() || (await git(["rev-parse", "HEAD"])).stdout.trim() !== migration.sourceRevision) {
  throw new Error("Staging must remain at its recorded source with no push remote");
}
const loaded = await loadConsciousness(root);
const profilePath = parseCangHaiRef(loaded.manifest.identity.runtimeProfileRef).relativePath;
const legacyProfile = await readFile(path.join(root, profilePath));
const legacy = parse(legacyProfile.toString("utf8"));
if (legacy?.schema_version !== "stella.runtime-profile/v1alpha" || legacy.locale !== "zh-CN" ||
  legacy.authority?.derived_runtime_may_write_authority !== false) throw new Error("Legacy profile needs an explicit reviewed mapping");
const base = "50_PersonalAgent/stella/v2-migration";
await mkdir(path.join(root, base), { recursive: true });
const writes = [];
async function create(relative, content) {
  await writeFile(path.join(root, relative), content, { flag: "wx", mode: 0o600 });
  writes.push({ path: relative, sha256: bytesVersion(content) });
}
await create(`${base}/runtime-profile.v1alpha.yaml`, legacyProfile);
const reader = await CatalogReader.load(root, migration.catalogPath);
const policy = reader.catalog.policies[0];
if (reader.catalog.policies.length !== 1) throw new Error("Staged policy selection is ambiguous");
const bindingPath = `${base}/praxis-binding.json`;
await create(bindingPath, canonicalJson({ schemaVersion: "stella.alpha-praxis-binding/v2",
  archive: { policyRef: { id: policy.id, version: policy.version }, objectRoot: "30_PersonalData/memory/objects", payloadRoot: "30_PersonalData/host-archive" },
  purpose: { readPurpose: "alpha_praxis", derivePurpose: "alpha_praxis", deliveryScope: "host-chat" },
  referenceBindings: migration.mapping.map(({ routingRef, sourceRef }) => ({ routingRef, sourceRef })),
}));
const acceptancePath = `${base}/capability-acceptance.json`;
await create(acceptancePath, canonicalJson({ schemaVersion: "stella.migration-capability-review/v1", hostVersion: "2026.8.2",
  status: "not_evaluated", scope: "configuration mapping only; current package and private recovery verification pending" }));
const policyRegistryPath = `${base}/source-policies.yaml`;
await create(policyRegistryPath, stringify({ schema_version: "stella.source-policy-registry/v1", id: "alpha-source-policies",
  policies: [{ id: policy.id, ref: `path:${policy.locator.path}` }] }));
const delegationPath = `${base}/delegations.yaml`;
await create(delegationPath, stringify({ schema_version: "stella.delegation-registry/v1", id: "alpha-delegations", delegations: [] }));
const deliveryPath = `${base}/delivery-policy.yaml`;
await create(deliveryPath, stringify({ schema_version: "stella.delivery-policy/v1", timezone: "Asia/Shanghai",
  allowed_windows: [], max_initiations_per_day: 0, channel_ref: "host-chat" }));
const model = { provider: "google", model: "gemini-3.1-pro-preview", required_capabilities: ["structured_model"] };
const capabilityDraft = alphaCapabilityDraft({ base, bindingPath, acceptancePath });
for (const file of capabilityDraft.files) await create(file.path, canonicalJson(file.object));
const profile = { schema_version: "stella.runtime-profile/v1", agent_id: "main", language: "zh-CN", timezone: "Asia/Shanghai", contract_profile: "alpha_praxis",
  models: Object.fromEntries(["main", "router", "learning", "framework_compiler"].map((id) => [id, model])),
  capabilities: capabilityDraft.capabilities,
  source_policies_ref: `path:${policyRegistryPath}`,
  memory: { catalog_ref: `path:${migration.catalogPath}`, semantic_provider: "google/gemini-3.1-pro-preview", required_views: [], archive_max_rpo_seconds: 300 },
  autonomy: { research_enabled: false, proactive_delivery_enabled: false, delivery_policy_ref: `path:${deliveryPath}`, delegation_registry_ref: `path:${delegationPath}` },
};
// Do not invent active learning from legacy summaries. Keep the old registry and every body.
const playbookPath = parseCangHaiRef(loaded.manifest.praxis.playbookRegistryRef).relativePath;
const legacyPlaybook = await readFile(path.join(root, playbookPath));
await create(`${base}/playbook-registry.legacy.yaml`, legacyPlaybook);
const playbook = parse(legacyPlaybook.toString("utf8"));
if (!["stella.praxis-playbook-registry/v1alpha", "stella.praxis-playbook-registry/v1"].includes(playbook?.schema_version) || !Array.isArray(playbook.items)) {
  throw new Error("Legacy learning registry needs an explicit reviewed mapping");
}
await writeFile(path.join(root, playbookPath), stringify({ schema_version: "stella.praxis-playbook-registry/v1", id: "alpha-verified-learning", items: [] }));
await writeFile(path.join(root, profilePath), stringify(profile));
const binding = await loadPraxisRuntimeBinding(await loadConsciousness(root));
if (binding.catalogPath !== migration.catalogPath || binding.referenceBindings.length !== migration.mapping.length) throw new Error("Runtime mapping readback mismatch");
await create(`${base}/mapping.json`, canonicalJson({ schemaVersion: "stella.runtime-migration/v1", sourceRevision: migration.sourceRevision,
  oldProfileVersion: legacy.schema_version, newProfileVersion: profile.schema_version,
  oldProfileSha256: bytesVersion(legacyProfile), oldPlaybookSha256: bytesVersion(legacyPlaybook),
  unverifiedLegacyLearningCount: playbook.items.length, activatedLearningCount: 0, registeredSourceCount: binding.referenceBindings.length,
  unresolved: ["capability acceptance and remaining capability mappings", "declared derived view recipes", "full portable registry validation", "original case evidence and genuine learning"],
  sourceFilesPreserved: true, activated: false, completeProfileVerified: false, writes }));
console.log(JSON.stringify({ staging, runtimeBindingReadback: true, registeredSourceCount: binding.referenceBindings.length,
  unverifiedLegacyLearningCount: playbook.items.length, activatedLearningCount: 0, completeProfileVerified: false, activated: false }));
