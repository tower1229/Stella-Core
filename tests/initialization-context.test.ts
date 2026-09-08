import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveBootstrapContextForRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { bytesVersion } from "../src/canghai/content-version.js";
import { verifyInitializationContext } from "../src/openclaw/initialization-context.js";
import { BOOTSTRAP_TARGETS } from "../src/openclaw/initialization-templates.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-context-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const files = [];
  for (const target of BOOTSTRAP_TARGETS) {
    const content = `# Synthetic ${target}\n\n${"A complete synthetic runtime rule.\n".repeat(20)}\n`;
    await writeFile(path.join(workspace, target), content);
    files.push({ target, sha256: bytesVersion(content) });
  }
  const config: OpenClawConfig = { agents: { defaults: { contextInjection: "always" }, entries: {
    stella: { workspace }, other: { bootstrapMaxChars: 1, contextInjection: "never" },
  } } };
  return { workspace, agentId: "stella", files, config, currentConfig: () => config };
}

test("installed OpenClaw loader preserves every required instruction using the target agent's budget", async (t) => {
  const f = await fixture(t);
  await verifyInitializationContext(f);
  f.config.agents!.defaults!.bootstrapMaxChars = 1;
  f.config.agents!.entries!.stella!.bootstrapMaxChars = 20000;
  await verifyInitializationContext(f);
  assert.equal(f.config.agents!.entries!.other!.bootstrapMaxChars, 1);
  f.config.agents!.entries!.stella!.bootstrapMaxChars = 120;
  await assert.rejects(verifyInitializationContext(f), /host_bootstrap_context_incomplete/);
  f.config.agents!.entries!.stella!.bootstrapMaxChars = 20000;
  f.config.agents!.entries!.stella!.bootstrapTotalMaxChars = 200;
  await assert.rejects(verifyInitializationContext(f), /host_bootstrap_context_(incomplete|missing)/);
  assert.equal(bytesVersion(await readFile(path.join(f.workspace, "AGENTS.md"))), f.files[0]!.sha256);
});

test("disabled or continuation-only injection cannot reuse a successful first-turn bootstrap proof", async (t) => {
  const f = await fixture(t);
  f.config.agents!.defaults!.contextInjection = "never";
  await assert.rejects(verifyInitializationContext(f), /host_context_injection_unsupported/);
  f.config.agents!.entries!.stella!.contextInjection = "always";
  await verifyInitializationContext(f);
  f.config.agents!.entries!.stella!.contextInjection = "continuation-skip";
  await assert.rejects(verifyInitializationContext(f), /host_context_injection_unsupported/);
});

test("hook replacement, omission and configuration races invalidate the loader proof", async (t) => {
  const f = await fixture(t);
  const changed: typeof resolveBootstrapContextForRun = async (params) => {
    const result = await resolveBootstrapContextForRun(params);
    result.contextFiles.find(file => file.path === path.join(f.workspace, "SOUL.md"))!.content = "Changed by a synthetic hook";
    return result;
  };
  await assert.rejects(verifyInitializationContext(f, changed), /host_bootstrap_context_incomplete/);
  await assert.rejects(verifyInitializationContext(f, async (params) => {
    const result = await resolveBootstrapContextForRun(params);
    result.contextFiles = result.contextFiles.filter(file => file.path !== path.join(f.workspace, "USER.md"));
    return result;
  }), /host_bootstrap_context_missing/);
  await assert.rejects(verifyInitializationContext(f, async (params) => {
    const result = await resolveBootstrapContextForRun(params);
    f.config.agents!.entries!.stella!.contextInjection = "never";
    return result;
  }), /initialization_config_changed/);
});
