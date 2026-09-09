import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { createFixture } from "./consciousness-fixture.js";
import { inspectMainReadiness } from "../src/acceptance/main-readiness.js";

test("main preflight exposes model drift and runtime blockers without treating bootstrap as behavioral acceptance", async t => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = "50_PersonalAgent/stella/runtime-profile.yaml";
  const profile = parse(await readFile(path.join(root, profilePath), "utf8"));
  profile.contract_profile = "full_memory";
  await writeFile(path.join(root, profilePath), stringify(profile));
  const catalogPath = path.join(root, "30_PersonalData/memory/catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.policies.push({ ...catalog.policies[0], version: `sha256:${"0".repeat(64)}`, status: "superseded" });
  await writeFile(catalogPath, JSON.stringify(catalog));
  const result = await inspectMainReadiness({ root, profilePath, agentId: "stella", modelRef: "google/gemini-3.1-pro-preview",
    fallbackModelRefs: ["synthetic/fallback"], initialization: { scope: "host_bootstrap", state: "ready",
      runtime: { state: "blocked", blockers: ["full_memory_acceptance_unavailable"] } } });
  assert.equal(result.behavioralAcceptance, "not_executed");
  assert.equal(result.diagnosticOnly, true);
  assert.ok(result.blockers.includes("model_route_mismatch:main"));
  assert.ok(result.blockers.includes("personal_view_fallback_route_forbidden"));
  assert.ok(result.blockers.includes("full_memory_acceptance_unavailable"));
  assert.ok(result.blockers.includes("personal_context_access_binding_missing"));
  assert.equal(result.counts.policies, 1);
});

test("empty runtime blockers and declared receipt success never manufacture current Host acceptance", async t => {
  const root = await createFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await inspectMainReadiness({ root, profilePath: "50_PersonalAgent/stella/runtime-profile.yaml", agentId: "stella",
    modelRef: "synthetic/synthetic", fallbackModelRefs: [], initialization: { scope: "host_bootstrap", state: "ready",
      runtime: { state: "not_evaluated", blockers: [] } } });
  assert.ok(result.blockers.includes("runtime_acceptance_not_evaluated"));
  assert.ok(result.blockers.includes("full_memory_profile_required"));
  assert.equal(result.behavioralAcceptance, "not_executed");
});
