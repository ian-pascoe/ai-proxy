// Use against allowance: a flat bar on the shared 0–100% scale (stone is the unused allowance) with its figure.
import type { QuotaLevel } from "../lib/quota.ts";
import { formatPercent } from "../lib/format.ts";
import styles from "./Meter.module.css";

interface MeterProps {
  readonly label: string;
  /** 0–100. */
  readonly percent: number;
  readonly level: QuotaLevel;
}

export const Meter = ({ label, percent, level }: MeterProps) => (
  <div className={styles["meter"]}>
    <span className={styles["label"]}>{label}</span>
    <div
      className={styles["track"]}
      role="meter"
      aria-label={`${label} allowance used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={formatPercent(percent)}
    >
      <div className={styles["fill"]} data-level={level} style={{ width: `${percent}%` }} />
    </div>
    <span className={styles["value"]} data-level={level}>
      {formatPercent(percent)}
    </span>
  </div>
);
