import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { personalMemoryFixture } from "./personal-memory-fixture.js";
import { prepareSourceOutputCheck } from "../src/canghai/source-output.js";

test("v3 source-specific interpretation restrictions reach the final output gate", async t => {
  const f = await personalMemoryFixture(t, true), resolver = await f.resolver();
  const validate = await prepareSourceOutputCheck({ question: "继续梳理", originals: [await resolver.readEvidence(f.evidence)],
    resolver, modelRef: "synthetic/model", assertCurrent: async () => {}, complete: async ({ prompt }) => {
      const data = JSON.parse(prompt.split("\n").at(-1)!);
      assert.equal(data.records[0].policies[0].policy.usageRules.interpretation[0].id, "preserve_author_intent");
      return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: data.requestHash, draftHash: data.draftHash,
        sourcesHash: data.sourcesHash, compliant: false, violations: ["source_rule_violated"] }) };
    } });
  await assert.rejects(validate("合成的违规结论", new AbortController().signal), /source_output_rejected/);
});

test("source-output judgment is bound to exact draft and policies; rejection, revocation and changed originals fail closed", async t => {
  const fixture = await personalMemoryFixture(t), resolver = await fixture.resolver();
  let mode = "allow", current = true;
  const validate = await prepareSourceOutputCheck({ question: "继续梳理原意", originals: [await resolver.readEvidence(fixture.evidence)],
    resolver, modelRef: "synthetic/model", assertCurrent: async () => { if (!current) throw new Error("grant_revoked"); },
    complete: async ({ prompt }) => {
      const input: Record<string, unknown> = JSON.parse(prompt.split("\n").at(-1)!);
      assert.ok(prompt.includes("Only summary access was authorized"));
      if (mode === "malformed") return { text: "private provider error", provider: "synthetic", model: "model" };
      return { provider: "synthetic", model: "model", text: JSON.stringify({ requestHash: input.requestHash,
        draftHash: mode === "unbound" ? "wrong" : input.draftHash, sourcesHash: input.sourcesHash,
        compliant: mode !== "quote", violations: mode === "quote" ? ["quotation_not_authorized"] : [] }) };
    } });
  const signal = new AbortController().signal;
  assert.ok((await validate("保留疑问，先检查论证", signal)).draftHash);
  mode = "quote"; await assert.rejects(validate("引用原文", signal), /source_output_rejected/);
  mode = "unbound"; await assert.rejects(validate("另一份回答", signal), /invalid_output_check/);
  mode = "malformed"; await assert.rejects(validate("回答", signal), /invalid_output_check/);
  mode = "allow"; current = false; await assert.rejects(validate("回答", signal), /grant_revoked/);
  current = true;
  await writeFile(path.join(fixture.root, "payload.json"), "changed");
  await assert.rejects(validate("回答", signal));
});
