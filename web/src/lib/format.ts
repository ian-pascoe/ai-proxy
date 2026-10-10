// Figures as the statements print them: grouped counts, compact token totals, whole percentages and spelled-out
// durations ("2 h 35 m"). Pure: no DOM, tested in test/web-quota.test.ts.

const counts = new Intl.NumberFormat("en-US");

const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** 1204 → "1,204". */
export const formatCount = (value: number): string => counts.format(value);

/** 18_200_000 → "18.2 M", 7400 → "7.4 k", 312 → "312". */
export const formatTokens = (value: number): string => {
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const;

  for (const [size, unit] of units) {
    if (Math.abs(value) >= size) return `${oneDecimal.format(value / size)} ${unit}`;
  }

  return counts.format(value);
};

/** 68.6 → "69%"; shares above 0 but under 1 read "<1%" so a used window never prints as empty. */
export const formatPercent = (value: number): string => {
  if (value > 0 && value < 1) return "<1%";

  return `${Math.round(value)}%`;
};

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

/** A remaining time in its two largest units: "4 d 3 h", "2 h 35 m", "12 m", "under 1 m". */
export const formatDuration = (ms: number): string => {
  if (ms < MINUTE) return "under 1 m";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);

  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;

  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} m` : `${hours} h`;

  return `${minutes} m`;
};

const clock = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** An instant in the operator's time zone: "Sat 4:35 PM". */
export const formatClock = (epochMs: number): string => clock.format(epochMs);
