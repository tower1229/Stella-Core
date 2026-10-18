// OpenClaw 2026.8.2 ships this public JS facade without its declaration file.
// Reuse the typed registration contract; do not import a private Host bundle.
declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
  export function listMemoryCorpusSupplements(): Array<{
    pluginId: string;
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0];
  }>;
}

// OpenClaw 2026.8.2 exposes this pinned storage schema through a public JS
// facade without declarations. No private Host bundle is imported.
declare module "openclaw/plugin-sdk/memory-core-host-engine-storage" {
  export const MEMORY_INDEX_FTS_TABLE: "memory_index_chunks_fts";
  export const MEMORY_INDEX_CHUNKS_TABLE: "memory_index_chunks";
  export const MEMORY_INDEX_SOURCES_TABLE: "memory_index_sources";
  export const MEMORY_INDEX_CHUNK_PROVENANCE_TABLE: "memory_index_chunk_provenance";
  export const MEMORY_INDEX_META_TABLE: "memory_index_meta";
  export const MEMORY_INDEX_VECTOR_TABLE: "memory_index_chunks_vec";
  export const MEMORY_EMBEDDING_CACHE_TABLE: "memory_embedding_cache";
  export function loadSqliteVecExtension(input: { db: import("node:sqlite").DatabaseSync; extensionPath?: string }):
    Promise<{ ok: true; extensionPath: string } | { ok: false; error: string }>;
}
