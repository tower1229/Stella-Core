// Proposed preload for the disposable child. fd3 must be a dedicated capture pipe.
import { createWriteStream } from 'node:fs';
import { installObservationSink, markObservationIncomplete } from './core-wait-observation.mjs';
if (process.env.OPENCLAW_TRACE_PREMODEL_WAIT === '1') {
  const points = new Set(['agent.listener', 'recorder.runtime', 'recorder.admission', 'projection.recorder', 'projection.write']);
  let count = 0;
  try {
    // Never attach error handlers to shared stderr or process exception events.
    const output = createWriteStream('', { fd: 3, autoClose: false });
    output.on('error', markObservationIncomplete);
    // Partial observations only: no lifecycle event attests complete capture.
    installObservationSink(record => {
      if (count++ >= 128) return;
      try {
        const { phase, sequence, id, point, monotonicMs, elapsedMs, incomplete } = record;
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 128) { markObservationIncomplete(); return; }
        const out = { phase, sequence };
        if (phase === 'limit' && incomplete === true) out.incomplete = true;
        else {
          if ((phase !== 'enter' && phase !== 'exit') || !points.has(point)) { markObservationIncomplete(); return; }
          if (!Number.isSafeInteger(id) || id < 1 || id > 128 || !Number.isFinite(monotonicMs) || monotonicMs < 0) { markObservationIncomplete(); return; }
          Object.assign(out, { id, point, monotonicMs });
          if (phase === 'exit') {
            if (!Number.isFinite(elapsedMs) || elapsedMs < 0) { markObservationIncomplete(); return; }
            out.elapsedMs = elapsedMs;
          }
        }
        // The callback and owned-stream listener cover asynchronous write failure.
        output.write(JSON.stringify(out) + '\n', error => { if (error) markObservationIncomplete(); });
      } catch {
        markObservationIncomplete();
      }
    });
  } catch {
    markObservationIncomplete();
  }
}
