import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { parse, stringify } from "yaml";
import { bytesVersion, canonicalJson } from "../dist/src/canghai/content-version.js";
import { loadConsciousness } from "../dist/src/canghai/manifest.js";
import { parseCangHaiRef } from "../dist/src/canghai/ref.js";
import { parseRuntimeProfile } from "../dist/src/canghai/runtime-profile.js";
import { loadPraxisRuntimeBinding } from "../dist/src/praxis/runtime-binding.js";
import { alphaCapabilityDraft } from "./lib/alpha-capability-draft.mjs";

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
  throw new Error("Staging source changed or has a push remote");
}
const loaded = await loadConsciousness(root);
const relative = parseCangHaiRef(loaded.manifest.identity.runtimeProfileRef).relativePath;
const original = await readFile(path.join(root, relative));
const profile = parse(original.toString("utf8"));
if (profile.schema_version !== "stella.runtime-profile/v1" || profile.contract_profile !== "alpha_praxis" ||
  !Array.isArray(profile.capabilities) || profile.capabilities.length !== 1 || profile.capabilities[0].id !== "transcript_archive") {
  throw new Error("Known transcript-only migration draft required");
}
const base = "50_PersonalAgent/stella/v2-migration";
const bindingPath = parseCangHaiRef(profile.capabilities[0].config_ref).relativePath;
const acceptancePath = parseCangHaiRef(profile.capabilities[0].acceptance_ref).relativePath;
const acceptance = JSON.parse(await readFile(path.join(root, acceptancePath), "utf8"));
if (acceptance.status !== "not_evaluated") throw new Error("Do not overwrite existing capability acceptance");
const draft = alphaCapabilityDraft({ base, bindingPath, acceptancePath });
profile.capabilities = draft.capabilities;
parseRuntimeProfile(profile);
await writeFile(path.join(root, `${base}/runtime-profile.before-capabilities.yaml`), original, { flag: "wx", mode: 0o600 });
for (const file of draft.files) await writeFile(path.join(root, file.path), canonicalJson(file.object), { flag: "wx", mode: 0o600 });
const next = stringify(profile);
await writeFile(path.join(root, relative), next);
await loadPraxisRuntimeBinding(await loadConsciousness(root));
const report = { schemaVersion: "stella.runtime-capability-mapping/v1", sourceRevision: migration.sourceRevision,
  oldProfileSha256: bytesVersion(original), newProfileSha256: bytesVersion(next),
  requiredCapabilities: draft.capabilities.map(({ id }) => id), structuralValidation: "passed", runtimeBindingReadback: true,
  capabilityAvailabilityVerified: false, acceptanceStatus: "not_evaluated", activated: false,
  remaining: ["validate capability adapters/configurations and exact Host availability", "verify external provider credential reference", "complete portable registries and private recovery"] };
await writeFile(path.join(staging, "capability-mapping.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
