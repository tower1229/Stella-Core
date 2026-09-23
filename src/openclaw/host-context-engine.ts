import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import path from "node:path";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { BoundTurnRequest } from "./turn-request.js";
import type { FragmentToolResultReceipt } from "./fragment-read-tool.js";
import type { HostMemoryInput, HostModelOutputReceipt } from "./host-memory-provider.js";
import { HostContextAuthority, type ContextFragment } from "./host-context-authority.js";
import type { CommitHostContextTurn } from "./host-context-turn-store.js";
import { projectManagedMessages } from "./host-context-prompt.js";
import { hasCompletionPersistencePermit } from "./completion.js";

// The slot is also a plugin activation id in the original Host. A separate
// engine alias loads at startup but cannot bind other Agents' prepared runtime.
export const STELLA_CONTEXT_ENGINE = "stella-core";
const ENGINE_INFO = Object.freeze({ id: STELLA_CONTEXT_ENGINE, name: "Stella managed context", version: "1", ownsCompaction: true });
type Messages = Parameters<ContextEngine["assemble"]>[0]["messages"];
type Sealed = Awaited<ReturnType<HostContextAuthority["seal"]>>;
type FactoryContext = Parameters<Parameters<OpenClawPluginApi["registerContextEngine"]>[1]>[0];
function check(value: unknown, category: string): asserts value {
  if (!value) throw new CatalogError(category);
}

function assertCompleteToolBatch(input: HostMemoryInput): void {
  let index = input.messages.length - 1;
  while (index >= 0 && input.messages[index]!.role !== "assistant") index--;
  const assistant = input.messages[index];
  if (assistant?.role !== "assistant") return;
  const calls = assistant.content.filter(part => part.type === "toolCall");
  const results = input.messages.slice(index + 1);
  check(calls.length === results.length && calls.every((call, position) => {
    const result = results[position];
    return result?.role === "toolResult" && result.toolCallId === call.id;
  }), "host_context_tool_batch_incomplete");
}

/** The original 2026.8.2 legacy engine is pass-through plus the public runtime
 * compaction delegate. Keep its id and delegate identity: the Host uses both
 * to retain native prompt preparation and compaction ownership. */
function legacyContextEngine(): ContextEngine {
  return {
    info: { id: "legacy", name: "Legacy Context Engine", version: "1.0.0",
      acceptedHostParams: ["sessionKey", "prompt", "runtimeSettings", "sessionTarget", "runtimeContext", "abortSignal"] },
    async ingest() { return { ingested: false }; },
    async assemble(params) { return { messages: params.messages, estimatedTokens: 0 }; },
    compact: delegateCompactionToRuntime,
  };
}

function selectsTarget(context: FactoryContext, targetAgentId: string): boolean {
  const cfg = context.config;
  check(cfg && context.agentDir && path.isAbsolute(context.agentDir) && context.workspaceDir &&
    path.isAbsolute(context.workspaceDir), "host_context_agent_scope_required");
  const agents = listAgentIds(cfg);
  check(agents.includes(targetAgentId), "host_context_target_agent_missing");
  const matches = agents.filter(agentId => path.resolve(resolveAgentDir(cfg, agentId)) === path.resolve(context.agentDir!));
  check(matches.length === 1 && path.resolve(resolveAgentWorkspaceDir(cfg, matches[0]!)) === path.resolve(context.workspaceDir),
    "host_context_agent_scope_mismatch");
  return matches[0] === targetAgentId;
}

/** Build a gateway configuration without mutating the input. The slot is
 * global; callers must persist/reload it and provide Agent dispatch in the
 * registered factory. A per-call override is not a Host selection guarantee. */
export function withStellaContextEngine(config: OpenClawConfig): OpenClawConfig {
  const previous = config.plugins?.slots?.contextEngine;
  check(previous === undefined || previous === "legacy" || previous === STELLA_CONTEXT_ENGINE,
    "host_context_existing_engine_migration_required");
  return { ...config, plugins: { ...config.plugins, slots: { ...config.plugins?.slots, contextEngine: STELLA_CONTEXT_ENGINE } } };
}

