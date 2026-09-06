import assert from "node:assert/strict";
import test from "node:test";
import { admitCompletionOnce, openCompletionAdmissionJournal, type CompletionAdmission } from "../src/openclaw/completion-admission.js";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("file journal reserves a request across reopened instances", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-admission-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { agentId: "test", runId: "durable-request", sessionKey: "session", resourceScope: "root", prompt: "question" };
  await admitCompletionOnce(await openCompletionAdmissionJournal(root), input);
  await assert.rejects(admitCompletionOnce(await openCompletionAdmissionJournal(root), input), /run_recovery_required/);
  const moduleUrl = new URL("../src/openclaw/completion-admission.js", import.meta.url).href;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import {admitCompletionOnce,openCompletionAdmissionJournal} from ${JSON.stringify(moduleUrl)};
     try { await admitCompletionOnce(await openCompletionAdmissionJournal(${JSON.stringify(root)}), ${JSON.stringify(input)}); process.exitCode=2; }
     catch(error) { console.log(error.category); }`]);
  assert.equal(child.stdout.trim(), "run_recovery_required");
  const directory = path.join(root, "plugins/stella-core/completion-admissions");
  const file = path.join(directory, (await readdir(directory))[0]!);
  await writeFile(file, "{");
  await assert.rejects(admitCompletionOnce(await openCompletionAdmissionJournal(root), input), /admission_store_unavailable/);
  assert.equal(await readFile(file, "utf8"), "{");
});

test("one atomic admission survives new adapter instances and rejects identity substitution", async () => {
  const retained = new Map<string, CompletionAdmission>();
  const openStore = () => ({
    async registerIfAbsent(key: string, value: CompletionAdmission) {
      if (retained.has(key)) return false;
      retained.set(key, structuredClone(value)); return true;
    },
    async lookup(key: string) { return retained.get(key); },
  });
  const input = { agentId: "test", runId: "request-id", sessionKey: "test-session", resourceScope: "private-repo", prompt: "private prompt" };
  const results = await Promise.allSettled([admitCompletionOnce(openStore(), input), admitCompletionOnce(openStore(), input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(admitCompletionOnce(openStore(), input), /run_recovery_required/);
  for (const change of [{ prompt: "replacement" }, { sessionKey: "other-session" }, { resourceScope: "other-root" }]) {
    await assert.rejects(admitCompletionOnce(openStore(), { ...input, ...change }), /run_identity_conflict/);
  }
  assert.equal(JSON.stringify([...retained.values()]).includes(input.prompt), false);
  assert.equal(JSON.stringify([...retained.values()]).includes(input.resourceScope), false);
});

test("uncertain state-store writes do not admit work or leak the backend error", async () => {
  await assert.rejects(admitCompletionOnce({
    async registerIfAbsent() { throw new Error("private database path"); }, async lookup() { return undefined; },
  }, { agentId: "test", runId: "run", sessionKey: "session", resourceScope: "root", prompt: "question" }), /admission_store_unavailable/);
});
