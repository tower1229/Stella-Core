import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PRIVATE_DRAFT_HOST_POLICY, parsePrivateAssistantDraft } from "../src/openclaw/completion-adapter.js";

test("exact Host empty-payload policy does not cover a Gemini private draft with a recovered payload", async () => {
  const require = createRequire(import.meta.url);
  const dist = path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-entry")), "..");
  assert.equal(JSON.parse(await readFile(path.join(dist, "../package.json"), "utf8")).version, "2026.8.2");
  const candidates = (await readdir(dist)).filter((file) => /^builtin-openclaw-.*\.js$/.test(file));
  const modules = [];
  for (const file of candidates) {
    if ((await readFile(path.join(dist, file), "utf8")).includes("function shouldTreatEmptyAssistantReplyAsSilent(")) modules.push(file);
  }
  assert.equal(modules.length, 1, "Exact Host layout changed; reverify the policy seam");
  // OpenClaw 2026.8.2 exports its actual incomplete-turn policy under L.
  const { L: shouldTreatEmptyAssistantReplyAsSilent, N: resolveReasoningOnlyRetryInstruction } = await import(pathToFileURL(path.join(dist, modules[0]!)).href);
  const assistant = { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "Synthetic private planning" }, { type: "text", text: "Synthetic complete answer" },
  ] };
  const input = { ...PRIVATE_DRAFT_HOST_POLICY, payloadCount: 0, aborted: false, timedOut: false,
    attempt: { assistantTexts: [], currentAttemptAssistant: assistant, lastAssistant: assistant,
      terminal: { kind: "completed" }, replayMetadata: { hadPotentialSideEffects: false }, toolMetas: [] } };
  assert.equal(shouldTreatEmptyAssistantReplyAsSilent({ ...input, allowEmptyAssistantReplyAsSilent: false }), false);
  assert.equal(shouldTreatEmptyAssistantReplyAsSilent(input), true);
  // Actual 2026.8.2 native state: silentExpected empties assistantTexts, but
  // terminal payload recovery still creates a nonempty payload. Unsigned Gemini
  // thinking triggers a continuation even though a complete answer exists.
  assert.equal(shouldTreatEmptyAssistantReplyAsSilent({ ...input, payloadCount: 1 }), false);
  assert.equal(typeof resolveReasoningOnlyRetryInstruction({ ...input, payloadCount: 1,
    provider: "google", modelId: "gemini-3.1-pro-preview", modelApi: "google-generative-ai" }), "string");
  assert.equal(parsePrivateAssistantDraft(assistant), "Synthetic complete answer");
  assert.throws(() => parsePrivateAssistantDraft({ ...assistant, content: [] }), /empty_private_draft/);
});
