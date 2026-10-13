// OpenClaw 2026.8.2 ships this public JS facade without its declaration file.
// Reuse the typed registration contract; do not import a private Host bundle.
declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
  export function listMemoryCorpusSupplements(): Array<{
    pluginId: string;
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0];
  }>;
}
