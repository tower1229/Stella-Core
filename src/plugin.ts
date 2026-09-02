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
import { createSemanticRouter } from "./routing/semantic-router.js";
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

function errorCategory(error: unknown): string {
  return error instanceof ConsciousnessLoadError
    ? error.category
    : "stella_consciousness_unavailable";
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

export default definePluginEntry({
  id: "stella-core",
  name: "Stella Core",
  description:
    "Stella 3.0 cognitive runtime: Personal Twin, Framework Runtime, Reality Intelligence, and Praxis Loop",

  register(api) {
    const config = parsePluginConfig(api.pluginConfig);
    const consciousness = new ConsciousnessLoader(config, api.runtime.version);
    const classifySemantically = createSemanticRouter(
      (params) => api.runtime.llm.complete(params),
      config.agentId,
    );

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        if (ctx.agentId !== config.agentId) return;

        const loaded = await consciousness.load();
        const route = await routeTurn(
          event.prompt,
          listFrameworkOperatorCandidates(loaded),
          classifySemantically,
        );
        if (route.mode === "ordinary" || route.mode === "outcome") {
          return {
            prependSystemContext: STELLA_CORE_SYSTEM_CONTEXT,
          };
        }
        const appendContext =
          route.mode === "praxis" || route.mode === "deep_praxis"
            ? renderPraxisContextPacket(buildPraxisContextPacket(event.prompt, route, loaded))
            : renderConsciousnessContext(loaded);
        return {
          prependSystemContext: STELLA_CORE_SYSTEM_CONTEXT,
          ...(appendContext ? { appendContext } : {}),
        };
      },
      { priority: 100, timeoutMs: 15_000 },
    );

    api.on(
      "before_agent_run",
      async (_event, ctx) => {
        if (ctx.agentId !== config.agentId) return { outcome: "pass" } as const;

        try {
          await consciousness.load();
          return { outcome: "pass" } as const;
        } catch (error) {
          const category = errorCategory(error);
          return {
            outcome: "block",
            reason: `Stella consciousness load failed (${category})`,
            message:
              "Stella Core 无法加载或验证 CangHai 核心意识数据。请先完成 CangHai 恢复/校验，再继续使用 Stella。",
            category,
          } as const;
        }
      },
      { priority: 1_000, timeoutMs: 15_000 },
    );
  },
});
