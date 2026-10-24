import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSupplySource } from "./checkpoint-agent-supply-fixture.js";
import { bytesVersion, canonicalJson, objectVersion } from "../src/canghai/content-version.js";
import { validateUnderstanding } from "../src/praxis/personal-views.js";
import type { CatalogGroup, MemoryCatalog } from "../src/canghai/catalog-reader.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";

export const UNDERSTANDING_MODEL = "google/gemini-3.8-flash";
export const UNDERSTANDING_IDS = { owner: "synthetic-owner-understanding", hypothesis: "synthetic-writing-hypothesis" } as const;
export const UNDERSTANDING_STATEMENT_A = "SYNTHETIC_UNDERSTANDING_A_5827: In the synthetic writing project, preserve unresolved questions.";
export const UNDERSTANDING_STATEMENT_B = "SYNTHETIC_UNDERSTANDING_B_5827: In the synthetic writing project, preserve unresolved questions and check the argument before closing.";
export const UNDERSTANDING_HYPOTHESIS = "SYNTHETIC_UNDERSTANDING_H_5827: An open ending may help this writing project; this remains an unaccepted hypothesis.";
export const UNDERSTANDING_CORRECTION = `SYNTHETIC_UNDERSTANDING_CORRECTION_5827: Change only my project-scoped owner statement to ${UNDERSTANDING_STATEMENT_B} Keep its scope and active status; leave the provisional hypothesis unchanged and do not promote it into an owner fact.`;
export const UNDERSTANDING_QUESTIONS = [
  "SYNTHETIC_UNDERSTANDING_QUERY_A_5827: What current author statement and provisional hypothesis apply to the synthetic-writing-project? Keep their USER and MEMORY distinctions.",
  "SYNTHETIC_UNDERSTANDING_QUERY_B_5827: Recall the current understanding for synthetic-writing-project after my correction, keeping the hypothesis provisional.",
] as const;

/** Synthetic origin graphs only; real public Host admission/processing remains a
 * separate test. No Work, direct correction writer or pre-archived correction. */
