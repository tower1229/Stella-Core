import path from "node:path";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { parseCangHaiRef } from "../canghai/ref.js";
import { readRepositoryBytes } from "../canghai/catalog-reader.js";
import { isRecord } from "../shared/type-guards.js";
import { InitializationError, StellaInitializer, type Materialization } from "./initialization.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import type { HostIdentity } from "./initialization-templates.js";
import { verifyInitializationContext } from "./initialization-context.js";
import { Type } from "typebox";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { completionOperationForRun, isCompletionResourceActive } from "./completion.js";
import { parseRuntimeProfile, RuntimeProfileError } from "../canghai/runtime-profile.js";
import { callGatewayFromCli, isGatewayClientRequestError, isGatewayTransportError } from "openclaw/plugin-sdk/gateway-runtime";
import { captureInitializationVerificationBinding } from "./initialization-verification-binding.js";
import {
  acceptHostBootstrapCapability,
  assertConstrainedToolSurface,
  createFileCapabilityReceiptStore,
  evaluateRuntimeCapabilityBlockers,
  listCapabilityReceiptIds,
} from "./capability-admission.js";
import { CapabilityReceiptError, capabilityReceiptLocator, invalidateCapabilityReceipt, type CapabilityVersionBinding } from "../acceptance/capability-receipt.js";
import type { InitializationVerificationBinding } from "./initialization.js";

type Config = { canghaiRoot: string; recoveryRevision: string; manifestPath: string; agentId: string; initializationGatewayAccess?: "local_operator_read" };
type Status = { state: "not_started" | "initializing" | "blocked" | "ready"; category?: string; operationId?: string; recipeHash?: string;
  runtime?: { state: "blocked" | "not_evaluated"; blockers: string[] } };
type ScopedStatus = Status & { scope: "host_bootstrap" };
const scoped = (value: Status) => ({ ...value, scope: "host_bootstrap" as const });
const toCapabilityBinding = (value: InitializationVerificationBinding): CapabilityVersionBinding => ({
  core: value.core, artifact: value.artifact, host: value.host, harness: value.harness, source: value.source,
  profile: value.profile, policy: value.policy, configuration: value.configuration, model: value.model, cases: value.cases,
});

async function materializationSource(config: Config) {
  const manifest: unknown = parseYaml((await readRepositoryBytes(config.canghaiRoot, config.manifestPath)).toString("utf8"));
  if (!isRecord(manifest) || !isRecord(manifest.identity) || typeof manifest.identity.runtimeProfileRef !== "string") throw new InitializationError("profile_required");
  const profilePath = parseCangHaiRef(manifest.identity.runtimeProfileRef);
  if (profilePath.fragment) throw new InitializationError("invalid_profile_ref");
  const profile = parseRuntimeProfile(parseYaml((await readRepositoryBytes(config.canghaiRoot, profilePath.relativePath)).toString("utf8")));
  if (profile.schema_version !== "stella.runtime-profile/v2" || !profile.host_materialization_ref) throw new InitializationError("profile_migration_required");
  if (profile.agent_id !== config.agentId) throw new InitializationError("profile_agent_mismatch");
  const recipeRef = parseCangHaiRef(profile.host_materialization_ref);
  if (recipeRef.fragment) throw new InitializationError("invalid_materialization_ref");
  const recipePath = recipeRef.relativePath;
  let document: unknown;
  try { document = JSON.parse((await readRepositoryBytes(config.canghaiRoot, recipePath)).toString("utf8")); }
  catch { throw new InitializationError("invalid_materialization_document"); }
  if (!isRecord(document) || document.schema_version !== "stella.host-materialization/v1") throw new InitializationError("materialization_migration_required");
  const skillRegistryRef = isRecord(manifest.extensions) ? manifest.extensions.skillRegistryRef : undefined;
  if (skillRegistryRef !== undefined && typeof skillRegistryRef !== "string") throw new InitializationError("invalid_skill_registry_ref");
  const requiredCapabilities = profile.capabilities.filter(capability => capability.required).map(capability => capability.id);
  return { recipePath, contractProfile: profile.contract_profile, requiredCapabilities,
    ...(skillRegistryRef ? { skillRegistryRef } : {}) };
}

