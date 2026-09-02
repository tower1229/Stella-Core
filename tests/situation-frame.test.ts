import assert from "node:assert/strict";
import test from "node:test";
import { buildSituationFrame } from "../src/situation/frame.js";

test("Situation Frame keeps observations separate from interpretations and unknowns", () => {
  const frame = buildSituationFrame(
    "她两天没回我消息。我觉得她可能在疏远我，但也不知道她是不是在忙。我想确认关系，同时不想给她压力。我要不要再发一条？",
    {
      mode: "praxis",
      domains: ["relationship"],
      actors: ["self", "other"],
      stakes: "medium",
      reversibility: "high",
      needsTwin: true,
      needsFramework: true,
      needsReality: true,
      needsExternalResearch: false,
    },
  );

  assert.deepEqual(frame.actors, ["self", "other"]);
  assert.deepEqual(frame.observations, ["她两天没回我消息"]);
  assert.deepEqual(frame.interpretations, ["我觉得她可能在疏远我"]);
  assert.deepEqual(frame.unknowns, ["也不知道她是不是在忙", "我要不要再发一条"]);
  assert.deepEqual(frame.userGoals, ["我想确认关系"]);
  assert.deepEqual(frame.constraints, ["同时不想给她压力"]);
  assert.deepEqual(frame.decision, {
    stakes: "medium",
    reversibility: "high",
  });
});

test("one clause can preserve overlapping goal, unknown, and interpretation semantics", () => {
  const frame = buildSituationFrame("我觉得她是不是在回避我。我想知道要不要再发一条。", {
    mode: "praxis",
    domains: ["relationship"],
    stakes: "medium",
    reversibility: "high",
    needsTwin: true,
    needsFramework: true,
    needsReality: true,
    needsExternalResearch: false,
  });

  assert.deepEqual(frame.interpretations, ["我觉得她是不是在回避我"]);
  assert.deepEqual(frame.unknowns, ["我觉得她是不是在回避我", "我想知道要不要再发一条"]);
  assert.deepEqual(frame.userGoals, ["我想知道要不要再发一条"]);
});
