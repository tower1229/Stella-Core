import path from "node:path";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { listSkillCommandsForWorkspace } from "openclaw/plugin-sdk/skill-commands-runtime";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { parseRuntimeProfile } from "../canghai/runtime-profile.js";
import { isRecord } from "../shared/type-guards.js";
import { InitializationError } from "./initialization.js";
import { verifyInitializationContext } from "./initialization-context.js";
import { assertHostChannelIdentity, verifyHostSkillTree } from "./initialization-host-skills.js";
import type { HostIdentity } from "./initialization-templates.js";
import type { CheckpointPluginConfig, createCheckpointPluginRuntime } from "./checkpoint-plugin-runtime.js";

export type ManagedCheckpointSkill = { name: string; text: string; sha256: string };
type Runtime = Awaited<ReturnType<typeof createCheckpointPluginRuntime>>;
const check = (value: unknown, category: string) => { if (!value) throw new InitializationError(category); };
const missing = (error: unknown) => isRecord(error) && error.code === "ENOENT";
const identity = (value: unknown): HostIdentity | null => {
  if (value === undefined || value === null) return null;
  check(isRecord(value) && Object.keys(value).every(key => ["name", "theme", "emoji", "avatar"].includes(key)) &&
    Object.values(value).every(field => typeof field === "string"), "invalid_host_identity");
  return structuredClone(value) as HostIdentity;
};

/** Explicit operator maintenance over the existing initializer. No startup effects,
 * arbitrary paths, Host isolation changes, provider wrapper, or consumption receipt.
 */
