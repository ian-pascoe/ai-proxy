/**
 * Server-sent events: upstream line splitting and downstream frame builders.
 *
 * Go source: bufio.Scanner with ScanLines (executors read upstream SSE line by line; `\n` terminates a line and a
 * trailing `\r` is dropped), internal/translator/common/bytes.go (AppendSSEEventBytes).
 */
import { Stream } from "effect";

/** Incremental line splitter with Go `bufio.ScanLines` semantics; the final unterminated line is emitted on `end`. */
export class LineSplitter {
  #buffer = "";

  push(text: string): string[] {
    const data = this.#buffer + text;
    const lines: string[] = [];
    let from = 0;
    let index = data.indexOf("\n", from);

    while (index !== -1) {
      lines.push(dropCR(data.slice(from, index)));
      from = index + 1;
      index = data.indexOf("\n", from);
    }

    this.#buffer = data.slice(from);

    return lines;
  }

  end(): string[] {
    const rest = this.#buffer;
    this.#buffer = "";

    return rest === "" ? [] : [dropCR(rest)];
  }
}

const dropCR = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** Decodes a byte stream as UTF-8 and splits it into lines (without terminators). */
export const splitLines = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<string, E, R> =>
  bytes.pipe(
    Stream.decodeText,
    Stream.mapAccum(
      () => new LineSplitter(),
      (splitter, text: string) => [splitter, splitter.push(text)] as const,
      { onHalt: (splitter) => splitter.end() },
    ),
  );

/** `data: <payload>\n\n` (OpenAI chat chunks, Gemini SSE). */
export const sseData = (payload: string): string => `data: ${payload}\n\n`;

/** `event: <name>\ndata: <payload>\n\n` (Claude, Responses, Interactions); `AppendSSEEventBytes` with two newlines. */
export const sseEvent = (event: string, payload: string): string =>
  `event: ${event}\ndata: ${payload}\n\n`;

/** Default SSE comment used as keep-alive. */
export const SSE_KEEP_ALIVE = ": keep-alive\n\n";

/** The `data:` payload of one SSE line (trimmed), or `undefined` when the line is not a data line. */
export const sseLinePayload = (line: string): string | undefined => {
  const trimmed = line.trim();

  return trimmed.startsWith("data:") ? trimmed.slice(5).trim() : undefined;
};
