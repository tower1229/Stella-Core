import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const TOOL = "stella_source_read";
const text = value => typeof value === "string" && value.length > 0;
const hash = value => createHash("sha256").update(value).digest("hex");
function requireValue(value, code) { if (!value) throw new Error(code); }
function data(value, keys) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "test_arguments_invalid");
  const props = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(props).length === keys.length && keys.every(key =>
    Object.hasOwn(props, key) && Object.hasOwn(props[key], "value")), "test_arguments_invalid");
  return Object.fromEntries(keys.map(key => [key, props[key].value]));
}

/** Additional restriction for ONE native test request; never a grant or source
 * admission. All original Core/Host checks still execute inside the callback.
 * No source I/O, persistence, model client or session creation lives here. */
export function createSingleSourceTestBoundary(seed, { now = () => performance.now() } = {}) {
  const s = data(seed, ["agentId", "sessionKey", "sessionId", "requestSha256", "ref"]);
  const ref = data(s.ref, ["id", "version"]);
  requireValue(s.agentId === "main" && text(s.sessionKey) && text(s.sessionId) &&
    /^[a-f0-9]{64}$/.test(s.requestSha256) && text(ref.id) &&
    /^sha256:[a-f0-9]{64}$/.test(ref.version), "test_seed_invalid");
  const identity = Object.freeze({ agentId: s.agentId, sessionKey: s.sessionKey, sessionId: s.sessionId });
  const chosen = Object.freeze({ id: ref.id, version: ref.version });
  const policyScope = new AsyncLocalStorage();
  let turn, ticket, closed = false, executions = 0, policies = 0, denials = 0;
  const matches = ctx => ctx?.agentId === identity.agentId && ctx?.sessionKey === identity.sessionKey && ctx?.sessionId === identity.sessionId;
  // Either stable session coordinate marks the target, so mismatches cannot
  // turn a target invocation into an unrestricted ordinary invocation.
  const target = ctx => ctx?.sessionKey === identity.sessionKey || ctx?.sessionId === identity.sessionId;
  const close = () => { closed = true; turn?.signal.removeEventListener("abort", close); };
  const current = () => {
    requireValue(!closed && turn && !turn.signal.aborted && now() < turn.deadline, "test_request_inactive");
  };
  const argumentsForRead = params => {
    const p = data(params, ["action", "ref"]), r = data(p.ref, ["id", "version"]);
    requireValue(p.action === "read" && r.id === chosen.id && r.version === chosen.version, "test_exact_fragment_required");
    return { action: "read", ref: { ...chosen } };
  };
  const reject = error => { denials++; return { block: true, blockReason: error.message }; };
  return {
    observeDispatch(event, ctx) {
      if (event.sessionKey !== identity.sessionKey && event.ctx?.SessionKey !== identity.sessionKey) return;
      try {
        const raw = event.ctx?.rawText, runId = event.runId, signal = ctx.abortSignal;
        requireValue(!closed && !turn && event.sessionKey === identity.sessionKey &&
          event.ctx?.SessionKey === identity.sessionKey && event.ctx?.AgentId === identity.agentId &&
          ctx.dispatchKind === "agent" && event.ctx?.ChatType === "direct" && event.ctx?.InternalTurnSource === undefined &&
          text(runId) && typeof raw === "string" && hash(raw) === s.requestSha256 &&
          signal && !signal.aborted, "test_native_request_mismatch");
        turn = { runId, signal, deadline: now() + 90_000 };
        signal.addEventListener("abort", close, { once: true });
      } catch { close(); }
    },
    beforePrompt(_event, ctx) {
      if (!target(ctx)) return;
      // This is only tool narrowing. It does NOT claim to remove history,
      // bootstrap, other prompt hooks, or prevent an initial paid model call.
      try { current(); requireValue(matches(ctx) && ctx.runId === turn.runId, "test_prompt_identity_mismatch"); }
      catch { close(); return { toolsAllow: [] }; }
      return { toolsAllow: [TOOL] };
    },
    beforeTool(event, ctx) {
      if (!target(ctx) && !(turn && ctx?.runId === turn.runId)) return;
      try {
        current();
        requireValue(matches(ctx) && ctx.runId === turn.runId && event.runId === turn.runId &&
          text(ctx.toolCallId) && event.toolCallId === ctx.toolCallId && !ctx.abortSignal?.aborted,
        "test_tool_identity_mismatch");
        requireValue(event.toolName === TOOL && ctx.toolName === TOOL, "test_other_tool_forbidden");
        const params = argumentsForRead(event.params);
        requireValue(!ticket && executions === 0, "test_read_limit");
        ticket = { callId: ctx.toolCallId, signal: ctx.abortSignal };
        return { params };
      } catch (error) { return reject(error); }
    },
    wrapTool(tool, ctx) {
      if (!target(ctx)) return tool;
      const original = tool.execute.bind(tool);
      const guard = typeof ctx.assertInvocationCurrent === "function" ? ctx.assertInvocationCurrent.bind(ctx) : null;
      const snapshot = { agentId: ctx.agentId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId };
      return { ...tool, async execute(callId, params, signal, ...rest) {
        current();
        requireValue(matches(snapshot) && matches(ctx) && guard, "test_factory_identity_mismatch");
        guard(); signal?.throwIfAborted(); ticket?.signal?.throwIfAborted();
        requireValue(tool.name === TOOL && ticket?.callId === callId && executions === 0, "test_unadmitted_or_repeated_execute");
        const exact = argumentsForRead(params);
        executions++; // Consume synchronously, including failed/cancelled attempts.
        const scope = { active: true, check: () => {
          current(); requireValue(matches(ctx), "test_factory_identity_mismatch");
          guard(); signal?.throwIfAborted(); ticket.signal?.throwIfAborted();
        } };
        try {
          const value = await policyScope.run(scope, () => original(callId, exact, signal, ...rest));
          scope.check(); return value;
        }
        finally { scope.active = false; }
      } };
    },
    async complete(params, originalComplete) {
      const scope = policyScope.getStore();
      // Other ordinary requests keep their original behavior; never borrow
      // this test's quota or qualification across an async continuation.
      if (!scope) return originalComplete(params);
      requireValue(scope.active, "test_policy_outside_execution"); scope.check();
      requireValue(policies === 0 && Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0 && params.maxTokens <= 8192, "test_policy_limit");
      policies++;
      const result = await originalComplete(params); scope.check(); return result;
    },
    end(event, ctx) {
      if (target(ctx) || turn && event.runId === turn.runId) close();
    },
    summary() { return { requestObserved: Boolean(turn), closed, executions, policyCompletions: policies, denials }; },
  };
}
