import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyMemoryTransaction, type MemoryTransactionPlan } from "../src/canghai/memory-transaction.js";
import { openLocalCheckpointRecovery } from "../src/canghai/local-checkpoint-recovery.js";
import type { RecoveryReadBinding } from "../src/canghai/recovery-read-binding.js";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFixture, prepareInitializationFixture, initializeFixtureRepository } from "./consciousness-fixture.js";
import { prepareHostRequestArchive } from "../src/canghai/host-request-archive.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { canonicalJson, bytesVersion, objectVersion } from "../src/canghai/content-version.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
export const BOOTSTRAP_MARKER = "SYNTHETIC_INSTALLED_BOOTSTRAP_8615";
export const SKILL_MARKER = "SYNTHETIC_INSTALLED_SKILL_BODY_8615";
export const SUPPLY_MARKER = "SYNTHETIC_ALLOWED_MEMORY_4931";
/** Synthetic source builder shared by fixture tests and the isolated stock Host probe. */
export async function createAgentSupplySource(options: { sourceAccess?: boolean; doNotRetain?: boolean; materialization?: boolean; additionalEvidence?: number; policyContext?: "allow" | "deny" | "missing" } = {}) {
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
  for (let index = 0; index < (options.additionalEvidence ?? 0); index++) {
    const next = snapshotTurnRequest({ agentId: "synthetic", sessionId: "synthetic-historical-source", sessionKey: "agent:synthetic:retained",
      prompt: `Synthetic retained entry ${index + 2}.`, senderId: "synthetic-owner", senderIsOwner: true, chatType: "direct" }, `synthetic-source-run-${index + 2}`);
    const extra = prepareHostRequestArchive({ schemaVersion: "stella.host-request-snapshot/v1", request: next, capturedAt: "2020-01-01T00:00:00Z" }, { ...binding.archive, ownerId: "owner-fixture" });
    for (const file of [{ path: extra.payload.path, bytes: extra.payload.bytes }, ...extra.objects.map(object => ({ path: object.entry.locator.path, bytes: object.bytes }))]) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true }); await writeFile(path.join(root, file.path), file.bytes);
    }
    for (const object of extra.objects) catalog[object.group].push(object.entry);
  }
  await writeFile(path.join(root, catalogPath), canonicalJson(catalog));
  if (options.policyContext) {
    const refs = new Map<string, { id: string; version: string }>();
    const replace = (value: any): any => Array.isArray(value) ? value.map(replace) : value && typeof value === "object"
      ? typeof value.id === "string" && typeof value.version === "string" && refs.has(canonicalJson({ id: value.id, version: value.version }))
        ? { ...value, ...refs.get(canonicalJson({ id: value.id, version: value.version })) }
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
    for (const group of ["policies", "sources", "evidence"]) for (const entry of catalog[group]) {
      const old = { id: entry.id, version: entry.version }, object = replace(JSON.parse(await readFile(path.join(root, entry.locator.path), "utf8")));
      if (group === "policies") Object.assign(object, { schemaVersion: "stella.source-policy/v3",
        restrictions: { sensitivity: "private", quotePolicy: "summarize_only", allowedScenarios: ["self_reflection"], forbiddenScenarios: ["relationship_judgment"] },
        usageRules: { access: [{ id: "requested_topic", requirement: "Use only for the explicitly requested synthetic topic." }],
          interpretation: [{ id: "keep_scope", requirement: "Do not generalize the synthetic example." }] } });
      const version = objectVersion(object); object.version = version; const bytes = canonicalJson(object);
      await writeFile(path.join(root, entry.locator.path), bytes); entry.version = version; entry.locator.sha256 = bytesVersion(bytes); entry.dependencies = replace(entry.dependencies);
      refs.set(canonicalJson(old), { id: entry.id, version });
    }
    const nextBinding = replace(binding); await writeFile(path.join(root, "50_PersonalAgent/stella/praxis-binding.json"), canonicalJson(nextBinding));
    const profilePath = path.join(root, "50_PersonalAgent/stella/runtime-profile.yaml"), profile = parseYaml(await readFile(profilePath, "utf8"));
    profile.capabilities.push({ id: "source_access_context", required: true, adapter_id: "stella.personal-context-access", adapter_version: "1",
      config_ref: "path:50_PersonalAgent/stella/checkpoint-access.json", acceptance_ref: profile.capabilities[0].acceptance_ref, required_secret_refs: [] });
    await writeFile(profilePath, stringifyYaml(profile));
    await writeFile(path.join(root, "50_PersonalAgent/stella/checkpoint-access.json"), canonicalJson({ schemaVersion: "stella.personal-context-access/v1",
      ownerId: "owner-fixture", requesterIds: ["synthetic-owner"], modelRefs: ["google/gemini-3.8-flash"], purpose: binding.purpose,
      descriptors: options.policyContext === "missing" ? [] : catalog.sources.map((entry: any) => ({ sourceRef: { id: entry.id, version: entry.version }, policyRef: nextBinding.archive.policyRef,
        description: "A reviewed synthetic event for self reflection, never original text." })) }));
    await writeFile(path.join(root, catalogPath), canonicalJson(catalog));
  }
  if (options.materialization) await prepareInitializationFixture(root, "synthetic", SKILL_MARKER, BOOTSTRAP_MARKER);
  const revision = await initializeFixtureRepository(root);
  return { root, revision, archive, catalogPath, binding };
}

/** Test-only publication for this empty-derived-view fixture, not a product policy writer.
 * Uses the production transaction/journal/CAS path and authenticates the returned C.
 */
