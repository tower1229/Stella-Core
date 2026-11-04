import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "../src/canghai/native-memory-origin.js";

// Historical origin shape still parsed by the current repository source adapter.
// This does not exercise a Host index or certify native memory consumption.
const origin: NativeMemoryOrigin = { schemaVersion: "stella.native-memory-origin/v1", hostVersion: "2026.8.2",
  agentId: "stella", provider: "memory-core", path: "memory/retained.md", fromLine: 1, lineCount: 1 };

test("native memory origin accepts only a closed versioned relative range", () => {
  assert.deepEqual(parseNativeMemoryOrigin(origin), origin);
  for (const patch of [{ path: "../private.md" }, { path: "/absolute.md" }, { path: "memory/.git/private.md" },
    { path: "memory/source.txt" }, { path: "memory/a\\b.md" }, { path: "memory/a\u0000.md" }, { lineCount: 0 }, { lineCount: 121 },
    { fromLine: Number.MAX_SAFE_INTEGER },
    { fromLine: 0 }, { agentId: "" }, { provider: "arbitrary-plugin" }, { claimId: "wrong-provider" }, { grant: true }]) {
    assert.throws(() => parseNativeMemoryOrigin({ ...origin, ...patch }), /invalid_native_memory_origin/);
  }
});
