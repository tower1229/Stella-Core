import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Read-only inspection of the exact installed SDK and native implementation.
// Internal implementation files are read as evidence, never imported or run.
const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = await realpath(path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw")));
const output = path.resolve(process.argv[2] ?? path.join(root, ".artifacts/issue23-dreaming-seams/interfaces.json"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = new Map();
async function source(relative) {
  if (files.has(relative)) return files.get(relative);
  const bytes = await readFile(path.join(hostRoot, relative));
  const parsed = ts.createSourceFile(relative, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
  const result = { bytes, parsed, sha256: hash(bytes) };
  files.set(relative, result); return result;
}
function declarations(parsed, name) {
  const result = parsed.statements.find(node => (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === name);
  assert.ok(result, `Missing pinned SDK type: ${name}`); return result;
}
function members(parsed, node, seen = new Set()) {
  if (ts.isTypeAliasDeclaration(node)) return members(parsed, node.type, seen);
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) return [...node.members];
  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(type => members(parsed, type, seen));
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !seen.has(node.typeName.text)) {
    seen.add(node.typeName.text);
    const reference = parsed.statements.find(item => (ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item)) && item.name.text === node.typeName.text);
    if (reference) return members(parsed, reference, seen);
  }
  return [];
}
function fields(parsed, name) {
  return members(parsed, declarations(parsed, name)).map(member => ({ name: member.name?.getText(parsed),
    type: member.type?.getText(parsed), line: parsed.getLineAndCharacterOfPosition(member.getStart(parsed)).line + 1 }));
}
function exports(parsed) {
  return parsed.statements.filter(ts.isExportDeclaration).flatMap(node =>
    node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map(item => item.name.text) : []);
}
function publicTypeFile(parsed, name) {
  const item = parsed.statements.find(node => ts.isImportDeclaration(node) && node.importClause?.namedBindings &&
    ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(element => element.name.text === name));
  assert.ok(item && ts.isStringLiteral(item.moduleSpecifier), `Missing SDK type import ${name}`);
  const relative = path.posix.normalize(path.posix.join("dist/plugin-sdk", item.moduleSpecifier.text.replace(/\.js$/, ".d.ts")));
  assert.ok(relative.startsWith("dist/") && !relative.includes("../")); return relative;
}
function codeEvidence(relative, name) {
  const { parsed } = files.get(relative);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing pinned native function ${name}`);
  return { path: relative, function: name, line: parsed.getLineAndCharacterOfPosition(declaration.getStart(parsed)).line + 1,
    functionSha256: hash(declaration.getText(parsed)) };
}
const pkg = JSON.parse((await source("package.json")).bytes);
assert.equal(pkg.version, "2026.8.2");
const entry = (await source("dist/plugin-sdk/plugin-entry.d.ts")).parsed;
const runtimeFile = publicTypeFile(entry, "OpenClawPluginApi"), hooksFile = publicTypeFile(entry, "PluginHookSkillBundleSnapshot");
const runtime = (await source(runtimeFile)).parsed, hooks = (await source(hooksFile)).parsed;
const sdk = {};
for (const name of ["memory-host-core", "memory-core-host-runtime-core", "memory-core-host-runtime-files", "memory-host-events", "plugin-runtime"]) {
  assert.ok(pkg.exports[`./plugin-sdk/${name}`], `Not a public SDK namespace: ${name}`);
  sdk[name] = exports((await source(`dist/plugin-sdk/${name}.js`)).parsed);
}
const hookNames = declarations(hooks, "PluginHookName").type.types.map(node => node.literal?.text).filter(Boolean);
const types = {};
for (const name of ["OpenClawPluginApi", "MemoryPluginCapability", "MemoryPluginRuntime", "MemoryCorpusSupplement", "MemoryPluginPublicArtifact",
  "PluginRuntimeLifecycleRegistration", "SubagentRunParams", "SubagentRunResult", "LlmDirectCompleteParams", "LlmCompleteCommonParams", "LlmCompleteResult", "ContextEngine"]) types[name] = fields(runtime, name);
for (const name of ["PluginHookBeforeAgentReplyEvent", "PluginHookBeforeAgentReplyResult", "PluginHookBeforeAgentRunEvent",
  "PluginAgentTurnPrepareEvent", "PluginAgentTurnPrepareResult", "PluginHookBeforeMessageWriteEvent", "PluginHookBeforeMessageWriteResult",
  "PluginHookHandlerMap", "PluginHookLlmInputEvent", "PluginHookLlmOutputEvent", "PluginHookBeforeAgentFinalizeEvent", "PluginHookBeforeAgentFinalizeResult"]) types[name] = fields(hooks, name);
const nativeSites = [
  ["dist/dreaming-BtRc_74l.js", "runShortTermDreamingPromotionIfTriggered"],
  ["dist/dreaming-narrative-D6hU_b7Q.js", "startNarrativeRunOrFallback"],
  ["dist/dreaming-narrative-D6hU_b7Q.js", "appendNarrativeEntry"],
  ["dist/dreaming-narrative-D6hU_b7Q.js", "appendFallbackNarrativeEntry"],
  ["dist/dreaming-phases-D6ou-Hmv.js", "runLightDreaming"],
  ["dist/dreaming-phases-D6ou-Hmv.js", "runRemDreaming"],
  ["dist/dreaming-dreams-file-Bq1YQ9a1.js", "updateDreamsFile"],
  ["dist/dreaming-dreams-file-Bq1YQ9a1.js", "writeDreamsFileAtomic"],
  ["dist/short-term-promotion-BCGI4auj.js", "applyShortTermPromotions"],
  ["dist/memory-entry-origins-CCiwtjR7.js", "writeMemoryContent"],
  ["dist/memory-artifact-provenance-BcOUEP3n.js", "normalizeMemoryArtifactRelativePath"],
  ["dist/memory-artifact-provenance-BcOUEP3n.js", "toPublicProvenance"],
  ["dist/hook-runner-global-ac8FBwry.js", "createHookRunner"],
  ["dist/hook-helpers-B4NmqFRB.js", "runAgentHarnessBeforeMessageWriteHook"],
];
for (const [file] of nativeSites) await source(file);
const core = [];
for (const relative of ["src/openclaw/host-memory-provider.ts", "src/openclaw/host-memory-acceptance.ts", "src/openclaw/host-history-compaction.ts",
  "src/openclaw/host-context-authority.ts", "src/openclaw/host-context-view.ts", "src/canghai/memory-transaction.ts", "src/canghai/synchronize.ts"]) {
  core.push({ path: relative, sha256: hash(await readFile(path.join(root, relative))) });
}
const report = { schemaVersion: "stella.dreaming-public-interface-audit/v1", scope: "read-only exact Host interface and native call-site inspection",
  auditVersion: "public-sdk-and-native-publish-chain/v1", hostVersion: pkg.version,
  coreRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceClean: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
  publicMemoryNamespaces: Object.keys(pkg.exports).filter(key => key.includes("memory") || key.includes("dream")),
  sdk, hookNames, types, nativeSites: nativeSites.map(([file, name]) => codeEvidence(file, name)), core,
  hostFiles: [...files].map(([file, value]) => ({ path: file, sha256: value.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
  nativePublishAdapter: "no_supported_adapter_identified_in_this_audit", qualifiedDreamingVerified: false,
  productionMutation: false, externalModelRequests: 0, issue23Complete: false };
report.hostInterfaceSha256 = hash(JSON.stringify({ sdk, hookNames, types, files: report.hostFiles }));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify({ report: output, coreRevision: report.coreRevision, hostInterfaceSha256: report.hostInterfaceSha256,
  hostFiles: report.hostFiles.length, hookNames: hookNames.length, nativePublishAdapter: report.nativePublishAdapter }) + "\n");
