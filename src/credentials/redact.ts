/**
 * Secret redaction for text that may be stored or returned to management clients (upstream error messages).
 *
 * Go source: sdk/cliproxy/auth/selector.go (`ExtractUpstreamErrorSummary`, redaction helpers). Credentials must never
 * be logged or echoed; this strips the common token shapes and truncates to 256 characters.
 */
const MAX_SUMMARY = 256;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh_[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    "$1$2[redacted]",
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [redacted]"],
];

/** Redacts token-shaped substrings and truncates to 256 characters (`253 + "..."`). */
export const redactSecrets = (text: string): string => {
  let out = text.replace(/\s+/g, " ").trim();

  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  const chars = Array.from(out);

  return chars.length > MAX_SUMMARY ? `${chars.slice(0, MAX_SUMMARY - 3).join("")}...` : out;
};
