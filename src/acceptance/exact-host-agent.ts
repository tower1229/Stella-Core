export type ExactHostAgentArgumentsInput = {
  agentId: string;
  message: string;
  sessionKey: string;
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
    "--local",
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

export function parseExactHostAgentOutput(stdout: string, probeId: string): string {
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
  if (record.ok === true && record.status === "ok" && typeof record.final === "string") {
    if (record.final.trim()) return record.final;
  }
  {
    const result = typeof record.result === "object" &&
        record.result !== null &&
        !Array.isArray(record.result)
      ? record.result as Record<string, unknown>
      : record;
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
      if (text) return text;
    }
  }
  throw new Error(`Exact Host probe ${probeId} did not complete successfully`);
}
