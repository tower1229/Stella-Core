import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_MANIFEST_PATH,
  loadConsciousness,
  type LoadedConsciousness,
} from "./canghai/manifest.js";

type StellaCoreConfig = {
  canghaiRoot: string;
  manifestPath: string;
  agentId: string;
};

function parsePluginConfig(raw: unknown): StellaCoreConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Stella Core requires plugin configuration");
  }

  const config = raw as Record<string, unknown>;
  if (typeof config.canghaiRoot !== "string" || !config.canghaiRoot.trim()) {
    throw new Error("Stella Core config.canghaiRoot must be a non-empty absolute path");
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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ConsciousnessLoader {
  #cached?: { loaded: LoadedConsciousness; at: number };
  #inflight?: Promise<LoadedConsciousness>;

  constructor(
    private readonly config: StellaCoreConfig,
    private readonly ttlMs = 5_000,
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
    const consciousness = new ConsciousnessLoader(config);

    api.on("gateway_start", async () => {
      // Warm validation only. Target-agent turns still enforce a fail-closed gate.
      await consciousness.load();
    });

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        if (ctx.agentId !== config.agentId) return;

        const loaded = await consciousness.load();
        return {
          prependSystemContext:
            "Stella Core is the cognitive runtime for this agent. Durable personal consciousness is loaded from CangHai; machine-local OpenClaw session state is not the authority for long-term identity.",
          appendContext: [
            "<stella_core_bootstrap>",
            `instance_id: ${loaded.manifest.instance.id}`,
            `manifest_schema: ${loaded.manifest.schemaVersion}`,
            `validated_refs: ${loaded.requiredReferences.length}`,
            "phase: bootstrap-only; Praxis packet assembly is implemented by later Alpha modules",
            "</stella_core_bootstrap>",
          ].join("\n"),
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
          return {
            outcome: "block",
            reason: `Stella consciousness load failed: ${errorMessage(error)}`,
            message:
              "Stella Core 无法加载或验证 CangHai 核心意识数据。请先完成 CangHai 恢复/校验，再继续使用 Stella。",
            category: "stella_consciousness_unavailable",
          } as const;
        }
      },
      { priority: 1_000, timeoutMs: 15_000 },
    );
  },
});
