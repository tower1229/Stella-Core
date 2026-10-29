import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { treeManifest } from './lib/package-evidence.mjs';
import { superviseOwnerSuite } from './lib/sdk-owner-supervisor.mjs';

// Focused artifact consumer only. Deliberately separate from formal acceptance.
const exec = promisify(execFile), require = createRequire(import.meta.url);
const repo = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--revision', '--sdk-root', '--out']); assert.equal(args.length, 6);
const revision = args[1], sdk = await realpath(args[3]), out = path.resolve(args[5]);
assert.match(revision, /^[a-f0-9]{40}$/); await mkdir(out); // Never overwrite evidence.
const run = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stella-focused-consumer-run-')));
const source = path.join(run, 'source'), consumer = path.join(run, 'consumer');
const sha = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const evidence = { schemaVersion: 'stella.focused-correction-consumer/v1', status: 'running', sourceRevision: revision,
  scope: 'focused_consumer_offline', actualHostAccepted: false, realModelAccepted: false, fullMemoryAccepted: false,
  formalConsumerAcceptance: false, freshDependencyInstall: false, commands: [], cleanup: 'pending' };
let suite, failure, consumerStarted = false, commandsHealthy = true;
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0', NODE_DISABLE_COMPILE_CACHE: '1', JITI_FS_CACHE: '0', OPENCLAW_LOAD_SHELL_ENV: '0' };
const save = () => writeFile(path.join(out, 'RESULT.json'), JSON.stringify(evidence, null, 2) + '\n');
async function command(name, binary, argv, cwd) {
  try {
    const r = await exec(binary, argv, { cwd, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(path.join(out, name + '.log'), r.stdout + r.stderr);
    evidence.commands.push({ name, exitCode: 0, logSha256: sha(Buffer.from(r.stdout + r.stderr)) }); return r.stdout;
  } catch (error) {
    // Trusted build commands are settled on a normal numeric exit. A killed,
    // signaled or unstarted command has uncertain descendants: retain the run.
    commandsHealthy = typeof error.code === "number" && !error.killed && !error.signal;
    await writeFile(path.join(out, name + '.log'), (error.stdout ?? '') + (error.stderr ?? ''));
    evidence.commands.push({ name, exitCode: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? false }); throw error;
  }
}
async function packageRoot(resolver, name) {
  let dir = path.dirname(resolver.resolve(name));
  for (;;) {
    try { if ((await json(path.join(dir, 'package.json'))).name === name) return await realpath(dir); } catch {}
    assert.notEqual(path.dirname(dir), dir, 'dependency root unavailable'); dir = path.dirname(dir);
  }
}
const copied = new Map(), dependencyCopies = {};
let fixedLock;
async function copyDependency(name, resolver) {
  let from = await packageRoot(resolver, name), metadata = await json(path.join(from, 'package.json'));
  const expectedVersion = fixedLock.packages['node_modules/' + name]?.version;
  assert.ok(expectedVersion, 'runtime dependency absent from fixed lock');
  let donor = 'existing_workspace_dependency';
  if (metadata.version !== expectedVersion) {
    evidence.dependencySelection ??= [];
    evidence.dependencySelection.push({ name, rejectedWorkspaceVersion: metadata.version, requiredVersion: expectedVersion });
    from = await packageRoot(createRequire(path.join(sdk, 'package.json')), name);
    metadata = await json(path.join(from, 'package.json')); donor = 'explicit_existing_sdk_dependency';
  }
  assert.equal(metadata.version, expectedVersion, 'no existing dependency matches fixed lock');
  if (copied.has(name)) { assert.equal(copied.get(name), metadata.version, 'dependency collision'); return; }
  copied.set(name, metadata.version);
  const destination = path.join(consumer, 'node_modules', name);
  await cp(from, destination, { recursive: true, dereference: true });
  const original = await treeManifest(from), copiedFiles = await treeManifest(destination);
  assert.equal(original.digest, copiedFiles.digest, 'runtime dependency copy differs');
  dependencyCopies[name] = { donor, version: metadata.version, files: original.entries.length, manifestSha256: original.digest, packageSha256: sha(await readFile(path.join(from, 'package.json'))) };
  const next = createRequire(path.join(from, 'package.json'));
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyDependency(dependency, next);
}
try {
  const sdkMetadata = await json(path.join(sdk, 'package.json'));
  assert.equal(sdkMetadata.name, 'openclaw'); assert.equal(sdkMetadata.version, '2026.10.8');
  assert.ok(!sdk.startsWith(repo + path.sep), 'consumer peer must be an explicit installation outside workspace');
  await command('clone-fixed-source', 'git', ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', repo, source], run);
  await command('checkout-fixed-source', 'git', ['checkout', '--quiet', '--detach', revision], source);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: source, env })).stdout.trim(), revision);
  // A real ignored node_modules directory, with build-only bindings. A symlink
  // at the directory itself is not ignored by Git's node_modules/ rule.
  await mkdir(path.join(source, 'node_modules'));
  for (const name of await readdir(path.join(repo, 'node_modules')))
    await symlink(path.join(repo, 'node_modules', name), path.join(source, 'node_modules', name));
  await command('build', process.execPath, [path.join(source, 'scripts/compile.mjs'), 'build'], source);
  const buildIdentity = await json(path.join(source, 'dist/build-identity.json'));
  evidence.buildIdentity = buildIdentity;
  assert.equal(buildIdentity.coreRevision, revision); assert.equal(buildIdentity.sourceClean, true);
  const npmBin = await realpath((await exec('which', ['npm'])).stdout.trim());
  await writeFile(path.join(run, 'user.npmrc'), ''); await writeFile(path.join(run, 'global.npmrc'), '');
  const pack = JSON.parse(await command('pack', process.execPath, [npmBin, 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', out,
    '--cache', path.join(run, 'pack-cache'), '--userconfig=' + path.join(run, 'user.npmrc'), '--globalconfig=' + path.join(run, 'global.npmrc')], source));
  assert.equal(pack.length, 1);
  const tgz = path.join(out, pack[0].filename), expectedFiles = Object.fromEntries(await Promise.all(pack[0].files.map(async f => [f.path, sha(await readFile(path.join(source, f.path)))])));
  for (const required of ['dist/src/plugin.js', 'dist/src/canghai/authorized-exact-readback.js', 'dist/src/openclaw/checkpoint-correction-readback.js', 'openclaw.plugin.json']) assert.ok(expectedFiles[required], required);
  assert.ok(!Object.keys(expectedFiles).some(p => p.startsWith('src/') || p.startsWith('tests/') || p.startsWith('.test-dist/')));
  evidence.artifact = { sha256: sha(await readFile(tgz)), files: Object.keys(expectedFiles).length, buildIdentity, unpackMethod: 'safe local tgz extraction into consumer node_modules; not npm ci or a fresh dependency installation' };
  await mkdir(path.join(consumer, 'node_modules/@tower1229/stella-core'), { recursive: true });
  await command('safe-unpack', 'python3', ['-B', '-c', `import tarfile,pathlib,sys,shutil
with tarfile.open(sys.argv[1]) as t:
 for m in t.getmembers():
  p=pathlib.PurePosixPath(m.name);assert p.parts[0]=='package' and '..' not in p.parts and not p.is_absolute()
  assert m.isfile() or m.isdir()
 for m in t.getmembers():
  dest=pathlib.Path(sys.argv[2]).joinpath(*pathlib.PurePosixPath(m.name).parts)
  if m.isdir(): dest.mkdir(parents=True,exist_ok=True)
  else:
   dest.parent.mkdir(parents=True,exist_ok=True)
   with dest.open('wb') as output: shutil.copyfileobj(t.extractfile(m),output)
`, tgz, path.join(run, 'unpacked')], run);
  const artifact = path.join(consumer, 'node_modules/@tower1229/stella-core');
  await cp(path.join(run, 'unpacked/package'), artifact, { recursive: true });
  const metadata = await json(path.join(artifact, 'package.json'));
  const lock = fixedLock = await json(path.join(source, 'package-lock.json'));
  for (const name of Object.keys(metadata.dependencies)) await copyDependency(name, require);
  for (const [name, version] of copied) assert.equal(lock.packages['node_modules/' + name]?.version, version, 'copied runtime dependency differs from fixed lock');
  assert.equal(metadata.openclaw.build.pluginSdkVersion, sdkMetadata.version);
  await symlink(sdk, path.join(consumer, 'node_modules/openclaw'), 'dir');
  await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  await writeFile(path.join(consumer, 'expected.json'), JSON.stringify({ artifactFiles: expectedFiles, sdkVersion: sdkMetadata.version, sdkRoot: sdk }));
  evidence.dependencies = { method: 'copied existing runtime dependency closure; explicit existing SDK peer', versions: Object.fromEntries(copied), copies: dependencyCopies, sdkVersion: sdkMetadata.version, sdkPackageSha256: sha(await readFile(path.join(sdk, 'package.json'))) };
  const harness = path.join(consumer, 'harness'); await mkdir(harness);
  const ts = require('typescript'); evidence.fixtureAdapters = {};
  for (const name of ['consciousness-fixture', 'checkpoint-agent-supply-fixture', 'checkpoint-work-fixture', 'checkpoint-agent-correction-supply.test']) {
    let original = await readFile(path.join(source, 'tests', name + '.ts'), 'utf8'), text = original;
    if (name.endsWith('.test')) {
      text = text.slice(0, text.indexOf('test("correction is opt-in'));
      text = text.replace('import { registerCheckpointPlugin } from "../src/openclaw/checkpoint-plugin-registration.js";', 'import entry from "@tower1229/stella-core"; const registerCheckpointPlugin = api => entry.register(api);');
      text = text.replace('async function fixture(', 'export async function fixture(');
      // Parent owns all temporary roots until the entire consumer process exits.
      text = text.replace('t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true }); });', '');
    }
    text = text.replaceAll('"../src/', '"@tower1229/stella-core/dist/src/').replaceAll('./consciousness-fixture.js', './consciousness-fixture.mjs').replaceAll('./checkpoint-agent-supply-fixture.js', './checkpoint-agent-supply-fixture.mjs').replaceAll('./checkpoint-work-fixture.js', './checkpoint-work-fixture.mjs');
    const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const dest = name.endsWith('.test') ? 'registered-fixture.mjs' : name + '.mjs';
    await writeFile(path.join(harness, dest), result);
    evidence.fixtureAdapters[name] = { originalSha256: sha(Buffer.from(original)), adaptedHarnessSha256: sha(Buffer.from(result)), productionImports: 'installed package only' };
  }
  for (const name of ['sdk-owner-supervisor.mjs', 'owned-node-test-suite.mjs']) await cp(path.join(repo, 'scripts/lib', name), path.join(harness, name));
  await cp(path.join(repo, 'scripts/lib/focused-correction-consumer-probe.mjs'), path.join(harness, 'probe.test.mjs'));
  await writeFile(path.join(harness, 'module-audit.mjs'), `import { registerHooks } from 'node:module';import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';
const roots=${JSON.stringify([consumer, sdk])};const audit={files:[],denied:[]};globalThis[Symbol.for('stella.focused.consumer.audit')]=audit;
registerHooks({resolve(specifier,context,next){const r=next(specifier,context);if(r.url.startsWith('file:')){const p=realpathSync(fileURLToPath(r.url));if(!roots.some(root=>p===root||p.startsWith(root+'/'))){audit.denied.push(p);throw Error('FOCUSED_CONSUMER_MODULE_OUTSIDE_BOUNDARY');}if(!audit.files.includes(p))audit.files.push(p);}return r;}});
`);
  const state = path.join(run, 'state'); await mkdir(state); await mkdir(path.join(run, 'tmp'));
  const config = path.join(run, 'openclaw.json'); await writeFile(config, '{"plugins":{"enabled":false},"agents":{"entries":{"synthetic":{"workspace":"' + run + '/workspace"}}}}');
  const childEnv = { ...env, TMPDIR: path.join(run, 'tmp'), OPENCLAW_HOME: path.join(run, 'home'), OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config, OPENCLAW_WORKSPACE_DIR: path.join(run, 'workspace'), XDG_CONFIG_HOME: path.join(run, 'xdg-config'), XDG_CACHE_HOME: path.join(run, 'xdg-cache'), XDG_DATA_HOME: path.join(run, 'xdg-data') };
  const stdout = createWriteStream(path.join(out, 'consumer.stdout')), stderr = createWriteStream(path.join(out, 'consumer.stderr'));
  consumerStarted = true;
  try { suite = await superviseOwnerSuite({ files: [path.join(harness, 'probe.test.mjs')], ownerFile: path.join(harness, 'probe.test.mjs'), cwd: consumer, env: childEnv, timeoutMs: 180_000, stdout, stderr }); }
  finally { stdout.end(); stderr.end(); await Promise.all([finished(stdout), finished(stderr)]); }
  evidence.suite = suite;
  const observed = await json(path.join(consumer, 'consumer-result.json'));
  evidence.consumer = { ...observed, moduleAudit: { files: observed.moduleAudit.files.map(p => p.startsWith(consumer) ? p.slice(consumer.length + 1) : 'PUBLIC_SDK/' + p.slice(sdk.length + 1)), denied: observed.moduleAudit.denied } };
  await writeFile(path.join(out, 'consumer-result.json'), JSON.stringify(evidence.consumer, null, 2));
  assert.ok(suite.passed, 'focused consumer suite failed');
  assert.equal(observed.moduleAudit.denied.length, 0); assert.equal(observed.groups.length, 4);
  assert.equal(observed.additionalChecks?.failedReadRetry?.status, 'passed');
  assert.equal(observed.additionalChecks?.symlinkAudit?.status, 'passed');
  assert.equal(observed.requestFreshness?.status, 'passed');
  assert.equal(observed.reducedPermissionFreshness?.status, 'passed');
  evidence.status = 'passed_focused_consumer_offline';
} catch (error) {
  failure = error; evidence.status = 'failed_focused_consumer_offline'; evidence.error = { code: error.code ?? null, message: error.message };
} finally {
  if (commandsHealthy && (!consumerStarted || suite?.group?.confirmedGone)) { await rm(run, { recursive: true, force: true }); evidence.cleanup = 'owned runtime removed after child completion'; }
  else evidence.cleanup = 'retained: process group stop not confirmed';
  await save();
}
if (failure) { process.stderr.write(`${failure.message}\nEvidence: ${out}\n`); process.exitCode = 1; }
else process.stdout.write(`Focused consumer passed; evidence: ${out}\n`);
