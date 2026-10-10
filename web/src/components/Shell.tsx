// The page frame: the utility-blue band (product name, page links, Connect account, Refresh) above the page.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, Outlet } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { credentialsAtom, usageLastDayAtom } from "../api/client.ts";
import { OLD_PANEL_CONNECT } from "../lib/old-panel.ts";
import styles from "./Shell.module.css";

const PAGES = [
  { to: "/", label: "Overview" },
  { to: "/accounts", label: "Accounts" },
  { to: "/keys", label: "API keys" },
  { to: "/models", label: "Models" },
  { to: "/usage", label: "Usage" },
  { to: "/settings", label: "Settings" },
] as const;

const RefreshButton = () => {
  const credentials = useAtomValue(credentialsAtom);
  const usage = useAtomValue(usageLastDayAtom);
  const refreshCredentials = useAtomRefresh(credentialsAtom);
  const refreshUsage = useAtomRefresh(usageLastDayAtom);
  const busy = credentials.waiting || usage.waiting;

  return (
    <button
      type="button"
      className={styles["iconButton"]}
      aria-label="Refresh"
      title="Refresh"
      aria-busy={busy}
      onClick={() => {
        refreshCredentials();
        refreshUsage();
      }}
    >
      <RefreshCw
        aria-hidden="true"
        size={18}
        strokeWidth={2}
        className={busy ? styles["spinning"] : undefined}
      />
    </button>
  );
};

export const Shell = () => (
  <>
    <a className={styles["skip"]} href="#main">
      Skip to content
    </a>
    <header className={styles["band"]}>
      <div className={styles["bandInner"]}>
        <Link to="/" className={styles["brand"]}>
          cliproxy
        </Link>
        <nav aria-label="Main" className={styles["nav"]}>
          <ul>
            {PAGES.map((page) => (
              <li key={page.to}>
                <Link
                  to={page.to}
                  activeOptions={{ exact: page.to === "/" }}
                  className={styles["navLink"]}
                >
                  {page.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles["actions"]}>
          <a className={styles["connect"]} href={OLD_PANEL_CONNECT}>
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
            Connect account
          </a>
          <RefreshButton />
        </div>
      </div>
    </header>
    <main id="main" tabIndex={-1} className={styles["main"]}>
      <Outlet />
    </main>
  </>
);
