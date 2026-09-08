import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveBootstrapContextForRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { bytesVersion } from "../canghai/content-version.js";
import { InitializationError } from "./initialization.js";
import { BOOTSTRAP_TARGETS } from "./initialization-templates.js";

/** Verify the Host's bounded bootstrap loader, not merely the bytes on disk.
 * This does not prove native harness consumption or refresh existing transcripts.
 */
export async function verifyInitializationContext(input: {
  workspace: string; agentId: string; currentConfig: OpenClawPluginApi["runtime"]["config"]["current"];
  files: readonly { target: string; sha256: string }[];
}, resolveContext = resolveBootstrapContextForRun): Promise<void> {
  // Public loader types accept mutable config; this independent clone never
  // exposes or mutates the Host's deeply readonly current configuration.
  const config = structuredClone(input.currentConfig()) as OpenClawConfig;
  const beforeConfig = bytesVersion(JSON.stringify(config));
  const agent = resolveAgentConfig(config, input.agentId);
  const mode = agent?.contextInjection ?? config.agents?.defaults?.contextInjection ?? "always";
  // Continuation skipping needs a separate session-refresh proof. It cannot
  // inherit this verification just because the synthetic first turn is complete.
  if (mode !== "always") throw new InitializationError("host_context_injection_unsupported");
  const workspace = await realpath(input.workspace);
  if (await realpath(resolveAgentWorkspaceDir(config, input.agentId)) !== workspace) {
    throw new InitializationError("host_workspace_mismatch");
  }
  const expected = new Map<string, string>();
  for (const target of BOOTSTRAP_TARGETS) {
    const file = input.files.filter(file => file.target === target);
    if (file.length !== 1) throw new InitializationError("required_bootstrap_missing");
    const destination = path.join(workspace, target);
    const bytes = await readFile(destination);
    if (bytesVersion(bytes) !== file[0]!.sha256) throw new InitializationError("projection_drift");
    expected.set(destination, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  let loaded: Awaited<ReturnType<typeof resolveBootstrapContextForRun>>;
  try {
    loaded = await resolveContext({ workspaceDir: workspace, agentId: input.agentId,
      config, sessionKey: `agent:${input.agentId}:main`, chatType: "direct", contextMode: "full",
      readOnlyState: true, warn: () => {} });
  } catch { throw new InitializationError("host_bootstrap_context_unavailable"); }
  for (const [destination, content] of expected) {
    const raw = loaded.bootstrapFiles.filter(file => path.resolve(file.path) === destination);
    const bounded = loaded.contextFiles.filter(file => path.resolve(file.path) === destination);
    if (raw.length !== 1 || raw[0]!.missing || bounded.length !== 1) {
      throw new InitializationError("host_bootstrap_context_missing");
    }
    // Host removes trailing whitespace. No other lossy normalization is accepted.
    if (raw[0]!.content !== content || bounded[0]!.content !== content.trimEnd()) {
      throw new InitializationError("host_bootstrap_context_incomplete");
    }
  }
  if (bytesVersion(JSON.stringify(input.currentConfig())) !== beforeConfig) {
    throw new InitializationError("initialization_config_changed");
  }
}
