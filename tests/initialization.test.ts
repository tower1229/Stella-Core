import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, chmod, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { StellaInitializer, parseMaterialization, type InitializationPorts, type Materialization } from "../src/openclaw/initialization.js";
import { bytesVersion } from "../src/canghai/content-version.js";
import { registerStellaInitialization } from "../src/openclaw/initialization-registration.js";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { prepareInitializationFixture } from "./consciousness-fixture.js";
import { coordinateCompletion } from "../src/openclaw/completion.js";
import { compileInitializationSource } from "../src/openclaw/initialization-source.js";
import { BOOTSTRAP_TARGETS, INITIALIZATION_TEMPLATE_VERSION, type HostIdentity } from "../src/openclaw/initialization-templates.js";

import { withMemoryMutationLock } from "../src/canghai/memory-transaction.js";

const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }, verify: InitializationPorts["verify"] = async () => undefined) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-init-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), workspace = path.join(root, "workspace"), state = path.join(root, "state");
  await Promise.all([mkdir(source), mkdir(workspace), mkdir(state)]);
  const files: Materialization["files"] = [];
  for (const target of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "skills/stella-test/SKILL.md"]) {
    const content = target.endsWith("SKILL.md") ? "---\nname: stella-test\ndescription: Synthetic test\n---\nTest only.\n" : `# Synthetic ${target}\n`;
    const name = `${files.length}.txt`;
    await writeFile(path.join(source, name), content);
    files.push({ target, source: name, sha256: bytesVersion(content), executable: false });
  }
  const recipe = { schemaVersion: "stella.host-files/v1", agentId: "stella", hostVersion: "2026.8.2", files, skills: ["stella-test"] };
  await writeFile(path.join(source, "recipe.json"), JSON.stringify(recipe));
  const git = async (args: string[]) => (await exec("git", ["-c", "core.fsmonitor=false", "-C", source, ...args])).stdout.trim();
  await git(["init"]); await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Synthetic initialization source"]);
  let fenced = false;
  let identity: HostIdentity | null = null;
  const config = { root: source, revision: await git(["rev-parse", "HEAD"]), recipePath: "recipe.json", agentId: "stella", hostVersion: "2026.8.2" };
  const ports = { fence: async () => { fenced = true; }, verify, release: async () => { fenced = false; },
    readIdentity: async () => structuredClone(identity),
    async applyIdentity(before: HostIdentity | null, after: HostIdentity | null, allowAlreadyApplied: boolean) {
      if (allowAlreadyApplied && JSON.stringify(identity) === JSON.stringify(after)) return;
      assert.deepEqual(identity, before);
      identity = structuredClone(after);
    },
  };
  return { source, workspace, state, config, ports, recipe, git, initializer: new StellaInitializer(workspace, state, config, ports), fenced: () => fenced };
}

test("initializes reviewed bootstrap and skills, preserving unrelated files", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, "personal.txt"), "keep");
  await writeFile(path.join(f.workspace, "SOUL.md"), "old identity");
  const receipt = await f.initializer.initialize();
  assert.equal(receipt.files.length, 6);
  assert.equal(await readFile(path.join(f.workspace, "personal.txt"), "utf8"), "keep");
  assert.equal(f.fenced(), false);
  const journal = JSON.parse(await readFile(path.join(f.state, "last-plan.json"), "utf8"));
  assert.equal(Buffer.from(journal.changes.find((file: { target: string }) => file.target === "SOUL.md").before, "base64").toString(), "old identity");
  await f.initializer.initialize();
  assert.equal(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), "# Synthetic SOUL.md\n");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.state, "operations", `${receipt.operationId}.json`), "utf8")), journal);
});

test("installed Host verification is read-only and cannot certify complete runtime capabilities", async (t) => {
  let observed = false;
  const f = await fixture(t, async () => { observed = true; });
  const installed = await f.initializer.initialize();
  observed = false;
  const proof = await f.initializer.verifyInstalled();
  assert.equal(observed, true);
  assert.equal(proof.operationId, installed.operationId);
  assert.equal(proof.scope, "host_files_and_skills");
  assert.equal(await f.git(["status", "--porcelain"]), "");
  assert.equal(f.fenced(), false);
  await writeFile(path.join(f.workspace, "SOUL.md"), "Owner edit");
  observed = false;
  await assert.rejects(f.initializer.verifyInstalled(), /projection_drift/);
  assert.equal(observed, false);
  assert.equal(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), "Owner edit");
});

