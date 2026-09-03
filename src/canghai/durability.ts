import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CangHaiDurabilityPolicy = "sync_immediately" | "bounded_batch";

type Schedule = (callback: () => void, delayMs: number) => unknown;

export type CangHaiDurabilityOptions = {
  root: string;
  remote: string;
  branch: string;
  criticalWritePolicy: CangHaiDurabilityPolicy;
  normalWritePolicy: CangHaiDurabilityPolicy;
  maxNormalRpoSeconds: number;
  now?: () => number;
  schedule?: Schedule;
  onRevision?: (revision: string) => void;
};

export type CangHaiDurabilityDiagnostics = {
  criticalWritePolicy: CangHaiDurabilityPolicy;
  criticalSynchronized: boolean;
  normalWritePolicy: CangHaiDurabilityPolicy;
  maxNormalRpoSeconds: number;
  observedNormalRpoSeconds: number;
  normalState: "current" | "pending" | "breached";
  localRevision: string;
  synchronizedRevision?: string;
  pendingNormalSince?: string;
  lastErrorCategory?: "stella_critical_sync_failed" | "stella_normal_sync_failed";
};

function validateRepositoryPath(value: string): string {
  if (!value || path.isAbsolute(value)) throw new Error("Durability path must be repository-relative");
  const normalized = path.posix.normalize(value.split(path.sep).join(path.posix.sep));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Durability path escapes the CangHai repository");
  }
  return normalized;
}

export class GitCangHaiDurability {
  readonly #root: string;
  readonly #remote: string;
  readonly #branch: string;
  readonly #criticalWritePolicy: CangHaiDurabilityPolicy;
  readonly #normalWritePolicy: CangHaiDurabilityPolicy;
  readonly #maxNormalRpoSeconds: number;
  readonly #now: () => number;
  readonly #schedule: Schedule;
  readonly #onRevision?: (revision: string) => void;
  #pendingNormalSince?: number;
  #synchronizedRevision?: string;
  #criticalSynchronized = false;
  #lastErrorCategory?: CangHaiDurabilityDiagnostics["lastErrorCategory"];
  #normalFlushScheduled = false;
  #initialized = false;
  #initializing?: Promise<void>;
  #operation = Promise.resolve();

  constructor(options: CangHaiDurabilityOptions) {
    if (options.criticalWritePolicy !== "sync_immediately") {
      throw new Error("Managed durability requires criticalWritePolicy=sync_immediately");
    }
    if (
      options.normalWritePolicy === "bounded_batch" &&
      (!Number.isInteger(options.maxNormalRpoSeconds) || options.maxNormalRpoSeconds <= 0)
    ) {
      throw new Error("Bounded normal writes require a positive maxNormalRpoSeconds");
    }
    if (
      options.normalWritePolicy === "sync_immediately" &&
      (!Number.isInteger(options.maxNormalRpoSeconds) || options.maxNormalRpoSeconds < 0)
    ) {
      throw new Error("Immediate normal writes require a non-negative maxNormalRpoSeconds");
    }
    if (!options.remote.trim() || !options.branch.trim()) {
      throw new Error("Managed durability requires an explicit remote and branch");
    }
    this.#root = path.resolve(options.root);
    this.#remote = options.remote;
    this.#branch = options.branch;
    this.#criticalWritePolicy = options.criticalWritePolicy;
    this.#normalWritePolicy = options.normalWritePolicy;
    this.#maxNormalRpoSeconds = options.maxNormalRpoSeconds;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    });
    this.#onRevision = options.onRevision;
  }

