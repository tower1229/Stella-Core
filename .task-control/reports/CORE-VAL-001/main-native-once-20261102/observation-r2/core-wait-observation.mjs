// R1 disposable SDK-copy observer only. Never loaded by installed Core/Host.
const enabled = process.env.OPENCLAW_TRACE_PREMODEL_WAIT === '1';
const points = new Set(['agent.listener', 'recorder.runtime', 'recorder.admission', 'projection.recorder', 'projection.write']);
let sink;
let incomplete = false;
let nextId = 0;
let emitted = 0;
const limit = 128;
export function markObservationIncomplete() {
  incomplete = true;
  sink = undefined;
}
// One private synchronous collector, not a public diagnostics_channel/event bus.
export function installObservationSink(collector) {
  if (!enabled || incomplete || sink || typeof collector !== 'function') return false;
  sink = collector;
  return true;
}
export function observationState() {
  return Object.freeze({ enabled, incomplete, emitted });
}
function emit(record) {
  if (!sink || incomplete || emitted >= limit) return;
  try {
    emitted++;
    const result = sink(Object.freeze({ ...record, sequence: emitted }));
    if (result && typeof result.then === 'function') {
      // A collector must be synchronous. Contain only its own returned rejection.
      markObservationIncomplete();
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    markObservationIncomplete();
  }
}
export function enterWait(point) {
  if (!enabled) return;
  try {
    if (!sink || incomplete || !points.has(point)) return;
    if (emitted === limit - 1) {
      emit({ phase: 'limit', incomplete: true });
      markObservationIncomplete();
      return;
    }
    if (emitted >= limit) return;
    const token = { id: ++nextId, point, startedAt: performance.now(), exited: false };
    emit({ phase: 'enter', id: token.id, point, monotonicMs: token.startedAt });
    return token;
  } catch {
    markObservationIncomplete();
    return;
  }
}
export function exitWait(token) {
  if (!enabled || !token || token.exited || incomplete) return;
  try {
    token.exited = true;
    const now = performance.now();
    if (emitted === limit - 1) {
      emit({ phase: 'limit', incomplete: true });
      markObservationIncomplete();
      return;
    }
    emit({ phase: 'exit', id: token.id, point: token.point, monotonicMs: now,
      elapsedMs: Math.max(0, now - token.startedAt) });
  } catch {
    markObservationIncomplete();
  }
}