test("a Host verification result cannot survive cancellation or edits made during verification", async (t) => {
  const f = await fixture(t);
  await f.initializer.initialize();
  const cancellation = new AbortController();
  const cancelled = new StellaInitializer(f.workspace, f.state, f.config,
    { ...f.ports, verify: async () => { cancellation.abort(); } }, cancellation.signal);
  await assert.rejects(cancelled.verifyInstalled(), /operation_cancelled/);
  const changed = new StellaInitializer(f.workspace, f.state, f.config, { ...f.ports,
    verify: async () => { await writeFile(path.join(f.workspace, "SOUL.md"), "Concurrent owner edit"); },
  });
  await assert.rejects(changed.verifyInstalled(), /projection_drift/);
  assert.equal(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), "Concurrent owner edit");
});

test("compiles public Core templates and pinned reviewed behavior without rewriting the source", async (t) => {
  const f = await fixture(t);
  const save = async (name: string, value: unknown) => {
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    await writeFile(path.join(f.source, name), bytes);
    return { ref: `path:${name}`, sha256: bytesVersion(bytes) };
  };
  const rules = Object.fromEntries(await Promise.all(
    BOOTSTRAP_TARGETS.filter((target) => target !== "IDENTITY.md").map(async (target) => {
      const stem = target.replace(/\.md$/i, "").toLowerCase();
      const body = target === "SOUL.md"
        ? "Be precise. Ask about material unknowns.\nSynthetic soul rules."
        : `Be precise. Ask about material unknowns.\nSynthetic ${target} rules.`;
      return [target, await save(`reviewed-${stem}.txt`, body)] as const;
    }),
  ));
  const exposure = { schema_version: "stella.projection-exposure/v1", id: "public-behavior", classification: "public_behavior",
    audiences: ["public"], targets: BOOTSTRAP_TARGETS };
  const exposureRef = await save("exposure.json", exposure);
  const mapping = { schema_version: "stella.behavior-mapping/v1", id: "synthetic-mapping", entries: [
    ...Object.entries(rules).map(([target, rule]) => ({
      id: target, source: { ref: `path:${target === "SOUL.md" ? "1.txt" : "0.txt"}`, sha256: f.recipe.files[target === "SOUL.md" ? 1 : 0]!.sha256 },
      role: "owner_behavior", status: "retained", new_rule_refs: [rule], reason: `Synthetic reviewed ${target}`,
      replacement_requirements: [] as string[], dependencies: [] as string[], required: true,
    })),
  ] as Array<{
    id: string; source: { ref: string; sha256: string }; role: string; status: string;
    new_rule_refs: Array<{ ref: string; sha256: string }>; reason: string;
    replacement_requirements: string[]; dependencies: string[]; required: boolean;
  }> };
  const mappingRef = await save("mapping.json", mapping);
  const displayIdentity = await save("display-identity.json", { schema_version: "stella.display-identity/v2", id: "unit-identity", name: "Unit Stella", emoji: "🧪" });
  mapping.entries.push({ id: "identity", source: { ref: "path:2.txt", sha256: f.recipe.files[2]!.sha256 }, role: "owner_behavior", status: "adapted",
    new_rule_refs: [displayIdentity], reason: "Synthetic display identity", replacement_requirements: ["native-identity"], dependencies: [], required: true });
  Object.assign(mappingRef, await save("mapping.json", mapping));
  const materialization = { schema_version: "stella.host-materialization/v1", id: "synthetic-instance",
    host_adapter: { id: "openclaw", version: "1", host_version: "2026.8.2", harness: "openclaw" }, behavior_mapping_ref: mappingRef,
    projection_recipes: BOOTSTRAP_TARGETS.map((target) => ({ target, template_version: INITIALIZATION_TEMPLATE_VERSION,
      behavior_ids: target === "IDENTITY.md" ? ["identity"] : [target],
      input_refs: target === "IDENTITY.md" ? [displayIdentity] : [rules[target]!], exposure_policy_ref: exposureRef })),
    skill_bindings: [], automation_declarations: [], required_checks: ["host_files", "host_skills", "host_identity", "host_setup"],
  };
  await save("recipe.json", materialization);
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Reviewed synthetic materialization"]);
  f.config.revision = await f.git(["rev-parse", "HEAD"]);
  const receipt = await f.initializer.initialize();
  assert.match(await readFile(path.join(f.workspace, "AGENTS.md"), "utf8"), /Be precise\. Ask about material unknowns\./);
  assert.match(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), /Be precise\. Ask about material unknowns\./);
  assert.deepEqual(await f.ports.readIdentity(), { name: "Unit Stella", emoji: "🧪" });
  assert.equal(await f.git(["status", "--porcelain"]), "");
  assert.equal(await readFile(path.join(f.source, "reviewed-soul.txt"), "utf8"), "Be precise. Ask about material unknowns.\nSynthetic soul rules.");
  assert.equal(receipt.scope, "host_bootstrap");
  const binding = { core: bytesVersion("core"), artifact: bytesVersion("artifact"), host: bytesVersion("host"),
    harness: bytesVersion("harness"), source: bytesVersion(f.config.revision), profile: bytesVersion("profile"),
    policy: bytesVersion("policy"), configuration: bytesVersion("configuration"), model: bytesVersion("model"),
    cases: bytesVersion("cases"), deployment: bytesVersion("deployment"), generation: bytesVersion("generation") };
  const capture = async () => structuredClone(binding);
  const proof = await f.initializer.verifyCapability(bytesVersion("authenticated-synthetic-operator"), capture);
  assert.equal(proof.runtimeAdmission, false);
  await f.initializer.assertCapabilityVerification(proof, capture);
  const restarted = new StellaInitializer(f.workspace, f.state, f.config, f.ports);
  await restarted.assertCapabilityVerification(proof, capture);
  await assert.rejects(restarted.assertCapabilityVerification({ ...proof, runtimeAdmission: true }, capture), /untrusted_verification_receipt/);
  for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
    const current = await restarted.verifyCapability(bytesVersion("operator"), capture);
    await assert.rejects(restarted.assertCapabilityVerification(current, async () => ({ ...binding, [key]: bytesVersion("drift") })), /verification_dependencies_changed/);
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.initializer.verifyCapability(bytesVersion("operator"), capture, aborted.signal), /operation_cancelled/);
  let captures = 0;
  await assert.rejects(f.initializer.verifyCapability(bytesVersion("operator"), async () => {
    captures++;
    return { ...binding, generation: bytesVersion(String(captures)) };
  }), /verification_dependencies_changed/);
  const duringReadback = new AbortController();
  await assert.rejects(restarted.assertCapabilityVerification(proof, async () => {
    duringReadback.abort(); return binding;
  }, duringReadback.signal), /operation_cancelled/);
  await assert.rejects(restarted.assertCapabilityVerification(proof, capture), /untrusted_verification_receipt/);
  const expiring = await restarted.verifyCapability(bytesVersion("operator"), capture);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    await assert.rejects(restarted.assertCapabilityVerification(expiring, async () => {
      t.mock.timers.setTime(Date.parse(expiring.expiresAt) + 1); return binding;
    }), /verification_expired/);
  } finally { t.mock.timers.reset(); }
  const beforeShutdown = await restarted.verifyCapability(bytesVersion("operator"), capture);
  const stopped = new StellaInitializer(f.workspace, f.state, f.config, f.ports, aborted.signal);
  await assert.rejects(stopped.assertCapabilityVerification(beforeShutdown, capture), /operation_cancelled/);
  await assert.rejects(restarted.assertCapabilityVerification(beforeShutdown, capture), /untrusted_verification_receipt/);
  const expectedIdentity = await f.ports.readIdentity();
  const externalIdentity = { name: "External edit" };
  await f.ports.applyIdentity(expectedIdentity, externalIdentity, false);
  await assert.rejects(f.initializer.rollback(receipt.operationId), /host_identity_conflict/);
  assert.match(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), /Be precise/);
  assert.deepEqual(await f.ports.readIdentity(), externalIdentity);
  await f.ports.applyIdentity(externalIdentity, expectedIdentity, false);
  await f.initializer.rollback(receipt.operationId);
  assert.equal(await f.ports.readIdentity(), null);
  await assert.rejects(readFile(path.join(f.workspace, "SOUL.md")), { code: "ENOENT" });
  assert.equal(f.fenced(), true);

  const missingRule = structuredClone(materialization);
  missingRule.projection_recipes.find((recipe) => recipe.target === "SOUL.md")!.input_refs = [];
  await assert.rejects(compileInitializationSource(f.source, missingRule, f.config), /complete_reviewed_document_required/);
  const conflict = structuredClone(mapping); conflict.entries[0]!.status = "conflict";
  const conflicted = { ...materialization, behavior_mapping_ref: await save("conflict.json", conflict) };
  await assert.rejects(compileInitializationSource(f.source, conflicted, f.config), /required_behavior_unresolved/);
  const privateExposure = await save("private-exposure.json", { ...exposure, classification: "private_facts" });
  const privateRecipe = structuredClone(materialization);
  privateRecipe.projection_recipes[0]!.exposure_policy_ref = privateExposure;
  await assert.rejects(compileInitializationSource(f.source, privateRecipe, f.config), /bootstrap_exposure_forbidden/);
  await assert.rejects(compileInitializationSource(f.source, { ...materialization, required_checks: [...materialization.required_checks, "memory_generation"] }, f.config),
    /required_check_adapter_unavailable/);
});

