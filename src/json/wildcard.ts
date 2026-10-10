/**
 * Port of github.com/tidwall/match (used by gjson for wildcard keys and the `%` / `!%` query operators).
 * `*` matches any sequence, `?` any single character (code point), `\c` matches `c` literally.
 */
type Token = { kind: "star" } | { kind: "any" } | { kind: "lit"; cp: string };

const tokenize = (pattern: string): Token[] => {
  const tokens: Token[] = [];
  const chars = Array.from(pattern);

  for (let i = 0; i < chars.length; i++) {
    // SAFETY: i is bounded by the loop condition i < chars.length.
    const ch = chars[i] as string;

    if (ch === "*") {
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else if (ch === "\\" && i + 1 < chars.length) {
      i++;
      // SAFETY: i + 1 < chars.length was checked before the increment.
      tokens.push({ kind: "lit", cp: chars[i] as string });
    } else {
      tokens.push({ kind: "lit", cp: ch });
    }
  }

  return tokens;
};

export const wildcardMatch = (value: string, pattern: string): boolean => {
  if (pattern === "*") return true;
  const tokens = tokenize(pattern);
  const chars = Array.from(value);
  let t = 0;
  let s = 0;
  let starToken = -1;
  let starChar = 0;

  while (s < chars.length) {
    const token = tokens[t];

    if (token !== undefined && token.kind === "star") {
      starToken = t++;
      starChar = s;
    } else if (token !== undefined && (token.kind === "any" || token.cp === chars[s])) {
      t++;
      s++;
    } else if (starToken >= 0) {
      t = starToken + 1;
      s = ++starChar;
    } else {
      return false;
    }
  }

  while (tokens[t]?.kind === "star") t++;

  return t === tokens.length;
};
