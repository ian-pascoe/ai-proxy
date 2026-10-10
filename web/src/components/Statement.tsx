// A ruled statement block: a utility-blue title strip over an itemised body, like a section of a bill.
import { useId, type ReactNode } from "react";
import styles from "./Statement.module.css";

interface StatementProps {
  readonly title: ReactNode;
  /** Secondary text in the strip after the title (the account address). */
  readonly subtitle?: ReactNode;
  /** Right end of the strip (a status tag). */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly busy?: boolean;
  readonly headingLevel?: 2 | 3;
}

export const Statement = ({
  title,
  subtitle,
  aside,
  children,
  footer,
  busy = false,
  headingLevel = 2,
}: StatementProps) => {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section className={styles["statement"]} aria-labelledby={id} aria-busy={busy}>
      <header className={styles["strip"]}>
        <Heading id={id} className={styles["title"]}>
          {title}
          {subtitle === undefined ? null : <span className={styles["subtitle"]}>{subtitle}</span>}
        </Heading>
        {aside === undefined ? null : <div className={styles["aside"]}>{aside}</div>}
      </header>
      <div className={styles["body"]}>{children}</div>
      {footer === undefined ? null : <footer className={styles["footer"]}>{footer}</footer>}
    </section>
  );
};

type TagTone = "neutral" | "amber" | "red";

/** A short status word in the title strip ("Disabled", "Cut off"). */
export const StatusTag = ({
  tone,
  children,
}: {
  readonly tone: TagTone;
  readonly children: ReactNode;
}) => (
  <span className={styles["tag"]} data-tone={tone}>
    {children}
  </span>
);
