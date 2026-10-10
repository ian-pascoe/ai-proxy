// The page frame: the yellow shell bar (name and host, page links, Connect account, Refresh) above the page.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { credentialsAtom, usageLastDayAtom } from "../api/client.ts";
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
      className={styles["refresh"]}
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
        strokeWidth={2.25}
        className={busy ? styles["spinning"] : undefined}
      />
    </button>
  );
};

/**
 * Narrow screens scroll the page links sideways: keep the current page's link in view, and mark which ends of the
 * strip have more links beyond them (the stylesheet fades those edges).
 */
const usePageLinkStrip = () => {
  const nav = useRef<HTMLElement>(null);
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    const strip = nav.current;

    if (strip === null) return;

    const mark = () => {
      strip.dataset["start"] = String(strip.scrollLeft <= 1);
      strip.dataset["end"] = String(strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1);
    };

    mark();
    strip.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("resize", mark);

    return () => {
      strip.removeEventListener("scroll", mark);
      window.removeEventListener("resize", mark);
    };
  }, []);

  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return nav;
};

export const Shell = () => {
  const nav = usePageLinkStrip();

  return (
    <>
      <a className={styles["skip"]} href="#main">
        Skip to content
      </a>
      <header className={styles["bar"]}>
        <div className={styles["inner"]}>
          <Link to="/" className={styles["brand"]}>
            <span className={styles["name"]}>cliproxy</span>
            <span className={styles["host"]} title={window.location.host}>
              {window.location.host}
            </span>
          </Link>
          <nav ref={nav} aria-label="Main" className={styles["nav"]}>
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
            <Link to="/accounts/connect" className={styles["connect"]}>
              <Plus aria-hidden="true" size={16} strokeWidth={2.5} />
              Connect account
            </Link>
            <RefreshButton />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={styles["main"]}>
        <Outlet />
      </main>
    </>
  );
};
