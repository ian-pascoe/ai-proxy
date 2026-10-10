// Log-safe summaries of failures. New in the Workers port: `Cause.pretty` includes stack traces and full error
// messages, and HTTP client errors embed request URLs (query strings may carry keys or tokens).
import { Cause } from "effect";

const MAX_SUMMARY_CHARS = 300;

/** Drops query strings and fragments of URLs inside `text` (`https://host/path?key=...` -> `https://host/path?…`). */
export const redactUrls = (text: string): string =>
  text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?…");

const describe = (cause: unknown): string => {
  if (cause instanceof Error) {
    const tag: unknown = "_tag" in cause ? cause._tag : undefined;

    return `${typeof tag === "string" ? tag : cause.name}: ${cause.message}`;
  }

  if (typeof cause === "object" && cause !== null) {
    const tag: unknown = "_tag" in cause ? cause._tag : undefined;
    const message: unknown = "message" in cause ? cause.message : undefined;

    if (typeof tag === "string") return typeof message === "string" ? `${tag}: ${message}` : tag;
  }

  return String(cause);
};

/** One line for logs: the error tag and message (no stack), URLs without query, at most 300 characters. */
export const causeSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted";

  const summary = redactUrls(describe(Cause.squash(cause)))
    .replace(/\s+/g, " ")
    .trim();

  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary;
};