test("source or runtime changes invalidate an already reviewed plan", async (t) => {
  const f = await fixture(t);
  const plan = await f.initializer.plan();
  await writeFile(path.join(f.workspace, "USER.md"), "owner edit");
  await assert.rejects(f.initializer.apply(plan), /host_file_conflict/);
  assert.equal(await readFile(path.join(f.workspace, "USER.md"), "utf8"), "owner edit");
  await writeFile(path.join(f.source, "new.txt"), "uncommitted");
  await assert.rejects(f.initializer.plan(), /source_dirty/);
});

test("skill reads require the current receipt and cannot read personal or undeclared files", async (t) => {
  const f = await fixture(t);
  await f.initializer.initialize();
  await f.initializer.assertSkillRead({ path: "skills/stella-test/SKILL.md" });
  await f.initializer.assertSkillRead({ file_path: path.join(f.workspace, "skills/stella-test/SKILL.md") });
  for (const target of ["USER.md", "personal.txt", "skills/stella-test/undeclared.txt", "../source/0.txt"]) {
    await assert.rejects(f.initializer.assertSkillRead({ path: target }));
  }
  await writeFile(path.join(f.workspace, "skills/stella-test/SKILL.md"), "changed");
  await assert.rejects(f.initializer.assertSkillRead({ path: "skills/stella-test/SKILL.md" }), /projection_drift/);
});

