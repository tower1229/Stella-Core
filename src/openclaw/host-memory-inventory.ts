import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { CatalogError } from "../canghai/catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import { HOST_MEMORY_PROVIDER } from "./host-memory-provider.js";

const nativeEntrances = ["memory_index", "session_summary", "bootstrap", "session_replay", "compaction", "prompt_cache", "context_engine", "harness_memory", "internal_hooks"];
const memoryPlugins = new Set(["memory-core", "session-memory", "dreaming", "active-memory", "memory-wiki"]);

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
  for (const kind of nativeEntrances) entries.push({ identityHash: bytesVersion(`native:${kind}`), kind,
    state: "unverifiable", reason: "host_provenance_binding_unavailable" });
  const seen = new Set<string>();
  for (const plugin of inventory.plugins) {
    if (!isRecord(plugin) || typeof plugin.id !== "string" || !plugin.id || typeof plugin.installed !== "boolean" ||
        typeof plugin.enabled !== "boolean" || seen.has(plugin.id)) throw new CatalogError("invalid_host_memory_inventory");
    seen.add(plugin.id);
    if (!plugin.installed || plugin.id === "stella-core") continue;
    entries.push({ identityHash: bytesVersion(`plugin:${plugin.id}`),
      kind: memoryPlugins.has(plugin.id) ? plugin.id : "additional_plugin",
      state: plugin.enabled ? "unverifiable" : "disabled",
      reason: plugin.enabled ? "plugin_input_provenance_unavailable" : "host_reports_disabled" });
  }
  const model = resolveDefaultModelForAgent({ cfg: input.config, agentId: input.agentId });
  return {
    schemaVersion: "stella.host-memory-inventory/v1", scope: "declared_host_memory", complete: false,
    configurationHash: hostMemoryConfigurationHash(input.config), generationHash: bytesVersion(input.generationId),
    coreConsumption: model.provider === HOST_MEMORY_PROVIDER ? "guarded_provider" : "admission_only",
    entries, blockers: ["host_memory_consumption_unverifiable"],
  };
}