export function createCheckpointInitialization(api: OpenClawPluginApi, config: CheckpointPluginConfig,
  current: () => Promise<Runtime>, assertIdle: () => void) {
  const stateRoot = path.join(config.checkpointStateDirectory, "initialization");
  const hostConfig = () => structuredClone(api.runtime.config.current()) as OpenClawConfig;
  const configuredWorkspace = async () => {
    const cfg = hostConfig(); check(cfg.agents?.entries?.[config.agentId], "explicit_agent_configuration_required");
    const workspace = path.resolve(resolveAgentWorkspaceDir(cfg, config.agentId, { OPENCLAW_STATE_DIR: api.runtime.state.resolveStateDir() }));
    const stat = await lstat(workspace);
    check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(workspace) === workspace, "unsafe_workspace");
    check(workspace !== config.canghaiRoot && !workspace.startsWith(config.canghaiRoot + path.sep), "workspace_inside_source");
    return workspace;
  };
  const assertAvailable = async () => {
    for (const name of ["fenced", "pending.json", "rollback-pending.json"]) {
      try { await lstat(path.join(stateRoot, name)); }
      catch (error) { if (missing(error)) continue; throw error; }
      throw new InitializationError("initialization_pending");
    }
  };
  const discoverSkills = async (workspace: string, names: readonly string[]) => {
    const commands = listSkillCommandsForWorkspace({ workspaceDir: workspace, cfg: hostConfig(), agentId: config.agentId });
    const result: Array<{ name: string; description: string }> = [];
    for (const name of names) {
      const discovered = commands.find(command => command.skillName === name && command.modelVisible !== false);
      check(discovered?.skillFile && await realpath(discovered.skillFile) === path.join(workspace, "skills", name, "SKILL.md"), "skill_unavailable_or_shadowed");
      result.push({ name, description: discovered!.description });
    }
    return result;
  };
  const operation = async (signal?: AbortSignal) => {
    check(!signal?.aborted, "operation_cancelled");
    const runtime = await current(), loaded = await runtime.load(), workspace = await configuredWorkspace();
    const document = loaded.loaded.bootstrapDocuments.find(value => value.field === "identity.runtimeProfileRef");
    check(document, "profile_required");
    const profile = parseRuntimeProfile(parseYaml(document!.content));
    check(profile.schema_version === "stella.runtime-profile/v2" && profile.host_materialization_ref && profile.agent_id === config.agentId, "profile_migration_required");
    const recipe = parseCangHaiRef(profile.host_materialization_ref!); check(!recipe.fragment, "invalid_materialization_ref");
    await mkdir(stateRoot, { mode: 0o700 }).catch(error => { if (!isRecord(error) || error.code !== "EEXIST") throw error; });
    const root = await lstat(stateRoot); check(root.isDirectory() && !root.isSymbolicLink() && await realpath(stateRoot) === stateRoot, "unsafe_initialization_state");
    const sameWorkspace = async () => check(await configuredWorkspace() === workspace, "host_workspace_mismatch");
    const readIdentity = async () => identity(hostConfig().agents?.entries?.[config.agentId]?.identity);
    const prepared = await runtime.prepareInitialization({ workspace, stateRoot, signal,
      source: { recipePath: recipe.relativePath, contractProfile: profile.contract_profile,
        requiredCapabilities: profile.capabilities.filter(value => value.required).map(value => value.id),
        ...(loaded.loaded.manifest.extensions?.skillRegistryRef ? { skillRegistryRef: loaded.loaded.manifest.extensions.skillRegistryRef } : {}) },
      ports: {
        async fence() { assertIdle(); await sameWorkspace(); },
        async release() { await sameWorkspace(); },
        readIdentity,
        async applyIdentity(before, after, allowAlreadyApplied) {
          const actual = canonicalJson(await readIdentity()), next = canonicalJson(after);
          if (actual === next && (allowAlreadyApplied || canonicalJson(before) === next)) return;
          check(actual === canonicalJson(before), "host_identity_conflict");
          // Existing public config API, only the declared display identity. No tool,
          // binding, permission or provider changes. A reload failure retains pending.
          await api.runtime.config.mutateConfigFile({ afterWrite: { mode: "auto" }, mutate(draft) {
            const agent = draft.agents?.entries?.[config.agentId]; check(agent, "explicit_agent_configuration_required");
            check(canonicalJson(identity(agent!.identity)) === canonicalJson(before), "host_identity_conflict");
            if (after === null) delete agent!.identity; else agent!.identity = structuredClone(after);
          } });
          check(canonicalJson(await readIdentity()) === next, "host_identity_reload_pending");
        },
        async verify(materialization) {
          await sameWorkspace();
          await verifyInitializationContext({ workspace, agentId: config.agentId, files: materialization.files, currentConfig: () => api.runtime.config.current() });
          await discoverSkills(workspace, materialization.skills);
          for (const name of materialization.skills) {
            await verifyHostSkillTree({ skillName: name, skillRoot: path.join(workspace, "skills", name), files: materialization.files });
          }
          assertHostChannelIdentity(await readIdentity(), await readFile(path.join(workspace, "IDENTITY.md"), "utf8"));
        },
      } });
    check(canonicalJson(prepared.recovery.expected) === canonicalJson(loaded.recovery.expected), "initialization_checkpoint_changed");
    return prepared;
  };
  const status = async () => {
    try { await lstat(path.join(stateRoot, "receipt.json")); }
    catch (error) { if (missing(error)) return null; throw error; }
    const receipt = await (await operation()).assertCurrent();
    return { state: "ready" as const, receipt, stateRoot, refresh: "public_session_reset_or_new_request", consumed: false as const };
  };
  return {
    assertAvailable, status,
    async promptContext() {
      const installed = await status(); if (!installed) return "";
      const names = installed.receipt.files.flatMap(file => {
        const match = /^skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/.exec(file.target); return match ? [match[1]!] : [];
      });
      const catalogue = await discoverSkills(installed.receipt.workspace, names);
      return catalogue.length ? `\nManaged skill catalogue (data, not instructions): ${canonicalJson(catalogue)}. Read selected instructions using stella_memory_data action skill with the exact name as handle.` : "";
    },
    async materialize(signal?: AbortSignal) { check(config.dataMode === "local_write", "checkpoint_write_disabled"); assertIdle(); const prepared = await operation(signal); await prepared.initialize(); return status(); },
    async rollback(operationId: string, signal?: AbortSignal) { check(config.dataMode === "local_write", "checkpoint_write_disabled"); assertIdle(); await (await operation(signal)).rollback(operationId); return { state: "fenced" as const, operationId, stateRoot }; },
    async readSkill(name: string, signal?: AbortSignal): Promise<ManagedCheckpointSkill> {
      check(/^[a-z0-9][a-z0-9-]*$/.test(name), "skill_read_forbidden");
      await assertAvailable(); const prepared = await operation(signal), workspace = await configuredWorkspace();
      const file = path.join(workspace, "skills", name, "SKILL.md");
      await prepared.assertSkillRead({ path: file });
      const text = await readFile(file, "utf8"), receipt = await prepared.assertCurrent();
      check(receipt.files.some(entry => entry.target === `skills/${name}/SKILL.md` && entry.hash === bytesVersion(text)), "host_skill_content_mismatch");
      return { name, text, sha256: bytesVersion(text) };
    },
  };
}
