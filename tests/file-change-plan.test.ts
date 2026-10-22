import assert from "node:assert/strict";
import test from "node:test";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { createFileChangePlan, FileChangePlanError } from "../src/canghai/file-change-plan.js";
import type { FileChangePlanInput, ManagedPlannedFile, PlannedFileVersion } from "../src/canghai/file-change-plan-contract.js";

const before = { sha256: bytesVersion("before"), mode: 0o600 };
const after = { sha256: bytesVersion("after"), mode: 0o600 };
const file = (path: string, version: PlannedFileVersion = before, rootId = "workspace"): ManagedPlannedFile => ({ rootId, path, version });
const observation = (path: string, version: PlannedFileVersion | null, rootId = "workspace") => ({ rootId, path, version });
function input(overrides: Partial<FileChangePlanInput> = {}): FileChangePlanInput {
  return { operationId: "sq_change_1", binding: { agentId: "stella", repositoryRoot: "/synthetic/canghai", manifestPath: "stella/manifest.yaml" },
    from: { revision: "a".repeat(40), token: "checkpoint-1" }, target: { revision: "b".repeat(40), token: "checkpoint-2" },
    managedBefore: [], desired: [], observed: [], ...overrides };
}
function rejects(category: string, value: unknown): void {
  assert.throws(() => createFileChangePlan(value as FileChangePlanInput), (error: unknown) =>
    error instanceof FileChangePlanError && error.category === category && error.message === `File change plan failed: ${category}`);
}

test("plans add, modify, delete and mode changes in stable root/path order", () => {
  const mode = { ...before, mode: 0o700 };
  const plan = createFileChangePlan(input({
    managedBefore: [file("remove.md"), file("edit.md"), file("mode.sh")],
    desired: [file("new.md", after), file("mode.sh", mode), file("edit.md", after)],
    observed: [observation("remove.md", before), observation("edit.md", before), observation("mode.sh", before), observation("new.md", null)],
  }));
  assert.deepEqual(plan.changes, [
    { kind: "modify", rootId: "workspace", path: "edit.md", before, after },
    { kind: "modify", rootId: "workspace", path: "mode.sh", before, after: mode },
    { kind: "add", rootId: "workspace", path: "new.md", after },
    { kind: "delete", rootId: "workspace", path: "remove.md", before },
  ]);
});

test("unchanged files emit no write and unmentioned observed user files are retained", () => {
  const plan = createFileChangePlan(input({ managedBefore: [file("same.md")], desired: [file("same.md")],
    observed: [observation("same.md", before), observation("user.md", after)] }));
  assert.deepEqual(plan.changes, []);
});

test("only explicit renames combine deletion and addition; matching hashes do not infer one", () => {
  const request = input({ managedBefore: [file("old.md")], desired: [file("new.md")],
    observed: [observation("old.md", before), observation("new.md", null)] });
  assert.deepEqual(createFileChangePlan(request).changes.map(change => change.kind), ["add", "delete"]);
  assert.deepEqual(createFileChangePlan({ ...request, renames: [{ rootId: "workspace", fromPath: "old.md", toPath: "new.md" }] }).changes,
    [{ kind: "rename", rootId: "workspace", fromPath: "old.md", path: "new.md", before, after: before }]);
});

test("explicit rename may also change its declared content and permissions", () => {
  const next = { ...after, mode: 0o640 };
  const plan = createFileChangePlan(input({ managedBefore: [file("old.md")], desired: [file("new.md", next)],
    observed: [observation("old.md", before), observation("new.md", null)],
    renames: [{ rootId: "workspace", fromPath: "old.md", toPath: "new.md" }] }));
  assert.deepEqual(plan.changes, [{ kind: "rename", rootId: "workspace", fromPath: "old.md", path: "new.md", before, after: next }]);
});

