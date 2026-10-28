import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

test("public session store resolver anchors relative paths to Host state and preserves absolute paths", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-session-store-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, "host-state"), env = { OPENCLAW_STATE_DIR: state };
  const options = { agentId: "synthetic", env };

  const relative = "stores/{agentId}/sessions.json";
  const expected = path.join(state, "stores/synthetic/sessions.json");
  assert.notEqual(expected, path.resolve("stores/synthetic/sessions.json"));
  assert.equal(resolveStorePath(relative, options), expected);
  assert.equal(resolveStorePath("sessions.json", options), path.join(state, "sessions.json"));

  const absolute = path.join(root, "external-store/sessions.json");
  assert.equal(resolveStorePath(absolute, options), absolute);
  assert.equal(resolveStorePath(absolute, { ...options, env: { OPENCLAW_STATE_DIR: path.join(root, "other-state") } }), absolute);
});