/** Registers effects only as a Host service or authenticated operation, never during plugin discovery. */
export function registerStellaInitialization(api: OpenClawPluginApi, config: Config,
  requestHost?: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  let status: Status = { state: "not_started" };
  let stateDir: string | undefined;
  let inflight: Promise<ScopedStatus> | undefined;
  let initializer: StellaInitializer | undefined;
  const resolveRuntimeBlockers = async (signal?: AbortSignal) => {
    if (!initializer) return [] as string[];
    const store = createFileCapabilityReceiptStore(initializer.stateRoot);
    const capture = async () => toCapabilityBinding(await captureInitializationVerificationBinding(api, config));
    const evaluated = await evaluateRuntimeCapabilityBlockers({
      compiledBlockers: initializer.runtimeBlockers,
      store,
      receiptIds: await listCapabilityReceiptIds(initializer.stateRoot),
      captureBinding: capture,
      signal,
    });
    return evaluated.blockers;
  };
  const runtimeStatus = async (signal?: AbortSignal): Promise<NonNullable<Status["runtime"]>> => {
    const blockers = await resolveRuntimeBlockers(signal);
    return { state: blockers.length ? "blocked" : "not_evaluated", blockers };
  };
  let reportHealth: (result: Status) => void = () => {};
  const shutdown = new AbortController();
  const identitySnapshot = (value: unknown): HostIdentity | null => {
    if (value === undefined || value === null) return null;
    if (!isRecord(value) || Object.keys(value).some((key) => !["name", "theme", "emoji", "avatar"].includes(key)) ||
      Object.values(value).some((field) => typeof field !== "string")) throw new InitializationError("invalid_host_identity");
    return structuredClone(value) as HostIdentity;
  };
  const readIdentity = async (): Promise<HostIdentity | null> => {
    const agent = api.runtime.config.current().agents?.entries?.[config.agentId];
    if (!agent) throw new InitializationError("explicit_agent_configuration_required");
    return identitySnapshot(agent.identity);
  };
  const applyIdentity = async (before: HostIdentity | null, after: HostIdentity | null, allowAlreadyApplied: boolean) => {
    identitySnapshot(before); identitySnapshot(after);
    if (canonicalJson(before) === canonicalJson(after)) {
      if (canonicalJson(await readIdentity()) !== canonicalJson(before)) throw new InitializationError("host_identity_conflict");
      return;
    }
    await api.runtime.config.mutateConfigFile({ afterWrite: { mode: "auto" }, mutate(draft) {
      const agent = draft.agents?.entries?.[config.agentId];
      if (!agent) throw new InitializationError("explicit_agent_configuration_required");
      const current = canonicalJson(identitySnapshot(agent.identity));
      if (allowAlreadyApplied && current === canonicalJson(after)) return;
      if (current !== canonicalJson(before)) throw new InitializationError("host_identity_conflict");
      if (after === null) delete agent.identity;
      else agent.identity = structuredClone(after);
    } });
    const deadline = Date.now() + 10000;
    while (canonicalJson(await readIdentity()) !== canonicalJson(after)) {
      if (shutdown.signal.aborted) throw new InitializationError("gateway_stopping");
      if (Date.now() >= deadline) throw new InitializationError("host_identity_reload_pending");
      await delay(100, undefined, { signal: shutdown.signal });
    }
  };
  const drain = async () => {
    const root = await realpath(config.canghaiRoot);
    if (isCompletionResourceActive(process.platform === "win32" ? root.toLowerCase() : root)) {
      throw new InitializationError("active_turn_drain_required");
    }
  };
  const request = requestHost ?? (async (method: string, params: Record<string, unknown>) => {
    if (config.initializationGatewayAccess !== "local_operator_read") throw new InitializationError("local_operator_read_authorization_required");
    if (api.config.gateway?.mode === "remote") throw new InitializationError("local_host_required");
    if (!["agents.files.list", "agents.files.get", "skills.status"].includes(method)) throw new InitializationError("host_method_forbidden");
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? api.config.gateway?.port ?? 18789);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InitializationError("invalid_gateway_port");
    // Explicit operator grant, ordinary authenticated transport, read scopes only.
    // Never request the restricted trusted-plugin runtime or manufacture plugin trust.
    try {
      return await callGatewayFromCli(method, { port: String(port), timeout: "10000", json: true }, params,
        { scopes: ["operator.read"], sharedStateMode: "read-only", progress: false, signal: shutdown.signal });
    } catch (error) {
      if (isGatewayClientRequestError(error)) throw new InitializationError(`host_rpc_${error.gatewayCode}`);
      if (isGatewayTransportError(error)) throw new InitializationError(`host_transport_${error.kind}`);
      throw error;
    }
  });

  const verifyHost = async (materialization: Materialization, host?: { setup: true }) => {
    const workspace = await realpath(resolveAgentWorkspaceDir(structuredClone(api.runtime.config.current()) as OpenClawConfig, config.agentId));
    if (host?.setup) {
      const setup = await api.runtime.agent.ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
      if (await realpath(setup.dir) !== workspace || setup.bootstrapPending !== false) throw new InitializationError("host_setup_pending");
    }

    const skills = await request("skills.status", { agentId: config.agentId });
    if (!isRecord(skills) || !Array.isArray(skills.skills) || typeof skills.workspaceDir !== "string" || await realpath(skills.workspaceDir) !== workspace) throw new InitializationError("host_skill_inventory_unavailable");
    for (const name of materialization.skills) {
      const text = await readFile(path.join(workspace, "skills", name, "SKILL.md"), "utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata: unknown = frontmatter ? parseYaml(frontmatter[1]!) : undefined;
      if (!isRecord(metadata) || metadata.name !== name || typeof metadata.description !== "string") throw new InitializationError("invalid_skill_metadata");
      const active = skills.skills.find((entry: unknown) => isRecord(entry) && entry.name === name);
      if (!isRecord(active) || active.eligible !== true || active.disabled === true || active.blockedByAgentFilter === true ||
        active.blockedByAllowlist === true || typeof active.filePath !== "string" ||
        await realpath(active.filePath) !== path.join(workspace, "skills", name, "SKILL.md")) throw new InitializationError("skill_unavailable_or_shadowed");
    }
    for (const file of materialization.files.filter((file) => !file.target.startsWith("skills/"))) {
      const observed = await request("agents.files.get", { agentId: config.agentId, name: file.target });
      if (!isRecord(observed) || !isRecord(observed.file) || typeof observed.file.content !== "string" ||
        bytesVersion(observed.file.content) !== file.sha256) throw new InitializationError("host_projection_mismatch");
    }

    await verifyInitializationContext({ workspace, agentId: config.agentId,
      files: materialization.files, currentConfig: () => api.runtime.config.current() });
  };

  const initialize = (): Promise<ScopedStatus> => {
    if (inflight) return inflight;
    inflight = (async () => {
      status = { state: "initializing" };
      let stage = "configuration";
      try {
        stateDir ??= resolveStateDir();
        if (shutdown.signal.aborted) throw new InitializationError("gateway_stopping");
        const source = await materializationSource(config);
        stage = "host_workspace";
        const inventory = await request("agents.files.list", { agentId: config.agentId });
        if (!isRecord(inventory) || typeof inventory.workspace !== "string") throw new InitializationError("host_workspace_unavailable");
        const workspace = await realpath(inventory.workspace);
        if (workspace !== await realpath(resolveAgentWorkspaceDir(api.config, config.agentId))) throw new InitializationError("host_workspace_mismatch");
        const localState = path.join(stateDir, "stella-core", "initialization", config.agentId);
        await mkdir(localState, { recursive: true, mode: 0o700 });
        stage = "transaction";
        initializer = new StellaInitializer(workspace, await realpath(localState), {
          root: await realpath(config.canghaiRoot), revision: config.recoveryRevision, ...source,
          agentId: config.agentId, hostVersion: api.runtime.version,
        }, {
          fence: drain,
          readIdentity, applyIdentity,
          verify: verifyHost,
          release: async () => {},
        }, shutdown.signal);
        const receipt = await initializer.initialize();
        if (shutdown.signal.aborted) throw new InitializationError("gateway_stopping");
        status = { state: "ready", operationId: receipt.operationId, recipeHash: receipt.recipeHash, runtime: await runtimeStatus() };
      } catch (error) {
        const category = error instanceof InitializationError || error instanceof RuntimeProfileError ? error.category : `initialization_${stage}_failed`;
        const operationId = initializer ? await initializer.pendingOperationId().catch(() => undefined) : undefined;
        status = { state: "blocked", category, ...(operationId ? { operationId } : {}) };
        api.logger.error(`Stella initialization blocked (${category})`);
      }
      reportHealth(status);
      return scoped(status);
    })().finally(() => { inflight = undefined; });
    return inflight;
  };

  const assertBootstrapReady = async () => {
    if (status.state === "initializing") throw new InitializationError("initialization_required");
    // Host harness registries may register this plugin again without starting services.
    // Rehydrate only a verified receipt, without running installation side effects.
    if (!initializer) {
      const source = await materializationSource(config);
      const unavailable = async () => { throw new InitializationError("gateway_service_not_started"); };
      initializer = new StellaInitializer(await realpath(resolveAgentWorkspaceDir(api.config, config.agentId)),
        await realpath(path.join(stateDir ?? resolveStateDir(), "stella-core", "initialization", config.agentId)), {
          root: await realpath(config.canghaiRoot), revision: config.recoveryRevision,
          ...source, agentId: config.agentId, hostVersion: api.runtime.version,
        }, { fence: unavailable, verify: verifyHost, release: unavailable, readIdentity, applyIdentity: unavailable }, shutdown.signal);
    }
    const current = api.runtime.config.current().plugins?.entries?.["stella-core"];
    if (current?.enabled !== true || current.config?.canghaiRoot !== config.canghaiRoot ||
      current.config.agentId !== config.agentId || typeof current.config.recoveryRevision !== "string" ||
      (current.config.manifestPath ?? "50_PersonalAgent/stella/manifest.yaml") !== config.manifestPath) throw new InitializationError("initialization_config_changed");
    // A Host config reload can retire this registration while a durable turn finishes.
    // Use the current authoritative pointer; the receipt still pins the projection bytes.
    initializer.source.revision = current.config.recoveryRevision;
    const source = await materializationSource({ ...config, recoveryRevision: current.config.recoveryRevision });
    Object.assign(initializer.source, source, { skillRegistryRef: source.skillRegistryRef });
    const receipt = await initializer.assertCurrent();
    await verifyInitializationContext({ workspace: receipt.workspace, agentId: config.agentId,
      files: receipt.files.map(file => ({ target: file.target, sha256: file.hash })), currentConfig: () => api.runtime.config.current() });
    status = { state: "ready", operationId: receipt.operationId, recipeHash: receipt.recipeHash, runtime: await runtimeStatus() };
  };

  const assertReady = async () => {
    await assertBootstrapReady();
    if ((await resolveRuntimeBlockers()).length) throw new InitializationError("runtime_capabilities_unavailable");
  };

  const inspect = async (): Promise<ScopedStatus> => {
    if (inflight || shutdown.signal.aborted) return scoped(status);
    try { await assertBootstrapReady(); }
    catch (error) { status = { state: "blocked", category: error instanceof InitializationError || error instanceof RuntimeProfileError ? error.category : "initialization_failed" }; }
    return scoped(status);
  };

  const rollback = async (operationId: string): Promise<ScopedStatus> => {
    if (inflight) throw new InitializationError("initialization_in_progress");
    if (shutdown.signal.aborted) throw new InitializationError("gateway_stopping");
    inflight = (async () => {
      status = { state: "initializing", operationId };
      try {
        const recovery = new StellaInitializer(await realpath(resolveAgentWorkspaceDir(api.config, config.agentId)),
          await realpath(path.join(stateDir ?? resolveStateDir(), "stella-core", "initialization", config.agentId)), {
            root: config.canghaiRoot, revision: config.recoveryRevision, recipePath: "unused-for-rollback",
            agentId: config.agentId, hostVersion: api.runtime.version,
          }, { fence: drain, release: async () => {}, readIdentity, applyIdentity,
            verify: async () => { throw new InitializationError("initialization_required"); } }, shutdown.signal);
        await recovery.rollback(operationId);
        status = { state: "blocked", category: "rolled_back_initialization_required", operationId };
        return scoped(status);
      } catch (error) {
        status = { state: "blocked", category: error instanceof InitializationError ? error.category : "rollback_failed", operationId };
        throw error;
      } finally { reportHealth(status); }
    })().finally(() => { inflight = undefined; });
    return inflight;
  };

  api.on("before_agent_run", async (_event, ctx) => {
    if (ctx.agentId !== config.agentId) return;
    try {
      if (shutdown.signal.aborted) throw new InitializationError("gateway_stopping");
      await assertReady();
      if (!ctx.runId) throw new InitializationError("run_binding_unavailable");
      await initializer!.bindRun(ctx.runId);
      const operationId = completionOperationForRun(ctx.runId);
      if (operationId && operationId !== ctx.runId) await initializer!.bindRun(operationId);
    }
    catch (error) {
      api.logger.error(`Stella initialization admission blocked (${error instanceof InitializationError ? error.category : "initialization_failed"})`);
      return { outcome: "block" as const, category: error instanceof InitializationError ? error.category : "initialization_failed",
        reason: "Stella initialization or runtime capability admission is not current", message:
          error instanceof InitializationError && error.category === "runtime_capabilities_unavailable"
            ? "Stella 运行文件已初始化，但所需能力尚未就绪；请通过 /stella-initialize status 查看阻断项。"
            : "Stella 初始化尚未完成或运行文件已变化；请执行 /stella-initialize。" };
    }
  }, { priority: 2000, timeoutMs: 15000 });
  api.on("before_tool_call", async (event, ctx) => {
    if (ctx.agentId !== config.agentId) return;
    try {
      await assertReady();
      if (!ctx.runId) throw new InitializationError("stale_initialization_run");
      await initializer!.assertRun(ctx.runId);
      if (event.toolName === "read") await initializer!.assertSkillRead(event.params);
      else if (event.toolName !== "stella_initialize") throw new InitializationError("private_draft_tool_forbidden");
    }
    catch (error) { return { block: true, blockReason: error instanceof InitializationError ? error.category : "Stella initialization is not current" }; }
  }, { priority: 2000, timeoutMs: 15000 });
  api.on("reply_payload_sending", async (event) => {
    if (!event.runId || !event.sessionKey?.startsWith(`agent:${config.agentId}:`)) return;
    try {
      await assertReady();
      await initializer!.assertRun(event.runId);
    }
    catch (error) {
      api.logger.error(`Stella initialization delivery blocked (${error instanceof InitializationError ? error.category : "initialization_failed"})`);
      return { cancel: true, reason: "Stella initialization is not current" };
    }
  }, { priority: 2000, timeoutMs: 15000 });

  api.registerService({
    id: "stella-initialization",
    start(ctx) {
      stateDir = ctx.stateDir;
      reportHealth = (result) => {
        if (result.state === "blocked") ctx.serviceHealth?.reportFailure(new InitializationError(result.category!));
        else ctx.serviceHealth?.clearFailure();
      };
      // Do not await a loopback request while the Host is still starting its listener.
      void initialize();
    },
    stop() { shutdown.abort(); reportHealth = () => {}; status = { state: "blocked", category: "gateway_stopping" }; },
  });
  api.on("gateway_start", async () => {
    // Gateway request context may become available after services begin starting.
    // A service-start request can still be failing when this event arrives.
    // Join it first so the ready listener gets its own initialization attempt.
    if (inflight) await inflight;
    if (!shutdown.signal.aborted && status.state !== "ready") await initialize();
  });
  api.registerGatewayMethod("stella.initialize", async ({ params, client, req, signal, respond }) => {
    if (client?.connect.role !== "operator" || !client.connect.scopes?.includes("operator.admin")) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "Initialization requires operator.admin" }); return;
    }
    const acceptCapability = isRecord(params) && params.action === "accept-capability" && Object.keys(params).length === 2 &&
      typeof params.runId === "string" && params.runId.trim().length > 0;
    const invalidateCapability = isRecord(params) && params.action === "invalidate-capability" && Object.keys(params).length === 2 &&
      typeof params.receiptId === "string" && /^cap_[a-f0-9-]{36}$/.test(params.receiptId);
    if (!isRecord(params) || typeof params.action !== "string" ||
      !(Object.keys(params).length === 1 && ["apply", "status", "verify"].includes(params.action) ||
        acceptCapability || invalidateCapability ||
        Object.keys(params).length === 2 && params.action === "rollback" && typeof params.operationId === "string" && /^init_[a-f0-9-]{36}$/.test(params.operationId))) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "Expected action: apply, status, verify, accept-capability with runId, invalidate-capability with receiptId, or rollback with operationId" }); return;
    }
    try {
      if (params.action === "verify") {
        if (!client.connId) throw new InitializationError("verification_actor_required");
        await assertBootstrapReady();
        const capture = () => captureInitializationVerificationBinding(api, config);
        const actorHash = bytesVersion(canonicalJson({ connection: client.connId, request: req.id,
          user: client.authenticatedUserId ?? null, role: client.connect.role }));
        const proof = await initializer!.verifyCapability(actorHash, capture, signal);
        await initializer!.assertCapabilityVerification(proof, capture, signal);
        respond(true, { verification: proof, runtime: await runtimeStatus(signal) });
        return;
      }
      if (params.action === "accept-capability") {
        if (!client.connId) throw new InitializationError("verification_actor_required");
        // Constrained acceptance uses bootstrap readiness only; it must not require business admission.
        await assertBootstrapReady();
        await initializer!.bindRun(String(params.runId));
        await initializer!.assertRun(String(params.runId));
        const actorHash = bytesVersion(canonicalJson({ connection: client.connId, request: req.id,
          user: client.authenticatedUserId ?? null, role: client.connect.role }));
        const store = createFileCapabilityReceiptStore(initializer!.stateRoot);
        const receipt = await acceptHostBootstrapCapability({
          host: {
            actorHash,
            runId: String(params.runId),
            purpose: { kind: "adapter_verification", capabilityId: "host_initialization" },
            resourceScope: bytesVersion(canonicalJson({ agentId: config.agentId, workspace: initializer!.workspace })),
          },
          captureBinding: async () => toCapabilityBinding(await captureInitializationVerificationBinding(api, config)),
          store,
          ports: {
            assertTrustedIdentity(hash) {
              if (hash !== actorHash) throw new InitializationError("verification_actor_required");
            },
            async assertRunBound(runId) {
              await initializer!.assertRun(runId);
            },
            assertConstrainedToolSurface(allowlist) {
              assertConstrainedToolSurface(allowlist);
            },
            async verifyInstalledBootstrap() {
              return initializer!.verifyInstalled();
            },
          },
          signal,
        });
        status = { ...status, runtime: await runtimeStatus(signal) };
        respond(true, {
          receipt: {
            id: receipt.id,
            capabilityId: receipt.capabilityId,
            adapterId: receipt.adapterId,
            result: receipt.result,
            businessAdmission: receipt.businessAdmission,
            mode: receipt.mode,
            locator: capabilityReceiptLocator(receipt),
            checkedAt: receipt.checkedAt,
            expiresAt: receipt.expiresAt,
          },
          runtime: status.runtime,
        });
        return;
      }
      if (params.action === "invalidate-capability") {
        await assertBootstrapReady();
        const store = createFileCapabilityReceiptStore(initializer!.stateRoot);
        const body = await store.read(String(params.receiptId));
        if (!body) throw new CapabilityReceiptError("capability_receipt_required");
        let receipt: unknown;
        try { receipt = JSON.parse(body); }
        catch { throw new CapabilityReceiptError("invalid_capability_receipt"); }
        await invalidateCapabilityReceipt(receipt, store);
        status = { ...status, runtime: await runtimeStatus(signal) };
        respond(true, { invalidated: String(params.receiptId), runtime: status.runtime });
        return;
      }
      const result = params.action === "status" ? await inspect() : params.action === "rollback" ? await rollback(params.operationId as string) : await initialize();
      if (params.action === "apply" && result.state === "blocked") respond(false, undefined, { code: "UNAVAILABLE", message: `Stella initialization blocked: ${result.category}` });
      else respond(true, result);
    } catch (error) {
      const category = error instanceof InitializationError || error instanceof RuntimeProfileError || error instanceof CapabilityReceiptError ? error.category
        : error && typeof error === "object" && "category" in error && typeof error.category === "string" ? error.category
        : params.action === "verify" ? "verification_failed" : params.action === "accept-capability" || params.action === "invalidate-capability" ? "capability_acceptance_failed" : "rollback_failed";
      respond(false, undefined, { code: "UNAVAILABLE", message: `Stella initialization blocked: ${category}` });
    }
  }, { scope: "operator.admin" });
  api.registerCommand({
    name: "stella-initialize", description: "初始化或重新核对 Stella 的运行文件与技能", requireAuth: true,
    requiredScopes: ["operator.admin"], acceptsArgs: true,
    async handler(ctx) {
      if (ctx.agentId !== config.agentId) return { text: "此命令仅适用于配置的 Stella Agent。" };
      const args = ctx.args?.trim().split(/\s+/) ?? [];
      if (args.length === 2 && args[0] === "rollback" && /^init_[a-f0-9-]{36}$/.test(args[1]!)) {
        try { return { text: JSON.stringify(await rollback(args[1]!)) }; }
        catch (error) { return { text: `Stella 回滚未完成：${error instanceof InitializationError ? error.category : "rollback_failed"}` }; }
      }
      if (ctx.args?.trim() && ctx.args.trim() !== "status") return { text: "用法：/stella-initialize 或 /stella-initialize status" };
      const result = ctx.args?.trim() === "status" ? await inspect() : await initialize();
      return { text: JSON.stringify(result) };
    },
  });
  api.registerTool((ctx) => ctx.agentId !== config.agentId ? null : {
    name: "stella_initialize", label: "Stella initialization",
    description: "Inspect initialization status, or initialize Stella again when the user explicitly requests initialization. Does not change source data or invent missing configuration.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("apply")]) }, { additionalProperties: false }),
    async execute(_id, input) {
      if (!isRecord(input) || (input.action !== "status" && input.action !== "apply")) throw new InitializationError("invalid_action");
      if (input.action === "apply" && ctx.senderIsOwner !== true) throw new InitializationError("owner_authorization_required");
      const result = input.action === "status" ? await inspect() : await initialize();
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: result.state === "blocked" };
    },
  }, { names: ["stella_initialize"] });
  return { initialize, rollback, assertReady, async assertRun(runId: string) {
    await assertReady();
    await initializer!.assertRun(runId);
  }, status: () => scoped(status) };
}
