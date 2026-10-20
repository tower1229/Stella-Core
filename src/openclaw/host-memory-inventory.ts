import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { CatalogError } from "../canghai/catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import { HOST_MEMORY_PROVIDER } from "./host-memory-provider.js";

export const HOST_NATIVE_MEMORY_ENTRANCES = ["memory_index", "session_summary", "bootstrap", "session_replay", "compaction", "prompt_cache", "context_engine", "harness_memory", "internal_hooks"] as const;
export const HOST_MEMORY_PLUGIN_IDS = ["memory-core", "session-memory", "dreaming", "active-memory", "memory-wiki"] as const;
const memoryPlugins = new Set<string>(HOST_MEMORY_PLUGIN_IDS);

// The Host's normalized config includes absent optional fields as undefined.
// Hash its JSON configuration representation, not runtime-only object layout.
export function hostMemoryConfigurationHash(config: unknown): string {
  return bytesVersion(canonicalJson(JSON.parse(JSON.stringify(config))));
}

/** Bind every execution setting while treating the durable source pointer as
 * data state. The expected pointer is Core's held recovery binding, updated
 * only after its durability callback succeeds; never copy it from this config.
 * Source revision, generation and payload eligibility remain separate gates. */
export function hostContextExecutionHash(config: unknown, expected: {
  agentId: string; canghaiRoot: string; recoveryRevision: string;
}): string {
  let snapshot: unknown;
  try { snapshot = JSON.parse(JSON.stringify(config)); }
  catch { throw new CatalogError("host_context_configuration_required"); }
  if (!isRecord(snapshot) || !isRecord(snapshot.plugins) || !isRecord(snapshot.plugins.entries)) {
    throw new CatalogError("host_context_configuration_required");
  }
  const entry = snapshot.plugins.entries["stella-core"];
  if (!isRecord(entry) || entry.enabled === false || !isRecord(entry.config) ||
      (entry.config.agentId ?? "stella") !== expected.agentId || entry.config.canghaiRoot !== expected.canghaiRoot ||
      entry.config.dataMode !== "managed_durable_write") throw new CatalogError("host_context_configuration_scope_mismatch");
  if (!/^[a-f0-9]{40}$/i.test(expected.recoveryRevision) || entry.config.recoveryRevision !== expected.recoveryRevision) {
    throw new CatalogError("host_context_recovery_binding_changed");
  }
  delete entry.config.recoveryRevision;
  return bytesVersion(canonicalJson({ schemaVersion: "stella.host-context-execution-config/v1", configuration: snapshot }));
}

/** Inventory evidence is diagnostic; neither an enabled plugin nor an absent
 * plugin proves the provenance of the final prompt assembled by the Host. */
