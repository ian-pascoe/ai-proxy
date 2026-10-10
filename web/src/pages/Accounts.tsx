// Accounts: every connected account by provider, with a filter for those that need attention or are disabled and a
// search; each row opens the account. Connecting starts from the header's Connect account.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ChevronRight, Search } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import { credentialsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { Meter } from "../components/Meter.tsx";
import { TrailMark } from "../components/Signs.tsx";
import { type Assessed, accountName, assess } from "../lib/accounts.ts";
import { failureMessage } from "../lib/failure.ts";
import { formatCount, formatDuration } from "../lib/format.ts";
import { providerName } from "../lib/providers.ts";
import { checksQuota, windowLevel } from "../lib/quota.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Accounts.module.css";

/** Requests per account are counted over the recent-requests ring: ten-minute buckets. */
const BUCKET_MS = 10 * 60_000;

type Filter = "all" | "attention" | "disabled";

const needsAttention = (account: Assessed): boolean =>
  !account.entry.disabled && (account.closed || account.tone === "near");

const FILTERS: ReadonlyArray<{
  readonly id: Filter;
  readonly label: string;
  readonly keep: (account: Assessed) => boolean;
}> = [
  { id: "all", label: "All", keep: () => true },
  { id: "attention", label: "Needs attention", keep: needsAttention },
  { id: "disabled", label: "Disabled", keep: (account) => account.entry.disabled },
];

const matches = (account: Assessed, query: string): boolean => {
  if (query === "") return true;
  const { entry } = account;

  return [
    providerName(entry.provider),
    accountName(entry),
    entry.name,
    entry.note,
    entry.project_id,
    account.note,
  ].some((field) => field?.toLowerCase().includes(query) === true);
};

const byProviderThenName = (a: Assessed, b: Assessed): number =>
  providerName(a.entry.provider).localeCompare(providerName(b.entry.provider)) ||
  accountName(a.entry).localeCompare(accountName(b.entry));

const Row = ({ account }: { readonly account: Assessed }) => {
  const { entry, standing, closed, note, tone } = account;
  const navigate = useNavigate();
  const requests = entry.recent_requests.reduce((sum, bucket) => sum + bucket.success, 0);
  const failed = entry.recent_requests.reduce((sum, bucket) => sum + bucket.failed, 0);

  return (
    <tr
      className={styles["row"]}
      data-disabled={entry.disabled}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a") !== null) return;
        void navigate({ to: "/accounts/$authIndex", params: { authIndex: entry.auth_index } });
      }}
    >
      <th scope="row" className={styles["accountCell"]}>
        <div className={styles["account"]}>
          <span className={styles["markSlot"]}>{closed ? <TrailMark /> : null}</span>
          <span className={styles["who"]}>
            <span className={styles["provider"]}>{providerName(entry.provider)}</span>
            <Link
              to="/accounts/$authIndex"
              params={{ authIndex: entry.auth_index }}
              className={styles["address"]}
            >
              {accountName(entry)}
            </Link>
            {note === undefined ? null : (
              <span className={styles["note"]} data-tone={tone}>
                {note}
              </span>
            )}
          </span>
        </div>
      </th>
      <td className={styles["quota"]}>
        {standing.windows.length === 0 ? (
          entry.quota_report?.error !== undefined && checksQuota(entry.provider) ? (
            <span className={styles["checkFailed"]}>
              <TrailMark />
              The last quota check failed
            </span>
          ) : (
            <span className={kit["muted"]}>
              {checksQuota(entry.provider) ? "No figures yet" : "Not reported"}
            </span>
          )
        ) : (
          <div className={styles["meters"]}>
            {standing.windows.map((window) => (
              <Meter
                key={window.label}
                label={window.label}
                percent={window.usedPercent}
                level={windowLevel(window)}
              />
            ))}
          </div>
        )}
      </td>
      <td className={`${styles["number"]} ${styles["priority"]}`}>
        {entry.priority === undefined ? (
          <span className={kit["muted"]}>0</span>
        ) : (
          formatCount(entry.priority)
        )}
      </td>
      <td className={`${styles["number"]} ${styles["requests"]}`}>
        <span className={styles["count"]}>{formatCount(requests + failed)}</span>
        {failed > 0 ? <span className={styles["failed"]}>{formatCount(failed)} failed</span> : null}
      </td>
      <td className={styles["go"]} aria-hidden="true">
        <ChevronRight size={18} strokeWidth={2.25} />
      </td>
    </tr>
  );
};

const List = ({ accounts }: { readonly accounts: ReadonlyArray<Assessed> }) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const searchId = useId();
  const keep = FILTERS.find((candidate) => candidate.id === filter)?.keep ?? (() => true);
  const shown = accounts.filter((account) => keep(account) && matches(account, query));

  const span = formatDuration(
    Math.max(1, ...accounts.map((account) => account.entry.recent_requests.length)) * BUCKET_MS,
  );

  return (
    <>
      <div className={styles["toolbar"]}>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {FILTERS.map((candidate) => {
            const count = accounts.filter(candidate.keep).length;

            return (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={filter === candidate.id}
                className={kit["tab"]}
                onClick={() => setFilter(candidate.id)}
              >
                {candidate.label}
                <span className={kit["tabCount"]}>{formatCount(count)}</span>
              </button>
            );
          })}
        </div>
        <div className={styles["search"]}>
          <label htmlFor={searchId} className={kit["visuallyHidden"]}>
            Search accounts
          </label>
          <Search
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={styles["searchIcon"]}
          />
          <input
            id={searchId}
            type="search"
            className={kit["input"]}
            placeholder="Search accounts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className={styles["empty"]}>
          {query === ""
            ? filter === "attention"
              ? "Nothing needs attention: every active account is taking requests."
              : "No disabled accounts."
            : `No account matches “${search.trim()}”.`}
        </p>
      ) : (
        <>
          <p className={styles["mobileKey"]} aria-hidden="true">
            Requests, last {span}
          </p>
          <table className={styles["accounts"]}>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Allowance used</th>
                <th scope="col" className={styles["number"]}>
                  Priority
                </th>
                <th scope="col" className={styles["number"]}>
                  Requests, last {span}
                </th>
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((account) => (
                <Row key={account.entry.id} account={account} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
};

export const AccountsPage = () => {
  usePageTitle("Accounts");
  const result = useAtomValue(credentialsAtom);
  const retry = useAtomRefresh(credentialsAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Accounts</h1>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading accounts…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load accounts. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) =>
          value.files.length === 0 ? (
            <p className={styles["empty"]}>
              No accounts yet. Connect one to let the proxy answer requests with it.
            </p>
          ) : (
            <List accounts={value.files.map(assess).toSorted(byProviderThenName)} />
          ),
      })}
    </div>
  );
};
