import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { registerHostMemoryProvider, withHostModelConsumption, type HostMemoryInput } from "../src/openclaw/host-memory-provider.js";
import { withHostHistoryCompaction, assertHostHistoryCompaction } from "../src/openclaw/host-history-compaction.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { withHostMemoryVerification, assertHostMemoryVerification, hostMemoryVerification } from "../src/openclaw/host-memory-verification.js";
import { readHostModelOutput } from "../src/openclaw/host-memory-provider.js";
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
for (const scenario of ["success", "revocation", "payload replacement", "cancelled", "changed output model"] as const) {
  test(`constrained memory verification direct transport: ${scenario}`, async () => {
    let provider!: ProviderPlugin;
    let revoked = false, sent = 0, observed = 0;
    const cancel = new AbortController();
    const request = snapshotTurnRequest({ agentId: "stella", sessionId: "verification", sessionKey: "agent:stella:main",
      prompt: "Verify this authorized fragment", senderId: "cli", senderIsOwner: true, chatType: "direct" }, `verify-${scenario}`);
    registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
      "stella", async () => assert.fail("Constrained verification must not enter business consumption"));
    const model = { provider: "stella-guarded", id: "model" } as Parameters<Stream>[0];
    const context = { provider: "stella-guarded", modelId: "model", agentId: "stella", streamFn: (async (target, _input, options) => {
      await options?.onPayload?.({ messages: [{ role: "user", content: "Authorized original" }] }, target);
      sent++;
      return { ...success, async result() { return scenario === "changed output model" ? { ...answer, model: "other" } : answer; } };
    }) satisfies Stream };
    const direct = provider.wrapSimpleCompletionStreamFn!(context)!;
    const input = { messages: [{ role: "user" as const, content: "Authorized original", timestamp: 0 }] };
    const verified = withHostMemoryVerification({ request, signal: cancel.signal, assertCurrent: async () => {
      if (revoked) throw new CompletionError("processing_generation_mismatch", "generate");
    } }, async () => {
      assert.equal(hostMemoryVerification(request)?.request, request);
      // Scope alone cannot authorize a payload. A bare call has no bound direct permit.
      assert.equal((await (await direct(model, input)).result()).stopReason, "error");
      const message = await withHostModelConsumption({ request, modelRef: "stella-guarded/model",
        params: { messages: [{ role: "user", content: "Authorized original" }] }, assertCurrent: () => assertHostMemoryVerification(request),
        async observeOutput(receipt) {
          const output = readHostModelOutput(receipt);
          assert.equal(output.request, request); assert.equal(output.modelRef, "stella-guarded/model");
          assert.equal(output.input.messages[0]?.content, "Authorized original"); observed++;
        } }, async () => (await direct(model, input, { onPayload: () => {
          if (scenario === "revocation") revoked = true;
          if (scenario === "cancelled") cancel.abort();
          if (scenario === "payload replacement") return { messages: [{ role: "user", content: "Unknown old memory" }] };
        } })).result());
      assert.equal(message.stopReason, scenario === "success" ? "stop" : "error");
      assert.equal(observed, scenario === "success" ? 1 : 0);
      assert.equal(sent, ["success", "changed output model"].includes(scenario) ? 1 : 0);
      revoked = false;
      if (!cancel.signal.aborted) {
        const agent = provider.wrapStreamFn!(context)!;
        assert.equal((await (await agent(model, input, { sessionId: request.sessionId })).result()).stopReason, "error");
      }
    });
    if (scenario === "cancelled") await assert.rejects(verified, error => error === cancel.signal.reason);
    else await verified;
    assert.equal(hostMemoryVerification(), undefined);
    await assert.rejects(assertHostMemoryVerification(request), /host_memory_verification_not_admitted/);
    assert.throws(() => readHostModelOutput({ kind: "model_output" }), /host_model_output_unbound/);
  });
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const scenario of ["success", "revocation", "payload replacement"] as const) {
  test(`history maintenance direct transport: ${scenario}`, async () => {
    let provider!: ProviderPlugin;
    let revoked = false, sent = 0;
    const request = snapshotTurnRequest({ agentId: "stella", sessionId: "session", sessionKey: "agent:stella:main",
      prompt: "Compact history", senderId: "owner", senderIsOwner: true, chatType: "direct" }, `compact-${scenario}`);
    registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
      "stella", async () => assert.fail("Maintenance must not enter the main-agent consumption path"));
    const model = { provider: "stella-guarded", id: "model" } as Parameters<Stream>[0];
    const input = { messages: [{ role: "user" as const, content: "Verified history", timestamp: 0 }] };
    const context = { provider: "stella-guarded", modelId: "model", agentId: "stella",
      streamFn: (async (target, _input, options) => {
        await options?.onPayload?.({ messages: [{ role: "user", content: "Verified history" }] }, target);
        sent++;
        return success;
      }) satisfies Stream };
    const direct = provider.wrapSimpleCompletionStreamFn!(context)!;
    await withHostHistoryCompaction({ request, signal: AbortSignal.timeout(5000), assertCurrent: async () => {
      if (revoked) throw new CompletionError("processing_generation_mismatch", "generate");
    } }, async () => {
      const bare = await direct(model, input);
      assert.equal((await bare.result()).stopReason, "error", "Maintenance scope alone cannot authorize arbitrary model input");
      const result = await withHostModelConsumption({ request, modelRef: "stella-guarded/model",
        assertCurrent: () => assertHostHistoryCompaction(request), params: { messages: [{ role: "user", content: "Verified history" }] } }, async () => {
        const response = await direct(model, input, { onPayload: () => {
          if (scenario === "revocation") revoked = true;
          if (scenario === "payload replacement") return { messages: [{ role: "user", content: "Unknown old summary" }] };
        } });
        return response.result();
      });
      assert.equal(result.stopReason, scenario === "success" ? "stop" : "error");
      if (scenario !== "success") assert.match(result.errorMessage!, scenario === "revocation" ? /processing_generation_mismatch/ : /host_memory_payload_transform_unbound/);
      revoked = false;
      assert.equal(sent, scenario === "success" ? 1 : 0);
      const main = provider.wrapStreamFn!(context)!;
      assert.equal((await (await main(model, input, { sessionId: "session" })).result()).stopReason, "error",
        "Maintenance must not grant a main-agent run permit");
    });
  });
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