/** Request-local context lifecycle. Raw Host messages go to the archive port;
 * only independently source-bound fragments enter model context. Archive and
 * summary ports must finish their existing durability transaction before return. */
export class ManagedHostContextEngine implements ContextEngine {
  readonly info = ENGINE_INFO;
  readonly #system: ContextFragment[];
  #history: ContextFragment[];
  #sealed?: Sealed;
  #boundaryProjected = false;
  #failure?: unknown;
  #busy = false;
  #toolQueue: Promise<void> = Promise.resolve();
  #pendingToolResults = 0;
  #releasedToCompletion = false;
  #completionPersisted = false;
  constructor(private readonly request: BoundTurnRequest, private readonly authority: HostContextAuthority,
    private readonly ports: {
      system: readonly ContextFragment[];
      history: readonly ContextFragment[];
      hostTimezone?: string;
      archive(messages: Messages): Promise<void>;
      persistSummary(summary: Sealed): Promise<void>;
      complete: Parameters<HostContextAuthority["summarize"]>[1];
    }) {
    this.#system = [...ports.system];
    this.#history = [...ports.history];
  }

  #scope(params: { sessionId: string; sessionKey?: string }): void {
    if (this.#failure) throw this.#failure;
    check(params.sessionId === this.request.sessionId && params.sessionKey === this.request.sessionKey, "host_context_session_mismatch");
  }

