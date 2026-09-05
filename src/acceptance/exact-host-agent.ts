export type ExactHostAgentArgumentsInput = {
  agentId: string;
  message: string;
  sessionKey: string;
};

export type ExactHostAgentCommand = {
  executable: string;
  args: string[];
};

export function buildExactHostAgentArguments({
  agentId,
  message,
  sessionKey,
}: ExactHostAgentArgumentsInput): string[] {
  if (!agentId.trim()) throw new Error("Exact Host agent id must be non-empty");
  if (!message.trim()) throw new Error("Exact Host agent message must be non-empty");
  if (!sessionKey.trim()) throw new Error("Exact Host session key must be non-empty");
  return [
    "agent",
    "--agent",
    agentId,
    "--session-key",
    sessionKey,
    "--message",
    message,
    "--json",
    "--timeout",
    "120",
  ];
}

export function buildExactHostAgentCommand(
  openclawBin: string,
  input: ExactHostAgentArgumentsInput,
): ExactHostAgentCommand {
  if (!openclawBin.trim()) throw new Error("OpenClaw module path must be non-empty");
  return {
    executable: process.execPath,
    args: [openclawBin, ...buildExactHostAgentArguments(input)],
  };
}

export type ExactHostAgentTurn = {
  text: string;
  runtimeContextChars: number;
};

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

export function extractSafeExactHostAgentError(
  stdout: string,
  privateMessage: string,
): string | undefined {
  const start = stdout.lastIndexOf("\n{");
  const candidate = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const result = typeof record.result === "object" &&
      record.result !== null &&
      !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : undefined;
  const message = errorMessage(record.error) ?? errorMessage(result?.error);
  if (!message) return undefined;
  return message
    .replaceAll(privateMessage, "<private-message>")
    .replace(/https?:\/\/\S+/giu, "<url>")
    .replace(/[a-zA-Z]:\\\S+/gu, "<path>")
    .replace(/\/(?:Users|private|var|tmp)\/\S+/gu, "<path>")
    .replace(/[a-zA-Z0-9_=-]{32,}/gu, "<token>")
    .slice(0, 300);
}

export async function runWithOneExactHostReadRetry<T>(
  run: (attempt: 0 | 1) => Promise<T>,
): Promise<T> {
  try {
    return await run(0);
  } catch {
    return run(1);
  }
}

export function parseExactHostAgentTurn(stdout: string, probeId: string): ExactHostAgentTurn {
  const start = stdout.lastIndexOf("\n{");
  const candidate = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Exact Host probe ${probeId} returned invalid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Exact Host probe ${probeId} did not complete successfully`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    (record.ok !== undefined && record.ok !== true) ||
    (record.status !== undefined && record.status !== "ok")
  ) {
    throw new Error(`Exact Host probe ${probeId} did not complete successfully`);
  }
  const result = typeof record.result === "object" &&
      record.result !== null &&
      !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : record;
  const meta = typeof result.meta === "object" && result.meta !== null && !Array.isArray(result.meta)
    ? result.meta as Record<string, unknown>
    : undefined;
  const systemPromptReport = typeof meta?.systemPromptReport === "object" &&
      meta.systemPromptReport !== null &&
      !Array.isArray(meta.systemPromptReport)
    ? meta.systemPromptReport as Record<string, unknown>
    : undefined;
  const currentTurn = typeof systemPromptReport?.currentTurn === "object" &&
      systemPromptReport.currentTurn !== null &&
      !Array.isArray(systemPromptReport.currentTurn)
    ? systemPromptReport.currentTurn as Record<string, unknown>
    : undefined;
  const runtimeContextChars = currentTurn?.runtimeContextChars;
  if (!Number.isInteger(runtimeContextChars) || (runtimeContextChars as number) < 0) {
    throw new Error(`Exact Host probe ${probeId} omitted runtime-context evidence`);
  }
  if (record.ok === true && record.status === "ok" && typeof record.final === "string") {
    if (record.final.trim()) return { text: record.final, runtimeContextChars: runtimeContextChars as number };
  }
  {
    const payloads = result.payloads;
    if (Array.isArray(payloads)) {
      const text = payloads
        .flatMap((payload) => {
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
          const value = (payload as Record<string, unknown>).text;
          return typeof value === "string" && value.trim() ? [value] : [];
        })
        .join("\n")
        .trim();
      if (text) return { text, runtimeContextChars: runtimeContextChars as number };
    }
  }
  throw new Error(`Exact Host probe ${probeId} did not complete successfully`);
}

export function parseExactHostAgentOutput(stdout: string, probeId: string): string {
  return parseExactHostAgentTurn(stdout, probeId).text;
}
