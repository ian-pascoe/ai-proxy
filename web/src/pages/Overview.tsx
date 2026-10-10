// Overview: one sentence on what needs attention, the accounts in urgency order (use against allowance and how long
// until each is back to full), and the last 24 hours of usage by model.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Plus } from "lucide-react";
import type { CredentialEntry } from "#contract/credentials.ts";
import type { UsageSummary } from "#contract/usage.ts";
import { credentialsAtom, nowAtom, usageLastDayAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { Meter } from "../components/Meter.tsx";
import { ResetBlade, TrailMark } from "../components/Signs.tsx";
import { type Assessed, accountName, assess } from "../lib/accounts.ts";
import { failureMessage } from "../lib/failure.ts";
import { formatClock, formatCount, formatDuration, formatTokens } from "../lib/format.ts";
import { providerName } from "../lib/providers.ts";
import { type AccountStanding, byUrgency, checksQuota, windowLevel } from "../lib/quota.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Overview.module.css";

/** One sentence over the table: what needs attention, or that nothing does. */
const statusSentence = (accounts: ReadonlyArray<Assessed>): string => {
  const active = accounts.filter((account) => !account.entry.disabled);
  const closed = active.filter((account) => account.closed).length;

  const near = active.filter(
    (account) => !account.closed && account.standing.level === "near",
  ).length;

  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

  if (closed === 0 && near === 0) {
    return active.length === 1
      ? "Your account is taking requests."
      : `All ${active.length} active accounts are taking requests.`;
  }

  const parts = [
    closed > 0
      ? `${closed} ${plural(closed, "account is", "accounts are")} not taking requests`
      : "",
    near > 0
      ? `${near} ${plural(near, "is", "are")} near ${plural(near, "its", "their")} limit`
      : "",
  ].filter((part) => part !== "");

  return `${parts.join(" and ")}.`;
};

const ResetCell = ({
  standing,
  order,
}: {
  readonly standing: AccountStanding;
  readonly order: number;
}) => {
  const now = useAtomValue(nowAtom);

  if (standing.nextReset === undefined || standing.nextReset <= now) {
    return <span className={kit["muted"]}>No reset reported</span>;
  }

  const closed = standing.cutOffUntil !== undefined;
  const time = formatDuration(standing.nextReset - now);
  const window = standing.nextResetWindow;

  return (
    <ResetBlade
      destination={closed ? "Back in" : (window ?? "Resets in")}
      time={time}
      label={
        closed || window === undefined
          ? `${closed ? "Back in" : "Resets in"} ${time}`
          : `${window} window resets in ${time}`
      }
      closed={closed}
      demanding={!closed && standing.level === "near"}
      order={order}
      caption={formatClock(standing.nextReset)}
    />
  );
};

/** Why an account shows no meters. */
const noQuotaNote = (entry: CredentialEntry): string =>
  checksQuota(entry.provider)
    ? "No figures yet; the next quota check reads them."
    : `${providerName(entry.provider)} does not report quota.`;

const AccountRow = ({ account, index }: { readonly account: Assessed; readonly index: number }) => {
  const { entry, standing, closed, note, tone } = account;

  const requests = entry.recent_requests.reduce(
    (sum, bucket) => sum + bucket.success + bucket.failed,
    0,
  );

  const failed = entry.recent_requests.reduce((sum, bucket) => sum + bucket.failed, 0);

  return (
    <tr className={styles["row"]} data-disabled={entry.disabled}>
      <th scope="row" className={styles["accountCell"]}>
        <div className={styles["account"]}>
          <span className={styles["markSlot"]}>{closed ? <TrailMark /> : null}</span>
          <span className={styles["who"]}>
            <span className={styles["provider"]}>{providerName(entry.provider)}</span>
            <span className={styles["address"]}>{accountName(entry)}</span>
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
          <span className={kit["muted"]}>{noQuotaNote(entry)}</span>
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
      <td className={styles["reset"]}>
        {entry.disabled ? (
          <span className={kit["muted"]}>Not in use</span>
        ) : (
          <ResetCell standing={standing} order={index} />
        )}
      </td>
      <td className={styles["requests"]}>
        <span className={styles["count"]}>{formatCount(requests)}</span>
        {failed > 0 ? <span className={styles["failed"]}>{formatCount(failed)} failed</span> : null}
      </td>
    </tr>
  );
};

const ConnectButton = () => (
  <Link to="/accounts/connect" className={kit["primary"]}>
    <Plus aria-hidden="true" size={16} strokeWidth={2.5} />
    Connect account
  </Link>
);

/** Requests per account are counted over the recent-requests ring: ten-minute buckets. */
const BUCKET_MS = 10 * 60_000;

const Accounts = () => {
  const result = useAtomValue(credentialsAtom);
  const retry = useAtomRefresh(credentialsAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <Section title="Accounts">
        <p className={kit["muted"]} aria-busy="true">
          Loading accounts…
        </p>
      </Section>
    ),
    onFailure: (failure) => (
      <Section title="Accounts">
        <Problem onRetry={retry}>Could not load accounts. {failureMessage(failure)}</Problem>
      </Section>
    ),
    onSuccess: ({ value }) => {
      if (value.files.length === 0) {
        return (
          <section className={styles["firstRun"]} aria-labelledby="first-run">
            <h2 id="first-run" className={styles["firstRunTitle"]}>
              Connect your first account
            </h2>
            <p className={styles["firstRunText"]}>
              The proxy answers requests with your provider subscriptions. Sign in to Claude, Codex
              or another provider once, and this page shows how much of each allowance is used and
              when it resets.
            </p>
            <ConnectButton />
          </section>
        );
      }

      const accounts = value.files.toSorted(byUrgency).map(assess);

      const span = `last ${formatDuration(
        Math.max(1, ...value.files.map((entry) => entry.recent_requests.length)) * BUCKET_MS,
      )}`;

      return (
        <>
          <p className={styles["status"]} role="status">
            {statusSentence(accounts)}
          </p>
          <Section
            title="Accounts"
            aside={
              <Link to="/accounts" className={kit["sectionLink"]}>
                Manage accounts
              </Link>
            }
          >
            <p className={styles["key"]} aria-hidden="true">
              Figures on the right: requests, {span}.
            </p>
            <table className={styles["accounts"]}>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Allowance used</th>
                  <th scope="col">Next reset</th>
                  <th scope="col" className={styles["number"]}>
                    Requests, {span}
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account, index) => (
                  <AccountRow key={account.entry.id} account={account} index={index} />
                ))}
              </tbody>
            </table>
          </Section>
        </>
      );
    },
  });
};

