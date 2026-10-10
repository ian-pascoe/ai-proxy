// Pages that have not moved from the previous panel yet: what will live here, and where to do it until then.
import { OLD_PANEL } from "../lib/old-panel.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Placeholder.module.css";

interface PlaceholderProps {
  readonly title: string;
  /** What the page will hold, one sentence. */
  readonly holds: string;
}

export const Placeholder = ({ title, holds }: PlaceholderProps) => {
  usePageTitle(title);

  return (
    <div className={styles["page"]}>
      <h1 className={styles["title"]}>{title}</h1>
      <p className={styles["lead"]}>{holds}</p>
      <p className={styles["lead"]}>
        This page has not moved here yet. Until it does, use the{" "}
        <a href={OLD_PANEL}>previous panel</a>.
      </p>
    </div>
  );
};

export const NotFound = () => {
  usePageTitle("Page not found");

  return (
    <div className={styles["page"]}>
      <h1 className={styles["title"]}>Page not found</h1>
      <p className={styles["lead"]}>
        Nothing lives at this address. Pick a page above, or go back to the <a href="/">overview</a>
        .
      </p>
    </div>
  );
};
