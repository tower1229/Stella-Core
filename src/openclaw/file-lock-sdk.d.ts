// OpenClaw 2026.8.2 exports this public JS facade without a declaration file.
declare module "openclaw/plugin-sdk/file-lock" {
  export function acquireFileLock(targetPath: string, options: {
    stale: number; retries: { retries: number }; staleRecovery: "fail-closed";
  }): Promise<{ lockPath: string; release(): Promise<void> }>;
  export function reclaimDefinitelyStaleFileLock(lockPath: string): Promise<"missing" | "removed" | "retained">;
}
