// OpenClaw 2026.8.2 exports this public JS facade without a facade declaration file.
// Narrow contract verified against its shipped session-transcript-runtime implementation.
declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  export function readSessionTranscriptRawDelta(params: {
    agentId: string; sessionId: string; sessionKey: string; storePath?: string;
    cursor?: string; maxEvents: number; maxBytes: number;
  }): Promise<
    { kind: "page"; cursor: string; events: Array<{ event: unknown; seq: number }>;
      hasMore: boolean; serializedBytes: number; requiredBytes?: number } |
    { kind: "reset"; cursor: string; reason: "generation_mismatch" | "invalid_cursor" | "scope_mismatch" } |
    { kind: "missing" }
  >;
}