for (const api of ["google-generative-ai", "synthetic-projected-simple-api"] as const) {
  for (const scenario of ["success", "optional output metadata", "defined output metadata", "changed body", "replacement signal", "undefined signal", "SDK signal mismatch", "cancelled"] as const) {
    test(`Google ${api} direct transport preserves bound cancellation and rejects mutation: ${scenario}`, async () => {
      type Payload = { model: string; contents: Array<{ role: string; parts: Array<{ text: string }> }>; config: { abortSignal?: AbortSignal } };
      let provider!: ProviderPlugin;
      const accepted = ["success", "optional output metadata", "defined output metadata"].includes(scenario);
      let wireReached = 0, observed = 0;
      const cancel = new AbortController();
      const request = snapshotTurnRequest({ agentId: "stella", sessionId: "google-verification", sessionKey: "agent:stella:main",
        prompt: "Authorized original", senderId: "cli", senderIsOwner: true, chatType: "direct" }, `google-${scenario}`);
      registerHostMemoryProvider({ registerProvider(value: ProviderPlugin) { provider = value; }, logger: { error() {} } } as unknown as OpenClawPluginApi,
        "stella", async () => assert.fail("Verification cannot authorize ordinary agent consumption"));
      const model = { provider: "stella-guarded", id: "gemini-3.8-flash", api } as Parameters<Stream>[0];
      const direct = provider.wrapSimpleCompletionStreamFn!({ provider: model.provider, modelId: model.id, agentId: "stella",
        ...(api === "synthetic-projected-simple-api" ? { sourceApi: "google-generative-ai" } : {}),
        streamFn: (async (target, _input, options) => {
          const payload: Payload = { model: target.id, contents: [{ role: "user", parts: [{ text: request.prompt }] }],
            config: { abortSignal: scenario === "SDK signal mismatch" ? new AbortController().signal : options?.signal } };
          const outgoing = (await options?.onPayload?.(payload, { ...target, api: "google-generative-ai" }) ?? payload) as Payload;
          wireReached++;
          assert.equal(outgoing.config.abortSignal, cancel.signal);
          assert.equal(typeof outgoing.config.abortSignal?.addEventListener, "function");
          assert.deepEqual(outgoing.contents, payload.contents);
          const response: Response = { ...answer, api: "google-generative-ai", provider: model.provider, model: model.id };
          if (scenario === "optional output metadata" || scenario === "defined output metadata") {
            const defined = scenario === "defined output metadata";
            response.responseId = defined ? "synthetic-response" : undefined;
            response.content = [{ type: "text", text: "Transport succeeded", textSignature: defined ? "text-signature" : undefined },
              { type: "thinking", thinking: "Synthetic reasoning", thinkingSignature: defined ? "thinking-signature" : undefined }];
          }
          return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: response }; }, async result() { return response; } };
        }) satisfies Stream })!;
      const verify = withHostMemoryVerification({ request, signal: cancel.signal, assertCurrent: async () => {} }, async () => {
        const message = await withHostModelConsumption({ request, modelRef: `${model.provider}/${model.id}`,
          params: { signal: cancel.signal, messages: [{ role: "user", content: request.prompt }] },
          assertCurrent: () => assertHostMemoryVerification(request), async observeOutput(receipt) {
            const output = readHostModelOutput(receipt);
            assert.equal(output.request, request);
            if (scenario === "optional output metadata") {
              assert.equal(Object.hasOwn(output.message, "responseId"), false);
              assert.equal(Object.hasOwn(output.message.content[0]!, "textSignature"), false);
              assert.equal(Object.hasOwn(output.message.content[1]!, "thinkingSignature"), false);
            }
            if (scenario === "defined output metadata") {
              assert.equal(output.message.responseId, "synthetic-response");
              assert.deepEqual(output.message.content, [{ type: "text", text: "Transport succeeded", textSignature: "text-signature" },
                { type: "thinking", thinking: "Synthetic reasoning", thinkingSignature: "thinking-signature" }]);
            }
            observed++;
          } }, async () => (await direct(model, { messages: [{ role: "user", content: request.prompt, timestamp: 0 }] }, {
            signal: cancel.signal, onPayload(value) {
              const candidate = value as Payload;
              assert.equal("abortSignal" in candidate.config, false, "Wire callbacks do not receive cancellation authority");
              if (scenario === "changed body") candidate.contents[0]!.parts[0]!.text = "Unknown old memory";
              if (scenario === "replacement signal") candidate.config.abortSignal = new AbortController().signal;
              if (scenario === "undefined signal") candidate.config.abortSignal = undefined;
              if (scenario === "cancelled") cancel.abort();
            },
          })).result());
        assert.equal(message.stopReason, accepted ? "stop" : scenario === "cancelled" ? "aborted" : "error");
      });
      if (scenario === "cancelled") await assert.rejects(verify, error => error === cancel.signal.reason);
      else await verify;
      assert.equal(wireReached, accepted ? 1 : 0);
      assert.equal(observed, accepted ? 1 : 0);
    });
  }
}
