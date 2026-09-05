import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  parsePraxisEvaluationSuite,
  parsePraxisEvaluationSuiteFragment,
  runPraxisEvaluation,
  selectPraxisEvaluationAnswerAgent,
  type PraxisEvaluationCase,
  type PraxisEvaluationObservation,
} from "../src/acceptance/praxis-evaluation.js";

const dimensions = {
  situationUnderstanding: true,
  personalContextUse: true,
  frameworkApplication: true,
  hiddenVariablesSurfaced: true,
  concreteNextAction: true,
  ownerFit: true,
  retrospectiveEndorsement: true,
};

function publicCases(count = 30): PraxisEvaluationCase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `social-${String(index + 1).padStart(2, "0")}`,
    boundary: "public_synthetic" as const,
    category: [
      "relationship_communication",
      "gratitude_reciprocity",
      "asking_for_help",
      "refusing_requests",
      "family_privacy",
      "social_etiquette",
      "informal_workplace",
      "uncertainty_conflict",
    ][index % 8]!,
    prompt: `Synthetic social situation ${index + 1}`,
  }));
}

test("isolates public synthetic answers from the private Stella agent", () => {
  const agents = {
    publicAnswerAgentId: "alpha-public",
    privateAnswerAgentId: "main",
  };

  assert.equal(selectPraxisEvaluationAnswerAgent("public_synthetic", agents), "alpha-public");
  assert.equal(selectPraxisEvaluationAnswerAgent("private_canghai", agents), "main");
});

test("runs 30-50 public Praxis cases through an injected behavioral seam", async () => {
  const seen: string[] = [];
  const report = await runPraxisEvaluation(publicCases(30), async (evaluationCase) => {
    seen.push(evaluationCase.id);
    return {
      caseId: evaluationCase.id,
      dimensions,
      evidence: ["structured evaluator evidence"],
    } satisfies PraxisEvaluationObservation;
  });

  assert.equal(report.schemaVersion, "stella.alpha-praxis-evaluation/v1");
  assert.equal(report.boundary, "public_synthetic");
  assert.deepEqual(report.boundaryCounts, { public_synthetic: 30, private_canghai: 0 });
  assert.equal(report.caseCount, 30);
  assert.equal(report.passedCount, 30);
  assert.equal(report.failedCount, 0);
  assert.deepEqual(report.failedDimensions, {});
  assert.deepEqual(seen, publicCases(30).map(({ id }) => id));
  assert.deepEqual(report.categoryCounts, {
    asking_for_help: 4,
    family_privacy: 4,
    gratitude_reciprocity: 4,
    informal_workplace: 3,
    relationship_communication: 4,
    refusing_requests: 4,
    social_etiquette: 4,
    uncertainty_conflict: 3,
  });
});

test("fails closed for an undersized, duplicate, or incomplete suite", async () => {
  const execute = async (evaluationCase: PraxisEvaluationCase) => ({
    caseId: evaluationCase.id,
    dimensions,
    evidence: ["evidence"],
  });

  await assert.rejects(runPraxisEvaluation(publicCases(29), execute), /30 to 50/);
  await assert.rejects(
    runPraxisEvaluation(
      publicCases(30).map((entry, index) => index === 29 ? { ...entry, id: "social-01" } : entry),
      execute,
    ),
    /unique/,
  );
  await assert.rejects(
    runPraxisEvaluation(
      publicCases(30).map((entry) => ({ ...entry, category: "relationship_communication" })),
      execute,
    ),
    /all required categories/,
  );
});

test("keeps public and private cases explicitly separated in a mixed run", async () => {
  const cases = publicCases(30).map((entry, index) => index === 0
    ? { ...entry, boundary: "private_canghai" as const }
    : entry);
  const report = await runPraxisEvaluation(cases, async (evaluationCase) => ({
    caseId: evaluationCase.id,
    dimensions,
    evidence: ["evidence"],
  }));

  assert.equal(report.boundary, "mixed");
  assert.deepEqual(report.boundaryCounts, { public_synthetic: 29, private_canghai: 1 });
});

test("accepts a bounded private fragment only when it is combined before evaluation", () => {
  const fragment = JSON.stringify({
    schemaVersion: "stella.alpha-praxis-suite/v1",
    boundary: "private_canghai",
    cases: [{ id: "private-01", category: "relationship_communication", prompt: "private" }],
  });
  assert.equal(parsePraxisEvaluationSuiteFragment(fragment).cases.length, 1);
  assert.throws(() => parsePraxisEvaluationSuite(fragment), /30 to 50/);
});

test("fails a case when any required rubric dimension lacks evidence", async () => {
  const report = await runPraxisEvaluation(publicCases(30), async (evaluationCase) => ({
    caseId: evaluationCase.id,
    dimensions: evaluationCase.id === "social-07"
      ? { ...dimensions, concreteNextAction: false }
      : dimensions,
    evidence: ["evidence"],
  }));

  assert.equal(report.passedCount, 29);
  assert.equal(report.failedCount, 1);
  assert.deepEqual(report.failedCaseIds, ["social-07"]);
  assert.deepEqual(report.failedDimensions, { "social-07": ["concreteNextAction"] });
});

test("ships a valid public synthetic relationship/social suite", async () => {
  const suitePath = path.join(process.cwd(), "evaluation", "praxis-social.synthetic.json");
  const suite = parsePraxisEvaluationSuite(await readFile(suitePath, "utf8"));

  assert.equal(suite.boundary, "public_synthetic");
  assert.equal(suite.cases.length, 32);
  assert.equal(new Set(suite.cases.map(({ prompt }) => prompt)).size, 32);
});
