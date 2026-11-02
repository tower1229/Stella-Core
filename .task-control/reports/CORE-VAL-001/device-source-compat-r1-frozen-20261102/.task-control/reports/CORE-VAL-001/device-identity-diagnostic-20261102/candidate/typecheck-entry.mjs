import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.cwd(), base = path.resolve('.task-control/reports/CORE-VAL-001/device-identity-diagnostic-20261102');
const original = fs.readFileSync('src/ordinary-plugin.ts', 'utf8');
if (crypto.createHash('sha256').update(original).digest('hex') !== 'd1b9f34d16e1d3e07698cc50161e8942fc497ecbf2f03ccf9871fb3b9333d0d7') throw new Error('entry baseline changed');
const prefix = `import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { createTemporaryDeviceDiagnostic } from "./openclaw/temporary-device-diagnostic.js";
import { EXPECTED_REQUESTER_SHA256 } from "./openclaw/temporary-device-diagnostic-seed.js";
const inspectTemporaryDevice = createTemporaryDeviceDiagnostic(EXPECTED_REQUESTER_SHA256, getPluginRuntimeGatewayRequestScope);
`;
const candidate = prefix + original.replace('return result(status());', 'return result({ ...status(), temporaryDeviceIdentity: inspectTemporaryDevice(owner, signal) });');
const virtual = new Map([
  [path.join(root, 'src/ordinary-plugin.ts'), candidate],
  [path.join(root, 'src/openclaw/temporary-device-diagnostic.ts'), fs.readFileSync(path.join(base, 'candidate/temporary-device-diagnostic.ts'), 'utf8')],
  [path.join(root, 'src/openclaw/temporary-device-diagnostic-seed.ts'), `export const EXPECTED_REQUESTER_SHA256 = "${'0'.repeat(64)}";\n`],
]);
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const options = { ...parsed.options, noEmit: true };
const host = ts.createCompilerHost(options), readFile = host.readFile, fileExists = host.fileExists;
host.fileExists = f => virtual.has(path.resolve(f)) || fileExists(f);
host.readFile = f => virtual.get(path.resolve(f)) ?? readFile(f);
host.getSourceFile = (f, version) => { const text = host.readFile(f); return text === undefined ? undefined : ts.createSourceFile(f, text, version, true); };
const program = ts.createProgram([path.join(root, 'src/ordinary-plugin.ts'), ...parsed.fileNames.filter(f => f.endsWith('.d.ts'))], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n' })); process.exitCode = 1; }
else console.log(JSON.stringify({ typecheck: 'pass', physicalSourceEdits: 0, emittedFiles: 0, seed: 'synthetic compile-only', entrySha256: crypto.createHash('sha256').update(candidate).digest('hex') }));
