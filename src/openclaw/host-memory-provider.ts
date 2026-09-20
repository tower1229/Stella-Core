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
/** Model-visible data only. Tool execution callbacks never confer input authority. */
export type HostMemoryInput = {
  readonly systemPrompt: string;
  readonly messages: Parameters<Stream>[1]["messages"];
  readonly tools: Array<Pick<NonNullable<Parameters<Stream>[1]["tools"]>[number], "name" | "description" | "parameters">>;
};
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
// A Host retry may reload the plugin registration, but cannot acquire fresh
// authority for a request whose consumption already failed. Weak keys follow
// the completion request's lifetime rather than retaining session contents.
const rejectedRequests = new WeakMap<BoundTurnRequest, string>();
export const isHostConsumptionRevalidation = (): boolean => revalidation.getStore() === true;

function failureCategory(error: unknown): string {
  return error instanceof CompletionError || error instanceof CatalogError || error instanceof ConsciousnessLoadError || error instanceof RuntimeProfileError
    ? error.category : "host_memory_consumption_failed";
}

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
  assertConsumption: (request: BoundTurnRequest, modelRef: string, input: HostMemoryInput) => Promise<void>,
): void {
  const wrap = (context: ProviderWrapStreamFnContext, kind: "agent" | "direct"): Stream => {
    const transport = context.streamFn;
    return async (...args: Parameters<Stream>) => {
      let boundRequest: BoundTurnRequest | undefined;
      const reject = (error: unknown): string => {
        const category = boundRequest && rejectedRequests.get(boundRequest) || failureCategory(error);
        if (boundRequest) rejectedRequests.set(boundRequest, category);
        api.logger.error(`Stella host memory: ${category}`);
        return category;
      };
      try {
        if (!transport) throw new CompletionError("host_memory_transport_unavailable", "generate");
        if ((kind === "agent" || context.agentId !== undefined) && context.agentId !== agentId) throw new CompletionError("host_memory_agent_mismatch", "generate");
        const request = readActiveCompletionRequest(agentId);
        const assertActive = () => {
          const priorFailure = rejectedRequests.get(request);
          if (priorFailure) throw new CompletionError(priorFailure, "generate");
          readActiveCompletionRequest(agentId, request.sessionId, request.sessionKey);
          args[2]?.signal?.throwIfAborted();
        };
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
        let assertCurrent: () => Promise<void>;
        if (kind === "direct") {
          if (!direct || !direct.active || direct.consumed || direct.modelRef !== modelRef || direct.request !== request) {
            throw new CompletionError("host_memory_call_binding_mismatch", "generate");
          }
          boundRequest = request;
          assertActive();
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
          assertCurrent = async () => {
            await direct.assertCurrent();
            if (!direct.active || directCalls.getStore() !== direct) throw new CompletionError("host_memory_call_expired", "generate");
          };
        } else {
          if (options?.sessionId !== request.sessionId) throw new CompletionError("host_memory_session_mismatch", "generate");
          boundRequest = request;
          assertActive();
          // The verifier gets the complete SDK Context snapshot, not merely
          // the run's source state. Keep its copy separate from transport so an
          // asynchronous verifier cannot mutate the bytes it is authorizing.
          const consumption: HostMemoryInput = structuredClone({
            systemPrompt: snapshot.systemPrompt ?? "", messages: snapshot.messages,
            tools: (snapshot.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })),
          });
          assertCurrent = () => revalidation.run(true, () => assertConsumption(request, modelRef, structuredClone(consumption)));
        }
        await assertCurrent();
        // Revocation/cancellation during an asynchronous check cannot authorize a
        // late transport call. Each continuation obtains a fresh validation.
        assertActive();
        const onPayload = options?.onPayload;
        return await transport(target, snapshot, { ...options, async onPayload(payload, payloadModel) {
          // The pinned Host applies extra_body through this callback *after*
          // provider Context validation. Observation is allowed; an unbound
          // payload replacement must never acquire the Context's authority.
          try {
            assertActive();
            const candidate = structuredClone(payload);
            const before = JSON.stringify(candidate);
            const replacement = await onPayload?.(candidate, { ...payloadModel });
            assertActive();
            const outgoing = structuredClone(replacement === undefined ? candidate : replacement);
            if (JSON.stringify(outgoing) !== before) throw new CompletionError("host_memory_payload_transform_unbound", "generate");
            await assertCurrent();
            assertActive();
            return outgoing;
          } catch (error) {
            // Native streams invoke this after transport() has returned. Keep
            // the failure observable and latched independently of that promise.
            throw new CompletionError(reject(error), "generate");
          }
        } });
      } catch (error) {
        return rejectedStream(args[0], reject(error), args[2]?.signal?.aborted === true);
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
