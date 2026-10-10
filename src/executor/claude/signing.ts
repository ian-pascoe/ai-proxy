/**
 * Claude Code billing "cch" body signature.
 *
 * Go source: internal/runtime/executor/claude_signing.go (ensureClaudeBillingHeaderCCHPlaceholder,
 * signAnthropicMessagesBody, normalizeClaudeCCHInput, claudeCCHSigningEnabled). The signature is computed over the
 * exact serialised body (so the body is serialised once and the 5 digits are patched in place), after emptying every
 * `"model"` string and removing the members `max_tokens`, `fallbacks` and `fallback_credit_token` without
 * re-serialising.
 */
import type { JsonObject } from "../../json/index.ts";
import { isArr, isObj } from "../../translator/common/gjson.ts";
import { textBlock } from "./cache-control.ts";
import { isAnthropicUpstreamBase, isClaudeOAuthToken } from "./credentials.ts";
import { xxh64 } from "./xxhash64.ts";

const CCH_SEED = 0x4d659218e32a3268n;

const CCH_LENGTH = 5;

const BILLING_PREFIX = "x-anthropic-billing-header:";

export class CchSigningError extends Error {
  override readonly name = "CchSigningError";
}

/** `claudeCCHSigningEnabled` (kind: anthropic for the Messages API; Vertex always signs). */
export const cchSigningEnabled = (
  apiKey: string,
  cliFingerprint: boolean,
  origin: string,
): boolean => {
  if (isClaudeOAuthToken(apiKey)) return true;

  if (!cliFingerprint) return false;

  return isAnthropicUpstreamBase(origin);
};

const billingText = (body: JsonObject): string | undefined => {
  const system = body.system;

  if (!isArr(system) || !isObj(system[0])) return undefined;
  const text = system[0].text;

  return typeof text === "string" && text.startsWith(BILLING_PREFIX) ? text : undefined;
};

/** True when `system.0.text` already holds a `cch=<5 hex>;` marker. */
const hasCchDigits = (text: string): boolean => /cch=[0-9a-f]{5};/.test(text);

const prependBillingBlock = (body: JsonObject, text: string): void => {
  const system = body.system;
  const block = textBlock(text);

  if (typeof system === "string") body.system = [block, textBlock(system)];
  else if (isArr(system)) system.unshift(block);
  else body.system = [block];
};

/** `ensureClaudeBillingHeaderCCHPlaceholder`: guarantees `cch=00000;` (inserted after `cc_entrypoint=<x>;`). */
export const ensureBillingCCHPlaceholder = (
  body: JsonObject,
  fallbackBilling: string,
): JsonObject => {
  let text = billingText(body);

  if (text === undefined) {
    if (fallbackBilling === "") return body;
    prependBillingBlock(body, fallbackBilling);
    text = billingText(body);

    if (text === undefined) return body;
  }

  if (hasCchDigits(text)) return body;
  const entrypoint = text.indexOf("cc_entrypoint=");

  if (entrypoint < 0) return body;
  const end = text.indexOf(";", entrypoint);

  if (end < 0) return body;
  const insertAt = end + 1;

  const updated = `${text.slice(0, insertAt)} cch=00000;${text.slice(insertAt)}`;

  (body.system as JsonObject[])[0] = { ...(body.system as JsonObject[])[0], text: updated };

  return body;
};

interface Member {
  start: number;
  end: number;
  commaBefore: number;
  commaAfter: number;
  excluded: boolean;
}

const EXCLUDED_KEYS = new Set(['"max_tokens"', '"fallbacks"', '"fallback_credit_token"']);

/** Single-pass JSON scanner collecting the byte ranges to remove (port of `claudeCCHJSONScanner`). */
class Scanner {
  pos = 0;
  readonly edits: Array<[number, number]> = [];
  constructor(readonly text: string) {}

