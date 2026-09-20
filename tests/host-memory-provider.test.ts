import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { registerHostMemoryProvider, type HostMemoryInput } from "../src/openclaw/host-memory-provider.js";
import { CompletionError, completionDraftHash, coordinateCompletion } from "../src/openclaw/completion.js";

type Stream = NonNullable<ReturnType<NonNullable<ProviderPlugin["wrapStreamFn"]>>>;
type Response = Awaited<ReturnType<Awaited<ReturnType<Stream>>["result"]>>;
const answer: Response = {
  role: "assistant", content: [{ type: "text", text: "Transport succeeded" }],
  api: "openai-completions", provider: "stella-guarded", model: "model", stopReason: "stop", timestamp: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const success: Awaited<ReturnType<Stream>> = {
  async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: answer }; },
  async result() { return answer; },
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const scenario of ["reject unbound input", "isolate input during asynchronous validation", "reject payload mutation", "reject payload replacement", "recheck after payload callback"] as const) {
 test(`provider must ${scenario} before transport`, async () => {
  let provider: ProviderPlugin | undefined;
  let transported = false;
  let transportStarts = 0;
  let sentInput: HostMemoryInput | undefined;
  let revoked = false;
  const input = {
    systemPrompt: "Unbound historical summary",
    messages: [{ role: "user" as const, content: "Current question", timestamp: 0 }],
    tools: [{ name: "read", description: "Read an authorized fragment", parameters: { type: "object" } }],
  };
  const api = { registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } };
  registerHostMemoryProvider(api as unknown as OpenClawPluginApi, "stella", async (_request, _model, snapshot) => {
    assert.deepEqual(snapshot, {
      systemPrompt: "Unbound historical summary",
      messages: [{ role: "user", content: "Current question", timestamp: 0 }],
      tools: [{ name: "read", description: "Read an authorized fragment", parameters: { type: "object" } }],
    });
    if (scenario === "reject unbound input") throw new CompletionError("host_memory_input_unbound", "generate");
    if (revoked) throw new CompletionError("processing_generation_mismatch", "generate");
    await Promise.resolve();
    input.messages[0]!.content = "Late Host replacement";
    input.tools[0]!.parameters.type = "string";
    // A verifier cannot change the already-snapshotted transport either.
    snapshot.messages.length = 0;
    snapshot.tools[0]!.description = "Verifier replacement";
  });
  const stream = provider?.wrapStreamFn?.({ provider: "stella-guarded", modelId: "model", agentId: "stella",
    streamFn: async (model, sent, options) => {
      transportStarts++;
      const payload = { model: "model", messages: structuredClone(sent.messages) };
      await options?.onPayload?.(payload, model);
      transported = true;
      sentInput = structuredClone({ systemPrompt: sent.systemPrompt ?? "", messages: sent.messages, tools: sent.tools ?? [] });
      return success;
    } });
  assert.ok(stream);
  await coordinateCompletion({ operationId: "input-proof", runId: "input-proof", timeoutMs: 1000,
    request: { agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main", prompt: "Current question", senderIsOwner: true, chatType: "direct" },
  }, {
    async generateDraft() {
      const result = await stream({ provider: "stella-guarded", id: "model" } as never, input, {
        sessionId: "session",
        async onPayload(payload) {
          await Promise.resolve();
          if (scenario === "reject payload mutation") Object.assign(payload!, { messages: [{ role: "user", content: "Old unbound understanding" }] });
          if (scenario === "reject payload replacement") return { messages: [{ role: "user", content: "Old unbound understanding" }] };
          if (scenario === "recheck after payload callback") revoked = true;
          return undefined;
        },
      });
      const response = await result.result();
      if (scenario === "reject unbound input") {
        assert.match(response.errorMessage!, /host_memory_input_unbound/);
        assert.equal(transported, false);
      } else if (scenario === "isolate input during asynchronous validation") {
        assert.equal(response.stopReason, "stop");
        assert.equal(transported, true);
        assert.deepEqual(sentInput, {
          systemPrompt: "Unbound historical summary",
          messages: [{ role: "user", content: "Current question", timestamp: 0 }],
          tools: [{ name: "read", description: "Read an authorized fragment", parameters: { type: "object" } }],
        });
      } else {
        assert.match(response.errorMessage!, scenario === "recheck after payload callback" ? /processing_generation_mismatch/ : /host_memory_payload_transform_unbound/);
        assert.equal(transported, false);
        input.messages[0]!.content = "Current question";
        input.tools[0]!.parameters.type = "object";
        revoked = false;
        const replay = await stream({ provider: "stella-guarded", id: "model" } as never, input, { sessionId: "session" });
        assert.equal((await replay.result()).stopReason, "error");
        assert.equal(transportStarts, 1, "A failed consumption cannot retry the transport in the same run");
      }
      return { draftId: "draft", text: "blocked", evidenceRef: "synthetic", responseKind: "answer", requiresCriticalPersistence: false };
    },
    async persist({ draft, operationId }) {
      return { schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
        draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind, evidenceRef: draft.evidenceRef,
        writeOperationIds: [], observedRevision: "a".repeat(40), generationId: "synthetic", persistenceStatus: "not_required", checkedAt: new Date().toISOString() };
    },
    async publishFinal() { return { deliveryId: "synthetic", status: "confirmed" }; },
  });
});

}

