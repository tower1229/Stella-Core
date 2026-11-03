// Targeted source replay, NOT a live Host/worker/VM capability test. Only fixed
// 10.9 functions are evaluated; their I/O collaborators are synthetic. No Host
// module import, user configuration, database, listener, network or provider.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";

export const pins = {
  "tool-surface-bridge-Ccc1MrSf.mjs": "4b28e228332d7b13b03a141bdbc9a11740ce1c7e9e6691925f46280f0c6293d1",
  "code-mode-state-BkXPjhOA.mjs": "6172910e8fd5f24f93c94a3d11e0314195f2cf9d3496245adf33ea426d59c313",
  "code-mode-control-tools-FkhKD315.mjs": "acea1a42570d99dbdd25c7bea366a07a0c8b9739865dd4793702e84101f91a7d",
};
const dist = new URL("../../node_modules/openclaw/dist/", import.meta.url);
const sources = {};
for (const [name, pin] of Object.entries(pins)) {
  const bytes = await readFile(new URL(name, dist));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin, `fixed 10.9 source: ${name}`);
  sources[name] = bytes.toString();
}
const section = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
};
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const core = sources["code-mode-control-tools-FkhKD315.mjs"];
export const identity = vm.runInNewContext(section(core, 'const CODE_MODE_EXEC_TOOL_NAME', '\n//#endregion') +
  ';({markCodeModeControlTool,getCodeModeExecBeforeHookMetadata,normalizeCodeModeExecBeforeHookParams,reconcileCodeModeExecBeforeHookParams})', {
  isPlainObject: plain, readNonBlankString: v => typeof v === "string" && v.trim() ? v : undefined,
  normalizeToolPolicyName: v => v,
}, { timeout: 1000 });
const state = sources["code-mode-state-BkXPjhOA.mjs"];
const readCode = vm.runInNewContext(`(${section(state, 'function readCode(args)', '\nfunction readRunId')})`, {
  asNonArrayRecord: v => plain(v) ? v : {},
  readNonBlankString: v => typeof v === "string" && v.trim() ? v : undefined, ToolInputError: Error,
}, { timeout: 1000 });
const runBridge = vm.runInNewContext(`(${section(state, 'async function runBridgeRequest(params)', '\n//#endregion')})`, {
  isRecord: plain, isCodeModeSessionStoreRequest: () => false, ToolInputError: Error,
  getBeforeToolCallFailureDisposition: () => undefined,
  redactCodeModeCatalogIds: s => s, formatErrorMessage: e => e.message,
  getToolContractFailureCode: () => undefined, isTrustedToolInputError: () => false,
}, { timeout: 1000 });
const createControlsSource = section(sources["tool-surface-bridge-Ccc1MrSf.mjs"],
  'function createCodeModeTools(ctx)', '\n/** Compact normal tools');

export function createReplayedControl({ ctx, invokeInner }) {
  const binding = { name: "stella_source_read", callableName: "stella_source_read", id: "synthetic:source", source: "openclaw" };
  const projection = { bindings: [binding], byCallableName: new Map([[binding.callableName, binding]]),
    byId: new Map([[binding.id, binding]]), searchableIds: new Set([binding.id]) };
  let programsExecuted = 0;
  const bridge = async (method, args, parent, signal) => {
    let reply;
    await runBridge({ request: { method, args }, catalogProjection: projection,
      namespaceRuntime: { mcpBindings: new Map() }, signal, parentToolCallId: parent,
      runtime: { search: async id => { assert.equal(id, binding.id); return [binding]; },
        callExactValue: async (id, input, options) => {
          assert.equal(id, binding.id); assert.equal(options.parentToolCallId, parent);
          return invokeInner(input, `synthetic-nested:${parent}`, options.signal);
        } },
      reply: { settle(ok, value) { reply = { ok, value }; } },
    });
    if (!reply?.ok) throw new Error(reply?.value?.message ?? "bridge_not_settled");
    return reply.value;
  };
  const createControls = vm.runInNewContext(`(${createControlsSource})`, {
    captureAgentPluginRuntimeRefresh: () => ({ assertCurrent() {}, assertActive() {}, isRequested: () => false }),
    resolveCodeModeConfig: () => ({}), resolveToolResultBudget: () => ({}),
    normalizeCodeModeTimeoutResult: x => x, markCodeModePermissionChangeResult() {},
    formatToolSearchControlResult: x => x, recordCodeModeToolOutcome: x => x,
    copyInternalToolResultState: (_a, b) => b, markCodeModeControlTool: identity.markCodeModeControlTool,
    CODE_MODE_EXEC_TOOL_NAME: "exec", CODE_MODE_WAIT_TOOL_NAME: "wait",
    createCodeModeExecDescription: () => "synthetic collaborators", executionTitleSchema: () => ({}),
    Type: { Object: x => x, String: () => ({}), Optional: x => x, Boolean: () => ({}) },
    getAgentToolAssistantTurnId: () => "synthetic-assistant", readCode,
    runCodeModeExec: async params => {
      programsExecuted++;
      // Only a program already admitted by the fixture can reach this point.
      const catalog = { search: async query => {
        const names = await bridge("search", [query], params.toolCallId, params.signal);
        return names.map(name => input => bridge("callValue", [name, input], params.toolCallId, params.signal));
      } };
      const value = await vm.runInNewContext(`(async () => {${params.code}\n})()`, { catalog }, { timeout: 1000 });
      return { status: "completed", value };
    },
  }, { timeout: 1000 });
  const [tool] = createControls(ctx);
  return { tool, programsExecuted: () => programsExecuted };
}
