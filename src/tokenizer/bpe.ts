/**
 * Byte-pair-encoding token counter matching `github.com/tiktoken-go/tokenizer` (`codec.Codec.Count`).
 *
 * Go source: tokenizer@v0.8.1/codec/codec.go. The algorithm is the same as Go's: the text is split with the encoding's
 * pre-tokenisation regex, a piece found in the vocabulary is one token, anything else is merged from single bytes by
 * repeatedly joining the adjacent pair with the lowest rank (the leftmost pair wins ties). Special tokens such as
 * `<|endoftext|>` are not recognised (Go treats them as ordinary text too).
 *
 * The vocabulary is a `Map` keyed by "binary strings" (one UTF-16 unit per byte), built lazily from the rank asset on
 * the first `count` call, so importing this module costs nothing at Worker startup. Long pieces (where Go's
 * quadratic merge loop would take seconds) use an equivalent heap-based merge.
 */

/**
 * Element `index` of a numeric list the caller has already bounds-checked, typed without `undefined`
 * (the merge loops index in hot paths and only ever read positions they have written).
 */
const at = (list: ArrayLike<number>, index: number): number => {
  // SAFETY: every caller passes an index below the list length (loop bounds or indices stored in the list itself).
  return list[index] as number;
};

const NO_RANK = Number.POSITIVE_INFINITY;

/** Pieces up to this many bytes use the Go-identical merge loop; longer ones the heap variant. */
export const HEAP_MERGE_THRESHOLD = 192;

const encoder = new TextEncoder();

/** Rank asset layout (see tools/fixturegen/tokens): `count:u32le`, then `len:u8, bytes` per token in rank order. */
const parseVocabulary = (data: ArrayBuffer): Map<string, number> => {
  const bytes = new Uint8Array(data);
  const count = new DataView(data).getUint32(0, true);
  const vocab = new Map<string, number>();
  let offset = 4;

  for (let rank = 0; rank < count; rank++) {
    const length = at(bytes, offset++);
    vocab.set(String.fromCharCode(...bytes.subarray(offset, offset + length)), rank);
    offset += length;
  }

  return vocab;
};

/** UTF-8 bytes of `piece` as a binary string. */
const toBinaryString = (piece: string): string => {
  let ascii = true;

  for (let i = 0; i < piece.length; i++) {
    if (piece.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }

  if (ascii) return piece;
  const bytes = encoder.encode(piece);
  let out = "";

  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }

  return out;
};

/** Go `mergePairs`: number of tokens `piece` (a binary string missing from the vocabulary) is merged into. */
const mergeCountNaive = (vocab: Map<string, number>, piece: string): number => {
  const offsets: number[] = [];
  const ranks: number[] = [];

  for (let i = 0; i <= piece.length; i++) {
    offsets.push(i);
    ranks.push(NO_RANK);
  }

  const rankAt = (index: number, skip: number): number => {
    if (index + skip + 2 < offsets.length) {
      const rank = vocab.get(piece.slice(at(offsets, index), at(offsets, index + skip + 2)));

      if (rank !== undefined) return rank;
    }

    return NO_RANK;
  };

  for (let i = 0; i < offsets.length - 2; i++) ranks[i] = rankAt(i, 0);

  for (;;) {
    if (offsets.length === 1) break;
    let minRank = NO_RANK;
    let minIndex = 0;

    for (let i = 0; i < offsets.length - 1; i++) {
      const rank = at(ranks, i);

      if (rank < minRank) {
        minRank = rank;
        minIndex = i;
      }
    }

    if (minRank === NO_RANK) break;
    ranks[minIndex] = rankAt(minIndex, 1);

    if (minIndex > 0) ranks[minIndex - 1] = rankAt(minIndex - 1, 1);
    offsets.splice(minIndex + 1, 1);
    ranks.splice(minIndex + 1, 1);
  }

  return offsets.length - 1;
};

interface MergeEntry {
  readonly rank: number;
  readonly index: number;
  readonly stamp: number;
}

interface MergeCounts {
  readonly naive: number;
  readonly heap: number;
}

/** Min-heap of `(rank, index, stamp)` ordered by rank, then index (leftmost first). */
class MergeHeap {
  readonly #ranks: number[] = [];
  readonly #indexes: number[] = [];
  readonly #stamps: number[] = [];

  get size(): number {
    return this.#ranks.length;
  }

