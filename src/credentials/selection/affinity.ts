/**
 * Session affinity: remembers which credential served a session so follow-up requests reuse it.
 *
 * Go source: sdk/cliproxy/auth/session_cache.go (`SessionCache`), selector.go (`SessionAffinitySelector.Pick/OnResult`,
 * `isSubagentSession`), home_session_alias.go (`isHierarchyParent`). Docs: credentials.md §6.9.
 * Differences: alias groups are replaced by independent keys, the LCP conversation matcher is not ported, and the
 * cache key additionally carries the caller scope so principals never share bindings.
 */

interface Entry {
  readonly authId: string;
  readonly expiresAt: number;
}

export const DEFAULT_AFFINITY_TTL_MS = 3_600_000;

export const DEFAULT_AFFINITY_CAPACITY = 65_536;

/** TTL cache `key -> credential id`. Every method takes the clock so tests control time. */
export class SessionCache {
  #entries = new Map<string, Entry>();
  #ttlMs: number;
  readonly #capacity: number;

  constructor(
    ttlMs: number = DEFAULT_AFFINITY_TTL_MS,
    capacity: number = DEFAULT_AFFINITY_CAPACITY,
  ) {
    this.#ttlMs = ttlMs > 0 ? ttlMs : DEFAULT_AFFINITY_TTL_MS;
    this.#capacity = capacity > 0 ? capacity : DEFAULT_AFFINITY_CAPACITY;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Applies a new TTL (config reload); existing bindings keep their deadlines. */
  setTtl(ttlMs: number): void {
    if (ttlMs > 0) this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Peek without refreshing. */
  get(key: string, now: number): string | undefined {
    const entry = this.#entries.get(key);

    if (entry === undefined) return undefined;

    if (now >= entry.expiresAt) {
      this.#entries.delete(key);

      return undefined;
    }

    return entry.authId;
  }

  /** Lookup that extends the TTL on a hit. */
  getAndRefresh(key: string, now: number): string | undefined {
    const authId = this.get(key, now);

    if (authId !== undefined) this.#put(key, authId, now);

    return authId;
  }

  /** Binds `key` to `authId` and (re)starts its TTL. */
  set(key: string, authId: string, now: number): void {
    if (key === "" || authId === "") return;
    this.#put(key, authId, now);
  }

  /** Extends the TTL only while `key` is still bound to `expectedAuthId`. */
  touch(key: string, expectedAuthId: string, now: number): boolean {
    const entry = this.#entries.get(key);

    if (entry === undefined || entry.authId !== expectedAuthId || now >= entry.expiresAt)
      return false;
    this.#put(key, expectedAuthId, now);

    return true;
  }

  /** Removes the binding only while it still points at `expectedAuthId`. */
  compareAndDelete(key: string, expectedAuthId: string): boolean {
    const entry = this.#entries.get(key);

    if (entry === undefined || entry.authId !== expectedAuthId) return false;
    this.#entries.delete(key);

    return true;
  }

  /** Drops every binding of a credential (removed, replaced or disabled). */
  invalidateAuth(authId: string): void {
    for (const [key, entry] of this.#entries)
      if (entry.authId === authId) this.#entries.delete(key);
  }

  /** Removes expired entries. */
  sweep(now: number): void {
    for (const [key, entry] of this.#entries) if (now >= entry.expiresAt) this.#entries.delete(key);
  }

  #put(key: string, authId: string, now: number): void {
    // Re-insert so Map order tracks recency; the oldest entries are evicted first.
    this.#entries.delete(key);
    this.#entries.set(key, { authId, expiresAt: now + this.#ttlMs });

    if (this.#entries.size > this.#capacity) {
      this.sweep(now);

      for (const oldest of this.#entries.keys()) {
        if (this.#entries.size <= this.#capacity) break;
        this.#entries.delete(oldest);
      }
    }
  }
}

/** `<callerScope>::<providers>::<sessionId>::<canonical model>`. */
export const affinityKey = (
  callerScope: string,
  provider: string,
  sessionId: string,
  model: string,
): string => [callerScope, provider, sessionId, model].join("::");

/** `isHierarchyParent`. */
const isHierarchyParent = (primary: string, fallback: string): boolean => {
  if (fallback === "" || primary === "" || primary === fallback) return false;

  if (primary.includes(":agent:")) return true;
  const index1 = primary.indexOf(":");
  const index2 = fallback.indexOf(":");

  if (index1 > 0 && index2 > 0 && primary.slice(0, index1) === fallback.slice(0, index2))
    return true;

  return index1 === -1 && index2 === -1;
};

/** `isSubagentSession`. */
export const isSubagentSession = (primaryId: string, fallbackId: string): boolean =>
  primaryId.includes(":agent:") || (fallbackId !== "" && isHierarchyParent(primaryId, fallbackId));
