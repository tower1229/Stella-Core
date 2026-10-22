import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { canonicalJson, bytesVersion, objectVersion } from "../src/canghai/content-version.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
export const SUPPLY_MARKER = "SYNTHETIC_ALLOWED_MEMORY_4931";
/** Synthetic source builder shared by fixture tests and the isolated stock Host probe. */
export async function createAgentSupplySource(options: { sourceAccess?: boolean; doNotRetain?: boolean } = {}) {
  const root = await realpath(await createFixture()), catalogPath = "30_PersonalData/memory/catalog.json";
  const catalog = JSON.parse(await readFile(path.join(root, catalogPath), "utf8"));
  const binding = JSON.parse(await readFile(path.join(root, "50_PersonalAgent/stella/praxis-binding.json"), "utf8"));
  if (options.sourceAccess) {
    const profilePath = path.join(root, "50_PersonalAgent/stella/runtime-profile.yaml"), profile = parseYaml(await readFile(profilePath, "utf8"));
    profile.capabilities.push({ id: "source_access_context", required: true, adapter_id: "stella.personal-context-access", adapter_version: "1",
      config_ref: "path:50_PersonalAgent/stella/personal-access.json", acceptance_ref: profile.capabilities[0].acceptance_ref, required_secret_refs: [] });
    await writeFile(path.join(root, "50_PersonalAgent/stella/personal-access.json"), JSON.stringify({ syntheticOnly: true }));
    await writeFile(profilePath, stringifyYaml(profile));
  }
  if (options.doNotRetain) {
    const file = path.join(root, catalog.policies[0].locator.path), policy = JSON.parse(await readFile(file, "utf8"));
    policy.retention = "do_not_retain"; const bytes = canonicalJson(policy), version = objectVersion(policy);
    catalog.policies[0].version = version; catalog.policies[0].locator.sha256 = bytesVersion(bytes); binding.archive.policyRef.version = version;
    await writeFile(file, bytes); await writeFile(path.join(root, "50_PersonalAgent/stella/praxis-binding.json"), canonicalJson(binding));
  }
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-historical-source", sessionKey: "agent:synthetic:retained",
    prompt: `${SUPPLY_MARKER}: Preserve unresolved questions while writing.`, senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, "synthetic-source-run");
  const archive = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request, capturedAt: "2020-01-01T00:00:00Z" }, { ...binding.archive, ownerId: "owner-fixture" });
  for (const file of [{ path: archive.payload.path, bytes: archive.payload.bytes }, ...archive.objects.map(object => ({ path: object.entry.locator.path, bytes: object.bytes }))]) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true }); await writeFile(path.join(root, file.path), file.bytes);
  }
  for (const object of archive.objects) catalog[object.group].push(object.entry);
  await writeFile(path.join(root, catalogPath), canonicalJson(catalog));
  const revision = await initializeFixtureRepository(root);
  return { root, revision, archive, catalogPath, binding };
}
