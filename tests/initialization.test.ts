import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, chmod, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { StellaInitializer, parseMaterialization, type InitializationPorts, type Materialization } from "../src/openclaw/initialization.js";
import { bytesVersion } from "../src/canghai/content-version.js";
import { prepareInitializationFixture } from "./consciousness-fixture.js";
import { compileInitializationSource, readCompiledContextRules } from "../src/openclaw/initialization-source.js";
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

test("read-only initialization planning leaves the Git index unchanged", async t => {
  const f = await fixture(t);
  const optionalLocks = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = "1";
  try {
    const index = await readFile(path.join(f.source, ".git/index"));
    const changedTime = new Date(Date.now() + 5_000);
    await utimes(path.join(f.source, "0.txt"), changedTime, changedTime);
    await f.initializer.plan();
    assert.deepEqual(await readFile(path.join(f.source, ".git/index")), index);
  } finally {
    if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
  }
});

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

test("initialization rechecks a transaction fence released after Git observed it", async (t) => {
  const f = await fixture(t);
  const control = await mkdtemp(path.join(os.tmpdir(), "stella-git-observation-"));
  const originalPath = process.env.PATH;
  const realGit = (await exec("which", ["git"])).stdout.trim();
  t.after(async () => { process.env.PATH = originalPath; await rm(control, { recursive: true, force: true }); });
  const observed = path.join(control, "observed"), resume = path.join(control, "resume");
  await writeFile(path.join(control, "git"), `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const output = execFileSync(${JSON.stringify(realGit)}, args);
if (args.includes('--porcelain') && !existsSync(${JSON.stringify(observed)})) {
  writeFileSync(${JSON.stringify(observed)}, output);
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(resume)})) {
    if (Date.now() > deadline) process.exit(2);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
process.stdout.write(output);
`, { mode: 0o755 });
  process.env.PATH = `${control}${path.delimiter}${originalPath}`;
  let enter!: () => void, unlock!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const writer = withMemoryMutationLock(f.source, async () => { enter(); await release; });
  await entered;
  const planned = f.initializer.plan();
  // The shim holds Git's real status output while the actual owner releases its lock.
  let captured = "";
  try {
    const deadline = Date.now() + 5000;
    while (!captured) {
      captured = await readFile(observed, "utf8").catch(() => "");
      if (Date.now() > deadline) throw new Error("git_observation_timeout");
      if (!captured) await new Promise(resolve => setTimeout(resolve, 5));
    }
  } finally {
    unlock(); await writer; await writeFile(resume, "continue");
  }
  assert.match(captured, /\.stella-memory-transaction\.json\.lock/);
  assert.equal((await planned).sourceRevision, f.config.revision);
});

test("context compilation requires a current admitted run and detects installed drift", async t => {
  const f = await fixture(t);
  const prefix = path.join(f.source, "50_PersonalAgent/stella");
  await mkdir(prefix, { recursive: true });
  await writeFile(path.join(prefix, "runtime-profile.yaml"), "{}");
  await writeFile(path.join(prefix, "manifest.yaml"), "{}");
  const document = await prepareInitializationFixture(f.source, "stella");
  await writeFile(path.join(f.source, "recipe.json"), JSON.stringify(document));
  await f.git(["add", "."]);
  await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Reviewed context source"]);
  f.config.revision = await f.git(["rev-parse", "HEAD"]);
  await f.initializer.initialize();
  await assert.rejects(f.initializer.contextCompilation("unbound"));
  const prepared = await f.initializer.prepareContextCompilation();
  assert.equal(readCompiledContextRules(prepared).agentId, "stella");
  // Prompt preparation precedes before_agent_run; compiling public rules must
  // neither require nor create the later model-consumption admission.
  await assert.rejects(f.initializer.assertRun("unbound"));
  const readIdentity = f.ports.readIdentity;
  let arrivals = 0;
  let release!: () => void;
  const bothCompiled = new Promise<void>(resolve => { release = resolve; });
  f.ports.readIdentity = async () => {
    if (++arrivals === 2) release();
    await bothCompiled;
    return readIdentity();
  };
  try {
    const [first, second] = await Promise.all([
      f.initializer.prepareContextCompilation(), f.initializer.prepareContextCompilation(),
    ]);
    assert.notEqual(first, second, "Each validation returns its own compiler receipt, not a shared mutable slot");
    assert.deepEqual(readCompiledContextRules(first), readCompiledContextRules(second));
  } finally { f.ports.readIdentity = readIdentity; }
  await f.initializer.bindRun("context-run");
  const compiled = await f.initializer.contextCompilation("context-run");
  assert.equal(readCompiledContextRules(compiled).agentId, "stella");
  await writeFile(path.join(f.workspace, "MEMORY.md"), "Unbound memory artifact");
  await assert.rejects(f.initializer.prepareContextCompilation(), /projection_drift/);
  await assert.rejects(f.initializer.contextCompilation("context-run"), /projection_drift/);
});
