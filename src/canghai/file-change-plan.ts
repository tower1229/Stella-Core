import path from "node:path";
import { bytesVersion, canonicalJson } from "./content-version.js";
import {
  FileChangePlanError,
  type ExplicitPlannedRename,
  type FileChangePlan,
  type FileChangePlanInput,
  type ManagedPlannedFile,
  type ObservedPlannedFile,
  type PlannedFileChange,
  type PlannedFileVersion,
} from "./file-change-plan-contract.js";
import type { RecoveryCheckpointBinding, RecoveryCheckpointVersion } from "./recovery-checkpoint-contract.js";

export { FileChangePlanError };

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
function check(value: unknown, category: string): asserts value {
  if (!value) throw new FileChangePlanError(category);
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype, "invalid_input");
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === "string" && (required.includes(key) || optional.includes(key)), "invalid_input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && "value" in descriptor && descriptor.enumerable, "invalid_input");
  }
  check(required.every(key => Object.hasOwn(value, key)), "invalid_input");
  return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, "invalid_input");
  check(Reflect.ownKeys(value).length === value.length + 1, "invalid_input");
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor && "value" in descriptor && descriptor.enumerable, "invalid_input");
  }
  return value as readonly unknown[];
}
function identifier(value: unknown, category: string): string {
  check(typeof value === "string" && ID.test(value), category);
  return value;
}
function relativePath(value: unknown): string {
  check(typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\\:\u0000-\u001f\u007f]/.test(value), "unsafe_path");
  check(value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." &&
    part.toLowerCase() !== ".git" && !/[. ]$/.test(part)), "unsafe_path");
  return value;
}
function binding(value: unknown): RecoveryCheckpointBinding {
  const input = record(value, ["agentId", "repositoryRoot", "manifestPath"]);
  const repositoryRoot = input.repositoryRoot;
  // Lexical validation only: this pure planner cannot certify realpath or ownership.
  check(typeof repositoryRoot === "string" && repositoryRoot.length <= 4096 &&
    path.isAbsolute(repositoryRoot) && repositoryRoot !== path.parse(repositoryRoot).root &&
    path.resolve(repositoryRoot) === repositoryRoot && !/[\\:\u0000-\u001f\u007f]/.test(repositoryRoot), "invalid_binding");
  relativePath(repositoryRoot.slice(path.parse(repositoryRoot).root.length));
  return { agentId: identifier(input.agentId, "invalid_binding"), repositoryRoot, manifestPath: relativePath(input.manifestPath) };
}
function checkpoint(value: unknown): RecoveryCheckpointVersion {
  const input = record(value, ["revision", "token"]);
  check(typeof input.revision === "string" && REVISION.test(input.revision) &&
    typeof input.token === "string" && TOKEN.test(input.token), "invalid_checkpoint");
  return { revision: input.revision, token: input.token };
}
function version(value: unknown): PlannedFileVersion {
  const input = record(value, ["sha256", "mode"]);
  check(typeof input.sha256 === "string" && DIGEST.test(input.sha256) &&
    typeof input.mode === "number" && Number.isSafeInteger(input.mode) && input.mode >= 0 && input.mode <= 0o777,
  "invalid_file_version");
  return { sha256: input.sha256, mode: input.mode };
}
const key = (rootId: string, file: string): string => `${rootId}\0${file}`;
const fold = (value: string): string => value.normalize("NFC").toLowerCase();
const equal = (left: PlannedFileVersion | null, right: PlannedFileVersion): boolean =>
  left !== null && left.sha256 === right.sha256 && left.mode === right.mode;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value) as unknown[]) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Plan explicit file mutations from caller-provided observations, never filesystem claims.
 * A future writer must independently revalidate actual bytes, permissions and ownership.
 */
