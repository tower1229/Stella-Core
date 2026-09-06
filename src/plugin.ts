import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  ConsciousnessLoadError,
  DEFAULT_MANIFEST_PATH,
  loadConsciousness,
  type LoadedConsciousness,
} from "./canghai/manifest.js";
import { renderConsciousnessContext } from "./canghai/context.js";
import { GitCangHaiDurability } from "./canghai/durability.js";
import {
  buildPraxisContextPacket,
  DEFAULT_MAX_PRAXIS_PACKET_CHARS,
  listSemanticRoutingCandidates,
  renderPraxisContextPacket,
} from "./praxis/packet.js";
import {
  CangHaiPraxisEpisodeStore,
  STELLA_DATA_MODES,
  type StellaDataMode,
} from "./praxis/episode-store.js";
import { createOpenClawRecoveryPointerWriter } from "./openclaw/recovery-pointer.js";
import { createSemanticRouter, SemanticRoutingError } from "./routing/semantic-router.js";
import type { CortexRoute } from "./routing/router.js";
import { registerCompletionTranscriptGuard } from "./openclaw/completion-transcript.js";
import { registerCompletionAdapter } from "./openclaw/completion-adapter.js";
import { CompletionError, completionDraftHash, hasCompletionRunPermit, recordCompletionPreparation, readCompletionPreparation,
  type CompletionDraft } from "./openclaw/completion.js";
import { canonicalJson } from "./canghai/content-version.js";

export const STELLA_CORE_COMPATIBILITY_VERSION = "3.0.0-alpha.0";
const STELLA_CORE_SYSTEM_CONTEXT =
  "Stella Core is the cognitive runtime for this agent. CangHai is the sole authority for durable personal consciousness and long-term identity facts. Machine-local OpenClaw sessions, SQLite, derived indexes, and prompt caches are not authoritative.";

type StellaCoreConfig = {
  canghaiRoot: string;
  manifestPath: string;
  agentId: string;
  recoveryRevision: string;
  dataMode: StellaDataMode;
  durabilityRemote?: string;
  durabilityBranch?: string;
};

function isDataMode(value: unknown): value is StellaDataMode {
  return STELLA_DATA_MODES.some((mode) => mode === value);
}

function parsePluginConfig(raw: unknown): StellaCoreConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Stella Core requires plugin configuration");
  }

  const config = raw as Record<string, unknown>;
  if (
    typeof config.canghaiRoot !== "string" ||
    !config.canghaiRoot.trim() ||
    !path.isAbsolute(config.canghaiRoot)
  ) {
    throw new Error("Stella Core config.canghaiRoot must be a non-empty absolute path");
  }
  if (
    typeof config.recoveryRevision !== "string" ||
    !/^[0-9a-f]{40}$/i.test(config.recoveryRevision)
  ) {
    throw new Error("Stella Core config.recoveryRevision must be a full Git commit SHA");
  }
  if (!isDataMode(config.dataMode)) {
    throw new Error(
      "Stella Core config.dataMode must be read_only, local_write, or managed_durable_write",
    );
  }
  if (
    config.dataMode === "managed_durable_write" &&
    (typeof config.durabilityRemote !== "string" || !config.durabilityRemote.trim())
  ) {
    throw new Error("managed_durable_write requires config.durabilityRemote");
  }
  if (
    config.dataMode === "managed_durable_write" &&
    (typeof config.durabilityBranch !== "string" || !config.durabilityBranch.trim())
  ) {
    throw new Error("managed_durable_write requires config.durabilityBranch");
  }

  return {
    canghaiRoot: config.canghaiRoot,
    manifestPath:
      typeof config.manifestPath === "string" && config.manifestPath.trim()
        ? config.manifestPath
        : DEFAULT_MANIFEST_PATH,
    agentId:
      typeof config.agentId === "string" && config.agentId.trim()
        ? config.agentId
        : "stella",
    recoveryRevision: config.recoveryRevision,
    dataMode: config.dataMode,
    ...(typeof config.durabilityRemote === "string"
      ? { durabilityRemote: config.durabilityRemote }
      : {}),
    ...(typeof config.durabilityBranch === "string"
      ? { durabilityBranch: config.durabilityBranch }
      : {}),
  };
}

