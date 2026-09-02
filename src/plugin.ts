import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  ConsciousnessLoadError,
  DEFAULT_MANIFEST_PATH,
  loadConsciousness,
  type LoadedConsciousness,
} from "./canghai/manifest.js";
import { renderConsciousnessContext } from "./canghai/context.js";
import {
  buildPraxisContextPacket,
  listFrameworkOperatorCandidates,
  renderPraxisContextPacket,
} from "./praxis/packet.js";
import { createSemanticRouter, SemanticRoutingError } from "./routing/semantic-router.js";
import { routeTurn } from "./routing/router.js";

export const STELLA_CORE_COMPATIBILITY_VERSION = "3.0.0-alpha.0";
const STELLA_CORE_SYSTEM_CONTEXT =
  "Stella Core is the cognitive runtime for this agent. Durable personal consciousness is loaded from CangHai; machine-local OpenClaw session state is not the authority for long-term identity.";

type StellaCoreConfig = {
  canghaiRoot: string;
  manifestPath: string;
  agentId: string;
  recoveryRevision: string;
};

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

type ReadyTurn = {
  outcome: "ready";
  prompt: string;
  prependSystemContext: string;
  appendContext?: string;
  preparedAt: number;
};

type BlockedTurn = {
  outcome: "blocked";
  prompt: string;
  category: string;
  message: string;
  preparedAt: number;
};

type PreparedTurn = ReadyTurn | BlockedTurn;

class PreparedTurnStore {
  readonly #turns = new Map<string, PreparedTurn>();

  put(runId: string, turn: Omit<ReadyTurn, "preparedAt"> | Omit<BlockedTurn, "preparedAt">): void {
    if (this.#turns.size >= 128) {
      const oldest = [...this.#turns.entries()].sort(
        (left, right) => left[1].preparedAt - right[1].preparedAt,
      )[0]?.[0];
      if (oldest) this.#turns.delete(oldest);
    }
    this.#turns.set(runId, { ...turn, preparedAt: Date.now() });
  }

  get(runId: string, prompt: string): PreparedTurn | undefined {
    const turn = this.#turns.get(runId);
    if (!turn || turn.prompt !== prompt || Date.now() - turn.preparedAt > 60_000) return undefined;
    return turn;
  }
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
      config.agentId,
    );

    api.on(
      "before_model_resolve",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return;
        if (!ctx.runId) throw new Error("Stella turn preparation requires a Host run id");
        try {
          const loaded = await consciousness.load();
          const route = await routeTurn(
            event.prompt,
            listFrameworkOperatorCandidates(loaded),
            classifySemantically,
          );
          const appendContext =
            route.mode === "ordinary" || route.mode === "outcome"
              ? undefined
              : route.mode === "praxis" || route.mode === "deep_praxis"
                ? renderPraxisContextPacket(buildPraxisContextPacket(event.prompt, route, loaded))
                : renderConsciousnessContext(loaded);
          preparedTurns.put(ctx.runId, {
            outcome: "ready",
            prompt: event.prompt,
            prependSystemContext: STELLA_CORE_SYSTEM_CONTEXT,
            ...(appendContext ? { appendContext } : {}),
          });
        } catch (error) {
          const consciousnessFailure = error instanceof ConsciousnessLoadError;
          const semanticFailure = error instanceof SemanticRoutingError;
          preparedTurns.put(ctx.runId, {
            outcome: "blocked",
            prompt: event.prompt,
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
        }
      },
      { priority: 1_000, timeoutMs: 15_000 },
    );

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return;
        if (!ctx.runId) throw new Error("Stella prepared turn requires a Host run id");
        const prepared = preparedTurns.get(ctx.runId, event.prompt);
        if (!prepared || prepared.outcome !== "ready") {
          throw new Error("Stella prepared turn is unavailable");
        }
        return {
          prependSystemContext: prepared.prependSystemContext,
          ...(prepared.appendContext ? { appendContext: prepared.appendContext } : {}),
        };
      },
      { priority: 100, timeoutMs: 15_000 },
    );

    api.on(
      "before_agent_run",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return { outcome: "pass" } as const;
        const prepared = ctx.runId ? preparedTurns.get(ctx.runId, event.prompt) : undefined;
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
  },
});
