import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  advanceStellaRecoveryPointer,
  RecoveryPointerSyncError,
} from "../src/openclaw/recovery-pointer.js";

const previousRevision = "1".repeat(40);
const nextRevision = "2".repeat(40);

function configAt(recoveryRevision: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "stella-core": {
          enabled: true,
          config: { recoveryRevision, canghaiRoot: "/private/canghai" },
        },
      },
    },
  };
}

test("advances only the Stella recovery pointer from the expected revision", () => {
  const original = configAt(previousRevision);
  const updated = advanceStellaRecoveryPointer(original, previousRevision, nextRevision);

  assert.equal(
    updated.plugins?.entries?.["stella-core"]?.config?.recoveryRevision,
    nextRevision,
  );
  assert.equal(
    original.plugins?.entries?.["stella-core"]?.config?.recoveryRevision,
    previousRevision,
  );
  assert.equal(
    updated.plugins?.entries?.["stella-core"]?.config?.canghaiRoot,
    "/private/canghai",
  );
});

test("rejects stale compare-and-set and malformed revisions", () => {
  assert.throws(
    () => advanceStellaRecoveryPointer(configAt(nextRevision), previousRevision, nextRevision),
    RecoveryPointerSyncError,
  );
  assert.throws(
    () => advanceStellaRecoveryPointer(configAt(previousRevision), "short", nextRevision),
    /full Git revisions/,
  );
});