  async syncCritical(paths: string[], message: string): Promise<CangHaiDurabilityDiagnostics> {
    return this.#enqueue(async () => {
      await this.#ensureInitialized();
      await this.#commit(paths, message, "critical");
      try {
        await this.#push();
        this.#criticalSynchronized = true;
        this.#pendingNormalSince = undefined;
        this.#lastErrorCategory = undefined;
      } catch (error) {
        this.#criticalSynchronized = false;
        this.#lastErrorCategory = "stella_critical_sync_failed";
        throw new Error("Critical CangHai synchronization failed", { cause: error });
      }
      return this.#diagnostics();
    });
  }

  async recordNormal(paths: string[], message: string): Promise<CangHaiDurabilityDiagnostics> {
    return this.#enqueue(async () => {
      await this.#ensureInitialized();
      await this.#commit(paths, message, "normal");
      if (this.#normalWritePolicy === "sync_immediately") {
        try {
          await this.#push();
          this.#pendingNormalSince = undefined;
          this.#lastErrorCategory = undefined;
        } catch (error) {
          this.#lastErrorCategory = "stella_normal_sync_failed";
          throw new Error("Normal CangHai synchronization failed", { cause: error });
        }
      } else {
        this.#pendingNormalSince ??= this.#now();
        this.#scheduleNormalFlush();
      }
      return this.#diagnostics();
    });
  }

  async flushNormal(): Promise<CangHaiDurabilityDiagnostics> {
    return this.#enqueue(async () => {
      await this.#ensureInitialized();
      if (this.#pendingNormalSince === undefined) return this.#diagnostics();
      try {
        await this.#push();
        this.#pendingNormalSince = undefined;
        this.#normalFlushScheduled = false;
        this.#lastErrorCategory = undefined;
      } catch (error) {
        this.#lastErrorCategory = "stella_normal_sync_failed";
        throw new Error("Normal CangHai synchronization failed", { cause: error });
      }
      return this.#diagnostics();
    });
  }

  async diagnostics(): Promise<CangHaiDurabilityDiagnostics> {
    return this.#enqueue(async () => {
      await this.#ensureInitialized();
      return this.#diagnostics();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #assertBranch(): Promise<void> {
    const { stdout } = await execFileAsync("git", ["-C", this.#root, "branch", "--show-current"]);
    if (stdout.trim() !== this.#branch) {
      throw new Error(`Managed durability requires CangHai branch ${this.#branch}`);
    }
  }

  async #commit(
    repositoryPaths: string[],
    message: string,
    kind: "critical" | "normal",
  ): Promise<void> {
    if (!message.trim()) throw new Error("Durability commit message must not be empty");
    const paths = [...new Set(repositoryPaths.map(validateRepositoryPath))];
    if (paths.length === 0) throw new Error("Durability commit requires at least one path");
    await this.#assertBranch();
    await execFileAsync("git", ["-C", this.#root, "add", "--", ...paths]);
    try {
      await execFileAsync("git", [
        "-C",
        this.#root,
        "commit",
        "--quiet",
        "-m",
        `[stella:${kind}] ${message}`,
        "--",
        ...paths,
      ]);
      const { stdout } = await execFileAsync("git", ["-C", this.#root, "rev-parse", "HEAD"]);
      this.#onRevision?.(stdout.trim());
    } catch (error) {
      throw new Error("CangHai durability commit failed", { cause: error });
    }
  }

  async #push(): Promise<void> {
    await this.#assertBranch();
    await execFileAsync("git", [
      "-C",
      this.#root,
      "push",
      this.#remote,
      `HEAD:refs/heads/${this.#branch}`,
    ]);
    const { stdout } = await execFileAsync("git", ["-C", this.#root, "rev-parse", "HEAD"]);
    this.#synchronizedRevision = stdout.trim();
    this.#criticalSynchronized = true;
  }

  #scheduleNormalFlush(delayMs = this.#maxNormalRpoSeconds * 1_000): void {
    if (this.#normalFlushScheduled) return;
    this.#normalFlushScheduled = true;
    this.#schedule(() => {
      this.#normalFlushScheduled = false;
      void this.flushNormal().catch(() => {
        // The failure remains visible through diagnostics and is retried by the next explicit flush.
      });
    }, Math.max(0, delayMs));
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) return;
    if (!this.#initializing) {
      this.#initializing = this.#initialize().finally(() => {
        this.#initializing = undefined;
      });
    }
    await this.#initializing;
  }

  async #initialize(): Promise<void> {
    await this.#assertBranch();
    const [{ stdout: localOutput }, { stdout: remoteOutput }] = await Promise.all([
      execFileAsync("git", ["-C", this.#root, "rev-parse", "HEAD"]),
      execFileAsync("git", [
        "-C",
        this.#root,
        "ls-remote",
        "--exit-code",
        this.#remote,
        `refs/heads/${this.#branch}`,
      ]),
    ]);
    const localRevision = localOutput.trim();
    const remoteRevision = remoteOutput.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/i.test(remoteRevision ?? "")) {
      throw new Error("Managed durability could not resolve the configured remote branch");
    }
    this.#synchronizedRevision = remoteRevision;
    if (localRevision === remoteRevision) {
      this.#criticalSynchronized = true;
      this.#initialized = true;
      return;
    }
    try {
      await execFileAsync("git", ["-C", this.#root, "merge-base", "--is-ancestor", remoteRevision!, "HEAD"]);
    } catch (error) {
      throw new Error("Managed durability remote is not an ancestor of local CangHai HEAD", {
        cause: error,
      });
    }
    const { stdout: logOutput } = await execFileAsync("git", [
      "-C",
      this.#root,
      "log",
      "--reverse",
      "--format=%ct%x00%s",
      `${remoteRevision}..HEAD`,
    ]);
    const records = logOutput.trim().split("\n").filter(Boolean).map((line) => {
      const [timestamp, subject = ""] = line.split("\0");
      return { timestamp: Number(timestamp) * 1_000, subject };
    });
    if (records.length === 0 || records.some(({ timestamp }) => !Number.isFinite(timestamp))) {
      throw new Error("Managed durability could not reconstruct unsynchronized Git history");
    }
    const hasCriticalOrUnknown = records.some(
      ({ subject }) => !subject.startsWith("[stella:normal] "),
    );
    if (hasCriticalOrUnknown) {
      try {
        await this.#push();
        this.#pendingNormalSince = undefined;
      } catch (error) {
        this.#lastErrorCategory = "stella_critical_sync_failed";
        throw new Error("Recovered critical CangHai synchronization failed", { cause: error });
      }
      this.#initialized = true;
      return;
    }
    this.#pendingNormalSince = records[0]!.timestamp;
    const ageMs = Math.max(0, this.#now() - this.#pendingNormalSince);
    const remainingMs = this.#maxNormalRpoSeconds * 1_000 - ageMs;
    if (remainingMs <= 0) {
      try {
        await this.#push();
        this.#pendingNormalSince = undefined;
      } catch (error) {
        this.#lastErrorCategory = "stella_normal_sync_failed";
        throw new Error("Recovered normal CangHai synchronization failed", { cause: error });
      }
    } else {
      this.#scheduleNormalFlush(remainingMs);
    }
    this.#initialized = true;
  }

  async #diagnostics(): Promise<CangHaiDurabilityDiagnostics> {
    const { stdout } = await execFileAsync("git", ["-C", this.#root, "rev-parse", "HEAD"]);
    const localRevision = stdout.trim();
    const observedNormalRpoSeconds = this.#pendingNormalSince === undefined
      ? 0
      : Math.max(0, (this.#now() - this.#pendingNormalSince) / 1_000);
    const normalState = this.#pendingNormalSince === undefined
      ? "current" as const
      : observedNormalRpoSeconds > this.#maxNormalRpoSeconds
        ? "breached" as const
        : "pending" as const;
    return {
      criticalWritePolicy: this.#criticalWritePolicy,
      criticalSynchronized: this.#criticalSynchronized,
      normalWritePolicy: this.#normalWritePolicy,
      maxNormalRpoSeconds: this.#maxNormalRpoSeconds,
      observedNormalRpoSeconds,
      normalState,
      localRevision,
      ...(this.#synchronizedRevision ? { synchronizedRevision: this.#synchronizedRevision } : {}),
      ...(this.#pendingNormalSince === undefined
        ? {}
        : { pendingNormalSince: new Date(this.#pendingNormalSince).toISOString() }),
      ...(this.#lastErrorCategory ? { lastErrorCategory: this.#lastErrorCategory } : {}),
    };
  }
}