for (const scenario of ["concurrent failure", "cross-session child", "unlicensed direct child"] as const) {
  test(`consumption failure ownership: ${scenario}`, async () => {
    let provider: ProviderPlugin | undefined;
    let sent = 0;
    const entered = signal();
    const release = signal();
    registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
      "stella", async (_request, _model, input) => {
        if (input.systemPrompt === "slow") { entered.resolve(); await release.promise; }
        if (input.systemPrompt === "bad") throw new CompletionError("host_memory_input_unbound", "generate");
      });
    const context = { provider: "stella-guarded", modelId: "model", agentId: "stella",
      streamFn: () => { sent++; return success; } };
    const stream = provider!.wrapStreamFn!(context)!;
    const model = { provider: "stella-guarded", id: "model" } as Parameters<Stream>[0];
    await coordinateCompletion({ operationId: scenario, runId: scenario, timeoutMs: 1000,
      request: { agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main", prompt: "Question", senderIsOwner: true, chatType: "direct" },
    }, {
      async generateDraft() {
        if (scenario === "concurrent failure") {
          const pending = stream(model, { systemPrompt: "slow", messages: [] }, { sessionId: "session" });
          await entered.promise;
          const denied = await stream(model, { systemPrompt: "bad", messages: [] }, { sessionId: "session" });
          assert.match((await denied.result()).errorMessage!, /host_memory_input_unbound/);
          release.resolve();
          assert.equal((await (await pending).result()).stopReason, "error");
          assert.equal(sent, 0);
        } else {
          const denied = scenario === "cross-session child"
            ? await stream(model, { messages: [] }, { sessionId: "other-session" })
            : await provider!.wrapSimpleCompletionStreamFn!(context)!(model, { messages: [] });
          assert.match((await denied.result()).errorMessage!, scenario === "cross-session child" ? /host_memory_session_mismatch/ : /host_memory_call_binding_mismatch/);
          assert.equal((await (await stream(model, { messages: [] }, { sessionId: "session" })).result()).stopReason, "stop");
          assert.equal(sent, 1);
        }
        return { draftId: "draft", text: "Test finished", evidenceRef: "synthetic", responseKind: "answer", requiresCriticalPersistence: false };
      },
      async persist({ draft, operationId }) {
        return { schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
          draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind, evidenceRef: draft.evidenceRef,
          writeOperationIds: [], observedRevision: "a".repeat(40), generationId: "synthetic", persistenceStatus: "not_required", checkedAt: new Date().toISOString() };
      },
      async publishFinal() { return { deliveryId: "synthetic", status: "confirmed" }; },
    });
  });
}