  async #operation<T>(run: () => Promise<T>, persistence = false): Promise<T> {
    check(!this.#releasedToCompletion || persistence, "host_context_model_phase_ended");
    let ownsOperation = false;
    try {
      check(!this.#busy, "host_context_operation_in_progress");
      if (this.#failure) throw this.#failure;
      this.#busy = true;
      ownsOperation = true;
      const result = await run();
      if (this.#failure) throw this.#failure;
      return result;
    } catch (error) {
      this.#failure = error instanceof Error ? error : new CatalogError("host_context_operation_failed");
      this.#sealed = undefined;
      throw this.#failure;
    } finally { if (ownsOperation) this.#busy = false; }
  }

  async ingest(params: Parameters<ContextEngine["ingest"]>[0]) {
    params = { ...params };
    const snapshot = structuredClone(params.message);
    return this.#operation(async () => {
      this.#scope(params);
      await this.ports.archive([snapshot]);
      return { ingested: true };
    });
  }

  async assemble(params: Parameters<ContextEngine["assemble"]>[0]): Promise<{ messages: HostMemoryInput["messages"]; estimatedTokens: number }> {
    params = { ...params };
    const snapshot = structuredClone(params.messages);
    const tools = new Set(params.availableTools);
    return this.#operation(async () => {
      this.#scope(params);
      // The original Host invokes assemble again from its tool-loop transform
      // without prompt or availableTools, including before the first call. It
      // already contains the current user message and must not append it twice.
      if (params.prompt === undefined) {
        const sealed = this.#sealed;
        check(sealed && this.#pendingToolResults === 0, "host_context_assembly_required");
        const messages = snapshot.filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
        check(messages.length === snapshot.length, "host_context_message_role_forbidden");
        const input = { ...sealed.input, messages };
        assertCompleteToolBatch(input);
        if (this.ports.hostTimezone) {
          if (this.#boundaryProjected) {
            await this.authority.assertConsumption(sealed.consumption, projectManagedMessages(input, this.ports.hostTimezone, this.request.hostMessageTimestamp === undefined ? undefined
              : { text: this.request.prompt, timestamp: this.request.hostMessageTimestamp }));
          } else {
            this.#sealed = await this.authority.projectBoundary(sealed.consumption, input, this.ports.hostTimezone);
            this.#boundaryProjected = true;
          }
        } else await this.authority.assertConsumption(sealed.consumption, input);
        await this.ports.archive(snapshot);
        const estimatedTokens = Buffer.byteLength(JSON.stringify(input));
        check(params.tokenBudget !== undefined && estimatedTokens <= params.tokenBudget, "host_context_budget_exhausted");
        return { messages: structuredClone(messages), estimatedTokens };
      }
      this.#sealed = undefined;
      this.#boundaryProjected = false;
      check(params.prompt === this.request.prompt, "host_context_prompt_changed");
      await this.ports.archive(snapshot);
      const sealed = await this.authority.seal({ system: this.#system, messages: [...this.#history, this.authority.currentInput()]
        .map(fragment => ({ role: "user", fragment })) });
      // Host assembles history before applying before_prompt_build.toolsAllow.
      // Require our tools to exist here; seal still binds the exact final tool
      // definitions, so an extra surviving tool fails at the provider boundary.
      check(sealed.input.tools.every(tool => tools.has(tool.name)), "host_context_tool_surface_changed");
      // Conservatively bound UTF-8 bytes; never prune history to conceal overflow.
      const estimatedTokens = Buffer.byteLength(JSON.stringify(sealed.input));
      check(params.tokenBudget !== undefined && estimatedTokens <= params.tokenBudget, "host_context_budget_exhausted");
      await this.authority.assertConsumption(sealed.consumption, sealed.input);
      if (this.#failure) throw this.#failure;
      this.#sealed = sealed;
      // The original Host appends the current prompt after assemble. Its final
      // user message is already included in the sealed consumption expectation.
      return { messages: structuredClone(sealed.input.messages.slice(0, -1)), estimatedTokens };
    });
  }

  async compact(params: Parameters<ContextEngine["compact"]>[0]) {
    params = { ...params };
    return this.#operation(async () => {
      this.#scope(params);
      params.abortSignal?.throwIfAborted();
      check(this.#pendingToolResults === 0, "host_context_tool_batch_incomplete");
      const sealed = this.#sealed;
      if (sealed) assertCompleteToolBatch(sealed.input);
      const history = sealed ? [await this.authority.conversation(sealed.consumption)] : this.#history;
      check(history.length > 0, "host_context_summary_input_required");
      const summary = await this.authority.summarize(history, this.ports.complete);
      params.abortSignal?.throwIfAborted();
      const sealedSummary = await this.authority.seal({ system: this.#system, messages: [{ role: "user", fragment: summary }] });
      await this.ports.persistSummary({ input: structuredClone(sealedSummary.input), consumption: sealedSummary.consumption });
      params.abortSignal?.throwIfAborted();
      await this.authority.assertConsumption(sealedSummary.consumption, sealedSummary.input);
      if (this.#failure) throw this.#failure;
      this.#history = [summary];
      this.#sealed = undefined;
      return { ok: true, compacted: true };
    });
  }

  async observeOutput(receipt: HostModelOutputReceipt): Promise<void> {
    return this.#operation(async () => {
      check(this.#sealed, "host_context_assembly_required");
      this.#sealed = await this.authority.extendAssistant(this.#sealed.consumption, receipt);
    });
  }

  async observeToolResult(receipt: FragmentToolResultReceipt): Promise<void> {
    this.#pendingToolResults++;
    const operation = this.#toolQueue.then(() => this.#operation(async () => {
      check(this.#sealed, "host_context_assembly_required");
      this.#sealed = await this.authority.extendToolResult(this.#sealed.consumption, receipt);
    }));
    // Serialize callbacks from parallel read-only Host tools; failure remains
    // latched in the engine and is returned to every affected caller.
    this.#toolQueue = operation.then(() => undefined, () => undefined);
    try { await operation; } finally { this.#pendingToolResults--; }
  }

  /** Final provider gate also catches Host's fallback after engine exceptions. */
  async assertConsumption(input: HostMemoryInput): Promise<void> {
    check(!this.#releasedToCompletion, "host_context_model_phase_ended");
    try {
      if (this.#failure) throw this.#failure;
      const sealed = this.#sealed;
      check(sealed && !this.#busy && this.#pendingToolResults === 0, "host_context_assembly_required");
      assertCompleteToolBatch(input);
      await this.authority.assertConsumption(sealed.consumption, input);
      if (this.#failure) throw this.#failure;
      check(!this.#releasedToCompletion, "host_context_model_phase_ended");
      check(this.#sealed === sealed && !this.#busy && this.#pendingToolResults === 0, "host_context_assembly_changed");
    } catch (error) {
      this.#failure = error instanceof Error ? error : new CatalogError("host_context_operation_failed");
      this.#sealed = undefined;
      throw this.#failure;
    }
  }

  /** Host disposal ends model execution. Core may retain this verified result
   * solely until its existing completion coordinator persists it or settles.
   * This does not manufacture a Host commitTurn acknowledgement. */
  releaseToCompletion(): void {
    this.#releasedToCompletion = true;
    if (this.#busy || this.#pendingToolResults !== 0) {
      this.#failure = new CatalogError("host_context_operation_in_progress");
      this.#sealed = undefined;
      this.authority.close();
      throw this.#failure;
    }
  }

  async persistCompletedHistory<T>(persist: (context: Sealed) => Promise<T>): Promise<T> {
    const assertPermit = () => check(hasCompletionPersistencePermit(this.request.runId), "host_context_persistence_permit_required");
    assertPermit();
    check(this.#releasedToCompletion && !this.#completionPersisted, "host_context_completion_phase_invalid");
    return this.#operation(async () => {
      const sealed = this.#sealed;
      check(sealed && this.#pendingToolResults === 0, "host_context_assembly_required");
      const terminal = sealed.input.messages.at(-1);
      check(terminal?.role === "assistant" && terminal.stopReason === "stop" &&
        terminal.content.some(part => part.type === "text" && part.text.trim()), "host_context_final_output_required");
      assertCompleteToolBatch(sealed.input);
      await this.authority.assertConsumption(sealed.consumption, sealed.input);
      assertPermit();
      const result = await persist({ input: structuredClone(sealed.input), consumption: sealed.consumption });
      assertPermit();
      await this.authority.assertConsumption(sealed.consumption, sealed.input);
      assertPermit();
      this.#completionPersisted = true;
      return result;
    }, true);
  }

  async dispose(): Promise<void> {
    this.#failure = new CatalogError("host_context_expired");
    this.#sealed = undefined;
    this.authority.close();
  }
}

/** Host creates the engine before prompt preparation. Bind the request now,
 * resolve its prepared engine at the first lifecycle operation, and keep that
 * same instance through disposal. Missing preparation remains an error. */
export function registerManagedHostContextEngine(api: OpenClawPluginApi,
  bindRequest: () => { resolve(): ManagedHostContextEngine; commitTurn?: CommitHostContextTurn; retainForCompletion?: true },
  scope?: { targetAgentId: string }): void {
  api.registerContextEngine(STELLA_CONTEXT_ENGINE, context => {
    if (scope && !selectsTarget(context, scope.targetAgentId)) return legacyContextEngine();
    const request = bindRequest();
    let engine: ManagedHostContextEngine | undefined;
    let disposed = false;
    const current = () => {
      check(!disposed, "host_context_expired");
      engine ??= request.resolve();
      check(!disposed, "host_context_expired");
      return engine;
    };
    return {
      info: request.commitTurn ? { ...ENGINE_INFO, transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1",
      } } : ENGINE_INFO,
      ...(request.commitTurn ? { commitTurn: ((params) => {
        check(!disposed, "host_context_expired");
        return request.commitTurn!(params);
      }) satisfies CommitHostContextTurn } : {}),
      ingest: params => current().ingest(params),
      assemble: params => current().assemble(params),
      compact: params => current().compact(params),
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (request.retainForCompletion) engine?.releaseToCompletion();
        else await engine?.dispose();
      },
    };
  });
}
