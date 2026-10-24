import { registerCheckpointIdentityDiagnostic } from "./checkpoint-request-identity.js";
import { createCheckpointInitialization } from "./checkpoint-initialization.js";
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
  registerCheckpointIdentityDiagnostic(api);
  let importing = false;
  let closed = false, pending: ReturnType<typeof createCheckpointPluginRuntime> | undefined;
  const current = async () => {
    if (closed) throw new RecoveryAuthorityError("recovery_scope_closed");
    pending ??= createCheckpointPluginRuntime(config, api.runtime.version);
    const runtime = await pending;
    if (closed) { runtime.close(); throw new RecoveryAuthorityError("recovery_scope_closed"); }
    return runtime;
  };
  const initialization = createCheckpointInitialization(api, config, current, () => supply.assertIdle());
  const ingress = registerCheckpointRequestIngress(api, config, current);
  const supply = registerCheckpointAgentSupply(api, config, current, initialization, config.requestArchive === "local" ? async (event, ctx) => {
    await initialization.assertAvailable(); return ingress.dispatch(event, ctx);
  } : undefined, () => { if (importing) throw new RecoveryAuthorityError("checkpoint_import_in_progress"); });
  const status = async (reload = false) => {
    const runtime = await current(), recovery = reload ? (await runtime.load()).recovery : await runtime.capture();
    await runtime.assert(recovery);
    const materialized = await initialization.status();
    return { authority: recovery.expected, loadedRevision: reload ? recovery.expected.revision : null, materialized, consumed: false,
      mode: config.agentMemory === "fresh_tools" ? "experimental_owner_chat" : "checkpoint_maintenance",
      ingress: ingress.status(), supply: supply.status(), capabilities: { ownerIngressArchive: config.requestArchive === "local", checkpoint: true, localArchiveInternal: config.dataMode === "local_write", hostBootstrap: Boolean(materialized), agentMemory: false, freshSessionTools: config.agentMemory === "fresh_tools", continuousOwnerChat: config.agentMemory === "fresh_tools", ownerCorrectionTool: config.agentCorrection === "tool", full_memory: false },
      blockers: config.agentMemory === "fresh_tools" ? [] : ["checkpoint_agent_memory_not_enabled"],
      fullMemoryBlockers: [...materialized ? [] : ["checkpoint_host_bootstrap_not_materialized"], "checkpoint_semantic_writers_not_migrated", "checkpoint_complete_transcript_not_migrated"] };
  };
  api.registerGatewayMethod("stella.checkpoint", async ({ params, respond, signal }) => {
    try {
      if (!isRecord(params) || typeof params.action !== "string" || !["status", "reload", "initialize", "materialize", "rollback", "import"].includes(params.action) ||
        Object.keys(params).some(key => !(params.action === "import" ? ["action", "expectedRevision", "expectedToken", "candidateRoot", "producerBaseRevision", "candidateRevision", "operationId"] : params.action === "initialize" ? ["action", "revision", "operationId"] : params.action === "rollback" ? ["action", "operationId"] : ["action"]).includes(key))) {
        throw new RecoveryAuthorityError("checkpoint_operation_invalid");
      }
      if (importing && !["status", "reload"].includes(params.action)) throw new RecoveryAuthorityError("checkpoint_import_in_progress");
      if (params.action === "import") {
        if (!["expectedRevision", "expectedToken", "candidateRoot", "producerBaseRevision", "candidateRevision", "operationId"].every(key => typeof params[key] === "string")) {
          throw new RecoveryAuthorityError("checkpoint_operation_invalid");
        }
        supply.assertIdle(); importing = true;
        try {
          await initialization.assertAvailable();
          const runtime = await current(), captured = await runtime.capture();
          // The resolver/binding come from configuration; expected revision/token are caller-pinned.
          const recovery = { resolver: captured.resolver, expected: { ...captured.expected,
            revision: params.expectedRevision as string, token: params.expectedToken as string } };
          const imported = await runtime.importSnapshot({ recovery, candidateRoot: params.candidateRoot as string,
            producerBaseRevision: params.producerBaseRevision as string, candidateRevision: params.candidateRevision as string,
            operationId: params.operationId as string, signal });
          respond(true, { imported, consumed: false, capabilities: { full_memory: false } }); return;
        } finally { importing = false; }
      }
      if (params.action === "initialize") {
        if (typeof params.revision !== "string" || typeof params.operationId !== "string") throw new RecoveryAuthorityError("checkpoint_operation_invalid");
        await (await current()).initializeAuthority({ revision: params.revision, operationId: params.operationId });
      }
      if (params.action === "materialize") await initialization.materialize(signal);
      if (params.action === "rollback") {
        if (typeof params.operationId !== "string") throw new RecoveryAuthorityError("checkpoint_operation_invalid");
        respond(true, await initialization.rollback(params.operationId, signal)); return;
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
  api.on("before_agent_run", async (event, ctx) => {
    if (ctx.agentId === config.agentId && importing) {
      supply.retireRun(ctx.runId);
      return { outcome: "block" as const, category: "checkpoint_import_in_progress",
        reason: "An explicit Core snapshot import is in progress", message: "Retry after the snapshot import completes." };
    }
    if (ctx.agentId === config.agentId) try { await initialization.assertAvailable(); }
    catch { supply.retireRun(ctx.runId); return { outcome: "block" as const, category: "initialization_pending", reason: "Core initialization is pending", message: "Complete or recover Core initialization before a new request." }; }
    return supply.beforeAgentRun(event, ctx);
  }, { priority: 10_000 });
  api.registerService({ id: "stella-checkpoint", start: async () => {}, async stop() {
    closed = true; ingress.close(); supply.close();
    if (pending) { try { (await pending).close(); } catch { /* Failed startup has no usable scope. */ } }
  } });
  return { status };
}
