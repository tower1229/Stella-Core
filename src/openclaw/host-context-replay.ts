import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CatalogError } from "../canghai/catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import type { HostMemoryInput } from "./host-memory-provider.js";

export type HostReplayProjection = (input: HostMemoryInput) => HostMemoryInput;

/** Pure formatters from the pinned Host build. Only independently bound
 * producer input is projected; observed Host content never grants authority. */
export async function loadHostReplayProjection(hostVersion: string): Promise<HostReplayProjection> {
  if (hostVersion !== "2026.8.2") throw new CatalogError("host_context_replay_version_unsupported");
  const dist = path.resolve(path.dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/plugin-entry")), "..");
  const toolIds: unknown = await import(pathToFileURL(path.join(dist, "tool-call-id-bBWjBMFi.js")).href);
  const toolDetails: unknown = await import(pathToFileURL(path.join(dist, "model-context-message-Dmngk3hL.js")).href);
  if (!isRecord(toolIds) || typeof toolIds.a !== "function" || !isRecord(toolDetails) || typeof toolDetails.r !== "function") {
    throw new CatalogError("host_context_replay_codec_unavailable");
  }
  const ids = toolIds.a as (messages: HostMemoryInput["messages"], mode: "strict") => HostMemoryInput["messages"];
  const details = toolDetails.r as (messages: HostMemoryInput["messages"]) => HostMemoryInput["messages"];
  return input => ({ ...structuredClone(input), messages: ids(details(structuredClone(input.messages)), "strict") });
}
