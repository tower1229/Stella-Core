import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createOrdinaryPlugin, SOURCE_READ_TOOL, parseOrdinaryConfig } from "../../src/ordinary-plugin.js";
import { executeOrdinarySourceRead, parseSourceReadBinding, type SourceReadAdmission } from "../../src/openclaw/ordinary-source-read.js";
import { prepareRepositorySource } from "../../src/canghai/repository-source.js";
import { CatalogError, parseMemoryCatalog } from "../../src/canghai/catalog-reader.js";
import { canonicalJson, bytesVersion, objectVersion } from "../../src/canghai/content-version.js";
import type { VersionedRef } from "../../src/canghai/ref.js";
import { sourceSegments, assertEvidenceSegment, segmentLocator } from "../../src/canghai/source-segments.js";

const run = promisify(execFile);
export const prefix = "50_PersonalAgent/stella/knowledge-migration-v1";
export const manifestPath = `${prefix}/manifest.json`, profilePath = `${prefix}/runtime-profile.json`;
export const catalogPath = "30_Knowledge/migration-v1/runtime/catalog.json";
export const hostVersion = "2026.10.9";
export async function fixture(t: TestContext, count = 3, textSize = 0, payloadText?: string, purpose = { readPurpose: "read", derivePurpose: "interpret", deliveryScope: "host" }, leafDerivePurposes = [purpose.derivePurpose]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-source-port-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, value: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value); };
  const policy = (id: string) => ({ schemaVersion: "stella.source-policy/v2", id, ownerId: "synthetic-owner", readPurposes: [purpose.readPurpose],
    derivePurposes: [purpose.derivePurpose], deliveryScopes: [purpose.deliveryScope], retention: "retain", authorityEvidenceRefs: [],
    restrictions: { sensitivity: "private", quotePolicy: "never_quote", allowedScenarios: ["writing"], forbiddenScenarios: ["social"] } });
  const basePolicy = policy("synthetic-base"), leafPolicy = { ...policy("synthetic-leaf"), derivePurposes: leafDerivePurposes };
  const baseRef = { id: basePolicy.id, version: objectVersion(basePolicy) }, leafRef = { id: leafPolicy.id, version: objectVersion(leafPolicy) };
  const catalog = parseMemoryCatalog({ schemaVersion: "stella.memory-catalog/v1", generationId: "synthetic-migration-one", parentGenerationId: null,
    sources: [], evidence: [], policies: [], coverage: [], understandings: [], works: [], changes: [], bundles: [], views: [] });
  for (const p of [basePolicy, leafPolicy]) {
    const bytes = canonicalJson(p), file = `30_Knowledge/migration-v1/runtime/objects/${p.id}.json`;
    await put(file, bytes); catalog.policies.push({ id: p.id, version: objectVersion(p), status: "current", dependencies: [], locator: { path: file, sha256: bytesVersion(bytes) } });
  }
  const refs: VersionedRef[] = [], texts: string[] = [];
  for (let index = 0; index < count; index++) {
    const text = payloadText ?? (textSize ? "x".repeat(textSize) : `Fictional source ${index}: the harbor walk is planned for July.\n`);
    const file = `30_Knowledge/migration-v1/runtime/payloads/source-${index}.txt`; await put(file, text); texts.push(text);
    const prepared = await prepareRepositorySource({ root, collectionId: "synthetic-migration", sourceId: `source-${index}`, relativePath: file,
      expectedSha256: bytesVersion(text), capturedAt: "2026-09-01T00:00:00Z", policyRef: baseRef, objectRoot: "30_Knowledge/migration-v1/runtime/objects",
      reviewedSegments: [{ start: 0, end: Buffer.byteLength(text), policyRef: leafRef }] });
    for (const item of prepared.objects) {
      if (item.group === "evidence") {
        const e: Record<string, unknown> = { ...item.object, role: index % 3 === 0 ? "owner" : index % 3 === 1 ? "assistant" : "external_author",
          kind: index % 3 === 0 ? "reported" : index % 3 === 1 ? "inference" : "quotation",
          occurredAt: "2026-07-01T00:00:00Z", authoredAt: "2026-08-01T00:00:00Z" };
        delete e.version;
        item.ref = { id: String(e.id), version: objectVersion(e) }; item.object = e; item.bytes = canonicalJson(e);
        item.entry = { ...item.entry, ...item.ref, locator: { path: `30_Knowledge/migration-v1/runtime/objects/evidence-${index}.json`, sha256: bytesVersion(item.bytes) } };
        refs.push(item.ref);
      }
      await put(item.entry.locator.path, item.bytes); catalog[item.group].push(item.entry);
    }
  }
  await put(catalogPath, canonicalJson(catalog));
  const manifest = { schemaVersion: "stella.consciousness-manifest/v1", sourceBaseline: { repository: "synthetic/CangHai", commit: "a".repeat(40) },
    instance: { id: "synthetic", ownerRef: "path:identity/owner.json" }, compatibility: { stellaCore: ">=3.0.0-alpha <4", openclaw: ">=2026.10.8" },
    identity: { soulRef: "path:identity/soul.md", runtimeProfileRef: `path:${profilePath}` }, twin: { hypothesisRegistryRef: "path:identity/twin.yaml" },
    frameworks: { sourceRegistryRef: "path:identity/frameworks.yaml", activeIrRegistryRef: "path:identity/active-ir.yaml" },
    praxis: { episodeRootRef: "path:praxis/episodes" }, experience: { corpusRegistryRef: "path:identity/corpora.yaml" },
    derived: { rebuild: [] }, runtimeState: { activationStatus: "active", runtimeProfileRef: `path:${profilePath}` } };
  const profile = { schema_version: "stella.runtime-profile/v2", contract_profile: "full_memory", host_materialization_ref: `path:${prefix}/host-materialization.json`,
    agent_id: "main", language: "zh-CN", timezone: "Etc/UTC", models: Object.fromEntries(["main", "router", "learning", "framework_compiler"].map(k =>
      [k, { provider: "google", model: "gemini-3.8-flash", required_capabilities: [] }])), capabilities: [], source_policies_ref: `path:${prefix}/source-policies.json`,
    memory: { catalog_ref: `path:${catalogPath}`, semantic_provider: "stella-structured-llm", required_views: ["current_understanding", "ongoing_work"], archive_max_rpo_seconds: 300 },
    autonomy: { research_enabled: false, proactive_delivery_enabled: false, delivery_policy_ref: "path:identity/delivery.json", delegation_registry_ref: "path:identity/delegation.json" } };
  await put(manifestPath, canonicalJson(manifest)); await put(profilePath, canonicalJson(profile));
  // No identity/Host config/bootstrap references are materialized: the narrow
  // reader must not load them or pretend full consciousness has been accepted.
  const git = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout;
  await git("init", "--quiet");
  const commit = async () => {
    await git("add", "--", ".");
    await git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic source snapshot");
    return (await git("rev-parse", "HEAD")).trim();
  };
  const revision = await commit();
  let metadataCalls = 0; const sourcePolicies: string[] = [];
  const admission: SourceReadAdmission = { assertCurrent() {}, async assertMetadata(reader, ref) {
    metadataCalls++;
    const e = await reader.read(ref, "evidence"), source = await reader.read(e.source as VersionedRef, "sources");
    const segment = assertEvidenceSegment(sourceSegments(source), e);
    return { sourceRef: e.source as VersionedRef, policyRef: e.policyRef as VersionedRef,
      ...(segment ? { segment: segmentLocator(segment) } : {}), description: `Reviewed fictional record ${refs.findIndex(r => r.id === ref.id)}.` };
  },
    purpose: { readPurpose: "read", derivePurpose: "interpret", deliveryScope: "host", evidenceCutoff: "2026-10-01T00:00:00Z",
      trustedAdapters: { user_report: [], tool_observation: [], system_event: [] },
      sourceAccess: async (_reader, target) => { sourcePolicies.push(target.policyRef.id); return { judgment: {
        scenarios: ["writing"], trigger: "user_requested", topicRequested: true, topicExplicitlyNamed: true, presentation: "summary" }, quoteGrants: [] }; } } };
  const binding = { root, manifestPath, revision };
  const execute = (parameters: unknown, use = admission) => executeOrdinarySourceRead({ binding, agentId: "main", hostVersion, parameters, admission: use });
  return { root, put, refs, texts, binding, admission, execute, git, commit, manifest, profile, catalog,
    metadataCalls: () => metadataCalls, sourcePolicies };
}
