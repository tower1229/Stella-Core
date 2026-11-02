"""Build a textual candidate only; never write installed SDK sources."""
from pathlib import Path
import difflib
import hashlib
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DIST = ROOT / 'node_modules/openclaw/dist'
expected = json.loads((HERE / 'WAIT-BOUNDARY-DIAGNOSIS.json').read_text())['sourceEvidence']
changes = {}
def edit(name, replacements):
    source = (DIST/name).read_text()
    assert hashlib.sha256(source.encode()).hexdigest() == expected[name]['sha256'], name
    new = source
    for old, replacement in replacements:
        assert new.count(old) == 1, (name, old)
        new = new.replace(old, replacement)
    new = 'import { enterWait, exitWait } from "./core-wait-observation.mjs";\n' + new
    changes[name] = (source, new)

edit('user-turn-transcript-DuAfBkUt.mjs', [(
'''\t\tif (runtimePersistencePromise) try {
\t\t\tawait runtimePersistencePromise;
\t\t} catch (error) {
\t\t\thandlePersistenceError(error);
\t\t}
\t\tawait admissionWrite;''',
'''\t\tif (runtimePersistencePromise) {
\t\t\tconst observation = enterWait("recorder.runtime");
\t\t\ttry {
\t\t\t\tawait runtimePersistencePromise;
\t\t\t} catch (error) {
\t\t\t\thandlePersistenceError(error);
\t\t\t} finally {
\t\t\t\texitWait(observation);
\t\t\t}
\t\t}
\t\tconst observation = enterWait("recorder.admission");
\t\ttry {
\t\t\tawait admissionWrite;
\t\t} finally {
\t\t\texitWait(observation);
\t\t}''')])
edit('attempt-system-prompt-prepare-ChKsbjSh.mjs', [(
'''\t\t\tawait params.recorder?.waitForRuntimePersistence();
\t\t\tassertCurrent();''',
'''\t\t\tconst observation = enterWait("projection.recorder");
\t\t\ttry {
\t\t\t\tawait params.recorder?.waitForRuntimePersistence();
\t\t\t} finally {
\t\t\t\texitWait(observation);
\t\t\t}
\t\t\tassertCurrent();'''),(
'''\t\t\t\t\t\tconst captured = await (params.withTranscriptWrite ? params.withTranscriptWrite(capture) : capture());''',
'''\t\t\t\t\t\tconst writeObservation = enterWait("projection.write");
\t\t\t\t\t\tlet captured;
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tcaptured = await (params.withTranscriptWrite ? params.withTranscriptWrite(capture) : capture());
\t\t\t\t\t\t} finally {
\t\t\t\t\t\t\texitWait(writeObservation);
\t\t\t\t\t\t}''')])
edit('agent-core-D7okjbP7.mjs', [(
'''\t\tfor (const listener of this.listeners) try {
\t\t\tawait listener(event, signal);
\t\t} finally {
\t\t\tif (publishedToolResult''',
'''\t\tfor (const listener of this.listeners) {
\t\t\tconst observation = enterWait("agent.listener");
\t\t\ttry {
\t\t\t\tawait listener(event, signal);
\t\t\t} finally {
\t\t\t\texitWait(observation);
\t\t\t\tif (publishedToolResult'''),(
'''\t\t\t\tpublishedToolResult = event.message;
\t\t\t\tthis.mutableState.messages[messageIndex] = publishedToolResult;
\t\t\t}
\t\t}
\t}
};''',
'''\t\t\t\t\tpublishedToolResult = event.message;
\t\t\t\t\tthis.mutableState.messages[messageIndex] = publishedToolResult;
\t\t\t\t}
\t\t\t}
\t\t}
\t}
};''')])
patch = []
for name, (old, new) in changes.items():
    patch.extend(difflib.unified_diff(old.splitlines(True),new.splitlines(True),
        fromfile='a/node_modules/openclaw/dist/'+name,tofile='b/node_modules/openclaw/dist/'+name))
helper = (HERE/'WAIT-OBSERVATION.mjs').read_text()
patch.extend(difflib.unified_diff([],helper.splitlines(True),fromfile='/dev/null',tofile='b/node_modules/openclaw/dist/core-wait-observation.mjs'))
(HERE/'UPSTREAM-WAIT-OBSERVATION.patch').write_text(''.join(patch))
# JSON source fragments are not saved: validation imports this builder and runs extracted functions only.
if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == '--fragments':
        fragments = {}
        for name, marker, ending, key in [
            ('user-turn-transcript-DuAfBkUt.mjs','\tconst waitForRuntimePersistence = async () => {','\n\t};','recorder'),
            ('attempt-system-prompt-prepare-ChKsbjSh.mjs','function installModelPromptProjection(','\n}','projection'),
            ('agent-core-D7okjbP7.mjs','\tasync processEvents(event) {','\n\t}','listener')]:
            fragments[key] = {}
            for version, text in zip(['original','candidate'],changes[name]):
                start = text.index(marker); end = text.index(ending,start)+len(ending)
                fragments[key][version] = text[start:end]
        with Path(sys.argv[2]).open('x') as file:
            json.dump(fragments,file)
    print(json.dumps({'candidateOnly':True,'installedFilesChanged':False,'sourceModules':list(changes),'sha256':hashlib.sha256(''.join(patch).encode()).hexdigest()}))
