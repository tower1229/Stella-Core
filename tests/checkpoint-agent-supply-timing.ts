type Phase = "init" | "ingress" | "admit" | "end" | "cleanup";
/** Diagnostic observations only. No timeout extension, retries or payloads. */
export function createCapacityTiming(signal: AbortSignal, emit: (value: object) => void, now = () => performance.now()) {
  const totals: Partial<Record<Phase, { count: number; elapsedMs: number }>> = {};
  let current: { round: number; phase: Phase; started: number } | undefined;
  const elapsed = (start: number) => Math.max(0, now() - start);
  const abort = () => emit({ event: "cancelled", ...(current ? { round: current.round, phase: current.phase, elapsedMs: elapsed(current.started) } : {}), totals });
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  return {
    async run<T>(round: number, phase: Phase, action: () => T | Promise<T>): Promise<T> {
      if (current) throw new Error("capacity_timing_phase_overlap");
      const started = now(); current = { round, phase, started }; let completed = false;
      try { const value = await action(); completed = true; return value; }
      finally {
        const elapsedMs = elapsed(started), total = totals[phase] ??= { count: 0, elapsedMs: 0 };
        total.count++; total.elapsedMs += elapsedMs; current = undefined;
        emit({ event: "phase", round, phase, elapsedMs, completed });
      }
    },
    finish() { signal.removeEventListener("abort", abort); emit({ event: "summary", totals }); },
  };
}