test("modified, chmodded or missing managed files conflict even when desired removes them", () => {
  for (const current of [after, { ...before, mode: 0o700 }, null]) {
    rejects("managed_file_changed", input({ managedBefore: [file("owned.md")], desired: [], observed: [observation("owned.md", current)] }));
  }
  rejects("managed_file_changed", input({ managedBefore: [file("same.md")], desired: [file("same.md")], observed: [observation("same.md", after)] }));
});

test("omitted observations are unknown, and existing user content is never adopted", () => {
  rejects("observation_required", input({ desired: [file("new.md")] }));
  rejects("observation_required", input({ managedBefore: [file("old.md")] }));
  rejects("observation_required", input({ managedBefore: [file("same.md")], desired: [file("same.md")] }));
  rejects("unmanaged_target_exists", input({ desired: [file("user.md")], observed: [observation("user.md", before)] }));
});

test("rename rejects occupied destinations, missing ownership and retained sources", () => {
  const rename = [{ rootId: "workspace", fromPath: "old.md", toPath: "new.md" }];
  rejects("unmanaged_target_exists", input({ managedBefore: [file("old.md")], desired: [file("new.md")],
    observed: [observation("old.md", before), observation("new.md", before)], renames: rename }));
  rejects("invalid_rename", input({ desired: [file("new.md")], observed: [observation("old.md", null), observation("new.md", null)], renames: rename }));
  rejects("invalid_rename", input({ managedBefore: [file("old.md")], desired: [file("old.md"), file("new.md")],
    observed: [observation("old.md", before), observation("new.md", null)], renames: rename }));
  rejects("invalid_rename", input({ managedBefore: [file("old.md"), file("new.md")], desired: [file("new.md")],
    observed: [observation("old.md", before), observation("new.md", before)], renames: rename }));
});

test("overlapping rename endpoints and swaps are explicit failures", () => {
  const request = input({ managedBefore: [file("a.md")], desired: [file("b.md"), file("c.md")],
    observed: [observation("a.md", before), observation("b.md", null), observation("c.md", null)] });
  rejects("rename_overlap", { ...request, renames: [
    { rootId: "workspace", fromPath: "a.md", toPath: "b.md" }, { rootId: "workspace", fromPath: "a.md", toPath: "c.md" },
  ] });
  rejects("invalid_rename", input({ managedBefore: [file("a.md"), file("b.md")], desired: [file("a.md"), file("b.md")],
    observed: [observation("a.md", before), observation("b.md", before)],
    renames: [{ rootId: "workspace", fromPath: "a.md", toPath: "b.md" }, { rootId: "workspace", fromPath: "b.md", toPath: "a.md" }] }));
});

test("unsafe paths and root aliases fail without exposing input paths", () => {
  for (const path of ["", "/secret", "../secret", "dir/../secret", "./secret", "dir//secret", "dir/", "dir\\secret", "file:stream", "nul\0name", ".git/HEAD", "dir/.GiT/config", "trailing.", "trailing "]) {
    rejects("unsafe_path", input({ desired: [file(path)], observed: [observation(path, null)] }));
  }
  for (const root of ["", "../root", "/root", "root/name", "root:name", ".git"]) {
    rejects("unsafe_root", input({ desired: [file("safe.md", before, root)], observed: [observation("safe.md", null, root)] }));
  }
});

test("duplicate, case-colliding and file/parent paths are rejected; different roots are isolated", () => {
  for (const list of ["managedBefore", "desired", "observed"] as const) {
    rejects("duplicate_path", input({ [list]: [file("same.md"), file("same.md")] }));
  }
  rejects("path_case_collision", input({ desired: [file("A.md"), file("a.md")], observed: [] }));
  rejects("path_case_collision", input({ managedBefore: [file("A.md")], desired: [file("a.md")], observed: [] }));
  rejects("root_case_collision", input({ desired: [file("a.md", before, "Root"), file("b.md", before, "root")] }));
  rejects("path_ancestor_collision", input({ desired: [file("parent"), file("parent/child.md")] }));
  const plan = createFileChangePlan(input({ desired: [file("same.md", before, "a"), file("same.md", after, "b")],
    observed: [observation("same.md", null, "b"), observation("same.md", null, "a")] }));
  assert.deepEqual(plan.changes.map(change => change.rootId), ["a", "b"]);
});

