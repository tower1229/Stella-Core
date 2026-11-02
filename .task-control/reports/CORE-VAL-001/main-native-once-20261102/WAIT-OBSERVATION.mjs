// Candidate for an isolated, single-request SDK copy only. Not loaded by Core.
import { channel } from 'node:diagnostics_channel';
const enabled = process.env.OPENCLAW_TRACE_PREMODEL_WAIT === '1';
const output = channel('openclaw.debug.pre-model-wait.v1');
const points = new Set(['agent.listener', 'recorder.runtime', 'recorder.admission', 'projection.recorder', 'projection.write']);
let nextId = 0;
let emitted = 0;
const limit = 128;
function emit(record) {
  // No promise, error text, input, IDs, paths, SQL or credentials cross this channel.
  try {
    if (emitted >= limit) return;
    emitted++;
    output.publish(Object.freeze({ ...record, sequence: emitted }));
  } catch {
    // Observability failure must not change the original operation's outcome.
  }
}
export function enterWait(point) {
  if (!enabled) return;
  try {
    if (!output.hasSubscribers || !points.has(point)) return;
    if (emitted === limit - 1) {
      emit({ phase: 'limit', incomplete: true });
      return;
    }
    if (emitted >= limit) return;
    const token = { id: ++nextId, point, startedAt: performance.now(), exited: false };
    emit({ phase: 'enter', id: token.id, point, monotonicMs: token.startedAt });
    return token;
  } catch {
    return;
  }
}
export function exitWait(token) {
  if (!enabled || !token || token.exited) return;
  try {
    token.exited = true;
    const now = performance.now();
    if (emitted === limit - 1) {
      emit({ phase: 'limit', incomplete: true });
      return;
    }
    emit({ phase: 'exit', id: token.id, point: token.point, monotonicMs: now,
      elapsedMs: Math.max(0, now - token.startedAt) });
  } catch {
    // No change to await, cancellation, settlement or custody.
  }
}