const UsageTable = ({ summary }: { readonly summary: UsageSummary }) => {
  const largest = Math.max(1, ...summary.groups.map((group) => group.total_tokens));

  return (
    <table className={styles["usage"]}>
      <caption className={kit["visuallyHidden"]}>Usage by model, last 24 hours</caption>
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col" className={styles["number"]}>
            Requests
          </th>
          <th scope="col" className={styles["number"]}>
            Failed
          </th>
          <th scope="col" className={styles["number"]}>
            Tokens
          </th>
          <th scope="col" className={styles["shareHead"]}>
            <span className={kit["visuallyHidden"]}>Share of tokens</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {summary.groups.map((group) => (
          <tr key={group.key}>
            <th scope="row" className={styles["model"]} title={group.key}>
              {group.key === "" ? "Unknown model" : group.key}
            </th>
            <td className={styles["number"]}>{formatCount(group.requests)}</td>
            <td className={styles["number"]} data-bad={group.failed > 0}>
              {formatCount(group.failed)}
            </td>
            <td className={styles["number"]}>{formatTokens(group.total_tokens)}</td>
            <td className={styles["share"]} aria-hidden="true">
              <span style={{ width: `${(group.total_tokens / largest) * 100}%` }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** The day's totals, beside the by-model table. */
const Totals = ({ summary }: { readonly summary: UsageSummary }) => (
  <dl className={styles["totals"]}>
    <div>
      <dt>Requests</dt>
      <dd>{formatCount(summary.totals.requests)}</dd>
    </div>
    <div>
      <dt>Failed</dt>
      <dd data-bad={summary.totals.failed > 0}>{formatCount(summary.totals.failed)}</dd>
    </div>
    <div>
      <dt>Tokens</dt>
      <dd>{formatTokens(summary.totals.total_tokens)}</dd>
    </div>
  </dl>
);

const LastDay = () => {
  const result = useAtomValue(usageLastDayAtom);
  const retry = useAtomRefresh(usageLastDayAtom);

  return (
    <Section
      title="Last 24 hours"
      aside={
        <Link to="/usage" className={kit["sectionLink"]}>
          All usage
        </Link>
      }
    >
      <div aria-busy={result.waiting}>
        {AsyncResult.match(result, {
          onInitial: () => <p className={kit["muted"]}>Loading usage…</p>,
          onFailure: (failure) => (
            <Problem onRetry={retry}>Could not load usage. {failureMessage(failure)}</Problem>
          ),
          onSuccess: ({ value }) =>
            value.totals.requests === 0 ? (
              <p className={kit["muted"]}>No requests in the last 24 hours.</p>
            ) : (
              <div className={styles["lastDay"]}>
                <Totals summary={value} />
                <UsageTable summary={value} />
              </div>
            ),
        })}
      </div>
    </Section>
  );
};

export const OverviewPage = () => {
  usePageTitle("Overview");

  return (
    <div className={kit["page"]}>
      <h1 className={kit["visuallyHidden"]}>Overview</h1>
      <Accounts />
      <LastDay />
    </div>
  );
};
