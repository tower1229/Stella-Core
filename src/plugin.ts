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
  type StagedEpisode,
  type StellaDataMode,
} from "./praxis/episode-store.js";
import { createSemanticRouter, SemanticRoutingError } from "./routing/semantic-router.js";
import type { CortexRoute } from "./routing/router.js";

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
  preparedAt: number;
};

class PreparedTurnStore {
  readonly #turns = new Map<string, PreparedTurn>();

  put(key: string, turn: Omit<PreparedTurn, "preparedAt">): void {
    if (this.#turns.size >= 128) {
      const oldest = [...this.#turns.entries()].sort(
        (left, right) => left[1].preparedAt - right[1].preparedAt,
      )[0]?.[0];
      if (oldest) this.#turns.delete(oldest);
    }
    this.#turns.set(key, { ...turn, preparedAt: Date.now() });
  }

  take(key: string): PreparedTurn | undefined {
    const turn = this.#turns.get(key);
    this.#turns.delete(key);
    if (!turn || Date.now() - turn.preparedAt > 60_000) return undefined;
    return turn;
  }
}

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

function preparedTurnKey(
  sessionKey: string | undefined,
  traceId: string | undefined,
  runId: string | undefined,
): string {
  if (!sessionKey) throw new Error("Stella prepared turn requires a Host session key");
  const turnId = traceId ?? runId;
  if (!turnId) throw new Error("Stella prepared turn requires a Host trace or run id");
  return `${sessionKey}:${turnId}`;
}

function renderToolObservation(toolName: string, result: unknown, error: string | undefined): string {
  try {
    return JSON.stringify({
      source: "tool_observation",
      toolName,
      result: JSON.stringify(result).slice(0, 4_000),
      error: error?.slice(0, 1_000),
    });
  } catch (cause) {
    throw new Error("Stella tool observation is not serializable", { cause });
  }
}

async function associateRouteOutcome(
  store: CangHaiPraxisEpisodeStore,
  route: CortexRoute,
): Promise<void> {
  if (!route.outcome) throw new Error("Outcome route is missing outcome details");
  await store.associateOutcome({
    episodeRef: route.outcome.openEpisodeRef,
    actualAction: route.outcome.actualAction,
    source: route.outcome.source,
    observations: route.outcome.observations,
    result: route.outcome.result,
    observedAt: route.outcome.observedAt,
    predictionAssessment: route.outcome.predictionAssessment,
    praxisLearning: route.outcome.praxisLearning,
  });
}

function lastAssistantText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    if (typeof record.content === "string" && record.content.trim()) return record.content;
    if (!Array.isArray(record.content)) continue;
    const text = record.content
      .flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? [(part as Record<string, unknown>).text as string]
          : [],
      )
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

export default definePluginEntry({
  id: "stella-core",
  name: "Stella Core",
  description:
    "Stella 3.0 cognitive runtime: Personal Twin, Framework Runtime, Reality Intelligence, and Praxis Loop",

  register(api) {
    const config = parsePluginConfig(api.pluginConfig);
    const consciousness = new ConsciousnessLoader(config, api.runtime.version);
    const preparedTurns = new PreparedTurnStore();
    const classifySemantically = createSemanticRouter(
      (params) => api.runtime.llm.complete(params),
    );
    const episodeByRun = new Map<string, StagedEpisode>();
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
          onRevision: (revision) => consciousness.setRecoveryRevision(revision),
        });
      }
      return new CangHaiPraxisEpisodeStore({
        loaded,
        dataMode: config.dataMode,
        ...(durability ? { durability } : {}),
      });
    };

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return;
        const turnKey = preparedTurnKey(ctx.sessionKey, ctx.trace?.traceId, ctx.runId);
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
            await associateRouteOutcome(episodeStore, route);
          } else if (
            (route.mode === "praxis" || route.mode === "deep_praxis") &&
            config.dataMode !== "read_only"
          ) {
            if (!route.twinPrediction || !route.situation) {
              throw new Error("Praxis route is missing its pre-outcome prediction");
            }
            if (!ctx.runId) throw new Error("Writable Praxis turn requires a Host run id");
            const packet = buildPraxisContextPacket(
              event.prompt,
              route,
              loadedForTurn,
              memory.openEpisodes,
            );
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
                prediction: route.twinPrediction,
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
            episodeByRun.set(ctx.runId, staged);
            appendContext = `${appendContext ?? ""}\npre_outcome_episode_ref: ${staged.ref}`.trim();
          }
          preparedTurns.put(turnKey, { outcome: "ready" });
          return {
            prependSystemContext: STELLA_CORE_SYSTEM_CONTEXT,
            ...(appendContext ? { appendContext } : {}),
          };
        } catch (error) {
          const consciousnessFailure = error instanceof ConsciousnessLoadError;
          const semanticFailure = error instanceof SemanticRoutingError;
          if (semanticFailure) {
            api.logger.error(`Stella semantic routing failed: ${error.diagnostic}`);
          }
          preparedTurns.put(turnKey, {
            outcome: "blocked",
            category: consciousnessFailure
              ? error.category
              : semanticFailure
                ? error.category
                : "stella_turn_preparation_failed",
            message: consciousnessFailure
              ? "Stella Core 无法加载或验证 CangHai 核心意识数据。请先完成 CangHai 恢复/校验，再继续使用 Stella。"
              : semanticFailure
                ? "Stella Core 无法可靠完成本轮语义路由，因此已停止本轮请求。请检查模型配置或稍后重试。"
                : "Stella Core 无法可靠准备本轮请求，因此已停止执行。",
          });
          return;
        }
      },
      { priority: 100, timeoutMs: 15_000 },
    );

    api.on(
      "after_tool_call",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return;
        const loaded = await consciousness.load();
        const episodeStore = createEpisodeStore(loaded);
        const memory = await episodeStore.listMemory();
        if (memory.openEpisodes.length === 0) return;
        const candidates = listSemanticRoutingCandidates(
          {
            ...loaded,
            praxisPlaybookItems: [...loaded.praxisPlaybookItems, ...memory.learningItems],
          },
          memory.openEpisodes,
        );
        const route = await classifySemantically(
          renderToolObservation(event.toolName, event.result, event.error),
          candidates,
        );
        if (route.mode !== "outcome") return;
        if (!route.outcome || route.outcome.source !== "tool_observation") {
          throw new Error("Tool outcome route must retain tool_observation provenance");
        }
        await associateRouteOutcome(episodeStore, route);
      },
      { priority: 100, timeoutMs: 15_000 },
    );

    api.on(
      "before_agent_run",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return { outcome: "pass" } as const;

        const prepared = preparedTurns.take(
          preparedTurnKey(ctx.sessionKey, ctx.trace?.traceId, ctx.runId),
        );
        if (prepared?.outcome === "ready") return { outcome: "pass" } as const;
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

    api.on("agent_end", async (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const staged = episodeByRun.get(runId);
      episodeByRun.delete(runId);
      if (!staged) return;
      const loaded = await consciousness.load();
      const episodeStore = createEpisodeStore(loaded);
      const recommendation = event.success ? lastAssistantText(event.messages) : undefined;
      if (!recommendation) {
        await episodeStore.discardStagedPrediction(staged);
        return;
      }
      await episodeStore.publishRecommendation(staged, recommendation.slice(0, 8_000), []);
    });
  },
});
