import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isCompletionDraftContext } from "./completion.js";

export function registerCompletionTranscriptGuard(
  api: Pick<OpenClawPluginApi, "on">,
  agentId: string,
): void {
  api.on("before_message_write", (event, context) => {
    if ((event.agentId ?? context.agentId) !== agentId) return;
    if (event.message.role === "assistant" && isCompletionDraftContext()) return { block: true };
  }, { priority: 1_000 });
}
