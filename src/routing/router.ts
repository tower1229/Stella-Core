export const CORTEX_MODES = [
  "ordinary",
  "twin",
  "praxis",
  "deep_praxis",
  "outcome",
] as const;

export type CortexMode = (typeof CORTEX_MODES)[number];
export type Stakes = "low" | "medium" | "high";
export type Reversibility = "high" | "medium" | "low";

export type CortexRoute = {
  mode: CortexMode;
  domains: string[];
  actors?: string[];
  stakes?: Stakes;
  reversibility?: Reversibility;
  needsTwin: boolean;
  needsFramework: boolean;
  needsReality: boolean;
  needsExternalResearch: boolean;
  candidateFrameworks?: string[];
  openEpisodeRef?: string;
};

export type ModelRouteFallback = (prompt: string) => Promise<CortexRoute>;

const RELATIONSHIP_SIGNAL =
  /(?:关系|恋爱|约会|喜欢|相亲|朋友|同事|伴侣|男友|女友|前任|暧昧|回复|回我|消息|疏远|压力|拒绝|边界|隐私|她|他)/u;
const DECISION_SIGNAL =
  /(?:怎么办|怎么做|要不要|该不该|是否应该|选择|决定|下一步|行动|发一条|回复|沟通|拒绝|邀请)/u;
const PERSONAL_SIGNAL = /(?:我|我们|自己的|这件事|在意|困扰|担心|纠结|希望|想要)/u;
const TWIN_SIGNAL = /(?:我通常|我会怎么|像我|了解我|我的偏好|我的风格|我的价值观)/u;
const OUTCOME_SIGNAL = /(?:后来|结果是|最后我|我已经|照做后|进展是)/u;
const CURRENT_FACT_SIGNAL =
  /(?:最新|现在的|目前的|法律|法规|政策|医疗|诊断|药物|投资|证券|税务|价格|汇率)/u;
const HIGH_STAKES_SIGNAL = /(?:生命|自杀|伤害|违法|诉讼|诊断|药物|大额|辞职|离婚)/u;

export function createOrdinaryRoute(): CortexRoute {
  return {
    mode: "ordinary",
    domains: ["general"],
    needsTwin: false,
    needsFramework: false,
    needsReality: false,
    needsExternalResearch: false,
  };
}

function praxisRoute(prompt: string): CortexRoute {
  const stakes: Stakes = HIGH_STAKES_SIGNAL.test(prompt) ? "high" : "medium";
  const needsExternalResearch = CURRENT_FACT_SIGNAL.test(prompt) || stakes === "high";
  return {
    mode: needsExternalResearch ? "deep_praxis" : "praxis",
    domains: RELATIONSHIP_SIGNAL.test(prompt) ? ["relationship"] : ["personal"],
    stakes,
    reversibility: stakes === "high" ? "low" : "high",
    needsTwin: true,
    needsFramework: true,
    needsReality: true,
    needsExternalResearch,
  };
}

function deterministicRoute(prompt: string): CortexRoute | undefined {
  const normalized = prompt.trim();
  if (!normalized) return createOrdinaryRoute();

  if (OUTCOME_SIGNAL.test(normalized) && PERSONAL_SIGNAL.test(normalized)) {
    return {
      mode: "outcome",
      domains: RELATIONSHIP_SIGNAL.test(normalized) ? ["relationship"] : ["personal"],
      needsTwin: false,
      needsFramework: false,
      needsReality: false,
      needsExternalResearch: false,
    };
  }

  if (TWIN_SIGNAL.test(normalized)) {
    return {
      mode: "twin",
      domains: RELATIONSHIP_SIGNAL.test(normalized) ? ["relationship"] : ["personal"],
      needsTwin: true,
      needsFramework: false,
      needsReality: false,
      needsExternalResearch: false,
    };
  }

  if (PERSONAL_SIGNAL.test(normalized) && DECISION_SIGNAL.test(normalized)) {
    return praxisRoute(normalized);
  }

  if (PERSONAL_SIGNAL.test(normalized) || RELATIONSHIP_SIGNAL.test(normalized)) {
    return undefined;
  }

  return createOrdinaryRoute();
}

export async function routeTurn(
  prompt: string,
  modelFallback: ModelRouteFallback,
): Promise<CortexRoute> {
  return deterministicRoute(prompt) ?? modelFallback(prompt);
}