test("strict schema, checkpoint and file-version validation rejects malformed inputs", () => {
  const base = input();
  for (const bad of ["", "1bad", "has space", "bad.id", "x".repeat(201)]) rejects("invalid_operation_id", { ...base, operationId: bad });
  for (const checkpoint of [{ revision: "A".repeat(40), token: "ok" }, { revision: "a".repeat(39), token: "ok" }, { revision: "a".repeat(40), token: "bad token" }]) {
    rejects("invalid_checkpoint", { ...base, target: checkpoint });
  }
  for (const bad of [{ sha256: "short", mode: 0o600 }, { sha256: before.sha256, mode: -1 }, { sha256: before.sha256, mode: 0o1000 }, { sha256: before.sha256, mode: 0.5 }]) {
    rejects("invalid_file_version", input({ desired: [file("x", bad)], observed: [observation("x", null)] }));
  }
  for (const root of ["relative", "/synthetic/../canghai", "/synthetic/canghai/", "/"]) rejects("invalid_binding", { ...base, binding: { ...base.binding, repositoryRoot: root } });
  rejects("invalid_binding", { ...base, binding: { ...base.binding, agentId: "../agent" } });
  rejects("unsafe_path", { ...base, binding: { ...base.binding, manifestPath: "../manifest" } });
  rejects("invalid_input", { ...base, extra: true });
  rejects("invalid_input", { ...base, renames: undefined });
  rejects("invalid_input", { ...base, desired: new Array(1) });
  rejects("invalid_input", { ...base, desired: [{ ...file("x"), extra: true }] });
  rejects("invalid_input", { ...base, observed: [{ rootId: "workspace", path: "x" }] });
  let invoked = false;
  const getter = { ...base };
  Object.defineProperty(getter, "operationId", { enumerable: true, get() { invoked = true; throw new Error("/private/path"); } });
  rejects("invalid_input", getter); assert.equal(invoked, false);
});

test("permutations are deterministic and digest covers the complete plan and target token", () => {
  const request = input({ managedBefore: [file("z.md"), file("a.md")], desired: [file("z.md", after), file("a.md")],
    observed: [observation("z.md", before), observation("a.md", before)] });
  const plan = createFileChangePlan(request);
  assert.deepEqual(createFileChangePlan({ ...request, managedBefore: [...request.managedBefore].reverse(), desired: [...request.desired].reverse(), observed: [...request.observed].reverse() }), plan);
  const { digest, ...body } = plan;
  assert.equal(digest, bytesVersion(canonicalJson(body)));
  assert.notEqual(createFileChangePlan({ ...request, target: { ...request.target, token: "checkpoint-3" } }).digest, digest);
  assert.notEqual(createFileChangePlan({ ...request, target: { ...request.target, revision: "c".repeat(40) } }).digest, digest);
});

test("returned plan is an immutable snapshot and does not freeze or retain caller-owned objects", () => {
  const version = { ...before }, binding = { ...input().binding }, target = { ...input().target };
  const request = { ...input(), binding, target, desired: [file("new.md", version)], observed: [observation("new.md", null)] };
  const plan = createFileChangePlan(request), serialized = canonicalJson(plan);
  version.mode = 0o777; binding.agentId = "other"; target.token = "changed"; request.desired.push(file("later.md"));
  assert.equal(canonicalJson(plan), serialized);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.binding) && Object.isFrozen(plan.target) && Object.isFrozen(plan.changes));
  const change = plan.changes[0]!;
  assert.ok("after" in change && Object.isFrozen(change.after));
  assert.equal(Reflect.set(plan.binding, "agentId", "changed"), false);
  assert.equal(Reflect.set(plan.changes, "0", null), false);
});
