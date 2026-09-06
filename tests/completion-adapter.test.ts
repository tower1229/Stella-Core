import assert from "node:assert/strict";
import test from "node:test";
import { parsePrivateAssistantDraft } from "../src/openclaw/completion-adapter.js";

test("private draft capture extracts only a completed assistant answer", () => {
  assert.equal(parsePrivateAssistantDraft({ role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "synthetic private reasoning" },
    { type: "text", text: "Synthetic committed answer" },
  ] }), "Synthetic committed answer");
});

test("private draft capture rejects incomplete, tool, commentary and missing output", () => {
  for (const value of [undefined, {},
    { role: "assistant", stopReason: "length", content: [{ type: "text", text: "truncated" }] },
    { role: "assistant", stopReason: "stop", phase: "commentary", content: [{ type: "text", text: "progress" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "synthetic" }] },
    { role: "assistant", stopReason: "stop", content: [] },
  ]) assert.throws(() => parsePrivateAssistantDraft(value));
});
