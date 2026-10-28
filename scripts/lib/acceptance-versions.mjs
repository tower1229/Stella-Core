import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const json = async file => JSON.parse(await readFile(file, "utf8"));
const exactVersion = value => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(value) &&
  !value.split("+")[0].split("-").slice(1).join("-").split(".").some(part => /^0\d+$/.test(part));
const coreName = "@tower1229/stella-core";

export const initialAcceptanceVersions = () => ({ targetHostVersion: null, workspaceSdkVersion: null, corePackageVersion: null, consumer: null });

function assertWorkspaceVersionFacts(versions) {
  assert.ok(exactVersion(versions.targetHostVersion), "acceptance_host_target_not_exact");
  assert.ok(exactVersion(versions.corePackageVersion), "acceptance_core_version_invalid");
  assert.equal(versions.workspaceSdkVersion, versions.targetHostVersion, "acceptance_workspace_sdk_version_mismatch");
}

async function resolvedSdk(packageRoot) {
  const entry = await realpath(createRequire(path.join(packageRoot, "package.json")).resolve("openclaw/plugin-sdk/plugin-entry"));
  const root = path.resolve(path.dirname(entry), "../..");
  return { root, metadata: await json(path.join(root, "package.json")) };
}

/** Read actual metadata without importing SDK code or executing a launcher.
 * Keep observations in the receipt even when a subsequent comparison fails. */
export async function verifyWorkspaceVersions(root, versions) {
  const metadata = await json(path.join(root, "package.json"));
  versions.targetHostVersion = metadata.devDependencies?.openclaw ?? null;
  versions.corePackageVersion = metadata.version ?? null;
  const sdk = await resolvedSdk(root);
  versions.workspaceSdkVersion = sdk.metadata.version ?? null;
  const lock = await json(path.join(root, "package-lock.json"));
  assert.equal(metadata.name, coreName, "acceptance_core_package_name_mismatch");
  assertWorkspaceVersionFacts(versions);
  for (const key of ["openclawVersion", "pluginSdkVersion"])
    assert.equal(metadata.openclaw?.build?.[key], versions.targetHostVersion, `acceptance_build_version_mismatch:${key}`);
  assert.equal(lock.packages?.[""]?.name, coreName, "acceptance_lock_core_name_mismatch");
  assert.equal(lock.packages?.[""]?.version, versions.corePackageVersion, "acceptance_lock_core_version_mismatch");
  assert.equal(lock.packages?.[""]?.devDependencies?.openclaw, versions.targetHostVersion, "acceptance_lock_target_mismatch");
  assert.equal(lock.packages?.["node_modules/openclaw"]?.version, versions.targetHostVersion, "acceptance_lock_host_version_mismatch");
  assert.equal(sdk.metadata.name, "openclaw", "acceptance_workspace_sdk_name_mismatch");
}

export function assertPreparedVersions(prepared, versions) {
  assertWorkspaceVersionFacts(versions);
  assert.deepEqual(prepared.versions, versions, "acceptance_prepared_versions_mismatch");
  assert.equal(prepared.versions?.consumer, null, "acceptance_prepared_consumer_not_empty");
  assert.equal(prepared.hostVersion, versions.workspaceSdkVersion, "acceptance_prepared_host_version_mismatch");
}

export async function verifyConsumerVersions({ consumer, packageRoot, hostRoot }, versions) {
  assertWorkspaceVersionFacts(versions);
  const host = await json(path.join(hostRoot, "package.json")), core = await json(path.join(packageRoot, "package.json"));
  versions.consumer = { hostVersion: host.version ?? null, corePackageVersion: core.version ?? null,
    lockedHostVersion: null, cliHostVersion: null, metadataVerified: false, cliVerified: false };
  const lock = await json(path.join(consumer, "package-lock.json"));
  versions.consumer.lockedHostVersion = lock.packages?.["node_modules/openclaw"]?.version ?? null;
  assert.equal(host.name, "openclaw", "acceptance_consumer_host_name_mismatch");
  assert.equal(host.version, versions.targetHostVersion, "acceptance_consumer_host_version_mismatch");
  assert.equal(core.name, coreName, "acceptance_consumer_core_name_mismatch");
  assert.equal(core.version, versions.corePackageVersion, "acceptance_consumer_core_version_mismatch");
  assert.equal(versions.consumer.lockedHostVersion, host.version, "acceptance_consumer_lock_host_mismatch");
  assert.equal(lock.packages?.[`node_modules/${coreName}`]?.version, core.version, "acceptance_consumer_lock_core_mismatch");
  for (const key of ["openclawVersion", "pluginSdkVersion"])
    assert.equal(core.openclaw?.build?.[key], versions.targetHostVersion, `acceptance_consumer_build_version_mismatch:${key}`);
  const sdk = await resolvedSdk(packageRoot);
  assert.equal(sdk.root, await realpath(hostRoot), "acceptance_consumer_sdk_root_mismatch");
  assert.equal(sdk.metadata.version, host.version, "acceptance_consumer_sdk_version_mismatch");
  versions.consumer.metadataVerified = true;
  return lock;
}

export function verifyConsumerCliVersion(versions, output) {
  assertWorkspaceVersionFacts(versions);
  assert.equal(versions.consumer?.metadataVerified, true, "acceptance_consumer_metadata_required");
  versions.consumer.cliVerified = false;
  const match = /^(?:OpenClaw )?([^\s]+)(?: \([\da-zA-Z._-]+\))?$/.exec(output.trim());
  versions.consumer.cliHostVersion = match && exactVersion(match[1]) ? match[1] : null;
  assert.equal(versions.consumer.cliHostVersion, versions.targetHostVersion, "acceptance_consumer_cli_version_mismatch");
  versions.consumer.cliVerified = true;
}

export function assertLegacyProbesMigrated(versions) {
  assertWorkspaceVersionFacts(versions);
  assert.equal(versions.consumer?.cliVerified, true, "acceptance_consumer_cli_required");
  assert.equal(versions.consumer.hostVersion, versions.targetHostVersion, "acceptance_consumer_host_version_mismatch");
  assert.equal(versions.consumer.cliHostVersion, versions.targetHostVersion, "acceptance_consumer_cli_version_mismatch");
  // This existing probe family remains 8.2-only. Metadata alignment must not
  // convert it into a claim that its Host behaviors were ported to 10.8.
  assert.equal(versions.consumer.hostVersion, "2026.8.2", "acceptance_legacy_probes_not_migrated: supported Host is 2026.8.2");
}
