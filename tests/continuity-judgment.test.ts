import assert from "node:assert/strict";
import test from "node:test";
import { judgeRecoveryContinuity, type ContinuityJudgmentInput } from "../src/acceptance/continuity-judgment.js";

const fixture = (): ContinuityJudgmentInput => ({ recoveryRevision: "1".repeat(40),
  documents: [{ ref: "path:synthetic.md", content: "Synthetic uncertain interpretation", provenance: "unknown" }],
  memory: { openEpisodes: [], learningItems: [] }, probes: [{ id: "identity", rubric: {
    schema_version: "stella.continuity-rubric/v1", id: "identity", allowed_response_kinds: ["answer"],
    structural_assertions: [{ id: "scope", required: true, condition: "Use restored scope" }],
    semantic_dimensions: [{ id: "uncertainty", required: true, condition: "Retain uncertainty" }],
  } }],
  observedTurns: [{ id: "identity", runId: "run-one", output: "Synthetic uncertain answer" }] });
const verdict = (passed = true) => ({ text: JSON.stringify({ verdicts: [{ id: "identity", responseKind: "answer", checks:
  ["scope", "uncertainty"].map((id) => ({ id, passed, reason: "PRIVATE REASON" })) }] }) });

test("continuity judge sees exact content and empty sets without exporting private reasons", async () => {
  const input = fixture();
  const result = await judgeRecoveryContinuity(input, async (prompt) => {
    assert.ok(prompt.includes(JSON.stringify(input)));
    return verdict();
  });
  assert.deepEqual(result, { accepted: true, evidence: ["identity:pass"] });
  assert.deepEqual(await judgeRecoveryContinuity(input, async () => verdict(false)), { accepted: false, evidence: ["identity:fail"] });
});

test("continuity judge cannot omit, duplicate or waive a required probe", async () => {
  for (const response of [{ accepted: true }, { verdicts: [] }, { verdicts: [{ id: "other", passed: true, reason: "ok" }] },
    { verdicts: [{ id: "identity", passed: true, reason: "ok" }, { id: "identity", passed: true, reason: "ok" }] }]) {
    await assert.rejects(judgeRecoveryContinuity(fixture(), async () => ({ text: JSON.stringify(response) })), /invalid_continuity_verdict/);
  }
  const input = fixture(); input.observedTurns.push(input.observedTurns[0]!);
  await assert.rejects(judgeRecoveryContinuity(input, async () => { throw new Error("must not call model"); }), /probe_set_mismatch/);
});

test("complete JSON fences preserve the exact verdict and do not permit prose or multiple envelopes", async () => {
  const json = verdict().text;
  const fence = "```";
  assert.deepEqual(await judgeRecoveryContinuity(fixture(), async () => ({ text: `${fence}json\n${json}\n${fence}` })),
    await judgeRecoveryContinuity(fixture(), async () => ({ text: json })));
  for (const text of [`Explanation\n${fence}json\n${json}\n${fence}`, `${fence}javascript\n${json}\n${fence}`,
    `${fence}json\n${json}\n${fence}\n${fence}json\n${json}\n${fence}`]) {
    await assert.rejects(judgeRecoveryContinuity(fixture(), async () => ({ text })), /continuity_judge_failed/);
  }
});

test("continuity judge checks every required assertion and allowed response kind", async () => {
  const response = JSON.parse(verdict().text);
  response.verdicts[0].checks.pop();
  await assert.rejects(judgeRecoveryContinuity(fixture(), async () => ({ text: JSON.stringify(response) })), /invalid_continuity_verdict/);
  const wrongKind = JSON.parse(verdict().text); wrongKind.verdicts[0].responseKind = "action_advice";
  assert.equal((await judgeRecoveryContinuity(fixture(), async () => ({ text: JSON.stringify(wrongKind) }))).accepted, false);
  const partial = JSON.parse(verdict().text); partial.verdicts[0].checks[1].passed = false;
  assert.equal((await judgeRecoveryContinuity(fixture(), async () => ({ text: JSON.stringify(partial) }))).accepted, false);
});

test("continuity failures do not retry, truncate evidence or expose private model output", async () => {
  let calls = 0;
  await assert.rejects(judgeRecoveryContinuity(fixture(), async () => { calls++; throw new Error("PRIVATE ERROR"); }), { message: "continuity_judge_failed" });
  assert.equal(calls, 1);
  const oversized = fixture(); oversized.documents.push("x".repeat(200_000));
  await assert.rejects(judgeRecoveryContinuity(oversized, async () => { calls++; return verdict(); }), /capacity_exceeded/);
  assert.equal(calls, 1);
  const changed = fixture();
  await assert.rejects(judgeRecoveryContinuity(changed, async () => { changed.memory.learningItems.push("changed"); return verdict(); }), /input_changed/);
});
