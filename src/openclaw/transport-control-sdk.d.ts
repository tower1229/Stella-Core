// Isolated Host 2026.8.2 control-binding extension. Production Hosts without
// this public facade fail closed when the Google Agent path requests it.
declare module "openclaw/plugin-sdk/provider-transport-control" {
  export type ProviderTransportControlCall = Readonly<{ kind: "provider-transport-control-call/v1" }>;
  export function createProviderTransportControlCall(request: {
    runId: string; modelRef: string; sourceApi: string; callerSignal: AbortSignal;
  }): ProviderTransportControlCall;
  export function withProviderTransportControlCall<T>(call: ProviderTransportControlCall, invoke: () => T | Promise<T>): Promise<T>;
  export function assertProviderTransportControlSignal(call: ProviderTransportControlCall, signal: unknown): AbortSignal;
  export function closeProviderTransportControlCall(call: ProviderTransportControlCall): void;
}
