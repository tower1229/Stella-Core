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