export function inspectDeclaredHostMemory(input: {
  config: OpenClawConfig; agentId: string; plugins: unknown; generationId: string;
}) {
  const inventory = input.plugins;
  if (!isRecord(inventory) || !Array.isArray(inventory.plugins) || inventory.plugins.length > 512) {
    throw new CatalogError("host_memory_inventory_unavailable");
  }
  const entries: Array<{ identityHash: string; kind: string; state: string; reason: string }> = [];
  for (const kind of HOST_NATIVE_MEMORY_ENTRANCES) entries.push({ identityHash: bytesVersion(`native:${kind}`), kind,
    state: "unverifiable", reason: "host_provenance_binding_unavailable" });
  // Bundled hooks are default-on when discovered. Config alone cannot prove
  // absence (managed installs may also load them); only an explicit disable is
  // sufficient to report disabled without a native hook-runtime inventory.
  const sessionMemoryDisabled = input.config.hooks?.internal?.enabled === false ||
    input.config.hooks?.internal?.entries?.["session-memory"]?.enabled === false;
  entries.push({ identityHash: bytesVersion("hook:session-memory"), kind: "session-memory",
    state: sessionMemoryDisabled ? "disabled" : "unverifiable",
    reason: sessionMemoryDisabled ? "host_reports_disabled" : "hook_input_provenance_unavailable" });
  const hooks = input.config.hooks?.internal;
  const declared = input.config.plugins?.entries ?? {};
  const pluginPaths = input.config.plugins?.load?.paths ?? [], hookPaths = hooks?.load?.extraDirs ?? [];
  const allowed = input.config.plugins?.allow ?? [];
  if ([Object.keys(declared), Object.keys(hooks?.entries ?? {}), pluginPaths, hookPaths, allowed].some(values => values.length > 512)) {
    throw new CatalogError("invalid_host_memory_inventory");
  }
  for (const [kind, paths] of [["additional_plugin_loader", pluginPaths], ["additional_internal_hook_loader", hookPaths]] as const) {
    for (const directory of new Set(paths)) entries.push({ identityHash: bytesVersion(`${kind}:${directory}`), kind,
      state: "unverifiable", reason: "declared_loader_inventory_unavailable" });
  }
  for (const [id, declaration] of Object.entries(hooks?.entries ?? {})) {
    if (id === "session-memory") continue;
    const disabled = hooks?.enabled === false || declaration.enabled === false;
    entries.push({ identityHash: bytesVersion(`hook:${id}`), kind: "additional_internal_hook",
      state: disabled ? "disabled" : "unverifiable",
      reason: disabled ? "host_reports_disabled" : "hook_input_provenance_unavailable" });
  }
  const observed = new Map<string, { installed: boolean; enabled: boolean }>();
  for (const plugin of inventory.plugins) {
    if (!isRecord(plugin) || typeof plugin.id !== "string" || !plugin.id || typeof plugin.installed !== "boolean" ||
        typeof plugin.enabled !== "boolean" || observed.has(plugin.id)) throw new CatalogError("invalid_host_memory_inventory");
    observed.set(plugin.id, { installed: plugin.installed, enabled: plugin.enabled });
  }
  // A configured but missing plugin is a gap, not evidence of absence. Keep
  // configured identities even when plugins.list cannot report their code.
  const ids = new Set([...Object.keys(declared), ...allowed, ...observed.keys()]);
  if (ids.size > 512) throw new CatalogError("invalid_host_memory_inventory");
  for (const id of [...ids].sort()) {
    const plugin = observed.get(id), declaration = declared[id];
    if (id === "stella-core" || !plugin?.installed && declaration === undefined && !allowed.includes(id) && !plugin?.enabled) continue;
    const conflict = plugin?.enabled === true && declaration?.enabled === false ||
      plugin?.installed === true && plugin.enabled === false && declaration?.enabled === true;
    const disabled = !conflict && (declaration?.enabled === false || plugin?.installed === true && plugin.enabled === false);
    entries.push({ identityHash: bytesVersion(`plugin:${id}`),
      kind: memoryPlugins.has(id) ? id : "additional_plugin", state: disabled ? "disabled" : "unverifiable",
      reason: conflict ? "host_plugin_state_conflict" : disabled ? "host_reports_disabled" :
        !plugin?.installed ? "declared_plugin_inventory_missing" : "plugin_input_provenance_unavailable" });
  }
  // Dreaming is bundled inside memory-core: it need not have a plugins.list
  // row of its own. An explicit disable is diagnostic only; neither omission
  // nor a cron completion binds native output to a Core Memory Generation.
  const core = observed.get("memory-core"), coreConfig = declared["memory-core"];
  const coreConflict = core?.enabled === true && coreConfig?.enabled === false ||
    core?.installed === true && core.enabled === false && coreConfig?.enabled === true;
  const dreaming = coreConfig?.config?.dreaming;
  const dreamingDisabled = isRecord(dreaming) && dreaming.enabled === false || !coreConflict &&
    (coreConfig?.enabled === false || core?.installed === true && core.enabled === false);
  entries.push({ identityHash: bytesVersion("memory-core:dreaming"), kind: "dreaming",
    state: dreamingDisabled ? "disabled" : "unverifiable",
    reason: dreamingDisabled ? "host_reports_disabled" : "native_dreaming_generation_binding_unavailable" });
  const model = resolveDefaultModelForAgent({ cfg: input.config, agentId: input.agentId });
  return {
    schemaVersion: "stella.host-memory-inventory/v1", scope: "declared_host_memory", complete: false,
    configurationHash: hostMemoryConfigurationHash(input.config), generationHash: bytesVersion(input.generationId),
    coreConsumption: model.provider === HOST_MEMORY_PROVIDER ? "guarded_provider" : "admission_only",
    entries, blockers: ["host_memory_consumption_unverifiable"],
  };
}
