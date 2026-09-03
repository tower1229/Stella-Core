import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitCangHaiDurability } from "../src/canghai/durability.js";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ root: string; remote: string; branch: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "stella-durability-"));
  const root = path.join(parent, "work");
  const remote = path.join(parent, "remote.git");
  await execFileAsync("git", ["init", "--bare", "--quiet", remote]);
  await execFileAsync("git", ["init", "--quiet", "-b", "stella-alpha", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Stella Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@stella.invalid"]);
  await execFileAsync("git", ["-C", root, "remote", "add", "origin", remote]);
  await writeFile(path.join(root, "manifest.txt"), "base\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
  await execFileAsync("git", ["-C", root, "push", "--quiet", "-u", "origin", "stella-alpha"]);
  return { root, remote, branch: "stella-alpha" };
}

test("critical writes commit and push before reporting success", async () => {
  const { root, remote, branch } = await fixture();
  try {
    await writeFile(path.join(root, "critical.txt"), "identity update\n", "utf8");
    const durability = new GitCangHaiDurability({
      root,
      remote: "origin",
      branch,
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
    });

    const status = await durability.syncCritical(["critical.txt"], "stella: critical update");
    const { stdout: head } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    const { stdout: remoteHead } = await execFileAsync("git", [
      "--git-dir", remote, "rev-parse", "refs/heads/stella-alpha",
    ]);

    assert.equal(remoteHead.trim(), head.trim());
    assert.equal(status.criticalSynchronized, true);
    assert.equal(status.normalState, "current");
    assert.equal(status.lastErrorCategory, undefined);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test("normal writes expose pending RPO and flush to the configured remote", async () => {
  const { root, remote, branch } = await fixture();
  let scheduled: (() => void) | undefined;
  let now = Date.now();
  try {
    await writeFile(path.join(root, "normal.txt"), "ordinary learning\n", "utf8");
    const durability = new GitCangHaiDurability({
      root,
      remote: "origin",
      branch,
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
      now: () => now,
      schedule: (callback) => {
        scheduled = callback;
      },
    });

    const pending = await durability.recordNormal(["normal.txt"], "stella: normal learning");
    assert.equal(pending.normalState, "pending");
    assert.equal(pending.observedNormalRpoSeconds, 0);
    assert.ok(scheduled);

    now += 120_000;
    const observed = await durability.diagnostics();
    assert.equal(observed.normalState, "pending");
    assert.equal(observed.observedNormalRpoSeconds, 120);

    await durability.flushNormal();
    const current = await durability.diagnostics();
    const { stdout: remoteContent } = await execFileAsync("git", [
      "--git-dir", remote, "show", "refs/heads/stella-alpha:normal.txt",
    ]);
    assert.equal(remoteContent, await readFile(path.join(root, "normal.txt"), "utf8"));
    assert.equal(current.normalState, "current");
    assert.equal(current.observedNormalRpoSeconds, 0);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test("managed durability rejects policies that cannot meet the Alpha contract", async () => {
  const { root, branch } = await fixture();
  try {
    assert.throws(
      () => new GitCangHaiDurability({
        root,
        remote: "origin",
        branch,
        criticalWritePolicy: "bounded_batch",
        normalWritePolicy: "bounded_batch",
        maxNormalRpoSeconds: 300,
      }),
      /criticalWritePolicy=sync_immediately/,
    );
    assert.throws(
      () => new GitCangHaiDurability({
        root,
        remote: "origin",
        branch,
        criticalWritePolicy: "sync_immediately",
        normalWritePolicy: "bounded_batch",
        maxNormalRpoSeconds: 0,
      }),
      /positive maxNormalRpoSeconds/,
    );
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test("a restarted coordinator reconstructs pending normal RPO from Git history", async () => {
  const { root, branch } = await fixture();
  let now = Date.now();
  try {
    await writeFile(path.join(root, "normal.txt"), "ordinary learning\n", "utf8");
    const first = new GitCangHaiDurability({
      root,
      remote: "origin",
      branch,
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
      now: () => now,
      schedule() {},
    });
    await first.recordNormal(["normal.txt"], "stella: normal learning");

    now += 120_000;
    let restartDelay: number | undefined;
    const restarted = new GitCangHaiDurability({
      root,
      remote: "origin",
      branch,
      criticalWritePolicy: "sync_immediately",
      normalWritePolicy: "bounded_batch",
      maxNormalRpoSeconds: 300,
      now: () => now,
      schedule(_callback, delayMs) {
        restartDelay = delayMs;
      },
    });
    const diagnostics = await restarted.diagnostics();

    assert.equal(diagnostics.normalState, "pending");
    assert.ok(diagnostics.observedNormalRpoSeconds >= 120);
    assert.ok(diagnostics.observedNormalRpoSeconds < 121);
    assert.ok(restartDelay !== undefined && restartDelay > 179_000 && restartDelay <= 180_000);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});