test("failed Host verification stays fenced and resumes from the same durable operation", async (t) => {
  let fail = true;
  const f = await fixture(t, async () => { if (fail) throw new Error("host verification failed"); });
  await assert.rejects(f.initializer.initialize(), /host verification failed/);
  assert.equal(f.fenced(), true);
  const pending = JSON.parse(await readFile(path.join(f.state, "pending.json"), "utf8"));
  fail = false;
  const recovered = new StellaInitializer(f.workspace, f.state, f.config, f.ports);
  assert.equal((await recovered.initialize()).operationId, pending.operationId);
  assert.equal(f.fenced(), false);
});

test("subsequent initialization does not overwrite owner drift", async (t) => {
  const f = await fixture(t);
  await f.initializer.initialize();
  await writeFile(path.join(f.workspace, "MEMORY.md"), "owner change");
  await assert.rejects(f.initializer.initialize(), /projection_drift/);
});

test("process death after file writes resumes the durable operation without age-based lock stealing", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../src/openclaw/initialization.js", import.meta.url).href;
  const script = `import { StellaInitializer } from ${JSON.stringify(moduleUrl)};
    const initializer = new StellaInitializer(${JSON.stringify(f.workspace)}, ${JSON.stringify(f.state)}, ${JSON.stringify(f.config)}, {
      async fence() {}, async release() {}, async verify() { process.kill(process.pid, "SIGKILL"); }
    }); await initializer.initialize();`;
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", script]), (error: unknown) =>
    error instanceof Error && "signal" in error && error.signal === "SIGKILL");
  const pending = JSON.parse(await readFile(path.join(f.state, "pending.json"), "utf8"));
  assert.equal((await f.initializer.initialize()).operationId, pending.operationId);
});