class ConsciousnessLoader {
  #cached?: { loaded: LoadedConsciousness; at: number };
  #inflight?: Promise<LoadedConsciousness>;

  constructor(
    private readonly config: StellaCoreConfig,
    private readonly openclawVersion: string,
    private readonly ttlMs = 1_000,
  ) {}

  setRecoveryRevision(recoveryRevision: string): void {
    this.config.recoveryRevision = recoveryRevision;
    this.#cached = undefined;
  }

  async load(): Promise<LoadedConsciousness> {
    const now = Date.now();
    if (this.#cached && now - this.#cached.at <= this.ttlMs) {
      return this.#cached.loaded;
    }

    if (!this.#inflight) {
      this.#inflight = loadConsciousness(
        this.config.canghaiRoot,
        this.config.manifestPath,
        {
          recoveryRevision: this.config.recoveryRevision,
          coreVersion: STELLA_CORE_COMPATIBILITY_VERSION,
          openclawVersion: this.openclawVersion,
          dataMode: this.config.dataMode,
        },
      )
        .then((loaded) => {
          this.#cached = { loaded, at: Date.now() };
          return loaded;
        })
        .finally(() => {
          this.#inflight = undefined;
        });
    }

    return this.#inflight;
  }
}

type PreparedTurn = {
  outcome: "ready" | "blocked";
  category?: string;
  message?: string;
  admitted?: boolean;
  route?: CortexRoute;
  context?: string;
  revision?: string;
  persistRecommendation?: (text: string) => Promise<string>;
};

function renderTwinContext(loaded: LoadedConsciousness, route: CortexRoute): string {
  const selectedTwinRefs = new Set(route.candidateTwinRefs ?? []);
  return renderConsciousnessContext({
    ...loaded,
    bootstrapDocuments: loaded.bootstrapDocuments.filter(
      (document) =>
        document.category === "identity" ||
        (document.category === "twin" && selectedTwinRefs.has(document.ref)),
    ),
  });
}

