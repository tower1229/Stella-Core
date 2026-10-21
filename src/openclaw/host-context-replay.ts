import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CatalogError } from "../canghai/catalog-reader.js";
import { canonicalJson } from "../canghai/content-version.js";
import { FRAGMENT_READ_DESCRIPTION, FRAGMENT_READ_PARAMETERS, FRAGMENT_READ_TOOL } from "./fragment-read-tool.js";
import { HOST_MEMORY_PROVIDER } from "./host-memory-provider.js";
import { isRecord } from "../shared/type-guards.js";
import type { HostMemoryInput } from "./host-memory-provider.js";

export type HostReplayTarget = Readonly<{ provider: string; modelId: string; api: string }>;

/** Only explicit, unique configuration can select the compatibility codec.
 * No credential fields or observed provider payloads are inspected here. */
export function resolveHostReplayTarget(config: unknown, modelRef: string): HostReplayTarget | undefined {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1 || !isRecord(config) || !isRecord(config.models) || !isRecord(config.models.providers)) return;
  const provider = modelRef.slice(0, slash), modelId = modelRef.slice(slash + 1);
  const declaration = config.models.providers[provider];
  if (!isRecord(declaration) || !Array.isArray(declaration.models)) return;
  const selected = declaration.models.filter(value => isRecord(value) && value.id === modelId);
  if (selected.length !== 1 || !isRecord(selected[0])) return;
  const api = selected[0].api ?? declaration.api;
  if (typeof api !== "string" || !api) return;
  return Object.freeze({ provider, modelId, api });
}

export function assertHostReplayTarget(target: HostReplayTarget | undefined, modelRef: string, api: string): void {
  if (target && (modelRef !== `${target.provider}/${target.modelId}` || api !== target.api)) {
    throw new CatalogError("host_context_replay_target_changed");
  }
}

export type HostReplayProjection = (input: HostMemoryInput) => HostMemoryInput;

/** Pure formatters from the pinned Host build. Only independently bound
 * producer input is projected; observed Host content never grants authority. */
export async function loadHostReplayProjection(hostVersion: string, target?: HostReplayTarget): Promise<HostReplayProjection> {
  if (hostVersion !== "2026.8.2") throw new CatalogError("host_context_replay_version_unsupported");
  const bound = target ? Object.freeze({ ...target }) : undefined;
  if (bound?.api === "google-generative-ai" && (bound.provider !== HOST_MEMORY_PROVIDER || bound.modelId !== "gemini-3.8-flash")) {
    throw new CatalogError("host_context_replay_target_unsupported");
  }
  const dist = path.resolve(path.dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/plugin-entry")), "..");
  const toolIds: unknown = await import(pathToFileURL(path.join(dist, "tool-call-id-bBWjBMFi.js")).href);
  const toolDetails: unknown = await import(pathToFileURL(path.join(dist, "model-context-message-Dmngk3hL.js")).href);
  if (!isRecord(toolIds) || typeof toolIds.a !== "function" || !isRecord(toolDetails) || typeof toolDetails.r !== "function") {
    throw new CatalogError("host_context_replay_codec_unavailable");
  }
  const ids = toolIds.a as (messages: HostMemoryInput["messages"], mode: "strict") => HostMemoryInput["messages"];
  const details = toolDetails.r as (messages: HostMemoryInput["messages"]) => HostMemoryInput["messages"];
  return input => {
    const projected = { ...structuredClone(input), messages: ids(details(structuredClone(input.messages)), "strict") };
    if (bound?.api === "google-generative-ai") for (const tool of projected.tools) {
      if (tool.name !== FRAGMENT_READ_TOOL) continue;
      if (!isRecord(tool.parameters) || tool.description !== FRAGMENT_READ_DESCRIPTION || canonicalJson(tool.parameters) !== canonicalJson(FRAGMENT_READ_PARAMETERS)) {
        throw new CatalogError("host_context_google_tool_schema_unbound");
      }
      // Fixed Host/Google declaration projection only. The original opaque tool
      // receipt and execute() exact-key validation remain authoritative. This is
      // not JSON Schema logical equivalence and cannot normalize observed input.
      const parameters: Record<string, unknown> = { ...tool.parameters };
      delete parameters.additionalProperties;
      tool.parameters = parameters;
    }
    return projected;
  };
}
