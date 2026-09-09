import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { deliveryCatalog } from "./delivery-catalog.js";

export type DeliveryStatus = "pending" | "in_progress" | "implemented" | "verified" | "blocked";
export type DeliveryVersion = { core: string; artifact: string; host: string; harness: string; source: string;
  profile: string; policy: string; configuration: string; model: string; cases: string; sourceClean: boolean };
export const deliveryEnvironments = ["synthetic_contract", "exact_host", "real_main", "natural_feedback"] as const;
type Environment = typeof deliveryEnvironments[number];
export type DeliveryEvidence = { id: string; target: string; caseId: string; environment: Environment;
  version: DeliveryVersion; recordedAt: string; expiresAt: string; result: "passed" | "failed" | "implemented" | "in_progress";
  artifactSha256: string; supersedes: string[] };
export type DeliveryPreflight = { schemaVersion: string; diagnosticOnly: boolean; behavioralAcceptance: string;
  capabilities: readonly { id: string; required: boolean; placeholder: boolean; declaredPassed: boolean }[];
  counts: { sources: number; understandings: number; works: number }; blockers: readonly string[] };
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const environments = deliveryEnvironments.filter(value => value !== "natural_feedback");

/** Reporting only: this ledger cannot admit capabilities or authorize runtime operations. */
export async function buildDeliveryLedger(input: { version: DeliveryVersion; checkedAt: string;
  evidence: readonly DeliveryEvidence[]; preflight: DeliveryPreflight | null; contractRoot?: string;
  readEvidence?: (sha256: string) => Promise<Uint8Array> }) {
  validateVersion(input.version);
  const now = Date.parse(input.checkedAt);
  if (!Number.isFinite(now)) throw new Error("invalid_delivery_date");
  const root = input.contractRoot ?? process.cwd();
  const contracts = new Map<string, string>();
  for (const { contract } of deliveryCatalog.acceptances) {
    if (!contracts.has(contract.path)) contracts.set(contract.path, digest(await readFile(path.join(root, contract.path))));
    if (contracts.get(contract.path) !== contract.sha256) throw new Error("delivery_contract_version_mismatch");
  }
  const history = await inspectEvidence(input.evidence, input.version, now, input.readEvidence);
  const makeRow = (id: string) => {
    const cases = environments.map(environment => {
      const caseId = `spec6-${id}-${environment}`;
      const applicable = history.filter(record => record.target === id && record.caseId === caseId && record.validity === "current");
      const result = applicable.some(record => record.result === "failed") ? "failed"
        : applicable.some(record => record.result === "passed") ? "passed"
        : applicable.some(record => record.result === "implemented") ? "implemented"
        : applicable.some(record => record.result === "in_progress") ? "in_progress" : "not_executed";
      return { caseId, environment, version: input.version, result, evidence: applicable.map(record => record.id) };
    });
    const stale = history.some(record => record.target === id && record.validity !== "current");
    const status: DeliveryStatus = cases.some(record => record.result === "failed") ? "blocked"
      : cases.every(record => record.result === "passed") ? "verified"
      : cases.some(record => record.result === "implemented" || record.result === "passed") ? "implemented"
      : cases.some(record => record.result === "in_progress") ? "in_progress" : "pending";
    return { id, status, gaps: [...(cases.some(record => record.result === "not_executed") ? ["evidence_missing"] : []),
      ...(stale ? ["historical_evidence_not_current"] : []), ...(status === "blocked" ? ["behavior_failed"] : [])], cases, completedEvidence: cases.flatMap(record => record.evidence),
      unblockConditions: ["Provide current interface evidence for each listed case."] };
  };
  const works = deliveryCatalog.works.map(row => ({ ...row, ...makeRow(row.id),
    kind: Number(row.id) >= 19 && Number(row.id) <= 30 ? "capability_closure" : "delivery_work" }));
  const acceptances = deliveryCatalog.acceptances.map(row => ({ ...row, ...makeRow(row.id) }));
  const preflight = summarizePreflight(input.preflight);
  for (const capability of preflight.capabilities) {
    const work = works.find(row => row.id === capability.workId);
    if (work && capability.configuration === "missing") {
      work.status = "blocked";
      work.gaps.push("configuration_missing");
    }
  }
  if (preflight.gaps.includes("acceptance_not_implemented")) {
    const work = works.find(row => row.id === "02")!;
    work.status = "blocked";
    work.gaps.push("acceptance_not_implemented");
  }
  for (const diagnostic of preflight.diagnostics) {
    for (const workId of diagnostic.workIds) {
      const work = works.find(row => row.id === workId)!;
      work.status = "blocked";
      work.gaps.push(diagnostic.category);
      work.unblockConditions.push(diagnostic.resolution);
    }
  }
  // Associations describe shared scope, not proof that this work implements the whole acceptance set.
  // Propagate dependency failures to a fixed point, including forward references.
  let changed: boolean;
  do {
    changed = false;
    for (const work of works) {
      if (work.status === "verified" && work.dependencies.some(id => works.find(row => row.id === id)?.status !== "verified")) {
        work.status = "implemented";
        work.gaps.push("dependencies_unverified");
        changed = true;
      }
    }
  } while (changed);
  return { schemaVersion: "stella.delivery-ledger/v1", specIssue: 6, scope: "delivery_diagnostic", diagnosticOnly: true,
    checkedAt: input.checkedAt, version: input.version, specification: { revision: deliveryCatalog.specRevision,
      bodySha256: deliveryCatalog.specBodySha256 }, works, acceptances, preflight,
    complete: input.version.sourceClean && preflight.state === "observed" && !preflight.gaps.some(gap => gap !== "behavioral_evidence_missing") &&
      works.every(row => row.status === "verified") && acceptances.every(row => row.status === "verified"),
    history, naturalFeedback: history.filter(record => record.environment === "natural_feedback") };
}

