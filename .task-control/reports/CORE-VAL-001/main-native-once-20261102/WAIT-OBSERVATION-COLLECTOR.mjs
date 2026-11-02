// Proposed --import preload for the isolated synthetic process. Not executed here.
import { channel } from 'node:diagnostics_channel';
if (process.env.OPENCLAW_TRACE_PREMODEL_WAIT === '1') {
  let count = 0;
  const points = new Set(['agent.listener', 'recorder.runtime', 'recorder.admission', 'projection.recorder', 'projection.write']);
  channel('openclaw.debug.pre-model-wait.v1').subscribe(record => {
    if (count++ >= 128) return;
    try {
      // Fixed scalar projection; never serialize arbitrary event objects.
      const { phase, sequence, id, point, monotonicMs, elapsedMs, incomplete } = record;
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 128) return;
      const out = { phase, sequence };
      if (phase === 'limit' && incomplete === true) out.incomplete = true;
      else {
        if ((phase !== 'enter' && phase !== 'exit') || !points.has(point)) return;
        if (!Number.isSafeInteger(id) || id < 1 || id > 128 || !Number.isFinite(monotonicMs) || monotonicMs < 0) return;
        Object.assign(out, { id, point, monotonicMs });
        if (phase === 'exit') {
          if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
          out.elapsedMs = elapsedMs;
        }
      }
      process.stderr.write('CORE_WAIT_SPAN ' + JSON.stringify(out) + '\n');
    } catch {
      // Missing or incomplete diagnostics are unknown, never successful cleanup.
    }
  });
}