export async function publishAgentSupplyPolicyDenial(source: Awaited<ReturnType<typeof createAgentSupplySource>>,
  stateDirectory: string, recovery: RecoveryReadBinding) {
  const git = promisify(execFile), { expected } = recovery;
  const authority = await openLocalCheckpointRecovery({ stateDirectory, binding: expected.binding });
  const catalogBefore = await readFile(path.join(source.root, source.catalogPath), "utf8"), catalog = JSON.parse(catalogBefore);
  for (const group of ["understandings", "works", "changes", "bundles", "views"]) assert.equal(catalog[group].length, 0);
  const replacements = new Map<string, { id: string; version: string }>(), files: MemoryTransactionPlan["files"] = [];
  const replaceRefs = (value: any): any => {
    if (Array.isArray(value)) return value.map(replaceRefs);
    if (!value || typeof value !== "object") return value;
    const ref = replacements.get(canonicalJson([value.id ?? null, value.version ?? null]));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "version" && ref ? ref.version : replaceRefs(child)]));
  };
  for (const group of ["policies", "sources", "evidence"]) for (const entry of catalog[group]) {
    const before = await readFile(path.join(source.root, entry.locator.path), "utf8"), document = replaceRefs(JSON.parse(before));
    if (group === "policies") document.readPurposes = [];
    const version = objectVersion(document); if (Object.hasOwn(document, "version")) document.version = version;
    const after = canonicalJson(document); replacements.set(canonicalJson([entry.id, entry.version]), { id: entry.id, version });
    entry.version = version; entry.dependencies = replaceRefs(entry.dependencies); entry.locator.sha256 = bytesVersion(after);
    files.push({ path: entry.locator.path, before, after });
  }
  catalog.parentGenerationId = catalog.generationId; catalog.generationId = "synthetic-policy-denial-C";
  files.push({ path: source.catalogPath, before: catalogBefore, after: canonicalJson(catalog) });
  const bindingPath = "50_PersonalAgent/stella/praxis-binding.json", before = await readFile(path.join(source.root, bindingPath), "utf8");
  files.push({ path: bindingPath, before, after: canonicalJson(replaceRefs(JSON.parse(before))) });
  const plan = { operationId: "synthetic-policy-denial-C", journalPath: "30_PersonalData/memory/operations/synthetic-policy-denial-C.checkpoint.json",
    recoveryCheckpoint: { binding: expected.binding, expected: { revision: expected.revision, token: expected.token } }, files };
  return applyMemoryTransaction(source.root, plan, {
    recovery: { authority, expected, async assertPublication(accepted) { await authority.assertCurrent(accepted); } },
    async validate() { await authority.assertCurrent(expected); },
    async persist(paths) {
      await git("git", ["-C", source.root, "add", "--", ...paths]);
      await git("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", source.root,
        "commit", "--quiet", "-m", "[synthetic] publish denied source policy", "--", ...paths]);
    },
    async confirmPreviouslyCommitted() { throw new Error("Synthetic fixture requires checkpoint receipt"); },
  });
}


/** Synthetic source-file revision, not a model correction/learning writer. Old A
 * remains in Git/history while the current catalog names only revised B objects.
 */
export async function publishAgentSupplySourceRevision(source: Awaited<ReturnType<typeof createAgentSupplySource>>,
  stateDirectory: string, recovery: RecoveryReadBinding, replacementText: string) {
  const git = promisify(execFile), { expected } = recovery;
  const authority = await openLocalCheckpointRecovery({ stateDirectory, binding: expected.binding });
  const catalogBefore = await readFile(path.join(source.root, source.catalogPath), "utf8"), catalog = JSON.parse(catalogBefore);
  for (const group of ["understandings", "works", "changes", "bundles", "views"]) assert.equal(catalog[group].length, 0);
  const snapshot = JSON.parse(await readFile(path.join(source.root, source.archive.payload.path), "utf8"));
  const request = snapshotTurnRequest({ ...snapshot.request, prompt: replacementText }, snapshot.request.runId);
  const revised = prepareHostRequestArchive({ ...snapshot, request }, { ...source.binding.archive, ownerId: "owner-fixture" });
  // Immutable archive versions remain retained; only the current catalog switches
  // to B. This fixture does not extend the transaction format with deletion.
  const changes = new Map<string, MemoryTransactionPlan["files"][number]>();
  for (const file of [{ path: revised.payload.path, bytes: revised.payload.bytes }, ...revised.objects.map(value => ({ path: value.entry.locator.path, bytes: value.bytes }))]) {
    changes.set(file.path, { path: file.path, before: changes.get(file.path)?.before ?? null, after: file.bytes });
  }
  for (const object of revised.objects) {
    const index = catalog[object.group].findIndex((entry: any) => entry.id === object.ref.id); assert.ok(index >= 0);
    catalog[object.group][index] = object.entry;
  }
  catalog.parentGenerationId = catalog.generationId; catalog.generationId = "synthetic-source-revision-B";
  changes.set(source.catalogPath, { path: source.catalogPath, before: catalogBefore, after: canonicalJson(catalog) });
  const plan = { operationId: "synthetic-source-revision-B", journalPath: "30_PersonalData/memory/operations/synthetic-source-revision-B.checkpoint.json",
    recoveryCheckpoint: { binding: expected.binding, expected: { revision: expected.revision, token: expected.token } }, files: [...changes.values()] };
  return applyMemoryTransaction(source.root, plan, {
    recovery: { authority, expected, async assertPublication(accepted) { await authority.assertCurrent(accepted); } },
    async validate() { await authority.assertCurrent(expected); },
    async persist(paths) {
      await git("git", ["-C", source.root, "add", "--", ...paths]);
      await git("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", source.root,
        "commit", "--quiet", "-m", "[synthetic] revise current source file", "--", ...paths]);
    }, async confirmPreviouslyCommitted() { throw new Error("Synthetic fixture requires checkpoint receipt"); },
  });
}
