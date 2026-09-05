import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
});
const schema = JSON.parse(
  await readFile(path.resolve("schemas/praxis-episode-v2.schema.json"), "utf8"),
) as object;
const validate = ajv.compile(schema);
const ref = { id: "evidence_synthetic", version: `sha256:${"a".repeat(64)}` };
const now = "2026-09-05T00:00:00Z";

function episode() {
  return {
    schemaVersion: "stella.praxis-episode/v2",
    id: "praxis_synthetic",
    status: "closed",
    createdAt: now,
    updatedAt: now,
    recoveryPriority: "normal",
    provenance: {},
    historicalInputRefs: [ref],
    situation: { summary: "Synthetic decision", domains: ["synthetic"], observations: [] },
    decision: { recommendation: "Ask for clarification", rationale: [] },
    actual: {
      action: "Asked for clarification",
      occurredAt: null,
      recordedAt: now,
      source: "user_report",
      evidenceRefs: [ref],
    },
    outcome: { observations: [], result: "Received clarification", observedAt: now, evidenceRefs: [ref] },
    learning: {
      algorithmVersion: "stella.praxis-learning/v2",
      predictionAssessment: "unresolved",
      evidenceRefs: [ref],
      twin: [],
      praxis: [],
    },
  };
}

test("v2 accepts unknown action time without inventing a timestamp or a prediction", () => {
  assert.equal(validate(episode()), true, ajv.errorsText(validate.errors));
});

test("v2 rejects an inferred action and missing original evidence", () => {
  const inferred = episode();
  inferred.actual.source = "inferred";
  assert.equal(validate(inferred), false);
  const missing = episode();
  missing.actual.evidenceRefs = [];
  assert.equal(validate(missing), false);
});

test("v2 allows Twin-only or Praxis-only learning without requiring both", () => {
  for (const target of ["twin", "praxis"] as const) {
    const value = episode();
    const withLearning = {
      ...value,
      learning: { ...value.learning, [target]: [ref] },
    };
    assert.equal(validate(withLearning), true, ajv.errorsText(validate.errors));
  }
});

test("v2 requires unresolved assessment when no prediction exists", () => {
  const value = episode();
  value.learning.predictionAssessment = "supported";
  assert.equal(validate(value), false);
});

test("v2 does not accept outcome data in an open or merely recommended state", () => {
  for (const status of ["open", "recommended", "acted", "observing"]) {
    const value = episode();
    value.status = status;
    assert.equal(validate(value), false, status);
  }
});

test("v2 rejects a closed record without its learning evaluation", () => {
  const { learning: _learning, ...value } = episode();
  assert.equal(validate(value), false);
});
