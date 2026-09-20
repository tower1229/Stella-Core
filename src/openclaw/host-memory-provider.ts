import type { OpenClawPluginApi, ProviderPlugin, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { CompletionError, readActiveCompletionRequest } from "./completion.js";
import { canonicalJson } from "../canghai/content-version.js";
import { ConsciousnessLoadError } from "../canghai/manifest.js";
import { RuntimeProfileError } from "../canghai/runtime-profile.js";
import { CatalogError } from "../canghai/catalog-reader.js";
import type { BoundTurnRequest } from "./turn-request.js";
import { AsyncLocalStorage } from "node:async_hooks";

type Stream = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;
type StreamResult = Awaited<ReturnType<Stream>>;
type AssistantMessage = Awaited<ReturnType<StreamResult["result"]>>;
function rejectedStream(model: Parameters<Stream>[0], category: string, aborted = false): StreamResult {
  const error: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: aborted ? "aborted" : "error", errorMessage: `Stella memory consumption blocked: ${category}`, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return { async *[Symbol.asyncIterator]() { yield { type: "error", reason: aborted ? "aborted" : "error", error }; }, async result() { return error; } };
}

export const HOST_MEMORY_PROVIDER = "stella-guarded";
const directCalls = new AsyncLocalStorage<{
  request: BoundTurnRequest; modelRef: string; active: boolean; consumed: boolean; payload: string; assertCurrent: () => Promise<void>;
}>();
const revalidation = new AsyncLocalStorage<boolean>();
export const isHostConsumptionRevalidation = (): boolean => revalidation.getStore() === true;

/** A Core-owned call, not a serialized permission or a Host-supplied flag. */
export async function withHostModelConsumption<T>(
  input: { request: BoundTurnRequest; modelRef: string; assertCurrent: () => Promise<void>; params: Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0] },
  complete: () => Promise<T>,
): Promise<T> {
  // Match the pinned Host simple-completion conversion: trimmed system
  // segments, unchanged user/assistant text, no tools or multimodal content.
  const payload = canonicalJson({
    systemPrompt: [input.params.systemPrompt, ...input.params.messages.filter(m => m.role === "system").map(m => m.content)]
      .map(text => text?.trim()).filter(Boolean).join("\n\n"),
    messages: input.params.messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })),
  });
  const scope = { ...input, active: true, consumed: false, payload };
  try { return await directCalls.run(scope, complete); }
  finally { scope.active = false; }
}

/** Explicitly selected transport boundary; never replaces another provider. */
export function registerHostMemoryProvider(
  api: OpenClawPluginApi,
  agentId: string,
  assertConsumption: (request: BoundTurnRequest, modelRef: string) => Promise<void>,
): void {
  const wrap = (context: ProviderWrapStreamFnContext, kind: "agent" | "direct"): Stream => {
    const transport = context.streamFn;
    return async (...args: Parameters<Stream>) => {
      try {
        if (!transport) throw new CompletionError("host_memory_transport_unavailable", "generate");
        if ((kind === "agent" || context.agentId !== undefined) && context.agentId !== agentId) throw new CompletionError("host_memory_agent_mismatch", "generate");
        const request = readActiveCompletionRequest(agentId);
        const [model, input, options] = args;
        const snapshot = { ...input, messages: structuredClone(input.messages),
          ...(input.tools ? { tools: input.tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : {}),
        };
        const target = { ...model };
        if (target.provider !== HOST_MEMORY_PROVIDER || target.id !== context.modelId) {
          throw new CompletionError("host_memory_model_mismatch", "generate");
        }
        options?.signal?.throwIfAborted();
        const modelRef = `${target.provider}/${target.id}`;
        const direct = directCalls.getStore();
        if (kind === "direct") {
          if (!direct || !direct.active || direct.consumed || direct.modelRef !== modelRef || direct.request !== request) {
            throw new CompletionError("host_memory_call_binding_mismatch", "generate");
          }
          direct.consumed = true;
          const messages = snapshot.messages.map(message => {
            if (message.role === "user" && typeof message.content === "string") return { role: message.role, content: message.content };
            if (message.role === "assistant" && message.content.length === 1 && message.content[0]?.type === "text") {
              return { role: message.role, content: message.content[0].text };
            }
            throw new CompletionError("host_memory_payload_mismatch", "generate");
          });
          if (snapshot.tools?.length || canonicalJson({ systemPrompt: snapshot.systemPrompt ?? "", messages }) !== direct.payload) {
            throw new CompletionError("host_memory_payload_mismatch", "generate");
          }
          await direct.assertCurrent();
          if (!direct.active || directCalls.getStore() !== direct) throw new CompletionError("host_memory_call_expired", "generate");
        } else {
          if (options?.sessionId !== request.sessionId) throw new CompletionError("host_memory_session_mismatch", "generate");
          await revalidation.run(true, () => assertConsumption(request, modelRef));
        }
        // Revocation/cancellation during an asynchronous check cannot authorize a
        // late transport call. Each continuation obtains a fresh validation.
        readActiveCompletionRequest(agentId, request.sessionId, request.sessionKey);
        options?.signal?.throwIfAborted();
        return await transport(target, snapshot, options);
      } catch (error) {
        const category = error instanceof CompletionError || error instanceof CatalogError || error instanceof ConsciousnessLoadError || error instanceof RuntimeProfileError ? error.category : "host_memory_consumption_failed";
        api.logger.error(`Stella host memory: ${category}`);
        return rejectedStream(args[0], category, args[2]?.signal?.aborted === true);
      }
    };
  };
  api.registerProvider({
    id: HOST_MEMORY_PROVIDER,
    label: "Stella Core consumption gate",
    auth: [],
    wrapStreamFn: context => wrap(context, "agent"),
    wrapSimpleCompletionStreamFn: context => wrap(context, "direct"),
  });
}
