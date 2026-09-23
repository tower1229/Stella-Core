import { formatZonedTimestamp } from "openclaw/plugin-sdk/core";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { HostMemoryInput } from "./host-memory-provider.js";

/** OpenClaw 2026.8.2's public prompt hook is followed by these deterministic
 * transformations (attempt-prompt-build / system-prompt). This is an expected
 * assembly, not a filter applied to an observed, potentially untrusted prompt.
 * Additional hook or media-task text still fails the complete input digest. */
export function assembleManagedSystemPrompt(reviewedPrompt: string, modelRef: string): string {
  const boundary = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
  const prefix = "Current model identity:";
  const line = `${prefix} ${modelRef.trim()}. If asked what model you are, answer with this value for the current run.`;
  // normalizeOptionalString at the public systemPrompt hook boundary.
  const base = reviewedPrompt.trim();
  const source = base && !base.includes(boundary) ? `${base}${boundary}` : base;
  const parts: string[] = [];
  let cursor = 0;
  for (let index = source.indexOf(prefix); index !== -1;) {
    const nextLine = source.indexOf("\n", index);
    const lineStart = source.lastIndexOf("\n", index) + 1;
    if (!source.slice(lineStart, index).trimStart()) {
      const preceding = source.slice(cursor, lineStart).replace(/\r\n/gu, "\n");
      parts.push(parts.length === 0 ? preceding : preceding.slice(0, -1));
      if (parts.length === 1) parts.push(line);
      cursor = nextLine === -1 ? source.length : nextLine;
    }
    index = nextLine === -1 ? -1 : source.indexOf(prefix, nextLine + 1);
  }
  if (parts.length) return [...parts, source.slice(cursor).replace(/\r\n/gu, "\n")].join("");
  return source.trimEnd() ? `${source.trimEnd()}\n\n${line}` : line;
}

/** Fixed 2026.8.2 wire formatting for Core's text-only user views. This compiles
 * already authorized text; it never strips a prefix from observed provider
 * input. Unexpected Host metadata transformations fail the final digest. */
export function projectManagedMessages(input: HostMemoryInput, timezone: string,
  current?: { text: string; timestamp: number }): HostMemoryInput {
  let currentIndex = input.messages.length - 1;
  while (currentIndex >= 0 && input.messages[currentIndex]!.role !== "user") currentIndex--;
  return { ...structuredClone(input), messages: input.messages.map((message, index) => {
    if (message.role !== "user") return structuredClone(message);
    const text = typeof message.content === "string" ? message.content
      : message.content.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : undefined;
    if (text === undefined || !Number.isSafeInteger(message.timestamp)) throw new CatalogError("host_context_boundary_invalid");
    // These are the pinned Host's envelope guards, not semantic classification.
    if (!text.trim() || /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(text) ||
      text.includes("Current time: ") || text.startsWith("[Inter-session message]")) return { ...message, content: text };
    const sourceTimestamp = current && index === currentIndex && text === current.text ? current.timestamp : message.timestamp;
    if (!Number.isSafeInteger(sourceTimestamp)) throw new CatalogError("host_context_boundary_invalid");
    const timestamp = formatZonedTimestamp(new Date(sourceTimestamp), { timeZone: timezone, displayWeekday: true });
    if (!timestamp) throw new CatalogError("host_context_boundary_invalid");
    return { ...message, content: `[${timestamp}] ${text}` };
  }) };
}

/** Pinned Host resolveUserTimezone behavior (not exported by its public SDK). */
export function resolveManagedHostTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
      return trimmed;
    } catch { /* The original Host uses its system zone for an invalid configured zone. */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
}