export default definePluginEntry({
  id: "stella-core",
  name: "Stella Core",
  description:
    "Stella 3.0 cognitive runtime: Personal Twin, Framework Runtime, Reality Intelligence, and Praxis Loop",

  register(api) {
    const config = parsePluginConfig(api.pluginConfig);
    registerCompletionTranscriptGuard(api, config.agentId);
    const consciousness = new ConsciousnessLoader(config, api.runtime.version);
    const classifySemantically = createSemanticRouter(
      (params) => api.runtime.llm.complete({ ...params, agentId: config.agentId }),
    );
    const recoveryPointer = createOpenClawRecoveryPointerWriter();
    let durability: GitCangHaiDurability | undefined;

    const createEpisodeStore = (loaded: LoadedConsciousness): CangHaiPraxisEpisodeStore => {
      if (config.dataMode === "managed_durable_write" && !durability) {
        const policy = loaded.manifest.durability;
        if (!policy?.criticalWritePolicy || !policy.normalWritePolicy) {
          throw new Error("managed_durable_write requires manifest durability policies");
        }
        durability = new GitCangHaiDurability({
          root: loaded.canghaiRoot,
          remote: config.durabilityRemote!,
          branch: config.durabilityBranch!,
          criticalWritePolicy: policy.criticalWritePolicy,
          normalWritePolicy: policy.normalWritePolicy,
          maxNormalRpoSeconds: policy.maxNormalRpoSeconds ?? 0,
          onRevision: async (revision) => {
            const previousRevision = config.recoveryRevision;
            await recoveryPointer.advance(previousRevision, revision);
            config.recoveryRevision = revision;
            consciousness.setRecoveryRevision(revision);
          },
        });
      }
      return new CangHaiPraxisEpisodeStore({
        loaded,
        dataMode: config.dataMode,
        ...(durability ? { durability } : {}),
      });
    };

    const completions = new Map<string, { prepared: PreparedTurn; draft: CompletionDraft }>();
    registerCompletionAdapter(api, config.agentId, {
      describeDraft(runId, text, input, value) {
        const prepared = value as PreparedTurn | undefined;
        if (prepared?.outcome !== "ready" || !prepared.admitted || !prepared.route || !prepared.revision) {
          throw new CompletionError("stella_turn_preparation_unavailable", "generate");
        }
        const draft: CompletionDraft = {
          draftId: runId, text, responseKind: prepared.route.responseKind,
          evidenceRef: completionDraftHash(canonicalJson({
            originalInput: input, context: prepared.context ?? "", route: prepared.route, revision: prepared.revision,
          })),
          requiresCriticalPersistence: Boolean(prepared.persistRecommendation),
        };
        completions.set(runId, { prepared, draft });
        return draft;
      },
      async persist({ operationId, draft, abortSignal }) {
        const pending = completions.get(operationId);
        if (!pending || pending.draft !== draft || abortSignal.aborted) throw new CompletionError("invalid_prepared_completion", "persist");
        let revision = pending.prepared.revision!;
        const writes: string[] = [];
        if (pending.prepared.persistRecommendation) {
          revision = await pending.prepared.persistRecommendation(draft.text);
          writes.push(operationId);
        }
        return {
          schemaVersion: "stella.completion-receipt/v1", operationId, draftId: draft.draftId,
          draftHash: completionDraftHash(draft.text), responseKind: draft.responseKind, evidenceRef: draft.evidenceRef,
          observedRevision: revision, generationId: `alpha-recovery:${revision}`,
          writeOperationIds: writes, persistenceStatus: writes.length ? "synchronized" : "not_required",
          checkedAt: new Date().toISOString(),
        };
      },
      settled(runId) { completions.delete(runId); },
    });

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return;
        if (!hasCompletionRunPermit(ctx.runId)) return;
        const runId = ctx.runId!;
        try {
          const loaded = await consciousness.load();
          const episodeStore = createEpisodeStore(loaded);
          const memory = await episodeStore.listMemory();
          const loadedForTurn: LoadedConsciousness = {
            ...loaded,
            praxisPlaybookItems: [...loaded.praxisPlaybookItems, ...memory.learningItems],
          };
          const candidates = listSemanticRoutingCandidates(
            loadedForTurn,
            memory.openEpisodes,
          );
          const route = await classifySemantically(
            event.prompt,
            candidates,
          );
          let persistRecommendation: PreparedTurn["persistRecommendation"];
          let appendContext =
            route.mode === "ordinary"
              ? STELLA_CORE_SYSTEM_CONTEXT
              : route.mode === "outcome"
                ? undefined
              : route.mode === "praxis" || route.mode === "deep_praxis"
                ? renderPraxisContextPacket(
                    buildPraxisContextPacket(
                      event.prompt,
                      route,
                      loadedForTurn,
                      memory.openEpisodes,
                    ),
                    DEFAULT_MAX_PRAXIS_PACKET_CHARS,
                    config.dataMode,
                  )
                : renderTwinContext(loadedForTurn, route);
          if (route.mode === "outcome") {
            throw new CompletionError("action_evidence_migration_required", "prepare");
          } else if (
            (route.mode === "praxis" || route.mode === "deep_praxis") &&
            route.responseKind === "action_advice" &&
            config.dataMode !== "read_only"
          ) {
            if (config.dataMode !== "managed_durable_write") {
              throw new CompletionError("critical_durability_required", "prepare");
            }
            if (!route.twinPrediction || !route.situation) {
              throw new Error("Praxis route is missing its pre-outcome prediction");
            }
            const prediction = route.twinPrediction;
            if (!ctx.runId) throw new Error("Writable Praxis turn requires a Host run id");
            const packet = buildPraxisContextPacket(
              event.prompt,
              route,
              loadedForTurn,
              memory.openEpisodes,
            );
            persistRecommendation = async (text) => {
            const staged = await episodeStore.stagePrediction({
              provenance: {
                agentId: ctx.agentId,
                sessionId: ctx.sessionId,
                runId: ctx.runId,
              },
              situation: {
                summary: event.prompt.slice(0, 2_000),
                domains: route.domains,
                actors: packet.situation.actors,
                observations: packet.situation.observations,
                interpretations: packet.situation.interpretations,
                unknowns: packet.situation.unknowns,
                goals: packet.situation.userGoals,
                stakes: route.stakes,
                reversibility: route.reversibility,
              },
              twin: {
                hypothesisRefs: packet.twin?.hypothesisRefs,
                prediction,
              },
              ...(packet.framework
                ? {
                    framework: {
                      frameworkRefs: packet.framework.frameworkRefs,
                      operatorRefs: packet.framework.operatorRefs,
                    },
                  }
                : {}),
              reality: {
                modes: packet.reality.modes,
                ...(packet.reality.norms ? { norms: packet.reality.norms } : {}),
                ...(packet.reality.hiddenVariables
                  ? { hiddenVariables: packet.reality.hiddenVariables }
                  : {}),
                ...(packet.reality.socialCosts
                  ? { socialCosts: packet.reality.socialCosts }
                  : {}),
                ...(packet.reality.uncertainties
                  ? { uncertainties: packet.reality.uncertainties }
                  : {}),
                ...(packet.reality.externalRefs
                  ? { externalRefs: packet.reality.externalRefs }
                  : {}),
                ...(packet.reality.personalPraxisRefs
                  ? { similarEpisodeRefs: packet.reality.personalPraxisRefs }
                  : {}),
              },
            });
            await episodeStore.publishRecommendation(staged, text, []);
            const state = await durability!.diagnostics();
            if (!state.criticalSynchronized || state.synchronizedRevision !== state.localRevision) {
              throw new CompletionError("stella_critical_sync_failed", "persist");
            }
            return state.localRevision;
            };
          }
          appendContext = `${appendContext ?? ""}\nresponse_contract: ${JSON.stringify({
            responseKind: route.responseKind, evidenceStatus: route.evidenceStatus,
            materialUnknowns: route.materialUnknowns,
          })}`.trim();
          recordCompletionPreparation(runId, {
            outcome: "ready", route, context: appendContext, revision: loaded.recoveryRevision ?? config.recoveryRevision,
            persistRecommendation,
          } satisfies PreparedTurn);
          return {
            prependSystemContext: STELLA_CORE_SYSTEM_CONTEXT,
            ...(appendContext ? { appendContext } : {}),
          };
        } catch (error) {
          const consciousnessFailure = error instanceof ConsciousnessLoadError;
          const semanticFailure = error instanceof SemanticRoutingError;
          if (semanticFailure) {
            api.logger.error(
              `Stella semantic routing failed: ${error.diagnostic}${error.validationCode ? `:${error.validationCode}` : ""}`,
            );
          }
          recordCompletionPreparation(runId, {
            outcome: "blocked",
            category: consciousnessFailure
              ? error.category
              : semanticFailure
                ? error.category
                : error instanceof CompletionError ? error.category : "stella_turn_preparation_failed",
            message: consciousnessFailure
              ? "Stella Core 无法加载或验证 CangHai 核心意识数据。请先完成 CangHai 恢复/校验，再继续使用 Stella。"
              : semanticFailure
                ? "Stella Core 无法可靠完成本轮语义路由，因此已停止本轮请求。请检查模型配置或稍后重试。"
                : "Stella Core 无法可靠准备本轮请求，因此已停止执行。",
          });
          return;
        }
      },
      { priority: 100, timeoutMs: 60_000 },
    );

    api.on(
      "before_agent_run",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return { outcome: "pass" } as const;

        if (!hasCompletionRunPermit(ctx.runId)) return {
          outcome: "block", reason: "Stella requires coordinated completion",
          message: "Stella Core 需要经过可验证的完成协调入口，已停止本轮请求。", category: "capability_unavailable",
        } as const;
        const prepared = readCompletionPreparation(ctx.runId!) as PreparedTurn | undefined;
        if (prepared?.outcome === "ready" && !prepared.admitted) {
          prepared.admitted = true;
          return { outcome: "pass" } as const;
        }
        const category = prepared?.category ?? "stella_turn_preparation_unavailable";
        return {
          outcome: "block",
          reason: `Stella turn admission failed (${category})`,
          message: prepared?.message ?? "Stella Core 未能可靠准备本轮请求，因此已停止执行。",
          category,
        } as const;
      },
      { priority: 1_000, timeoutMs: 15_000 },
    );

  },
});
