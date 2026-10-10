/**
 * Selection strategies over an ID-sorted, already filtered candidate list.
 *
 * Go source: sdk/cliproxy/auth/selector.go (`RoundRobinSelector.Pick`, `successorIndex`, `FillFirstSelector.Pick`,
 * `WeightedRoundRobinSelector.Pick`, `smoothWeightedState`, `pickSmoothWeightedAuth`). Docs: credentials.md §6.4.
 * State lives in memory only (losing it merely perturbs fairness), keyed by `<providers>:<canonical model>`.
 */

export interface Weighted {
  readonly id: string;
  readonly weight: number;
}

const DEFAULT_MAX_KEYS = 4096;

export const MAX_SMOOTH_STATE_ENTRIES = 1024;

const MAX = Number.MAX_SAFE_INTEGER;

/** Candidates arrive sorted by ID: first ID strictly greater than `lastId`, wrapping to the head. */
export const successorIndex = (
  candidates: ReadonlyArray<{ readonly id: string }>,
  lastId: string | undefined,
): number => {
  if (lastId === undefined || lastId === "") return 0;
  let low = 0;
  let high = candidates.length;

  while (low < high) {
    const mid = (low + high) >>> 1;

    if ((candidates[mid] as { id: string }).id > lastId) high = mid;
    else low = mid + 1;
  }

  return low >= candidates.length ? 0 : low;
};

const saturatingAdd = (value: number, delta: number): number => {
  if (delta > 0 && value > MAX - delta) return MAX;

  if (delta < 0 && value < -MAX - delta) return -MAX;

  return value + delta;
};

/** Accumulated credits of smooth weighted round-robin for one key. */
export class SmoothWeightedState {
  current = new Map<string, number>();
  weights = new Map<string, number>();

  /**
   * Syncs configured weights without discarding credits. Credits reset only when a credential's configured weight
   * changes, never when the candidate set shrinks (retry exclusions, cooldowns, affinity).
   */
  prepare(weights: ReadonlyMap<string, number>): void {
    if (this.weights.size > 0) {
      for (const [id, weight] of weights) {
        const previous = this.weights.get(id);

        if (previous !== undefined && previous !== weight) {
          this.current = new Map();
          break;
        }
      }
    }

    for (const [id, weight] of weights) this.weights.set(id, weight);

    if (
      this.current.size > MAX_SMOOTH_STATE_ENTRIES ||
      this.weights.size > MAX_SMOOTH_STATE_ENTRIES
    ) {
      for (const id of this.current.keys()) if (!weights.has(id)) this.current.delete(id);

      for (const id of this.weights.keys()) if (!weights.has(id)) this.weights.delete(id);
    }
  }
}

/** `pickSmoothWeightedAuth`: add each weight, take the maximum (first wins ties), subtract the total from it. */
export const pickSmoothWeighted = <T extends Weighted>(
  candidates: ReadonlyArray<T>,
  current: Map<string, number>,
): T | undefined => {
  let picked: T | undefined;
  let pickedCurrent = 0;
  let total = 0;

  for (const candidate of candidates) {
    if (candidate.weight <= 0) continue;
    const next = saturatingAdd(current.get(candidate.id) ?? 0, candidate.weight);
    current.set(candidate.id, next);
    total = saturatingAdd(total, candidate.weight);

    if (picked === undefined || next > pickedCurrent) {
      picked = candidate;
      pickedCurrent = next;
    }
  }

  if (picked === undefined) return undefined;
  current.set(picked.id, saturatingAdd(current.get(picked.id) ?? 0, -total));

  return picked;
};

/** Rotation cursors and weighted credits for every strategy. */
export class RotationState {
  readonly #maxKeys: number;
  #lastPicked = new Map<string, string>();
  #weighted = new Map<string, SmoothWeightedState>();

  constructor(maxKeys: number = DEFAULT_MAX_KEYS) {
    this.#maxKeys = maxKeys > 0 ? maxKeys : DEFAULT_MAX_KEYS;
  }

  /** Round-robin ring over ID-sorted candidates, resuming after the last picked ID. */
  roundRobin<T extends { readonly id: string }>(
    key: string,
    candidates: ReadonlyArray<T>,
  ): T | undefined {
    if (candidates.length === 0) return undefined;

    if (!this.#lastPicked.has(key) && this.#lastPicked.size >= this.#maxKeys)
      this.#lastPicked = new Map();
    const picked = candidates[successorIndex(candidates, this.#lastPicked.get(key))] as T;
    this.#lastPicked.set(key, picked.id);

    return picked;
  }

  /** First candidate in ID order. */
  fillFirst<T>(candidates: ReadonlyArray<T>): T | undefined {
    return candidates[0];
  }

  /** Smooth weighted round-robin; candidates with a non-positive weight are ignored. */
  weightedRoundRobin<T extends Weighted>(key: string, candidates: ReadonlyArray<T>): T | undefined {
    if (!this.#weighted.has(key) && this.#weighted.size >= this.#maxKeys)
      this.#weighted = new Map();
    let state = this.#weighted.get(key);

    if (state === undefined) {
      state = new SmoothWeightedState();
      this.#weighted.set(key, state);
    }

    const weights = new Map<string, number>();

    for (const candidate of candidates)
      if (candidate.weight > 0) weights.set(candidate.id, candidate.weight);
    state.prepare(weights);

    return pickSmoothWeighted(candidates, state.current);
  }

  /** Test hook: number of tracked cursor keys. */
  get cursorKeys(): number {
    return this.#lastPicked.size;
  }
}
