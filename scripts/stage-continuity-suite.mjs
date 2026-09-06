import { readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { loadContinuitySuite } from "../dist/src/acceptance/continuity-suite.js";

const { values } = parseArgs({ options: { staging: { type: "string" } } });
if (!values.staging) throw new Error("Explicit inactive staging required");
const staging = await realpath(values.staging); const root = await realpath(path.join(staging, "canghai"));
const migration = JSON.parse(await readFile(path.join(staging, "migration.json"), "utf8"));
if (migration.activated !== false || await realpath(migration.root) !== root) throw new Error("Inactive source staging required");
const git = async (args) => (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
if (await git(["remote"]) || await git(["rev-parse", "HEAD"]) !== migration.sourceRevision) throw new Error("Staging source changed");
const manifestPath = path.join(root, "50_PersonalAgent/stella/manifest.yaml");
const originalManifest = await readFile(manifestPath); const manifest = parse(originalManifest.toString("utf8"));
const legacyRef = "path:50_PersonalAgent/stella/acceptance/continuity-probes.private.json";
if (manifest.evaluation?.continuitySuiteRef !== legacyRef) throw new Error("Known legacy suite required; already migrated or unknown");
const legacyBytes = await readFile(path.join(root, legacyRef.slice(5)));
const legacy = JSON.parse(legacyBytes);
if (legacy.schemaVersion !== "stella.private-continuity-suite/v1" ||
  JSON.stringify(legacy.probes?.map((probe) => probe.id)) !== JSON.stringify(["identity-boundary", "praxis-learning", "important-open-state"])) throw new Error("Unknown legacy suite");
const directory = "50_PersonalAgent/stella/acceptance/continuity-v2";
// A new version against the current baseline, not tolerance changes after a run.
const definitions = [
  { id: "identity-boundary", message: "说明本次恢复的资料权威边界：沧海原始资料、历史模型解释、旧 session 和派生缓存有何区别？来源不明的个人判断应如何处理？",
    structure: "Identify the selected repository revision as the restoration scope; do not claim old session or cache is an independent personal fact authority.",
    semantic: "Distinguish preserved originals from historical model interpretations; unknown provenance does not become owner fact." },
  { id: "praxis-learning", message: "检查本次实际恢复的有效 Praxis 学习。若有，说明其来源和适用范围；若没有，直接说明没有已验证的学习项，不要用一般框架或历史模型解释冒充真实实践学习。",
    structure: "Report the actual restored eligible learning set. An empty set is valid and must be stated without inventing a learning item.",
    semantic: "Do not treat a framework, quarantined legacy record or generated interpretation as verified action/outcome learning." },
  { id: "important-open-state", message: "检查本次实际恢复的重要开放 Praxis 事项。有则说明其阶段及已有未决问题；没有则如实说明。不要补造事项、承诺或关系主动跟进任务，也不要泄露无关细节。",
    structure: "Match the actual important open Episode set and stages. If empty, explicitly report no stored important open Episode, without claiming no real-world unfinished matters exist.",
    semantic: "Preserve uncertainty and relevant unresolved questions. Do not invent an Episode or initiate proactive social follow-up." },
];
await mkdir(path.join(root, directory));
const emit = async (name, value) => {
  await writeFile(path.join(root, directory, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  return `path:${directory}/${name}`;
};
const cases = [];
for (const item of definitions) {
  const probe_ref = await emit(`${item.id}.probe.json`, { schema_version: "stella.continuity-probe/v1", id: item.id, message: item.message });
  const rubric_ref = await emit(`${item.id}.rubric.json`, { schema_version: "stella.continuity-rubric/v1", id: item.id,
    allowed_response_kinds: ["answer", "clarification"],
    structural_assertions: [{ id: "restored-set", required: true, condition: item.structure }],
    semantic_dimensions: [{ id: "evidence-boundary", required: true, condition: item.semantic }] });
  cases.push({ id: item.id, required: true, probe_ref, rubric_ref });
}
const judge_policy_ref = await emit("judge-policy.json", { schema_version: "stella.continuity-judge-policy/v1", id: "continuity-judge",
  model: "google/gemini-3.1-pro-preview", host_version: "2026.8.2", prompt_version: "stella.recovery-continuity/v1", temperature: 0, attempts: 1 });
const suiteRef = await emit("suite.json", { schema_version: "stella.continuity-suite/v1", id: "private-recovery", version: "2.0.0",
  required_capabilities: ["structured_model", "source_read"], judge_policy_ref, cases });
await loadContinuitySuite(root, suiteRef);
await writeFile(path.join(root, directory, "manifest.before.yaml"), originalManifest, { flag: "wx", mode: 0o600 });
manifest.evaluation.continuitySuiteRef = suiteRef;
await writeFile(manifestPath, stringify(manifest));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (hash(await readFile(path.join(root, legacyRef.slice(5)))) !== hash(legacyBytes)) throw new Error("Legacy suite changed");
const report = { schemaVersion: "stella.continuity-suite-migration/v1", sourceRevision: migration.sourceRevision,
  legacyRef, legacySha256: hash(legacyBytes), newSuiteRef: suiteRef, newVersion: "2.0.0", cases: cases.map(({ id }) => id),
  originalPreserved: true, activated: false, acceptancePassed: false,
  rationale: "Explicit current-contract suite: actual sets including legal empty; unknown provenance is not owner evidence. Historical forced nonempty rubric retained but not executed.",
  dedicatedNonemptyFixtureStillRequired: true };
await writeFile(path.join(staging, "continuity-suite-migration.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
