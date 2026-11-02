"""One bounded existing-log projection. Never print messages, SQL, paths or payloads."""
from pathlib import Path
from datetime import datetime
import hashlib
import json
import re

HERE = Path(__file__).resolve().parent
RUN = json.loads((HERE / 'REPORT.json').read_text())['execution']['runId']
PID = 14106
START = '2026-11-02T11:20:29.893+00:00'
END = '2026-11-02T11:25:23+00:00'
def epoch(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError, AttributeError):
        return None
LO, HI = epoch(START), epoch(END)
def digest(raw):
    return hashlib.sha256(raw).hexdigest()
def dicts(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from dicts(child)

log = Path('/tmp/openclaw/openclaw-2026-11-02.log')
size = log.stat().st_size
with log.open('rb') as file:
    raw = file.read(size)
window = []
for line in raw.splitlines():
    try:
        obj = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        continue
    stamp = obj.get('time') or obj.get('_meta', {}).get('date')
    ts = epoch(stamp)
    if ts is not None and LO <= ts <= HI:
        window.append((obj, line, stamp))

traces = set()
for obj, line, stamp in window:
    if RUN.encode() in line:
        for item in dicts(obj):
            for key in ('traceId', 'operationTraceId'):
                value = item.get(key)
                if isinstance(value, str) and re.fullmatch('[0-9a-f]{32}', value):
                    traces.add(value)

numbers = {'pid', 'threadId', 'elapsedMs', 'durationMs', 'waitMs', 'holderElapsedMs',
           'completionDelayMs', 'mutationQueueWaitMs', 'lifecycleQueueWaitMs',
           'identityCount', 'omittedObservations', 'queueDepth', 'queued', 'active', 'waiting'}
booleans = {'holderObserved', 'holderSignalAborted', 'signalAborted', 'isMainThread'}
labels = {'operation', 'holderOperation', 'mutationKind', 'holderMutationKind',
          'phase', 'holderPhase', 'queueKind', 'operationLabel', 'requestClass'}
ids = {'operationId', 'holderOperationId', 'diagnosticEpoch', 'sessionScopeHash',
       'holderSessionScopeHash', 'identityHash', 'traceId', 'operationTraceId',
       'holderTraceId', 'spanId', 'operationSpanId', 'holderSpanId'}
projected = []
excluded_other_pid = 0
for obj, line, stamp in window:
    text = line.decode('utf8', errors='replace').lower()
    if 'session lifecycle queue waiting' in text:
        kind = 'session_lifecycle_queue_waiting'
    elif 'slow session lifecycle operation' in text:
        kind = 'slow_session_lifecycle_operation'
    elif 'sqlite' in text and any(x in text for x in ('write', 'writer', 'holder', 'operation', 'waiting')):
        kind = 'sqlite_operation_metadata_candidate'
    else:
        continue
    items = list(dicts(obj))
    pids = {v['pid'] for v in items if type(v.get('pid')) is int}
    if pids and PID not in pids:
        excluded_other_pid += 1
        continue
    known_trace = any(v.get(k) in traces for v in items for k in ('traceId', 'operationTraceId', 'holderTraceId'))
    same_run = RUN.encode() in line
    fields = {}
    for item in items:
        for key, value in item.items():
            if key in numbers and type(value) in (int, float):
                fields[key] = value
            elif key in booleans and type(value) is bool:
                fields[key] = value
            elif key in labels and isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:/-]{1,80}', value) and '/' not in value:
                fields[key] = value
            elif key in ids and isinstance(value, str):
                fields[key + 'Digest'] = digest(value.encode())
    projected.append({'utc': stamp, 'kind': kind, 'originalLineSha256': digest(line),
                      'attribution': 'exact_run' if same_run else 'known_trace' if known_trace else 'original_pid_only' if PID in pids else 'time_window_only_not_identity_proof',
                      'fields': fields})

snapshot_path = Path('/Users/zangtao/.openclaw/logs/stability/openclaw-stability-2026-11-02T11-46-18-861Z-14106-gateway.restart_shutdown_timeout.json')
snap_raw = snapshot_path.read_bytes()
snapshot = json.loads(snap_raw)
assert snapshot['process']['pid'] == PID
snapshot_types = {}
snapshot_candidates = []
for event in snapshot['snapshot']['events']:
    if not LO * 1000 <= event.get('ts', -1) <= HI * 1000:
        continue
    kind = event.get('type', '')
    snapshot_types[kind] = snapshot_types.get(kind, 0) + 1
    if 'sqlite' in kind.lower() or 'lifecycle' in kind.lower():
        snapshot_candidates.append({'seq': event.get('seq'), 'ts': event['ts'], 'type': kind,
                                    'numericFields': {k:v for k,v in event.items() if k in numbers and type(v) in (int,float)}})

result = {'schemaVersion': 1, 'scope': {'originalPid': PID, 'from': START, 'through': END,
          'readPasses': 1, 'runIdentityFrom': 'REPORT.json', 'bodyAndSecretOutput': False,
          'excluded': 'No session store, SQLite database, source body, system log query, live status, service or model operation.'},
          'log': {'basename': log.name, 'prefixBytes': size, 'prefixSha256': digest(raw),
                  'windowRecords': len(window), 'knownTraceCount': len(traces),
                  'otherPidCandidatesExcluded': excluded_other_pid, 'records': projected},
          'snapshot': {'basename': snapshot_path.name, 'sha256': digest(snap_raw),
                       'windowTypeCounts': snapshot_types, 'matchingRecords': snapshot_candidates},
          'limitations': 'Only the fixed daily structured log and the known original-PID stability snapshot. No matching record is not proof no write/queue existed: diagnostics may be disabled, sampled, omitted, or emitted only at completion. Time-only records cannot establish request identity.'}
target = HERE / 'EXISTING-WAIT-METADATA.json'
with target.open('x') as file:
    json.dump(result, file, ensure_ascii=False, indent=2)
    file.write('\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