const versionKeys = ["core", "artifact", "host", "harness", "source", "profile", "policy", "configuration", "model", "cases", "sourceClean"] as const;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validateVersion(value: unknown): asserts value is DeliveryVersion {
  if (!isRecord(value) || Object.keys(value).length !== versionKeys.length ||
    !versionKeys.every(key => key === "sourceClean" ? typeof value[key] === "boolean" : key === "core"
      ? typeof value[key] === "string" && /^[a-f0-9]{40}$/.test(value[key]) : hash(value[key]))) throw new Error("invalid_delivery_version");
}
function validateEvidence(value: unknown): asserts value is DeliveryEvidence {
  const keys = ["id", "target", "caseId", "environment", "version", "recordedAt", "expiresAt", "result", "artifactSha256", "supersedes"];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
    !hash(value.id) || !hash(value.artifactSha256) || typeof value.target !== "string" ||
    ![...deliveryCatalog.works, ...deliveryCatalog.acceptances].some(row => row.id === value.target) ||
    !deliveryEnvironments.some(environment => environment === value.environment) ||
    value.caseId !== `spec6-${value.target}-${value.environment}` ||
    !["passed", "failed", "implemented", "in_progress"].includes(String(value.result)) ||
    typeof value.recordedAt !== "string" || typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt)) || !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.recordedAt) ||
    !Array.isArray(value.supersedes) || !value.supersedes.every(hash)) throw new Error("invalid_delivery_evidence");
  validateVersion(value.version);
}
async function inspectEvidence(evidence: readonly DeliveryEvidence[], version: DeliveryVersion, now: number,
  readEvidence?: (sha256: string) => Promise<Uint8Array>) {
  const ids = new Set<string>();
  for (const record of evidence) {
    validateEvidence(record);
    if (ids.has(record.id)) throw new Error("duplicate_delivery_evidence");
    ids.add(record.id);
  }
  const currentValidity = (record: DeliveryEvidence) => !record.version.sourceClean ? "dirty_source"
    : canonicalJson(record.version) !== canonicalJson(version) ? "version_mismatch"
    : Date.parse(record.recordedAt) > now ? "future_evidence" : Date.parse(record.expiresAt) <= now ? "expired" : "current";
  const superseded = new Set<string>();
  for (const record of evidence) {
    for (const id of record.supersedes) {
      const previous = evidence.find(item => item.id === id);
      if (!previous || previous.target !== record.target || previous.caseId !== record.caseId ||
        Date.parse(previous.recordedAt) >= Date.parse(record.recordedAt)) throw new Error("invalid_evidence_supersession");
      if (currentValidity(record) === "current") superseded.add(id);
    }
  }
  return Promise.all(evidence.map(async record => {
    if (!readEvidence || digest(await readEvidence(record.artifactSha256)) !== record.artifactSha256) throw new Error("evidence_digest_mismatch");
    const validity = superseded.has(record.id) ? "superseded" : currentValidity(record);
    return { ...record, recordedAt: new Date(record.recordedAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString(),
      validity, locator: `sha256:${record.artifactSha256}` };
  }));
}

const capabilityIds = ["memory_access", "memory_lifecycle", "source_access_context", "semantic_retrieval", "ongoing_work",
  "framework_learning", "external_research", "uniform_sampling", "weread_gateway", "public_ask_batch", "automation_delivery", "host_initialization"] as const;
function summarizePreflight(preflight: DeliveryPreflight | null) {
  if (!preflight) return { state: "not_executed", gaps: ["preflight_evidence_missing"], capabilities: [], collections: [], diagnostics: [] as PreflightDiagnostic[] };
  if (preflight.schemaVersion !== "stella.main-readiness/v1" || preflight.diagnosticOnly !== true ||
    preflight.behavioralAcceptance !== "not_executed" || !Array.isArray(preflight.capabilities) || !Array.isArray(preflight.blockers) ||
    !preflight.counts || ![preflight.counts.sources, preflight.counts.understandings, preflight.counts.works].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("invalid_delivery_preflight");
  }
  // Only fixed vocabulary and aggregate presence leave the private inspection boundary.
  const capabilities = capabilityIds.map(id => {
    const rows = preflight.capabilities.filter(row => row.id === id);
    const row = rows[0];
    if (rows.length > 1) throw new Error("invalid_delivery_preflight");
    return { id, workId: String(19 + capabilityIds.indexOf(id)).padStart(2, "0"),
      configuration: !row || row.placeholder ? "missing" : "present",
      behavioralEvidence: "missing" };
  });
  return { state: "observed", diagnostics: diagnoseBlockers(preflight.blockers), gaps: ["behavioral_evidence_missing", ...(capabilities.some(row => row.configuration === "missing") ? ["configuration_missing"] : []),
    ...(preflight.blockers.includes("full_memory_acceptance_unavailable") ? ["acceptance_not_implemented"] : []),
    ...(preflight.blockers.length ? ["runtime_blocked"] : [])], capabilities,
    collections: (["sources", "understandings", "works"] as const).map(id => ({ id, state: preflight.blockers.includes("memory_catalog_missing") ? "unavailable"
      : preflight.counts[id] === 0 ? "valid_empty" : "present" })) };
}


type PreflightDiagnostic = { category: string; workIds: string[]; resolution: string };
function diagnoseBlockers(blockers: readonly string[]): PreflightDiagnostic[] {
  const known: PreflightDiagnostic[] = [
    { category: "profile_agent_mismatch", workIds: ["31"], resolution: "Align the profile and configured target agent." },
    { category: "full_memory_profile_required", workIds: ["02", "30"], resolution: "Provide the required full_memory profile without removing capability gates." },
    { category: "personal_view_fallback_route_forbidden", workIds: ["13", "32"], resolution: "Remove the unauthorized fallback model route from personal-context execution." },
    { category: "host_initialization_not_ready", workIds: ["31"], resolution: "Resolve the initialization coordinator stage and rerun its public status check." },
    { category: "invalid_host_runtime_status", workIds: ["02"], resolution: "Obtain a valid runtime status through the existing initialization coordinator." },
    { category: "runtime_acceptance_not_evaluated", workIds: ["02", "37"], resolution: "Execute the required capability acceptance and validate its current receipts." },
    { category: "full_memory_acceptance_unavailable", workIds: ["02", "05"], resolution: "Implement and validate the full-memory capability acceptance adapter." },
    { category: "personal_context_access_binding_missing", workIds: ["03", "21"], resolution: "Configure the supported personal-context access binding and verify its authorization boundary." },
    { category: "owner_input_archive_binding_missing", workIds: ["04", "08"], resolution: "Configure the owner input archive binding and verify durable ingest." },
    { category: "source_purpose_migration_pending", workIds: ["11", "13"], resolution: "Complete the reviewed source-purpose migration and recheck authorization." },
    { category: "memory_catalog_missing", workIds: ["07", "20"], resolution: "Provide and validate the declared memory catalog; absence is not an empty collection." },
  ];
  for (const role of ["main", "router", "learning", "framework_compiler"]) known.push({ category: `model_route_mismatch:${role}`,
    workIds: ["03", "32"], resolution: "Align the profile model route with the actual configured agent route and repeat the check." });
  for (const [index, id] of capabilityIds.entries()) {
    for (const kind of ["capability_configuration_missing", "capability_acceptance_missing", "skill_capability_unverified"]) {
      known.push({ category: `${kind}:${id}`, workIds: [String(19 + index).padStart(2, "0")],
        resolution: kind === "capability_configuration_missing" ? "Replace the placeholder with the actual adapter configuration and validate dependencies."
          : "Run this capability's success and refusal cases on the current version and register validated evidence." });
    }
  }
  const result = known.filter(item => blockers.includes(item.category));
  if (blockers.some(blocker => !known.some(item => item.category === blocker))) result.push({ category: "unrecognized_runtime_blocker",
    workIds: ["02"], resolution: "Inspect the private preflight receipt and resolve its unrecognized runtime failure before repeating the check." });
  return result;
}