  #addEdit(start: number, end: number): void {
    if (start < end) this.edits.push([start, end]);
  }

  #skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];

      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") this.pos++;
      else return;
    }
  }

  #consume(ch: string): boolean {
    if (this.text[this.pos] !== ch) return false;
    this.pos++;

    return true;
  }

  #parseString(): [number, number] {
    if (this.text[this.pos] !== '"')
      throw new CchSigningError(`missing JSON string at ${this.pos}`);
    const start = this.pos;
    this.pos++;

    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];

      if (ch === "\\") this.pos += 2;
      else if (ch === '"') {
        this.pos++;

        return [start, this.pos];
      } else this.pos++;
    }

    throw new CchSigningError(`unterminated JSON string at ${start}`);
  }

  parseValue(collect: boolean): void {
    this.#skipWhitespace();

    if (this.pos >= this.text.length)
      throw new CchSigningError(`missing JSON value at ${this.pos}`);

    switch (this.text[this.pos]) {
      case "{":
        this.#parseObject(collect);

        return;
      case "[":
        this.#parseArray(collect);

        return;
      case '"':
        this.#parseString();

        return;
      default: {
        const start = this.pos;

        while (this.pos < this.text.length && !",}] \t\r\n".includes(this.text[this.pos] as string))
          this.pos++;

        if (this.pos === start) throw new CchSigningError(`missing JSON value at ${start}`);
      }
    }
  }

  #parseArray(collect: boolean): void {
    this.pos++;
    this.#skipWhitespace();

    if (this.#consume("]")) return;

    for (;;) {
      this.parseValue(collect);
      this.#skipWhitespace();

      if (this.#consume(",")) continue;

      if (!this.#consume("]")) throw new CchSigningError(`missing array end at ${this.pos}`);

      return;
    }
  }

  #parseObject(collect: boolean): void {
    this.pos++;
    this.#skipWhitespace();

    if (this.#consume("}")) return;
    const members: Member[] = [];
    let commaBefore = -1;

    for (;;) {
      this.#skipWhitespace();
      const memberStart = this.pos;
      const [keyStart, keyEnd] = this.#parseString();
      this.#skipWhitespace();

      if (!this.#consume(":")) throw new CchSigningError(`missing object colon at ${this.pos}`);
      this.#skipWhitespace();
      const key = this.text.slice(keyStart, keyEnd);
      const excluded = collect && EXCLUDED_KEYS.has(key);

      if (collect && key === '"model"' && this.text[this.pos] === '"') {
        const [valueStart, valueEnd] = this.#parseString();
        this.#addEdit(valueStart + 1, valueEnd - 1);
      } else {
        this.parseValue(collect && !excluded);
      }

      const memberEnd = this.pos;
      this.#skipWhitespace();
      let commaAfter = -1;

      if (this.#consume(",")) commaAfter = this.pos - 1;
      members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });

      if (commaAfter >= 0) {
        commaBefore = commaAfter;
        continue;
      }

      if (!this.#consume("}")) throw new CchSigningError(`missing object end at ${this.pos}`);
      break;
    }

    if (collect) this.#addExcludedMemberEdits(members);
  }

  #addExcludedMemberEdits(members: Member[]): void {
    for (let start = 0; start < members.length;) {
      const first = members[start] as Member;

      if (!first.excluded) {
        start++;
        continue;
      }

      let end = start;

      while (end + 1 < members.length && (members[end + 1] as Member).excluded) end++;
      const last = members[end] as Member;

      if (end + 1 < members.length) this.#addEdit(first.start, last.commaAfter + 1);
      else if (start > 0 && end > start) this.#addEdit(first.start, last.end);
      else if (start > 0) this.#addEdit(first.commaBefore, last.end);
      else this.#addEdit(first.start, last.end);
      start = end + 1;
    }
  }
}

/** `normalizeClaudeCCHInput`. */
export const normalizeCchInput = (text: string): string => {
  const scanner = new Scanner(text);
  scanner.parseValue(true);
  const sorted = [...scanner.edits].toSorted((a, b) => a[0] - b[0]);
  let out = "";
  let last = 0;

  for (const [start, end] of sorted) {
    if (start < last || end > text.length)
      throw new CchSigningError(`overlapping CCH normalization edit at ${start}`);
    out += text.slice(last, start);
    last = end;
  }

  return out + text.slice(last);
};

/** cch digits for an already serialised body whose billing block holds `cch=00000;` (offset of the digits). */
const cchDigitsOffset = (serialized: string, billing: string): number | undefined => {
  // The billing text is a JSON string value; locate its first occurrence in the serialised system[0] block.
  const needle = JSON.stringify(billing);
  const valueStart = serialized.indexOf(needle);

  if (valueStart < 0) return undefined;
  const valueEnd = valueStart + needle.length;

  for (let from = valueStart; from < valueEnd;) {
    const prefix = serialized.indexOf("cch=", from);

    if (prefix < 0 || prefix >= valueEnd) return undefined;
    const digits = prefix + 4;
    const end = digits + CCH_LENGTH;

    if (serialized[end] === ";" && /^[0-9a-f]{5}$/.test(serialized.slice(digits, end)))
      return digits;
    from = prefix + 4;
  }

  return undefined;
};

/**
 * `signAnthropicMessagesBody`: serialises the final body once and patches the signature in place. The result is the
 * exact text to send.
 */
export const serializeAndSign = (body: JsonObject, sign: boolean): string => {
  const serialized = JSON.stringify(body);

  if (!sign) return serialized;
  const billing = billingText(body);

  if (billing === undefined) return serialized;
  const offset = cchDigitsOffset(serialized, billing);

  if (offset === undefined) return serialized;
  const unsigned = `${serialized.slice(0, offset)}00000${serialized.slice(offset + CCH_LENGTH)}`;
  const normalized = normalizeCchInput(unsigned);
  const cch = (xxh64(new TextEncoder().encode(normalized), CCH_SEED) & 0xfffffn)
    .toString(16)
    .padStart(5, "0");

  return `${unsigned.slice(0, offset)}${cch}${unsigned.slice(offset + CCH_LENGTH)}`;
};
