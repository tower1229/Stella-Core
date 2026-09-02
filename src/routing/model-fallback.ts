import {
  CORTEX_MODES,
  createOrdinaryRoute,
  type CortexMode,
  type CortexRoute,
  type ModelRouteFallback,
} from "./router.js";
import { isRecord } from "../shared/type-guards.js";

export type RoutingCompletion = (params: {
  agentId: string;
  maxTokens: number;
  temperature: number;
  purpose: string;
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ text: string }>;

function isCortexMode(value: string): value is CortexMode {
  return CORTEX_MODES.some((mode) => mode === value);
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Model route field ${key} must be boolean`);
  return value;
}

function routeRiskFields(record: Record<string, unknown>) {
  const stakes = record.stakes;
  const reversibility = record.reversibility;
  if (stakes !== "low" && stakes !== "medium" && stakes !== "high") {
    throw new Error("Model Praxis route requires low, medium, or high stakes");
  }
  if (reversibility !== "high" && reversibility !== "medium" && reversibility !== "low") {
    throw new Error("Model Praxis route requires high, medium, or low reversibility");
  }
  return { stakes, reversibility } as const;
}

function parseModelRoute(text: string): CortexRoute {
  const json = text.match(/\{[\s\S]*\}/u)?.[0];
  const parsed = json ? (JSON.parse(json) as unknown) : undefined;
  if (!isRecord(parsed) || typeof parsed.mode !== "string") {
    throw new Error("Model router did not return a JSON route");
  }
  if (!isCortexMode(parsed.mode)) {
    throw new Error("Model router returned an unsupported mode");
  }
  const domains = Array.isArray(parsed.domains)
    ? parsed.domains.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (domains.length === 0) throw new Error("Model route requires at least one domain");

  const isPraxis = parsed.mode === "praxis" || parsed.mode === "deep_praxis";
  return {
    mode: parsed.mode,
    domains: domains.slice(0, 4),
    ...(isPraxis ? routeRiskFields(parsed) : {}),
    needsTwin: booleanField(parsed, "needsTwin"),
    needsFramework: booleanField(parsed, "needsFramework"),
    needsReality: booleanField(parsed, "needsReality"),
    needsExternalResearch: booleanField(parsed, "needsExternalResearch"),
  };
}

export function createModelRouteFallback(
  complete: RoutingCompletion,
  agentId: string,
): ModelRouteFallback {
  return async (prompt) => {
    try {
      const result = await complete({
        agentId,
        maxTokens: 300,
        temperature: 0,
        purpose: "stella-core-turn-routing",
        systemPrompt: [
          "Classify one user turn for Stella Cortex. Do not answer the user.",
          "Return only JSON with mode, domains, stakes, reversibility, needsTwin, needsFramework, needsReality, needsExternalResearch.",
          "Praxis and deep_praxis must include stakes (low|medium|high) and reversibility (high|medium|low).",
          "Use praxis for a personal real-world choice, twin for owner-self questions, deep_praxis only for current external facts, and ordinary otherwise.",
        ].join(" "),
        messages: [{ role: "user", content: prompt }],
      });
      return parseModelRoute(result.text);
    } catch {
      return createOrdinaryRoute();
    }
  };
}
