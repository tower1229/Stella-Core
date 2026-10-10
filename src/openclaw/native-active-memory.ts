import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CatalogError } from "../canghai/catalog-reader.js";
import { canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { FRAGMENT_READ_TOOL, type FragmentToolResultReceipt } from "./fragment-read-tool.js";
import { ManagedHostContextEngine } from "./host-context-engine.js";
import { readHostModelOutput, type HostMemoryInput, type HostModelOutputReceipt } from "./host-memory-provider.js";
import type { HostContextAuthority, ContextFragment } from "./host-context-authority.js";
import type { BoundTurnRequest } from "./turn-request.js";

type ToolAuthority = { allows(name: string): boolean; assertActive(): void };
type NativeConfig = { enabled: boolean; agents: string[]; mode: string; queryMode: string;
  toolsAllow: string[]; maxSummaryChars: number; model?: string; modelFallback?: string };
type NativeCodec = {
  normalizePluginConfig(value: unknown, config: unknown): NativeConfig;
  buildQuery(input: { latestUserMessage: string; config: NativeConfig }): string;
  buildSearchQuery(input: { latestUserMessage: string }): string;
  buildRecallPrompt(input: { config: NativeConfig; query: string; searchQuery: string }): string;
  normalizeActiveSummary(text: string): string | null;
  truncateSummary(text: string, length: number): string;
  buildPromptPrefix(text: string | null): string | undefined;
  projectReplay(input: HostMemoryInput): HostMemoryInput;
};
type NativeRecallPorts = {
  request: BoundTurnRequest; authority: HostContextAuthority; system: readonly ContextFragment[];
  capability: ToolAuthority; timezone: string; modelRef: string; assertCurrent(): Promise<void>;
  assertActive(): void;
};
function check(value: unknown, category: string): asserts value {
  if (!value) throw new CatalogError(category);
}
export type NativeRecallPrompt = Readonly<{ kind: "native_recall_prompt" }>;
const prompts = new WeakMap<NativeRecallPrompt, { request: BoundTurnRequest; text: string }>();
const fragmentReads = new AsyncLocalStorage<NativeMemoryRecall>();
export function readNativeRecallPrompt(receipt: NativeRecallPrompt) {
  const binding = prompts.get(receipt);
  check(binding, "native_memory_prompt_unbound");
  return binding;
}

// These versioned extension exports are used only as pure payload codecs.
// Admission uses public Host capabilities, never an imported private runner.
const nativeDirectory = path.resolve(path.dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/plugin-entry")), "../extensions/active-memory");
export async function loadNativeMemoryCodec(hostVersion: string): Promise<NativeCodec> {
  check(hostVersion === "2026.8.2", "native_memory_host_version_unsupported");
  const modules = await Promise.all(["config", "query", "prompt"].map(name => import(pathToFileURL(path.join(nativeDirectory, `${name}.js`)).href) as Promise<unknown>));
  const result = Object.assign({}, ...modules) as Record<string, unknown>;
  for (const name of ["normalizePluginConfig", "buildQuery", "buildSearchQuery", "buildRecallPrompt", "normalizeActiveSummary", "truncateSummary", "buildPromptPrefix"]) {
    check(typeof result[name] === "function", "native_memory_codec_unavailable");
  }
  const toolIds: unknown = await import(pathToFileURL(path.resolve(nativeDirectory, "../../tool-call-id-bBWjBMFi.js")).href);
  const toolDetails: unknown = await import(pathToFileURL(path.resolve(nativeDirectory, "../../model-context-message-Dmngk3hL.js")).href);
  check(isRecord(toolIds) && typeof toolIds.a === "function" && isRecord(toolDetails) && typeof toolDetails.r === "function",
    "native_memory_codec_unavailable");
  const ids = toolIds.a as (messages: HostMemoryInput["messages"], mode: "strict") => HostMemoryInput["messages"];
  const details = toolDetails.r as (messages: HostMemoryInput["messages"]) => HostMemoryInput["messages"];
  result.projectReplay = (input: HostMemoryInput): HostMemoryInput => ({ ...structuredClone(input),
    messages: ids(details(structuredClone(input.messages)), "strict") });
  return result as unknown as NativeCodec;
}

/** The scope comes from the Host's registered runtime proxy, not a session
 * suffix, model text, trigger, or a caller-supplied plugin-id field. */
export async function assertNativeMemoryOwner(): Promise<void> {
  const scope = getPluginRuntimeGatewayRequestScope();
  check(scope?.pluginId === "active-memory" && scope.pluginOrigin === "bundled" && scope.pluginSource,
    "native_memory_owner_unbound");
  check(await realpath(scope.pluginSource) === await realpath(path.join(nativeDirectory, "index.js")), "native_memory_owner_unbound");
}

export function isNativeMemoryOwner(): boolean {
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.pluginId === "active-memory" && scope.pluginOrigin === "bundled";
}

export async function nativeMemoryConfiguration(api: OpenClawPluginApi, agentId: string) {
  const cfg = api.runtime.config.current();
  const entry = cfg.plugins?.entries?.["active-memory"];
  if (entry?.enabled !== true || isRecord(entry.config) && entry.config.enabled === false) return;
  const codec = await loadNativeMemoryCodec(api.runtime.version);
  const config = codec.normalizePluginConfig(entry.config, cfg);
  if (!config.enabled || !config.agents.includes(agentId)) return;
  return { codec, config };
}

/** One recall under one live parent capability. Nothing here survives a turn,
 * grants new source access, or treats native cache text as a credential. */
export class NativeMemoryRecall {
  #session?: { runId: string; sessionId: string; sessionKey: string };
  #engine?: ManagedHostContextEngine;
  #terminal?: HostModelOutputReceipt;
  #failure?: unknown;
  #fragment?: ContextFragment;
  #expectedPrompt: string;
  #nativePrefix?: string;
  private constructor(private readonly input: NativeRecallPorts & { codec: NativeCodec; config: NativeConfig }) {
    // No raw Host history enters the child. A short-query history expansion
    // therefore fails the exact prompt check instead of acquiring authority.
    this.#expectedPrompt = input.codec.buildRecallPrompt({ config: input.config,
      query: input.codec.buildQuery({ latestUserMessage: input.request.prompt, config: input.config }),
      searchQuery: input.codec.buildSearchQuery({ latestUserMessage: input.request.prompt }) });
  }

  static async begin(api: OpenClawPluginApi, input: NativeRecallPorts): Promise<NativeMemoryRecall | undefined> {
    const selected = await nativeMemoryConfiguration(api, input.request.agentId);
    if (!selected) return;
    const { codec, config } = selected;
    check(config.mode === "always" && config.queryMode === "message" && canonicalJson(config.toolsAllow) === canonicalJson([FRAGMENT_READ_TOOL]),
      "native_memory_configuration_unsupported");
    check(input.modelRef.startsWith("stella-guarded/") && config.model === input.modelRef && !config.modelFallback,
      "native_memory_model_mismatch");
    input.capability.assertActive();
    check(input.capability.allows(FRAGMENT_READ_TOOL), "native_memory_tool_not_authorized");
    await input.assertCurrent();
    input.capability.assertActive();
    return new NativeMemoryRecall({ ...input, codec, config });
  }

  async #current(): Promise<void> {
    this.#active();
    await this.input.assertCurrent();
    this.#active();
  }

  #active(): void {
    if (this.#failure) throw this.#failure;
    this.input.assertActive();
    this.input.capability.assertActive();
    check(this.input.capability.allows(FRAGMENT_READ_TOOL), "native_memory_tool_not_authorized");
  }

  async bind(ctx: { agentId?: string; runId?: string; sessionId?: string; sessionKey?: string; modelProviderId?: string; modelId?: string }, prompt: string) {
    try {
      await assertNativeMemoryOwner();
      this.#active();
      if (ctx.modelProviderId !== undefined || ctx.modelId !== undefined) {
        check(`${ctx.modelProviderId}/${ctx.modelId}` === this.input.modelRef, "native_memory_model_mismatch");
      }
      check(ctx.agentId === this.input.request.agentId && ctx.runId && ctx.sessionId && ctx.sessionKey &&
        ctx.runId !== this.input.request.runId && ctx.sessionId !== this.input.request.sessionId,
      "native_memory_child_scope_mismatch");
      check(prompt === this.#expectedPrompt, "native_memory_child_prompt_unbound");
      if (this.#session) {
        check(this.matches(ctx), "native_memory_child_scope_mismatch");
        const systemPrompt = await this.input.authority.systemPrompt(this.input.system);
        this.#active();
        return { systemPrompt, toolsAllow: [FRAGMENT_READ_TOOL] };
      }
      this.#session = { runId: ctx.runId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey };
      const receipt: NativeRecallPrompt = Object.freeze({ kind: "native_recall_prompt" });
      prompts.set(receipt, { request: this.input.request, text: this.#expectedPrompt });
      const currentInput = await this.input.authority.nativeRecallInput(receipt);
      this.#engine = new ManagedHostContextEngine(this.input.request, this.input.authority, {
        system: this.input.system, history: [], currentInput, prompt: this.#expectedPrompt, session: this.#session,
        hostTimezone: this.input.timezone,
        projectNativeReplay: this.input.codec.projectReplay,
        // This is a derived internal request. The parent's signed consumption
        // trace retains its exact input, tool results and model output.
        archive: async () => { this.#active(); },
        persistSummary: async () => { throw new CatalogError("native_memory_compaction_not_admitted"); },
        complete: async () => { throw new CatalogError("native_memory_compaction_not_admitted"); },
      });
      const systemPrompt = await this.input.authority.systemPrompt(this.input.system);
      this.#active();
      return { systemPrompt, toolsAllow: [FRAGMENT_READ_TOOL] };
    } catch (error) { this.#failure = error; throw error; }
  }

  engine(): ManagedHostContextEngine {
    check(this.#engine, "native_memory_child_not_admitted");
    return this.#engine;
  }

  matches(ctx: { runId?: string; sessionId?: string; sessionKey?: string }): boolean {
    return Boolean(this.#session && (ctx.runId === undefined || this.#session.runId === ctx.runId) &&
      this.#session.sessionId === ctx.sessionId && (ctx.sessionKey === undefined || this.#session.sessionKey === ctx.sessionKey));
  }

  async assertChild(ctx: { runId?: string; sessionId?: string; sessionKey?: string; modelProviderId?: string; modelId?: string }): Promise<void> {
    await assertNativeMemoryOwner();
    check(this.matches(ctx), "native_memory_child_scope_mismatch");
    if (ctx.modelProviderId !== undefined || ctx.modelId !== undefined) {
      check(`${ctx.modelProviderId}/${ctx.modelId}` === this.input.modelRef, "native_memory_model_mismatch");
    }
    this.#active();
  }

  async assertConsumption(input: HostMemoryInput): Promise<void> {
    await this.#current();
    await this.engine().assertConsumption(input);
    this.#active();
  }

  async observeToolResult(receipt: FragmentToolResultReceipt): Promise<void> {
    check(this.isFragmentRead(), "native_memory_tool_result_unbound");
    this.#active();
    await this.engine().observeToolResult(receipt);
    this.#active();
  }

  isFragmentRead(): boolean { return fragmentReads.getStore() === this; }

  assertFragmentChild(ctx: { sessionId?: string; sessionKey?: string }): void {
    check(getPluginRuntimeGatewayRequestScope()?.pluginId === "stella-core" && this.matches(ctx),
      "native_memory_child_scope_mismatch");
    this.#active();
  }

  /** Host tool callbacks run under the tool's owner (Core), not the caller's
   * native-plugin scope. Use the independently bound child identity together
   * with its still-live parent capability, and retain that binding for the
   * opaque result callback. No session naming convention grants admission. */
  async readFragment<T>(ctx: { sessionId?: string; sessionKey?: string }, read: () => Promise<T>): Promise<T> {
    this.assertFragmentChild(ctx);
    const result = await fragmentReads.run(this, read);
    this.#active();
    return result;
  }

  async observeOutput(receipt: HostModelOutputReceipt): Promise<void> {
    this.#active();
    await this.engine().observeOutput(receipt);
    const output = readHostModelOutput(receipt);
    if (output.message.stopReason === "stop") {
      check(!this.#terminal, "native_memory_output_replayed");
      this.#terminal = receipt;
      const raw = output.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      check(output.message.content.every(part => part.type === "text" || part.type === "thinking"), "native_memory_output_invalid");
      const normalized = this.input.codec.normalizeActiveSummary(raw);
      const summary = normalized === null ? null : this.input.codec.truncateSummary(normalized, this.input.config.maxSummaryChars);
      this.#nativePrefix = this.input.codec.buildPromptPrefix(summary);
      // Even NONE inherits the search's dependencies and actual output trace.
      this.#fragment = await this.engine().nativeRecallSummary(receipt, summary ?? "");
    }
    this.#active();
  }

  /** The Host revokes hook authority at dispatch completion. Final consumption
   * instead revalidates the inherited source closure and bound output receipt. */
  async currentInput(): Promise<ContextFragment> {
    if (this.#failure) throw this.#failure;
    check(this.#terminal, "native_memory_recall_incomplete");
    await this.input.assertCurrent();
    check(this.#fragment, "native_memory_recall_incomplete");
    return this.input.authority.nativeMemoryInput(this.#fragment, this.#nativePrefix);
  }

  prompt(): string {
    if (this.#failure) throw this.#failure;
    check(this.#terminal, "native_memory_recall_incomplete");
    return this.#nativePrefix ? `${this.#nativePrefix}\n\n${this.input.request.prompt}` : this.input.request.prompt;
  }
}
