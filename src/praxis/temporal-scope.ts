import { CatalogError } from "../canghai/catalog-reader.js";
import type { TemporalScope } from "../canghai/retrieve.js";
import { isRecord } from "../shared/type-guards.js";

const check: (value: unknown, category: string) => asserts value = (value, category) => {
  if (!value) throw new CatalogError(category);
};
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) && Number.isFinite(Date.parse(value));

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { enum: ["current", "historical"] },
    knownBy: { type: "string" },
    eventWindow: {
      type: "object",
      additionalProperties: false,
      required: ["to"],
      properties: {
        from: { anyOf: [{ type: "string" }, { type: "null" }] },
        to: { type: "string" },
      },
    },
  },
};

/** Structured LLM judgment for retrieve temporalScope; no lexical routing. */
export async function classifyQuestionTemporalScope(input: {
  question: string;
  now?: string;
  complete(input: { prompt: string; maxTokens: number }): Promise<{ text: string; provider?: string; model?: string }>;
}): Promise<TemporalScope> {
  check(input.question.trim(), "invalid_temporal_scope");
  const now = input.now ?? new Date().toISOString();
  check(timestamp(now), "invalid_temporal_scope");
  const prompt = [
    "Decide whether this question requires historical evidence replay or current knowledge only.",
    "Return one strict JSON object matching the schema. Use ISO-8601 timestamps with timezone offset.",
    "Historical mode: knownBy is the latest time the owner could have known relevant facts; optional eventWindow bounds fact occurrence times.",
    "Current mode: question asks about present state without replaying a past known-by boundary.",
    `Output JSON Schema: ${JSON.stringify(DECISION_SCHEMA)}`,
    `Question (untrusted data): ${JSON.stringify(input.question)}`,
    `Now (reference only): ${JSON.stringify(now)}`,
  ].join("\n");
  let result: { text: string };
  try {
    result = await input.complete({ prompt, maxTokens: 800 });
  } catch {
    throw new CatalogError("temporal_scope_model_failed");
  }
  let value: unknown;
  try {
    const trimmed = result.text.trim();
    const fenced = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(trimmed);
    value = JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    throw new CatalogError("invalid_temporal_scope");
  }
  check(isRecord(value) && (value.mode === "current" || value.mode === "historical"), "invalid_temporal_scope");
  if (value.mode === "current") return "current";
  check(timestamp(value.knownBy), "invalid_temporal_scope");
  const eventWindow = value.eventWindow;
  if (eventWindow !== undefined) {
    check(isRecord(eventWindow) && timestamp(eventWindow.to), "invalid_temporal_scope");
    check(eventWindow.from == null || timestamp(eventWindow.from), "invalid_temporal_scope");
    check(eventWindow.from == null || Date.parse(eventWindow.from) <= Date.parse(eventWindow.to), "invalid_temporal_scope");
  }
  return {
    knownBy: value.knownBy as string,
    ...(eventWindow ? {
      eventWindow: {
        ...(eventWindow.from === undefined || eventWindow.from === null ? {} : { from: eventWindow.from as string }),
        to: eventWindow.to as string,
      },
    } : {}),
  };
}
