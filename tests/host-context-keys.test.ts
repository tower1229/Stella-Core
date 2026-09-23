import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeContextHistoryKeys, loadContextHistoryKeys } from "../src/openclaw/host-context-keys.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-context-keys-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "host-state"), repositoryRoot = path.join(root, "repository");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(repositoryRoot);
  return { root, stateDirectory, repositoryRoot, agentId: "stella" };
}

test("context archive keys survive reload, are pinned independently, and stay outside personal data", async t => {
  const scope = await fixture(t);
  const created = await initializeContextHistoryKeys(scope);
  const reloaded = await loadContextHistoryKeys(scope, created.signerId);
  assert.equal(reloaded.signerId, created.signerId);
  assert.equal((await stat(created.keyPath)).mode & 0o777, 0o600);
  assert.ok(created.keyPath.startsWith(`${await realpath(scope.stateDirectory)}/`));
  assert.equal(verify(null, Buffer.from("history"), reloaded.verificationKey,
    sign(null, Buffer.from("history"), created.signingKey)), true);
  const moduleUrl = new URL("../src/openclaw/host-context-keys.js", import.meta.url).href;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import { loadContextHistoryKeys } from ${JSON.stringify(moduleUrl)};
     import { verify } from 'node:crypto';
     const keys = await loadContextHistoryKeys(JSON.parse(process.argv[1]), process.argv[2]);
     if (!verify(null, Buffer.from('history'), keys.verificationKey, Buffer.from(process.argv[3], 'base64'))) throw new Error('signature mismatch');
     process.stdout.write(keys.signerId);`,
    JSON.stringify(scope), created.signerId, sign(null, Buffer.from("history"), created.signingKey).toString("base64")]);
  assert.equal(child.stdout, created.signerId);
  await assert.rejects(loadContextHistoryKeys(scope, `sha256:${"0".repeat(64)}`), /host_context_archive_signer_mismatch/);
  await assert.rejects(loadContextHistoryKeys({ ...scope, agentId: "other" }, created.signerId), /host_context_archive_key_missing/);
  const otherRepository = path.join(scope.root, "other-repository");
  await mkdir(otherRepository);
  await assert.rejects(loadContextHistoryKeys({ ...scope, repositoryRoot: otherRepository }, created.signerId), /host_context_archive_key_missing/);
  await rm(created.keyPath);
  await assert.rejects(loadContextHistoryKeys(scope, created.signerId), /host_context_archive_key_missing/);
  await assert.rejects(stat(created.keyPath), { code: "ENOENT" });
  const unsafeState = path.join(scope.repositoryRoot, "host-state");
  await mkdir(unsafeState, { mode: 0o700 });
  await assert.rejects(initializeContextHistoryKeys({ ...scope, stateDirectory: unsafeState }), /host_context_archive_key_scope_invalid/);
});

test("concurrent explicit initialization keeps one signing identity", async t => {
  const scope = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => initializeContextHistoryKeys(scope)));
  assert.equal(new Set(results.map(result => result.signerId)).size, 1);
  assert.equal((await initializeContextHistoryKeys(scope)).signerId, results[0]!.signerId);
});

test("a repository containing the signing subtree is rejected before creating a private key", async t => {
  const scope = await fixture(t);
  const repositoryRoot = path.join(scope.stateDirectory, "stella-core");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await assert.rejects(initializeContextHistoryKeys({ ...scope, repositoryRoot }), /host_context_archive_key_scope_invalid/);
  await assert.rejects(stat(path.join(repositoryRoot, "context-signing")), { code: "ENOENT" });
});

test("unsafe, substituted, and corrupt key files fail without replacement", async t => {
  const scope = await fixture(t);
  const key = await initializeContextHistoryKeys(scope);
  const original = await readFile(key.keyPath);
  await chmod(key.keyPath, 0o644);
  await assert.rejects(loadContextHistoryKeys(scope, key.signerId), /host_context_archive_key_unsafe/);
  await chmod(key.keyPath, 0o600);
  await writeFile(key.keyPath, "corrupt");
  await assert.rejects(initializeContextHistoryKeys(scope), /host_context_archive_key_invalid/);
  assert.equal(await readFile(key.keyPath, "utf8"), "corrupt");
  await rm(key.keyPath);
  const outside = path.join(scope.root, "outside.pem");
  await writeFile(outside, original, { mode: 0o600 });
  await symlink(outside, key.keyPath);
  await assert.rejects(loadContextHistoryKeys(scope, key.signerId), /host_context_archive_key_unsafe/);
});
