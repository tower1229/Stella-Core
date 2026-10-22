import { canonicalJson } from "./content-version.js";
import { RecoveryAuthorityError, type RecoveryAuthorityResolver, type RecoveryAuthoritySnapshot } from "./recovery-authority-contract.js";
import type { RecoveryCheckpointBinding } from "./recovery-checkpoint-contract.js";

/** Legacy compatibility only; no checkpoint file is discovered or initialized. */
export function createLegacyRecoveryAuthority(binding: RecoveryCheckpointBinding, readRevision: () => string): RecoveryAuthorityResolver {
  const owner = Object.freeze({ ...binding });
  const read = async (): Promise<RecoveryAuthoritySnapshot> => {
    const revision = readRevision();
    if (typeof revision !== "string" || !/^[a-f0-9]{40}$/i.test(revision)) throw new RecoveryAuthorityError("recovery_authority_invalid_revision");
    return Object.freeze({ mode: "legacy_config", binding: owner, revision, token: `legacy:${revision}` });
  };
  return Object.freeze({ mode: "legacy_config" as const, read, async assertCurrent(expected: RecoveryAuthoritySnapshot) {
    const frozenExpected = canonicalJson(expected);
    if (canonicalJson(await read()) !== frozenExpected) throw new RecoveryAuthorityError("recovery_authority_changed");
  } });
}

/** One bounded cache, inflight keyed by the full authority snapshot and local invalidation.
 * It neither upgrades a caller's expectation nor treats a successful load as model consumption.
 */
export class RecoveryBoundLoader<T> {
  readonly #authority: RecoveryAuthorityResolver;
  readonly #load: (snapshot: RecoveryAuthoritySnapshot) => Promise<T>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #generation = 0;
  #cache?: { key: string; value: T; at: number };
  readonly #inflight = new Map<string, Promise<T>>();

  constructor(options: { authority: RecoveryAuthorityResolver; load(snapshot: RecoveryAuthoritySnapshot): Promise<T>; ttlMs?: number; now?: () => number }) {
    this.#authority = options.authority;
    this.#load = options.load;
    this.#ttlMs = options.ttlMs ?? 1_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs < 0) throw new RecoveryAuthorityError("recovery_loader_invalid_ttl");
  }
  invalidate(): void { this.#generation++; this.#cache = undefined; }

  async load(): Promise<T> {
    const generation = this.#generation;
    const source = await this.#authority.read();
    const snapshot = Object.freeze({ ...source, binding: Object.freeze({ ...source.binding }) });
    const key = `${generation}:${canonicalJson(snapshot)}`;
    const check = async () => {
      await this.#authority.assertCurrent(snapshot);
      if (generation !== this.#generation) throw new RecoveryAuthorityError("recovery_loader_invalidated");
    };
    if (generation !== this.#generation) throw new RecoveryAuthorityError("recovery_loader_invalidated");
    const cached = this.#cache;
    if (cached?.key === key && this.#now() - cached.at <= this.#ttlMs) {
      await check();
      return cached.value;
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const value = await this.#load(snapshot);
        await check();
        this.#cache = { key, value, at: this.#now() };
        return value;
      })().finally(() => { this.#inflight.delete(key); });
      this.#inflight.set(key, pending);
    }
    return pending;
  }
}
