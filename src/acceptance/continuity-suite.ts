import { readRepositoryBytes } from "../canghai/catalog-reader.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { isRecord } from "../shared/type-guards.js";

const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
function check(value: unknown): asserts value {
  if (!value) throw new Error("continuity_suite_validation_failed");
}
export type ContinuityRubric = {
  schema_version: "stella.continuity-rubric/v1"; id: string;
  allowed_response_kinds: string[];
  structural_assertions: Array<{ id: string; required: boolean; condition: string }>;
  semantic_dimensions: Array<{ id: string; required: boolean; condition: string }>;
};
export type ContinuitySuite = {
  id: string; version: string; requiredCapabilities: string[];
  judgePolicy: { model: "google/gemini-3.1-pro-preview"; host_version: "2026.8.2";
    prompt_version: "stella.recovery-continuity/v1"; temperature: number; attempts: 1 };
  probes: Array<{ id: string; required: boolean; message: string; rubric: ContinuityRubric }>;
};

/** Explicit portable suite only; legacy formats require a separate migration. */
export async function loadContinuitySuite(root: string, ref: string): Promise<ContinuitySuite> {
  async function read(reference: unknown): Promise<Record<string, unknown>> {
    check(nonempty(reference));
    const parsed = parseCangHaiRef(reference);
    check(!reference.includes("#") && !parsed.relativePath.split("/").some((part) => part.toLowerCase() === ".git"));
    const bytes = await readRepositoryBytes(root, parsed.relativePath);
    check(bytes.length <= 200_000);
    const value: unknown = JSON.parse(bytes.toString("utf8")); check(isRecord(value)); return value;
  }
  try {
    const suite = await read(ref);
    check(suite.schema_version === "stella.continuity-suite/v1" && id(suite.id) && nonempty(suite.version) &&
      Array.isArray(suite.cases) && suite.cases.length > 0 && suite.cases.length <= 10 &&
      Array.isArray(suite.required_capabilities) && suite.required_capabilities.every(nonempty) &&
      new Set(suite.required_capabilities).size === suite.required_capabilities.length && suite.required_capabilities.includes("structured_model"));
    const policy = await read(suite.judge_policy_ref);
    check(policy.schema_version === "stella.continuity-judge-policy/v1" && id(policy.id) &&
      policy.model === "google/gemini-3.1-pro-preview" && policy.host_version === "2026.8.2" &&
      policy.prompt_version === "stella.recovery-continuity/v1" && policy.temperature === 0 && policy.attempts === 1);
    const probes: ContinuitySuite["probes"] = [];
    for (const entry of suite.cases) {
      check(isRecord(entry) && id(entry.id) && typeof entry.required === "boolean" && !probes.some((probe) => probe.id === entry.id));
      const probe = await read(entry.probe_ref); const rubric = await read(entry.rubric_ref);
      check(probe.schema_version === "stella.continuity-probe/v1" && probe.id === entry.id && nonempty(probe.message));
      check(rubric.schema_version === "stella.continuity-rubric/v1" && rubric.id === entry.id &&
        Array.isArray(rubric.allowed_response_kinds) && rubric.allowed_response_kinds.length > 0 &&
        rubric.allowed_response_kinds.every((kind) => ["answer", "clarification", "collaboration", "action_advice", "outcome_ack"].includes(String(kind))));
      const assertionIds = new Set<string>();
      for (const key of ["structural_assertions", "semantic_dimensions"]) {
        check(Array.isArray(rubric[key]) && rubric[key].length > 0);
        for (const assertion of rubric[key]) {
          check(isRecord(assertion) && id(assertion.id) && !assertionIds.has(assertion.id) &&
            typeof assertion.required === "boolean" && nonempty(assertion.condition));
          assertionIds.add(assertion.id);
        }
      }
      probes.push({ id: entry.id, required: entry.required, message: probe.message, rubric: rubric as ContinuityRubric });
    }
    check(probes.some((probe) => probe.required));
    return { id: suite.id, version: suite.version, requiredCapabilities: suite.required_capabilities,
      judgePolicy: policy as ContinuitySuite["judgePolicy"], probes };
  } catch { throw new Error("continuity_suite_validation_failed"); }
}