export function createFileChangePlan(value: FileChangePlanInput): FileChangePlan {
  try {
    const input = record(value, ["operationId", "binding", "from", "target", "managedBefore", "desired", "observed"], ["renames"]);
    check(typeof input.operationId === "string" && OPERATION.test(input.operationId), "invalid_operation_id");
    const owner = binding(input.binding), from = checkpoint(input.from), target = checkpoint(input.target);
    const rootNames = new Map<string, string>(), pathNames = new Map<string, string>();
    const locate = (root: unknown, file: unknown): { rootId: string; path: string } => {
      const rootId = identifier(root, "unsafe_root"), filePath = relativePath(file);
      const rootFold = fold(rootId), pathFold = key(rootFold, fold(filePath));
      check(!rootNames.has(rootFold) || rootNames.get(rootFold) === rootId, "root_case_collision");
      check(!pathNames.has(pathFold) || pathNames.get(pathFold) === filePath, "path_case_collision");
      rootNames.set(rootFold, rootId); pathNames.set(pathFold, filePath);
      return { rootId, path: filePath };
    };
    const manifest = (raw: unknown): Map<string, ManagedPlannedFile> => {
      const result = new Map<string, ManagedPlannedFile>();
      for (const item of array(raw)) {
        const entry = record(item, ["rootId", "path", "version"]), location = locate(entry.rootId, entry.path);
        const id = key(location.rootId, location.path);
        check(!result.has(id), "duplicate_path");
        result.set(id, { ...location, version: version(entry.version) });
      }
      return result;
    };
    const managed = manifest(input.managedBefore), desired = manifest(input.desired);
    const observed = new Map<string, ObservedPlannedFile>();
    for (const item of array(input.observed)) {
      const entry = record(item, ["rootId", "path", "version"]), location = locate(entry.rootId, entry.path);
      const id = key(location.rootId, location.path);
      check(!observed.has(id), "duplicate_path");
      observed.set(id, { ...location, version: entry.version === null ? null : version(entry.version) });
    }
    // Files cannot also be parent directories. Complex file/directory migrations
    // need a separate explicit protocol, rather than an unsafe mutation ordering.
    for (const [id, filePath] of pathNames) {
      const root = id.slice(0, id.indexOf("\0"));
      const parts = fold(filePath).split("/");
      for (let count = 1; count < parts.length; count++) {
        check(!pathNames.has(key(root, parts.slice(0, count).join("/"))), "path_ancestor_collision");
      }
    }
    for (const [id, file] of managed) {
      check(observed.has(id), "observation_required");
      check(equal(observed.get(id)!.version, file.version), "managed_file_changed");
    }
    for (const id of desired.keys()) {
      check(observed.has(id), "observation_required");
      if (!managed.has(id)) check(observed.get(id)!.version === null, "unmanaged_target_exists");
    }
    const renames: ExplicitPlannedRename[] = [], endpoints = new Set<string>();
    for (const item of Object.hasOwn(input, "renames") ? array(input.renames) : []) {
      const entry = record(item, ["rootId", "fromPath", "toPath"]);
      const source = locate(entry.rootId, entry.fromPath), destination = locate(entry.rootId, entry.toPath);
      const sourceId = key(source.rootId, source.path), destinationId = key(destination.rootId, destination.path);
      check(sourceId !== destinationId && !endpoints.has(sourceId) && !endpoints.has(destinationId), "rename_overlap");
      endpoints.add(sourceId); endpoints.add(destinationId);
      check(managed.has(sourceId) && !desired.has(sourceId) && desired.has(destinationId) && !managed.has(destinationId), "invalid_rename");
      check(observed.has(sourceId) && observed.has(destinationId), "observation_required");
      check(observed.get(destinationId)!.version === null, "unmanaged_target_exists");
      renames.push({ rootId: source.rootId, fromPath: source.path, toPath: destination.path });
    }
    const changes: PlannedFileChange[] = [];
    for (const rename of renames) {
      changes.push({ kind: "rename", rootId: rename.rootId, fromPath: rename.fromPath, path: rename.toPath,
        before: managed.get(key(rename.rootId, rename.fromPath))!.version,
        after: desired.get(key(rename.rootId, rename.toPath))!.version });
    }
    for (const [id, file] of managed) {
      if (endpoints.has(id)) continue;
      const next = desired.get(id);
      if (!next) changes.push({ kind: "delete", rootId: file.rootId, path: file.path, before: file.version });
      else if (!equal(file.version, next.version)) changes.push({ kind: "modify", rootId: file.rootId, path: file.path, before: file.version, after: next.version });
    }
    for (const [id, file] of desired) {
      if (!managed.has(id) && !endpoints.has(id)) changes.push({ kind: "add", rootId: file.rootId, path: file.path, after: file.version });
    }
    changes.sort((left, right) => compare(left.rootId, right.rootId) || compare(left.path, right.path) || compare(left.kind, right.kind));
    const body = { schemaVersion: "stella.file-change-plan/v1" as const, status: "planned" as const,
      operationId: input.operationId, binding: owner, from, target, changes };
    return freeze({ ...body, digest: bytesVersion(canonicalJson(body)) });
  } catch (error) {
    if (error instanceof FileChangePlanError) throw error;
    throw new FileChangePlanError("invalid_input");
  }
}