  #less(a: number, b: number): boolean {
    const ra = at(this.#ranks, a);
    const rb = at(this.#ranks, b);

    return ra < rb || (ra === rb && at(this.#indexes, a) < at(this.#indexes, b));
  }

  #swap(a: number, b: number): void {
    for (const list of [this.#ranks, this.#indexes, this.#stamps]) {
      const tmp = at(list, a);
      list[a] = at(list, b);
      list[b] = tmp;
    }
  }

  push(rank: number, index: number, stamp: number): void {
    this.#ranks.push(rank);
    this.#indexes.push(index);
    this.#stamps.push(stamp);
    let child = this.#ranks.length - 1;

    while (child > 0) {
      const parent = (child - 1) >> 1;

      if (!this.#less(child, parent)) break;
      this.#swap(child, parent);
      child = parent;
    }
  }

  /** Removes the smallest entry and returns it. */
  pop(): MergeEntry {
    const top: MergeEntry = {
      rank: at(this.#ranks, 0),
      index: at(this.#indexes, 0),
      stamp: at(this.#stamps, 0),
    };

    const last = this.#ranks.length - 1;
    this.#swap(0, last);
    this.#ranks.pop();
    this.#indexes.pop();
    this.#stamps.pop();
    let parent = 0;

    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;

      if (left < last && this.#less(left, smallest)) smallest = left;

      if (right < last && this.#less(right, smallest)) smallest = right;

      if (smallest === parent) break;
      this.#swap(parent, smallest);
      parent = smallest;
    }

    return top;
  }
}

/** Same result as {@link mergeCountNaive} in O(n log n): a linked list of parts and a heap of candidate merges. */
const mergeCountHeap = (vocab: Map<string, number>, piece: string): number => {
  const n = piece.length;
  // Part `i` starts at byte `i` (it keeps its start when merged); `next[i]` is the start of the following part.
  const next = Array.from({ length: n }, (_, i) => i + 1);
  const prev = Array.from({ length: n }, (_, i) => i - 1);
  const stamp = Array.from({ length: n }, () => 0);
  const alive = Array.from({ length: n }, () => true);
  const heap = new MergeHeap();

  // Rank of joining part `i` with its successor, or NO_RANK when it has none.
  const pairRank = (i: number): number => {
    const successor = at(next, i);

    if (successor >= n) return NO_RANK;

    return vocab.get(piece.slice(i, at(next, successor))) ?? NO_RANK;
  };

  const schedule = (i: number): void => {
    stamp[i] = at(stamp, i) + 1;
    const rank = pairRank(i);

    if (rank !== NO_RANK) heap.push(rank, i, at(stamp, i));
  };

  for (let i = 0; i < n - 1; i++) schedule(i);

  let parts = n;

  while (heap.size > 0) {
    const top = heap.pop();

    if (!alive[top.index] || stamp[top.index] !== top.stamp) continue;
    const i = top.index;
    const removed = at(next, i);
    alive[removed] = false;
    next[i] = at(next, removed);

    if (at(next, i) < n) prev[at(next, i)] = i;
    parts--;
    schedule(i);
    const before = at(prev, i);

    if (before >= 0) schedule(before);
  }

  return parts;
};

export class BpeCodec {
  readonly #vocabularyData: ArrayBuffer;
  readonly #pattern: RegExp;
  #vocabulary: Map<string, number> | undefined;

  constructor(
    readonly name: string,
    vocabularyData: ArrayBuffer,
    pattern: RegExp,
  ) {
    this.#vocabularyData = vocabularyData;
    this.#pattern = new RegExp(pattern.source, "gu");
  }

  /** Whether the vocabulary has been parsed (it is built on the first `count`). */
  get loaded(): boolean {
    return this.#vocabulary !== undefined;
  }

  #vocab(): Map<string, number> {
    this.#vocabulary ??= parseVocabulary(this.#vocabularyData);

    return this.#vocabulary;
  }

  /** Go `Codec.Count`. */
  count(text: string): number {
    if (text === "") return 0;
    const vocab = this.#vocab();
    const pattern = new RegExp(this.#pattern.source, "gu");
    let tokens = 0;

    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const piece = toBinaryString(match[0]);

      if (vocab.has(piece)) tokens++;
      else
        tokens +=
          piece.length > HEAP_MERGE_THRESHOLD
            ? mergeCountHeap(vocab, piece)
            : mergeCountNaive(vocab, piece);
    }

    return tokens;
  }

  /** Test hook: the merge loops must agree. */
  mergeCounts(piece: string): MergeCounts {
    const vocab = this.#vocab();
    const binary = toBinaryString(piece);

    const counts: MergeCounts = {
      naive: mergeCountNaive(vocab, binary),
      heap: mergeCountHeap(vocab, binary),
    };

    return counts;
  }
}
