// Fixed local OpenClaw 2026.10.9 source replay. Synthetic collaborators only;
// never import the Host runtime, read a user workspace/database, or send a call.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
const root = new URL("../../../../", import.meta.url);
const pins = {
  "attempt-system-prompt-prepare-ChKsbjSh.mjs": "99bb65a40f568e2953aac51a599bc76d8e9fcb9fd02e5daa76f082a9340b439c",
  "embedded-agent-DoEPu8ye.mjs": "21a06d87da38b464c600a7447fd79d03be1f376e9e275cf1f1ece297a029cdbb",
  "extensions/memory-core/index.js": "e7c8f538275bc8df8272337f3c95d2e38dd23e9e8a1fdb96422c17f19200a8aa",
};
const sources = {};
for (const [file, pin] of Object.entries(pins)) {
  const bytes = await readFile(new URL(`node_modules/openclaw/dist/${file}`, root));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin);
  sources[file] = bytes.toString("utf8");
}
const bootstrapSource = sources[Object.keys(pins)[0]];
const a = bootstrapSource.indexOf("async function resolveAttemptBootstrapContext(params) {");
const b = bootstrapSource.indexOf("\n/**", a);
assert.ok(a > 0 && b > a);
const resolve = vm.runInNewContext(`(${bootstrapSource.slice(a, b).trim()})`, {
  isHeartbeatLifecycleRunKind: () => false,
  isUnreadableWorkspaceBootstrapFile: () => false,
}, { timeout: 1000 });
const outcomes = [];
for (const mode of ["always", "never"]) {
  let reads = 0;
  const value = await resolve({ contextInjectionMode: mode, bootstrapMode: "full", bootstrapContextRunKind: "default",
    deliversCompleteWorkspaceContext: true, hasCompletedBootstrapTurn: async () => false,
    resolveBootstrapContextForRun: async () => { reads++; return {
      bootstrapFiles: [{ name: "USER.md", content: "SYNTHETIC USER" }, { name: "MEMORY.md", content: "SYNTHETIC MEMORY" }],
      contextFiles: [{ path: "synthetic-canonical-workspace" }],
    }; } });
  assert.equal(reads, mode === "always" ? 1 : 0);
  assert.equal(value.bootstrapFiles.length, mode === "always" ? 2 : 0);
  outcomes.push({ case: `official bootstrap ${mode}`, pass: true, resolverCalls: reads, files: value.bootstrapFiles.length });
}
assert.ok(sources["embedded-agent-DoEPu8ye.mjs"].includes("bootstrapWorkspaceDir: canonicalWorkspace"));
assert.ok(bootstrapSource.includes("const bootstrapWorkspaceDir = attempt.bootstrapWorkspaceDir ?? params.setup.resolvedWorkspace;"));
outcomes.push({ case: "empty execution workspace does not replace canonical bootstrap workspace", pass: true, kind: "static callsite" });
const memory = sources["extensions/memory-core/index.js"];
const start = memory.indexOf('api.on("before_prompt_build", ');
const end = memory.indexOf('\n\t\tapi.on("before_agent_reply"', start);
assert.ok(start > 0 && end > start);
let handler, matched = 0;
vm.runInNewContext(memory.slice(start, end), {
  api: { on(name, fn) { assert.equal(name, "before_prompt_build"); handler = fn; }, runtime: { config: { current: () => ({}) } }, logger: {} },
  resolveSessionAgentIdStrict: () => "main",
  loadStandingIntentsModule: async () => ({
    isEligibleStandingIntentTurn: () => true,
    matchStandingIntents: async () => { matched++; return [{ text: "SYNTHETIC STANDING INTENT" }]; },
    buildStandingIntentContext: () => "SYNTHETIC STANDING INTENT",
  }),
}, { timeout: 1000 });
const hookResult = await handler({ prompt: "synthetic question", messages: [] }, {
  trigger: "user", sessionKey: "agent:main:brand-new-synthetic", hookInvocation: { assertActive() {} },
});
assert.equal(matched, 1); assert.equal(hookResult.prependContext, "SYNTHETIC STANDING INTENT");
outcomes.push({ case: "new empty-history user turn still invokes standing-intent prompt hook", pass: true, matcherCalls: matched });
process.stdout.write(JSON.stringify({ sdk: "2026.10.9", pins, outcomes, total: 4, pass: 4,
  liveHostExecuted: false, realWorkspaceOrDatabaseRead: false, providerCalls: 0,
  conclusion: "Current empty-worktree proposal does not prove USER/MEMORY or standing-intent exclusion." }, null, 2) + "\n");
