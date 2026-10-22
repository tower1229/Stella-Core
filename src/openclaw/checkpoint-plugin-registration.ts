import { registerCheckpointAgentSupply } from "./checkpoint-agent-supply.js";
import { registerCheckpointRequestIngress } from "./checkpoint-request-ingress.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createCheckpointPluginRuntime, parseCheckpointPluginConfig } from "./checkpoint-plugin-runtime.js";
import { RecoveryAuthorityError } from "../canghai/recovery-authority-contract.js";
import { isRecord } from "../shared/type-guards.js";

/** Restricted opt-in maintenance surface; legacy writers/providers are never registered in this mode.
 * No Host configuration write, startup migration, auto initialization or claim of Agent consumption.
 */
export function registerCheckpointPlugin(api: OpenClawPluginApi) {
  const config = parseCheckpointPluginConfig(api.pluginConfig);
  let closed = false, pending: ReturnType<typeof createCheckpointPluginRuntime> | undefined;
  const current = async () => {
    if (closed) throw new RecoveryAuthorityError("recovery_scope_closed");
    pending ??= createCheckpointPluginRuntime(config, api.runtime.version);
    const runtime = await pending;
    if (closed) { runtime.close(); throw new RecoveryAuthorityError("recovery_scope_closed"); }
    return runtime;
  };
  const supply = registerCheckpointAgentSupply(api, config, current);
  const ingress = registerCheckpointRequestIngress(api, config, current);
  const status = async (reload = false) => {
    const runtime = await current(), recovery = reload ? (await runtime.load()).recovery : await runtime.capture();
    await runtime.assert(recovery);
    return { authority: recovery.expected, loadedRevision: reload ? recovery.expected.revision : null, materialized: null, consumed: false,
      ingress: ingress.status(), supply: supply.status(), capabilities: { ownerIngressArchive: config.requestArchive === "local", checkpoint: true, localArchiveInternal: config.dataMode === "local_write", hostBootstrap: false, agentMemory: false, freshSessionTools: config.agentMemory === "fresh_tools", full_memory: false },
      blockers: ["checkpoint_host_bootstrap_not_migrated", "checkpoint_agent_writers_not_migrated"] };
  };
  api.registerGatewayMethod("stella.checkpoint", async ({ params, respond }) => {
    try {
      if (!isRecord(params) || !["status", "reload", "initialize"].includes(String(params.action)) ||
        Object.keys(params).some(key => !(params.action === "initialize" ? ["action", "revision", "operationId"] : ["action"]).includes(key))) {
        throw new RecoveryAuthorityError("checkpoint_operation_invalid");
      }
      if (params.action === "initialize") {
        if (typeof params.revision !== "string" || typeof params.operationId !== "string") throw new RecoveryAuthorityError("checkpoint_operation_invalid");
        await (await current()).initializeAuthority({ revision: params.revision, operationId: params.operationId });
      }
      respond(true, await status(params.action === "reload"));
    } catch (error) {
      const category = error && typeof error === "object" && "category" in error && typeof error.category === "string" ? error.category : "checkpoint_operation_failed";
      respond(false, undefined, { code: "UNAVAILABLE", message: category });
    }
  }, { scope: "operator.admin" });
  api.registerTool(ctx => ctx.agentId !== config.agentId ? null : {
    name: "stella_initialize", label: "Stella checkpoint status", description: "Report restricted Core checkpoint status. Initialization requires an explicit operator-admin request; Agent memory remains blocked.",
    parameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
    async execute(_id, input) {
      if (!isRecord(input) || input.action !== "status" || Object.keys(input).length !== 1) throw new RecoveryAuthorityError("checkpoint_operation_invalid");
      const result = await status();
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  }, { names: ["stella_initialize"] });
  api.on("before_agent_run", (event, ctx) => supply.beforeAgentRun(event, ctx), { priority: 10_000 });
  api.registerService({ id: "stella-checkpoint", start: async () => {}, async stop() {
    closed = true; ingress.close(); supply.close();
    if (pending) { try { (await pending).close(); } catch { /* Failed startup has no usable scope. */ } }
  } });
  return { status };
}
