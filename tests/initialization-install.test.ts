import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { prepareInitializationFixture } from "./consciousness-fixture.js";
import { registerStellaInitialization } from "../src/openclaw/initialization-registration.js";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";

const exec = promisify(execFile);

type SkillStatus = {
  name: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAgentFilter?: boolean;
  blockedByAllowlist?: boolean;
  filePath?: string;
};

async function installFixture(t: { after(fn: () => Promise<void>): void }, options?: {
  skillStatuses?: SkillStatus[];
}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-install-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  await Promise.all([mkdir(source), mkdir(workspace), mkdir(state)]);
  const prefix = "50_PersonalAgent/stella";
  await mkdir(path.join(source, prefix), { recursive: true });
  await writeFile(path.join(source, prefix, "manifest.yaml"), `identity:\n  runtimeProfileRef: path:${prefix}/runtime-profile.yaml\n`);
  await writeFile(path.join(source, prefix, "runtime-profile.yaml"), JSON.stringify({
    schema_version: "stella.runtime-profile/v2",
    host_materialization_ref: `path:${prefix}/host-materialization.json`,
    contract_profile: "alpha_praxis",
    agent_id: "stella",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    models: Object.fromEntries(["main", "router", "learning", "framework_compiler"].map((role) => [role, {
      provider: "synthetic", model: "synthetic", required_capabilities: [],
    }])),
    capabilities: [],
    source_policies_ref: "path:policies.yaml",
    autonomy: {
      research_enabled: false,
      proactive_delivery_enabled: false,
      delivery_policy_ref: "path:delivery.yaml",
      delegation_registry_ref: "path:delegations.yaml",
    },
  }));
  await prepareInitializationFixture(source, "stella");
  const skillRoot = path.join(source, prefix, "host/skills/stella-initialization-probe");
  const resourceBody = "Synthetic skill resource used by Host resolution.\n";
  await writeFile(path.join(skillRoot, "reference.txt"), resourceBody);
  const materializationPath = path.join(source, prefix, "host-materialization.json");
  const materialization = JSON.parse(await readFile(materializationPath, "utf8")) as {
    skill_bindings: Array<{
      files: Array<{ path: string; sha256: string; executable: boolean }>;
      tree_digest: string;
    }>;
  };
  const binding = materialization.skill_bindings[0]!;
  binding.files.push({ path: "reference.txt", sha256: bytesVersion(resourceBody), executable: false });
  const tree = [...binding.files]
    .map((file) => ({ path: file.path, sha256: file.sha256, executable: file.executable }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  binding.files = tree;
  binding.tree_digest = bytesVersion(canonicalJson(tree));
  await writeFile(materializationPath, JSON.stringify(materialization));

  const git = async (args: string[]) => (await exec("git", ["-c", "core.fsmonitor=false", "-C", source, ...args])).stdout.trim();
  await git(["init"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Synthetic install source"]);

  const pluginConfig = {
    canghaiRoot: source,
    recoveryRevision: await git(["rev-parse", "HEAD"]),
    manifestPath: `${prefix}/manifest.yaml`,
    agentId: "stella",
  };
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  let command: Parameters<OpenClawPluginApi["registerCommand"]>[0] | undefined;
  const hostConfig: OpenClawConfig = {
    agents: {
      entries: {
        stella: { workspace },
        other: { identity: { name: "Keep other identity" }, workspace: path.join(root, "other-workspace") },
      },
    },
    plugins: { entries: { "stella-core": { enabled: true, config: pluginConfig } } },
  };
  const defaultSkillPath = path.join(workspace, "skills/stella-initialization-probe/SKILL.md");
  const skillStatuses = options?.skillStatuses ?? [{
    name: "stella-initialization-probe",
    eligible: true,
    filePath: defaultSkillPath,
  }];
  let getFile: (name: string) => Promise<string> = async (name) => readFile(path.join(workspace, name), "utf8");
  const api = {
    config: hostConfig,
    runtime: {
      version: "2026.8.2",
      config: {
        current: () => hostConfig,
        async mutateConfigFile(input: { mutate(config: OpenClawConfig): unknown }) {
          await input.mutate(hostConfig);
          return {};
        },
      },
      agent: {
        async ensureAgentWorkspace(input: { dir: string }) {
          return { dir: input.dir, bootstrapPending: false };
        },
      },
      gateway: {
        async request(method: string, params: { name?: string }) {
          if (method === "agents.files.list") return { workspace };
          if (method === "skills.status") {
            return { workspaceDir: workspace, skills: skillStatuses };
          }
          if (method === "agents.files.get") {
            return { file: { content: await getFile(params.name!) } };
          }
          throw new Error("unexpected Host method");
        },
      },
    },
    logger: { error() {} },
    registerService(value: typeof service) { service = value; },
    registerCommand(value: typeof command) { command = value; },
    registerTool() {},
    registerGatewayMethod() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { hooks.set(name, handler); },
  };

  const initialization = registerStellaInitialization(api as never, pluginConfig, async (method, params) =>
    api.runtime.gateway.request(method, params));
  return {
    source, workspace, state, pluginConfig, hostConfig, api, hooks, service, command, initialization, git,
    setGetFile(next: (name: string) => Promise<string>) { getFile = next; },
    async start() {
      await service!.start({ config: api.config, stateDir: state, logger: api.logger } as never);
      await hooks.get("gateway_start")!({}, {});
    },
  };
}

test("formal Host service install and manual retry share one coordinator, recipe, and success criteria", async (t) => {
  const f = await installFixture(t);
  await f.start();
  assert.equal(f.initialization.status().state, "ready");
  assert.equal(f.initialization.status().scope, "host_bootstrap");
  const first = f.initialization.status().operationId;
  assert.ok(first);
  const manual = JSON.parse((await f.command!.handler({ agentId: "stella", isAuthorizedSender: true } as never)).text!);
  assert.equal(manual.state, "ready");
  assert.equal(manual.operationId, first);
  assert.equal(manual.recipeHash, f.initialization.status().recipeHash);
  assert.equal(f.hostConfig.agents?.entries?.stella?.identity?.name, "Synthetic Stella");
  assert.equal(f.hostConfig.agents?.entries?.other?.identity?.name, "Keep other identity");
  assert.match(await readFile(path.join(f.workspace, "IDENTITY.md"), "utf8"), /- Name: Synthetic Stella/);
  assert.match(await readFile(path.join(f.workspace, "skills/stella-initialization-probe/SKILL.md"), "utf8"), /No private data/);
  assert.equal(await readFile(path.join(f.workspace, "skills/stella-initialization-probe/reference.txt"), "utf8"),
    "Synthetic skill resource used by Host resolution.\n");
});

test("Host-resolved skill body and resources must match the recipe; file presence cannot replace Host resolution", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-shadow-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shadowSkill = path.join(root, "skills/stella-initialization-probe/SKILL.md");
  await mkdir(path.dirname(shadowSkill), { recursive: true });
  await writeFile(shadowSkill, "---\nname: stella-initialization-probe\ndescription: Shadowed skill\n---\nShadowed body.\n");
  const shadowed = await installFixture(t, {
    skillStatuses: [{
      name: "stella-initialization-probe",
      eligible: true,
      filePath: shadowSkill,
    }],
  });
  await shadowed.start();
  assert.equal(shadowed.initialization.status().state, "blocked");
  assert.match(String(shadowed.initialization.status().category), /skill_unavailable_or_shadowed/);

  const f = await installFixture(t);
  await f.start();
  assert.equal(f.initialization.status().state, "ready");
  await writeFile(path.join(f.workspace, "skills/stella-initialization-probe/reference.txt"), "Tampered resource on disk\n");
  const retry = await f.initialization.initialize();
  assert.equal(retry.state, "blocked");
  assert.equal(retry.category, "projection_drift");
});

test("Host-served IDENTITY must match config identity fields after install", async (t) => {
  const f = await installFixture(t);
  await f.start();
  assert.equal(f.initialization.status().state, "ready");
  const onDisk = await readFile(path.join(f.workspace, "IDENTITY.md"), "utf8");
  f.setGetFile(async (name) => {
    if (name === "IDENTITY.md") {
      return onDisk.replace("- Name: Synthetic Stella", "- Name: Impostor");
    }
    return readFile(path.join(f.workspace, name), "utf8");
  });
  const retry = await f.initialization.initialize();
  assert.equal(retry.state, "blocked");
  assert.equal(retry.category, "host_channel_identity_mismatch");
});

test("repeat initialization keeps the same receipt and does not claim full_memory when runtime is blocked", async (t) => {
  const f = await installFixture(t);
  await f.start();
  const first = f.initialization.status();
  assert.equal(first.state, "ready");
  const second = await f.initialization.initialize();
  assert.equal(second.state, "ready");
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.recipeHash, first.recipeHash);
  assert.equal(f.hostConfig.agents?.entries?.other?.identity?.name, "Keep other identity");

  const profilePath = path.join(f.source, "50_PersonalAgent/stella/runtime-profile.yaml");
  const profile = parseYaml(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  profile.contract_profile = "full_memory";
  profile.memory = {
    catalog_ref: "path:catalog.json",
    semantic_provider: "synthetic",
    required_views: [],
    archive_max_rpo_seconds: 300,
  };
  await writeFile(profilePath, JSON.stringify(profile));
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Declare full_memory"]);
  f.pluginConfig.recoveryRevision = await f.git(["rev-parse", "HEAD"]);
  const installed = await f.initialization.initialize();
  assert.equal(installed.state, "ready");
  assert.equal(installed.scope, "host_bootstrap");
  assert.deepEqual(installed.runtime, { state: "blocked", blockers: ["full_memory_acceptance_unavailable"] });
  await assert.rejects(f.initialization.assertReady(), /runtime_capabilities_unavailable/);
  const again = await f.initialization.initialize();
  assert.deepEqual(again.runtime, installed.runtime);
  assert.equal(again.operationId, installed.operationId);
});