test("rejects skill and source path escapes", async (t) => {
  const f = await fixture(t);
  assert.throws(() => parseMaterialization({ ...f.recipe, files: [{ ...f.recipe.files[0], target: "../SOUL.md" }] }), /unsafe_path/);
  await symlink(f.source, path.join(f.workspace, "skills"));
  await assert.rejects(f.initializer.plan(), /unsafe_path/);
});

test("rollback restores adopted files and modes, removes new files, and retains unrelated content", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, "SOUL.md"), "original owner instructions");
  await chmod(path.join(f.workspace, "SOUL.md"), 0o640);
  await writeFile(path.join(f.workspace, "unmanaged.txt"), "keep");
  const receipt = await f.initializer.initialize();
  await f.initializer.rollback(receipt.operationId);
  assert.equal(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), "original owner instructions");
  assert.equal((await stat(path.join(f.workspace, "SOUL.md"))).mode & 0o777, 0o640);
  await assert.rejects(readFile(path.join(f.workspace, "USER.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.workspace, "unmanaged.txt"), "utf8"), "keep");
  assert.equal(f.fenced(), true);
  await assert.rejects(f.initializer.assertCurrent(), /initialization_pending/);
});

test("Host service initializes on startup; manual entry shares the same transaction and admission gate", async (t) => {
  const f = await fixture(t);
  const prefix = "50_PersonalAgent/stella";
  await mkdir(path.join(f.source, prefix), { recursive: true });
  await writeFile(path.join(f.source, prefix, "manifest.yaml"), `identity:\n  runtimeProfileRef: path:${prefix}/runtime-profile.yaml\n`);
  await writeFile(path.join(f.source, prefix, "runtime-profile.yaml"), JSON.stringify({ schema_version: "stella.runtime-profile/v2", host_materialization_ref: "path:recipe.json",
    contract_profile: "alpha_praxis", agent_id: "stella", language: "zh-CN", timezone: "Asia/Shanghai",
    models: Object.fromEntries(["main", "router", "learning", "framework_compiler"].map((role) => [role,
      { provider: "synthetic", model: "synthetic", required_capabilities: [] }])), capabilities: [], source_policies_ref: "path:policies.yaml",
    autonomy: { research_enabled: false, proactive_delivery_enabled: false, delivery_policy_ref: "path:delivery.yaml", delegation_registry_ref: "path:delegations.yaml" },
  }));
  await prepareInitializationFixture(f.source, "stella");
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Synthetic profile"]);
  const pluginConfig = { canghaiRoot: f.source, recoveryRevision: await f.git(["rev-parse", "HEAD"]), manifestPath: `${prefix}/manifest.yaml`, agentId: "stella" };
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  let command: Parameters<OpenClawPluginApi["registerCommand"]>[0] | undefined;
  let registeredTool: Parameters<OpenClawPluginApi["registerTool"]>[0] | undefined;
  let toolOptions: Parameters<OpenClawPluginApi["registerTool"]>[1];
  const hostConfig: OpenClawConfig = { agents: { entries: { stella: { workspace: f.workspace }, other: { identity: { name: "Keep other identity" } } } },
    plugins: { entries: { "stella-core": { enabled: true, config: pluginConfig } } } };
  const api = {
    config: hostConfig,
    runtime: { version: "2026.8.2", config: { current: () => hostConfig,
      async mutateConfigFile(input: { mutate(config: OpenClawConfig): unknown }) { await input.mutate(hostConfig); return {}; } },
    agent: { async ensureAgentWorkspace(input: { dir: string }) { return { dir: input.dir, bootstrapPending: false }; } },
    gateway: { async request(method: string, params: { name?: string }) {
      if (method === "agents.files.list") return { workspace: f.workspace };
      if (method === "skills.status") return { workspaceDir: f.workspace, skills: [{ name: "stella-initialization-probe", eligible: true, filePath: path.join(f.workspace, "skills/stella-initialization-probe/SKILL.md") }] };
      if (method === "agents.files.get") return { file: { content: await readFile(path.join(f.workspace, params.name!), "utf8") } };
      throw new Error("unexpected Host method");
    } } },
    logger: { error() {} },
    registerService(value: typeof service) { service = value; },
    registerCommand(value: typeof command) { command = value; },
    registerTool(value: typeof registeredTool, options: typeof toolOptions) { registeredTool = value; toolOptions = options; }, registerGatewayMethod() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { hooks.set(name, handler); },
  };
  let inventoryRequests = 0;
  const initialization = registerStellaInitialization(api as never, pluginConfig, async (method, params) => {
    if (method === "agents.files.list" && ++inventoryRequests === 1) throw new Error("Synthetic listener is not ready yet");
    return api.runtime.gateway.request(method, params);
  });
  assert.equal(initialization.status().state, "not_started");
  const context = { agentId: "stella", runId: "test-run" };
  assert.equal((await hooks.get("before_agent_run")!({}, context) as { outcome: string }).outcome, "block");
  assert.equal(await hooks.get("before_agent_run")!({}, { agentId: "other" }), undefined);
  await service!.start({ config: api.config, stateDir: f.state, logger: api.logger } as never);
  await hooks.get("gateway_start")!({}, {});
  assert.equal(inventoryRequests, 2);
  assert.equal(initialization.status().state, "ready");
  assert.equal(hostConfig.agents?.entries?.stella?.identity?.name, "Synthetic Stella");
  assert.equal(hostConfig.agents?.entries?.other?.identity?.name, "Keep other identity");
  hostConfig.agents!.entries!.stella!.bootstrapMaxChars = 100;
  await assert.rejects(initialization.assertReady(), /host_bootstrap_context_incomplete/);
  assert.equal((await initialization.initialize()).state, "blocked");
  delete hostConfig.agents!.entries!.stella!.bootstrapMaxChars;
  assert.equal((await initialization.initialize()).state, "ready");
  assert.equal(await hooks.get("before_agent_run")!({}, context), undefined);
  const manual = await command!.handler({ agentId: "stella", isAuthorizedSender: true } as never);
  assert.equal(JSON.parse(manual.text!).state, "ready");
  const runtimeProfilePath = path.join(f.source, prefix, "runtime-profile.yaml");
  const alphaProfile = await readFile(runtimeProfilePath, "utf8");
  const fullProfile = parseYaml(alphaProfile) as Record<string, unknown>;
  fullProfile.contract_profile = "full_memory";
  fullProfile.memory = { catalog_ref: "path:catalog.json", semantic_provider: "synthetic", required_views: [], archive_max_rpo_seconds: 300 };
  await writeFile(runtimeProfilePath, JSON.stringify(fullProfile));
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Declare synthetic full-memory requirements"]);
  pluginConfig.recoveryRevision = await f.git(["rev-parse", "HEAD"]);
  const installed = await initialization.initialize();
  assert.equal(installed.state, "ready");
  assert.equal(installed.scope, "host_bootstrap");
  assert.deepEqual(installed.runtime, { state: "blocked", blockers: ["full_memory_acceptance_unavailable"] });
  await assert.rejects(initialization.assertReady(), /runtime_capabilities_unavailable/);
  assert.equal((await hooks.get("before_agent_run")!({}, context) as { category: string }).category, "runtime_capabilities_unavailable");
  const inspected = JSON.parse((await command!.handler({ agentId: "stella", args: "status" } as never)).text!);
  assert.equal(inspected.state, "ready");
  assert.equal(inspected.runtime.state, "blocked");
  await writeFile(runtimeProfilePath, alphaProfile);
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Restore synthetic Alpha profile"]);
  pluginConfig.recoveryRevision = await f.git(["rev-parse", "HEAD"]);
  assert.equal((await initialization.initialize()).state, "ready");
  assert.equal(typeof registeredTool, "function");
  assert.deepEqual(toolOptions?.names, ["stella_initialize"]);
  if (typeof registeredTool !== "function") throw new Error("Missing initialization tool factory");
  const visitorTool = registeredTool({ agentId: "stella", senderIsOwner: false });
  if (!visitorTool || Array.isArray(visitorTool)) throw new Error("Missing initialization tool");
  await assert.rejects(visitorTool.execute("visitor-request", { action: "apply" }), /owner_authorization_required/);
  let markGenerating!: () => void;
  const generating = new Promise<void>((resolve) => { markGenerating = resolve; });
  const abort = new AbortController();
  const activeTurn = coordinateCompletion({ operationId: "draining", runId: "draining", resourceScope: f.source,
    timeoutMs: 10000, abortSignal: abort.signal }, {
    generateDraft: ({ abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      markGenerating();
    }),
    async persist() { throw new Error("Must not persist a cancelled test turn"); },
    async publishFinal() { throw new Error("Must not publish a cancelled test turn"); },
  });
  const cancelled = assert.rejects(activeTurn, /cancelled/);
  await generating;
  const soulBefore = await readFile(path.join(f.workspace, "SOUL.md"), "utf8");
  await assert.rejects(initialization.rollback(initialization.status().operationId!), /active_turn_drain_required/);
  assert.equal(await readFile(path.join(f.workspace, "SOUL.md"), "utf8"), soulBefore);
  await assert.rejects(initialization.assertReady(), /initialization_pending/);
  abort.abort();
  await cancelled;
  await initialization.initialize();
  assert.equal(initialization.status().state, "ready");
  await writeFile(path.join(f.workspace, "USER.md"), "Changed while running");
  assert.equal((await hooks.get("reply_payload_sending")!({ runId: "test-run", sessionKey: "agent:stella:main" }, {}) as { cancel: boolean }).cancel, true);
  const profilePath = path.join(f.source, prefix, "runtime-profile.yaml");
  const profile = parseYaml(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  profile.schema_version = "stella.runtime-profile/v1";
  delete profile.host_materialization_ref;
  await writeFile(profilePath, JSON.stringify(profile));
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Change synthetic profile contract"]);
  pluginConfig.recoveryRevision = await f.git(["rev-parse", "HEAD"]);
  await assert.rejects(initialization.assertReady(), /profile_migration_required/);
  await service!.stop!({ config: api.config, stateDir: f.state, logger: api.logger } as never);
  assert.equal((await initialization.initialize()).state, "blocked");
});


test("initialization accepts only its live delivery lock and still rejects unrelated dirty source", async (t) => {
  const f = await fixture(t);
  const alias = path.join(path.dirname(f.source), "parent-alias");
  await symlink(path.dirname(f.source), alias);
  await withMemoryMutationLock(path.join(alias, "source"), async () => {
    await f.initializer.initialize();
    await writeFile(path.join(f.source, "unexpected.txt"), "synthetic dirty source");
    await assert.rejects(f.initializer.initialize(), /source_dirty/);
    await rm(path.join(f.source, "unexpected.txt"));
  });
  await writeFile(path.join(f.source, ".stella-memory-transaction.json.lock"), "unowned");
  await assert.rejects(f.initializer.initialize(), /source_dirty/);
});

test("initialization accepts live memory transaction marker with its owned lock", async (t) => {
  const f = await fixture(t);
  await withMemoryMutationLock(f.source, async () => {
    await writeFile(path.join(f.source, ".stella-memory-transaction.json"),
      JSON.stringify({ schemaVersion: "stella.memory-transaction/v1", operationId: "synthetic_live_tx" }));
    await f.initializer.initialize();
    await writeFile(path.join(f.source, "unexpected.txt"), "synthetic dirty source");
    await assert.rejects(f.initializer.initialize(), /source_dirty/);
    await rm(path.join(f.source, "unexpected.txt"));
  });
  await writeFile(path.join(f.source, ".stella-memory-transaction.json"),
    JSON.stringify({ schemaVersion: "stella.memory-transaction/v1", operationId: "unowned_marker" }));
  await writeFile(path.join(f.source, ".stella-memory-transaction.json.lock"), "unowned");
  await assert.rejects(f.initializer.initialize(), /source_dirty/);
});
