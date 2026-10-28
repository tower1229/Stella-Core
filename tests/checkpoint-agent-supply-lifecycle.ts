import assert from "node:assert/strict";

/** Test-owned work only. Core stop does not establish that SDK database owners
 * have drained; this helper never closes private SDK resources or retries rm. */
export function createAgentSupplyFixtureLifecycle(signal: AbortSignal) {
  const controller = new AbortController(), stops: Array<() => unknown> = [], removals: Array<() => unknown> = [];
  const pending = new Set<Promise<unknown>>();
  const shutdownErrors: unknown[] = []; let shuttingDown = false;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  function track<T>(value: T): T {
    if (value && typeof (value as { then?: unknown }).then === "function") {
      // Return the full chain so an ignored rejection remains observable. A
      // rejection during an awaited stop must also survive pending-set removal.
      const work = Promise.resolve(value).catch(error => { if (shuttingDown) shutdownErrors.push(error); throw error; })
        .finally(() => { pending.delete(work); }); pending.add(work);
      return work as T;
    }
    return value;
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      shuttingDown = true; controller.abort(); signal.removeEventListener("abort", abort);
      const errors = shutdownErrors;
      // Includes work started by another already-owned callback during shutdown.
      // Joining a rejected operation does not turn its returned promise into success.
      while (stops.length || pending.size) {
        while (stops.length) try { await stops.pop()!(); } catch (error) { errors.push(error); }
        await Promise.allSettled([...pending]);
      }
      if (errors.length) throw new AggregateError(errors, "Agent supply fixture shutdown failed; directories retained");
      for (const remove of removals) try { await remove(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Agent supply fixture cleanup failed");
    })();
  }
  return { controller, stops, removals, track, close };
}

/** Passing requests need no status RPC. Preserve the original equality check
 * and detailed supply diagnostic when preparation actually fails. */
export async function assertOwnerPreparation(prepared: unknown, index: number, status: () => Promise<unknown>) {
  if (prepared !== undefined) assert.equal(prepared, undefined, `completed request ${index + 1}: ${JSON.stringify(await status())}`);
}