export async function createCheckpointUnderstandingSource() {
  const source = await createAgentSupplySource({ materialization: true, policyContext: "allow" });
  const catalog = JSON.parse(await readFile(path.join(source.root, source.catalogPath), "utf8")) as MemoryCatalog;
  const binding = JSON.parse(await readFile(path.join(source.root, "50_PersonalAgent/stella/praxis-binding.json"), "utf8"));
  assert.equal(catalog.sources.length, 1); assert.equal(catalog.evidence.length, 1);
  assert.equal(catalog.works.length, 0); assert.equal(catalog.understandings.length, 0); assert.equal(catalog.changes.length, 0);
  const sourceRef = { id: catalog.sources[0]!.id, version: catalog.sources[0]!.version };
  const evidenceRef = { id: catalog.evidence[0]!.id, version: catalog.evidence[0]!.version };
  const originalPolicyRef = { id: String(binding.archive.policyRef.id), version: String(binding.archive.policyRef.version) };
  const written: string[] = [];
  const put = async (group: CatalogGroup, object: Record<string, unknown>, dependencies: VersionedRef[] = []) => {
    const ref = { id: String(object.id), version: objectVersion(object) }, bytes = canonicalJson(object);
    const relative = `30_PersonalData/memory/objects/${ref.id}/${ref.version.slice(7)}.json`;
    await mkdir(path.dirname(path.join(source.root, relative)), { recursive: true }); await writeFile(path.join(source.root, relative), bytes);
    catalog[group].push({ ...ref, status: "current", dependencies, locator: { path: relative, sha256: bytesVersion(bytes) } });
    written.push(relative); return ref;
  };
  const at = "2020-01-01T00:00:00Z";
  const common = { schemaVersion: "stella.understanding/v1", scope: { workIds: [], contexts: ["synthetic-writing-project"], domains: ["writing"], global: false },
    supportRefs: [evidenceRef], counterRefs: [], dependencyRefs: [], createdAt: at, updatedAt: at };
  const records = {
    owner: { ...structuredClone(common), id: UNDERSTANDING_IDS.owner, kind: "owner_statement", status: "active", statement: UNDERSTANDING_STATEMENT_A,
      originChangeId: "synthetic-owner-understanding-origin" },
    hypothesis: { ...structuredClone(common), id: UNDERSTANDING_IDS.hypothesis, kind: "hypothesis", status: "candidate", statement: UNDERSTANDING_HYPOTHESIS,
      originChangeId: "synthetic-writing-hypothesis-origin" },
  };
  validateUnderstanding(records.owner); validateUnderstanding(records.hypothesis);
  const understandingRefs = { owner: await put("understandings", records.owner, [evidenceRef]), hypothesis: await put("understandings", records.hypothesis, [evidenceRef]) };
  for (const name of ["owner", "hypothesis"] as const) {
    const target = understandingRefs[name], record = records[name];
    await put("changes", { schemaVersion: "stella.learning-change/v1", id: record.originChangeId, operationId: record.originChangeId,
      algorithmVersion: "synthetic-understanding-seed/v1", modelRef: UNDERSTANDING_MODEL, promptVersion: "synthetic-understanding-seed/v1",
      inputRefs: [evidenceRef], targetRefs: [target], changes: [{ kind: "create", before: null, after: target, supportRefs: [evidenceRef], counterRefs: [] }],
      rationale: "Synthetic initial origin graph distinguishes an owner statement from an unaccepted hypothesis.", disposition: "update" }, [evidenceRef, target]);
  }
  // Only new user inputs use v1 archive admission. Existing Source/Evidence keep
  // their v3 policy, exact reviewed descriptor and keep_scope/summarize_only rules.
  const archivePolicyRef = await put("policies", { schemaVersion: "stella.source-policy/v1", id: "synthetic-understanding-ingress-policy", ownerId: "owner-fixture",
    readPurposes: [binding.purpose.readPurpose], derivePurposes: [binding.purpose.derivePurpose], deliveryScopes: [binding.purpose.deliveryScope],
    retention: "retain", authorityEvidenceRefs: [] });
  binding.archive.policyRef = archivePolicyRef;
  const bindingPath = "50_PersonalAgent/stella/praxis-binding.json";
  await writeFile(path.join(source.root, bindingPath), canonicalJson(binding));
  const grantPath = "50_PersonalAgent/stella/checkpoint-access.json";
  const grant = JSON.parse(await readFile(path.join(source.root, grantPath), "utf8"));
  grant.requesterIds = ["cli"]; grant.modelRefs = [UNDERSTANDING_MODEL]; grant.viewProcessingModelRefs = [UNDERSTANDING_MODEL];
  await writeFile(path.join(source.root, grantPath), canonicalJson(grant));
  catalog.parentGenerationId = catalog.generationId; catalog.generationId = "synthetic-current-understanding-A";
  await writeFile(path.join(source.root, source.catalogPath), canonicalJson(catalog));
  const execute = promisify(execFile), git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false",
    "-c", "diff.autoRefreshIndex=false", "-C", source.root, ...args], { timeout: 15_000 })).stdout.trim();
  assert.equal(await git("remote"), "");
  await git("add", "--", ...written, source.catalogPath, bindingPath, grantPath);
  await git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "[synthetic] seed scoped owner and provisional understanding origin graphs");
  assert.equal(await git("status", "--porcelain"), "");
  return { ...source, revision: await git("rev-parse", "HEAD"), binding, catalogPath: source.catalogPath, grantPath, sourceRef, evidenceRef,
    originalPolicyRef, archivePolicyRef, understandingRefs, records, statementA: UNDERSTANDING_STATEMENT_A, statementB: UNDERSTANDING_STATEMENT_B,
    correction: UNDERSTANDING_CORRECTION, questions: UNDERSTANDING_QUESTIONS };
}
