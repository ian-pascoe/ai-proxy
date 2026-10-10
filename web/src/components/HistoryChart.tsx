// Tokens per past window as columns: stone for finished windows, ink for the one in progress. The readout over the
// columns names the column under the pointer (the current one otherwise); a hidden table gives assistive
// technology the same figures.
import { type CSSProperties, useState } from "react";
import type { HistoryBar } from "../lib/history.ts";
import { formatCount, formatTokens } from "../lib/format.ts";
import { kit } from "./Kit.tsx";
import styles from "./HistoryChart.module.css";

interface HistoryChartProps {
  /** "Tokens per 5-hour window". */
  readonly title: string;
  readonly bars: ReadonlyArray<HistoryBar>;
  /** A bar's period: "Oct 3 – Oct 10". */
  readonly period: (bar: HistoryBar) => string;
  /** Said under the chart when the bars are approximate. */
  readonly note?: string | undefined;
  /** What the bar in progress is called: "This window" unless the bars are days. */
  readonly currentLabel?: string;
}

export const HistoryChart = ({
  title,
  bars,
  period,
  note,
  currentLabel = "This window",
}: HistoryChartProps) => {
  const [pointed, setPointed] = useState<number | undefined>(undefined);
  const largest = Math.max(1, ...bars.map((bar) => bar.tokens));
  const shown = bars[pointed ?? bars.length - 1];
  const first = bars[0];
  // SAFETY: React's CSSProperties omits custom properties; `--bars` is a plain number the stylesheet reads.
  const width = { "--bars": bars.length } as CSSProperties;

  return (
    <figure className={styles["chart"]} style={width}>
      <figcaption className={styles["title"]}>{title}</figcaption>
      <p className={styles["readout"]} aria-hidden="true">
        {shown === undefined ? null : (
          <>
            <span className={styles["period"]}>{shown.current ? currentLabel : period(shown)}</span>
            <span className={styles["figure"]}>{formatTokens(shown.tokens)} tokens</span>
            <span className={styles["requests"]}>{formatCount(shown.requests)} requests</span>
          </>
        )}
      </p>
      <div
        className={styles["plot"]}
        aria-hidden="true"
        onPointerLeave={() => setPointed(undefined)}
      >
        {bars.map((bar, index) => (
          <span
            key={bar.start}
            className={styles["slot"]}
            onPointerEnter={() => setPointed(index)}
            data-pointed={pointed === index}
          >
            <span
              className={styles["bar"]}
              data-current={bar.current}
              data-empty={bar.tokens === 0}
              style={{ height: `${(bar.tokens / largest) * 100}%` }}
            />
          </span>
        ))}
      </div>
      <div className={styles["axis"]} aria-hidden="true">
        <span>{first === undefined ? "" : period(first)}</span>
        <span>Now</span>
      </div>
      {note === undefined ? null : <p className={styles["note"]}>{note}</p>}
      <table className={kit["visuallyHidden"]}>
        <thead>
          <tr>
            <th scope="col">Window</th>
            <th scope="col">Tokens</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.start}>
              <th scope="row">{bar.current ? `${currentLabel} (${period(bar)})` : period(bar)}</th>
              <td>{formatTokens(bar.tokens)}</td>
              <td>{formatCount(bar.requests)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
