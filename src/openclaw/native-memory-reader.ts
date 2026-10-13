import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { getMemoryCapabilityRegistration } from "openclaw/plugin-sdk/memory-host-core";
import { listMemoryCorpusSupplements } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { CatalogError } from "../canghai/catalog-reader.js";
import { parseNativeMemoryOrigin, type NativeMemoryOrigin } from "../canghai/native-memory-origin.js";
import type { OriginalEvidence } from "../praxis/episode-evidence.js";
import { isRecord } from "../shared/type-guards.js";

function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Host search ranks candidates, but cannot choose or authorize personal evidence.
 * This reader looks up only a fragment already selected by Core's semantic path.
 * Actual native bytes must equal its independently retained, admitted original. */
export function createNativeMemoryReader(api: OpenClawPluginApi, agentId: string, sessionKey: string) {
  return async (value: NativeMemoryOrigin, original: OriginalEvidence, assertCurrent: () => Promise<void>): Promise<string> => {
    await assertCurrent();
    const origin = parseNativeMemoryOrigin(value);
    check(api.runtime.version === "2026.8.2" && origin.hostVersion === api.runtime.version, "native_memory_host_version_unsupported");
    check(origin.agentId === agentId, "native_memory_agent_mismatch");
    const config = structuredClone(api.runtime.config.current()) as OpenClawConfig;
    check(config.plugins?.entries?.[origin.provider === "session-memory" ? "memory-core" : origin.provider]?.enabled === true,
      "native_memory_provider_disabled");
    const query = original.text.trim().slice(0, 512);
    check(query.length > 0 && original.text.length <= 12_000, "native_memory_excerpt_budget_exhausted");
    let result: unknown;
    if (origin.provider === "memory-wiki") {
      const supplements = listMemoryCorpusSupplements().filter(entry => entry.pluginId === "memory-wiki");
      check(supplements.length === 1, "native_memory_provider_unbound");
      const supplement = supplements[0]!.supplement;
      // Wiki ranks compiled page metadata; use the already selected exact page
      // locator rather than treating a long Markdown body as a semantic query.
      const hits = await supplement.search({ agentId, agentSessionKey: sessionKey, sandboxed: false, query: origin.path, maxResults: 32 });
      await assertCurrent();
      check(Array.isArray(hits) && hits.some(hit => isRecord(hit) && hit.path === origin.path), "native_memory_index_miss");
      // A declared claim alias requires the native compiled cache. An absent or
      // invalidated publication must return failure, never retry by page path.
      result = await supplement.get({ agentId, agentSessionKey: sessionKey, sandboxed: false,
        lookup: origin.claimId === undefined ? origin.path : `claim:${origin.claimId}`,
        fromLine: origin.fromLine, lineCount: origin.lineCount });
      await assertCurrent();
      check(isRecord(result) && result.corpus === "wiki" && result.path === origin.path && result.fromLine === origin.fromLine &&
        result.lineCount === origin.lineCount && typeof result.content === "string", "native_memory_read_unverifiable");
      check(result.content === original.text, "native_memory_payload_changed");
      return result.content;
    }
    check(origin.path.startsWith("memory/"), "native_memory_path_forbidden");
    if (origin.provider === "session-memory") check(config.hooks?.internal?.enabled === true &&
      config.hooks.internal.entries?.["session-memory"]?.enabled === true, "native_session_memory_disabled");
    const registration = getMemoryCapabilityRegistration();
    check(registration?.pluginId === "memory-core" && registration.capability.runtime, "native_memory_provider_unbound");
    const runtime = registration.capability.runtime;
    const loaded = await runtime.getMemorySearchManager({ cfg: config, agentId });
    await assertCurrent();
    check(loaded.manager && !loaded.error, "native_memory_index_unavailable");
    check(runtime.authorizeSearchHits, "native_memory_search_authority_unavailable");
    const found = await loaded.manager.search(query, { maxResults: 32, minScore: 0, sources: ["memory"] });
    await assertCurrent();
    const hits = await runtime.authorizeSearchHits({ cfg: config, agentId,
      requesterSessionKey: sessionKey, sandboxed: false,
      hits: found });
    await assertCurrent();
    check(hits.some(hit => hit.path === origin.path && hit.startLine <= origin.fromLine &&
      hit.endLine >= origin.fromLine + origin.lineCount - 1), "native_memory_index_miss");
    result = await loaded.manager.readFile({ relPath: origin.path, from: origin.fromLine, lines: origin.lineCount });
    await assertCurrent();
    check(isRecord(result) && result.status === "ok" && result.path === origin.path && result.from === origin.fromLine &&
      result.lines === origin.lineCount && typeof result.text === "string", "native_memory_read_unverifiable");
    // The pinned public read codec removes the last empty file line and may
    // append this exact range continuation notice. No unknown rewrite is accepted.
    const body = original.text.endsWith("\n") ? original.text.slice(0, -1) : original.text;
    const notice = result.truncated === true && result.nextFrom === origin.fromLine + origin.lineCount
      ? `\n\n[More content available. Use from=${result.nextFrom} to continue.]` : "";
    check(result.text === body + notice && (result.truncated !== true || notice.length > 0), "native_memory_payload_changed");
    return result.text.slice(0, body.length) + (original.text.endsWith("\n") ? "\n" : "");
  };
}
