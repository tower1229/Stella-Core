import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadContinuitySuite } from "../src/acceptance/continuity-suite.js";

test("portable continuity suite resolves explicit versioned inputs, rejects legacy and malformed dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-suite-test-"));
  const emit = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value));
  const suite = { schema_version: "stella.continuity-suite/v1", id: "synthetic", version: "2.0.0", required_capabilities: ["structured_model"],
    judge_policy_ref: "path:judge.json", cases: [{ id: "identity", required: true, probe_ref: "path:probe.json", rubric_ref: "path:rubric.json" }] };
  const rubric = { schema_version: "stella.continuity-rubric/v1", id: "identity", allowed_response_kinds: ["answer"],
    structural_assertions: [{ id: "scope", required: true, condition: "Match actual set" }],
    semantic_dimensions: [{ id: "meaning", required: true, condition: "Keep unknown unknown" }] };
  try {
    await emit("suite.json", suite);
    await emit("judge.json", { schema_version: "stella.continuity-judge-policy/v1", id: "judge", model: "google/gemini-3.1-pro-preview",
      host_version: "2026.8.2", prompt_version: "stella.recovery-continuity/v1", temperature: 0, attempts: 1 });
    await emit("probe.json", { schema_version: "stella.continuity-probe/v1", id: "identity", message: "Synthetic prompt" });
    await emit("rubric.json", rubric);
    assert.equal((await loadContinuitySuite(root, "path:suite.json")).probes[0]!.message, "Synthetic prompt");
    for (const invalid of [{ schemaVersion: "stella.private-continuity-suite/v1", probes: [] },
      { ...suite, cases: [...suite.cases, ...suite.cases] }, { ...suite, judge_policy_ref: "path:../outside.json" },
      { ...suite, cases: [{ ...suite.cases[0], probe_ref: "path:missing.json" }] }]) {
      await emit("suite.json", invalid);
      await assert.rejects(loadContinuitySuite(root, "path:suite.json"), { message: "continuity_suite_validation_failed" });
    }
    await emit("suite.json", suite);
    await emit("rubric.json", { ...rubric, semantic_dimensions: rubric.structural_assertions });
    await assert.rejects(loadContinuitySuite(root, "path:suite.json"), /validation_failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
