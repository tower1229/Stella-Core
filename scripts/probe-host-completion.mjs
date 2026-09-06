import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { i as initialize, t as runner, a as reset } from "../node_modules/openclaw/dist/hook-runner-global-ac8FBwry.js";
import { i as createDispatcher } from "../node_modules/openclaw/dist/reply-dispatcher-BzP_1lSP.js";
import { coordinateCompletion, completionDraftHash } from "../dist/src/openclaw/completion.js";
import { publishCompletionDraft } from "../dist/src/openclaw/completion-delivery.js";

// Fixed-version component probe, not a gateway/channel acceptance receipt.
const host = JSON.parse(await readFile(new URL("../node_modules/openclaw/package.json", import.meta.url), "utf8"));
assert.equal(host.version, "2026.8.2");
const observations = [];
function install(hooks) {
  reset();
  initialize({ hooks: [], typedHooks: hooks.map(([hookName, handler, timeoutMs]) => ({
    pluginId: "stella-completion-probe", hookName, handler, timeoutMs,
  })) });
  return runner();
}
const event = { ctx: {}, inboundAudio: false, shouldRouteToOriginating: false,
  shouldSendToolSummaries: false, shouldSendFullToolDetails: false, sendPolicy: "allow" };
const agentEvent = { prompt: "synthetic completion probe", messages: [] };

try {
  const hooks = install([
    ["reply_dispatch", () => { throw new Error("synthetic takeover failure"); }],
    ["before_agent_run", () => ({ outcome: "block", reason: "no trusted run permit" })],
  ]);
  assert.equal(await hooks.runReplyDispatch(event, { cfg: {}, dispatchKind: "agent" }), undefined);
  assert.equal((await hooks.runBeforeAgentRun(agentEvent, { agentId: "probe" })).decision.outcome, "block");
  observations.push("takeover_failure_requires_separate_admission_gate");

  let lateEffect = false;
  const timeoutHooks = install([["reply_dispatch", async () => {
    await delay(40);
    lateEffect = true;
    return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }, 5]]);
  assert.equal(await timeoutHooks.runReplyDispatch(event, { cfg: {}, dispatchKind: "agent" }), undefined);
  await delay(60);
  assert.equal(lateEffect, true);
  observations.push("hook_timeout_does_not_cancel_handler");

  for (const mode of ["delivered", "failed", "cancelled"]) {
    let sends = 0;
    const dispatcher = createDispatcher({
      deliver: async () => { sends++; if (mode === "failed") throw new Error("synthetic delivery failure"); },
      beforeDeliver: mode === "cancelled" ? () => null : undefined,
    });
    assert.equal(dispatcher.supportsSettledReceipt, true);
    dispatcher.sendFinalReply({ text: "Synthetic final" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();
    if (mode === "delivered") assert.equal(receipt.counts.final.delivered, 1);
    if (mode === "failed") assert.equal(receipt.counts.final.failedBeforeSend + receipt.counts.final.failedAfterSend, 1);
    if (mode === "cancelled") { assert.equal(receipt.counts.final.cancelled, 1); assert.equal(sends, 0); }
    observations.push(`dispatcher_${mode}_observable`);
  }
  for (const mode of ["success", "push_failure", "cancelled_write", "delivery_failure"]) {
    let sends = 0;
    const abort = new AbortController();
    const dispatcher = createDispatcher({ deliver: async () => {
      sends++;
      if (mode === "delivery_failure") throw new Error("synthetic delivery failure");
    } });
    const completion = coordinateCompletion({ operationId: "synthetic-op", runId: "synthetic-run",
      timeoutMs: 1000, abortSignal: abort.signal }, {
      async generateDraft() { return { draftId: "synthetic-draft", text: "Synthetic final", evidenceRef: "synthetic-evidence", responseKind: "action_advice", requiresCriticalPersistence: true }; },
      async persist({ draft, operationId, responseKind }) {
        if (mode === "push_failure") throw new Error("synthetic push failure");
        if (mode === "cancelled_write") abort.abort();
        return { schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
          draftHash: completionDraftHash(draft.text), responseKind, evidenceRef: draft.evidenceRef,
          writeOperationIds: ["synthetic-write"], observedRevision: "a".repeat(40), generationId: "synthetic-generation",
          persistenceStatus: "synchronized", checkedAt: new Date().toISOString() };
      },
      publishFinal: (args) => publishCompletionDraft({ ...args, dispatcher }),
    });
    if (mode === "push_failure" || mode === "cancelled_write") {
      await assert.rejects(completion); assert.equal(sends, 0);
      dispatcher.markComplete(); await dispatcher.waitForIdle();
    } else {
      const result = await completion;
      assert.equal(sends, 1);
      assert.equal(result.delivery.status, mode === "success" ? "confirmed" : "unknown");
    }
    observations.push(`coordinator_${mode}_checked_with_host_dispatcher`);
  }
  console.log(JSON.stringify({ host: host.version, scope: "host-components-only", observations }, null, 2));
} finally { reset(); }
