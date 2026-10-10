// Overview: one statement per account in urgency order (use against allowance, when it resets), an attention line
// only when something needs the operator, and the last 24 hours of usage itemised by model.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { TriangleAlert } from "lucide-react";
import type { CredentialEntry } from "#contract/credentials.ts";
import type { UsageSummary } from "#contract/usage.ts";
import { credentialsAtom, nowAtom, usageLastDayAtom } from "../api/client.ts";
import { Meter } from "../components/Meter.tsx";
import { Statement, StatusTag } from "../components/Statement.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  formatClock,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
} from "../lib/format.ts";
import { OLD_PANEL_CONNECT } from "../lib/old-panel.ts";
import { providerName } from "../lib/providers.ts";
import {
  type AccountStanding,
  accountStanding,
  byUrgency,
  reportsQuota,
  windowLevel,
} from "../lib/quota.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Overview.module.css";

/** Minutes covered by the recent-requests ring (20 ten-minute buckets). */
const RECENT_WINDOW = "last 3 h 20 m";

/** The account's address or label, whichever it has (the file name as a last resort). */
const accountName = (entry: CredentialEntry): string =>
  [entry.email, entry.account, entry.label].find((name) => name !== undefined && name !== "") ??
  entry.name;

const attentionSentences = (accounts: ReadonlyArray<CredentialEntry>): string[] =>
  accounts
    .filter((entry) => !entry.disabled)
    .flatMap((entry) => {
      const standing = accountStanding(entry);
      const who = `${providerName(entry.provider)} (${accountName(entry)})`;

      if (standing.cutOffUntil !== undefined) return [`${who} is cut off.`];

      if (entry.status === "error") {
        return [
          `${who} is failing${entry.status_message === "" ? "" : `: ${entry.status_message}`}.`,
        ];
      }

      const full = standing.windows.find((window) => windowLevel(window) !== "ok");

      return full === undefined
        ? []
        : [
            `${who} has used ${formatPercent(full.usedPercent)} of its ${full.label.toLowerCase()} allowance.`,
          ];
    });

const AttentionLine = ({ accounts }: { readonly accounts: ReadonlyArray<CredentialEntry> }) => {
  const sentences = attentionSentences(accounts);

  if (sentences.length === 0) return null;

  return (
    <p className={styles["attention"]} role="status">
      <TriangleAlert
        aria-hidden="true"
        size={18}
        strokeWidth={2.25}
        className={styles["attentionIcon"]}
      />
      <span>{sentences.join(" ")}</span>
    </p>
  );
};

const ResetBox = ({ standing }: { readonly standing: AccountStanding }) => {
  const now = useAtomValue(nowAtom);

  if (standing.nextReset === undefined || standing.nextReset <= now) return null;
  const cutOff = standing.cutOffUntil !== undefined;

  return (
    <div className={styles["reset"]} data-level={standing.level}>
      <span className={styles["resetLabel"]}>{cutOff ? "Back in" : "Resets in"}</span>
      <span className={styles["resetFigure"]}>{formatDuration(standing.nextReset - now)}</span>
      <span className={styles["resetClock"]}>{formatClock(standing.nextReset)}</span>
    </div>
  );
};

const statusTag = (entry: CredentialEntry, standing: AccountStanding) => {
  if (entry.disabled) return <StatusTag tone="neutral">Disabled</StatusTag>;

  if (standing.cutOffUntil !== undefined) return <StatusTag tone="red">Cut off</StatusTag>;

  if (entry.status === "error") return <StatusTag tone="red">Failing</StatusTag>;

  return standing.level === "near" ? <StatusTag tone="amber">Near limit</StatusTag> : undefined;
};

/** Why an account shows no meters. */
const noQuotaNote = (entry: CredentialEntry): string => {
  const provider = providerName(entry.provider);

  if (entry.disabled) return "Disabled: this account takes no requests until it is enabled again.";

  if (!reportsQuota(entry.provider)) return `${provider} does not report its quota.`;

  return `No quota figures from ${provider} yet. They appear after the next request through this account.`;
};

const AccountStatement = ({ entry }: { readonly entry: CredentialEntry }) => {
  const standing = accountStanding(entry);

  const requests = entry.recent_requests.reduce(
    (sum, bucket) => sum + bucket.success + bucket.failed,
    0,
  );

  const failed = entry.recent_requests.reduce((sum, bucket) => sum + bucket.failed, 0);

  return (
    <Statement
      headingLevel={3}
      title={providerName(entry.provider)}
      subtitle={accountName(entry)}
      aside={statusTag(entry, standing)}
      footer={
        <dl className={styles["counts"]}>
          <div>
            <dt>Requests, {RECENT_WINDOW}</dt>
            <dd>{formatCount(requests)}</dd>
          </div>
          <div>
            <dt>Failed</dt>
            <dd data-bad={failed > 0}>{formatCount(failed)}</dd>
          </div>
        </dl>
      }
    >
      <div className={styles["account"]}>
        <div className={styles["meters"]}>
          {standing.windows.length === 0 ? (
            <p className={styles["muted"]}>{noQuotaNote(entry)}</p>
          ) : (
            standing.windows.map((window) => (
              <Meter
                key={window.label}
                label={window.label}
                percent={window.usedPercent}
                level={windowLevel(window)}
              />
            ))
          )}
        </div>
        <ResetBox standing={standing} />
      </div>
    </Statement>
  );
};

const Accounts = () => {
  const result = useAtomValue(credentialsAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <div className={styles["grid"]} aria-busy="true">
        <Statement headingLevel={3} title="Accounts" busy>
          <p className={styles["muted"]}>Loading accounts…</p>
        </Statement>
      </div>
    ),
    onFailure: (failure) => (
      <Statement
        headingLevel={3}
        title="Accounts"
        aside={<StatusTag tone="red">Unavailable</StatusTag>}
      >
        <p>Could not load accounts. {failureMessage(failure)}</p>
      </Statement>
    ),
    onSuccess: ({ value }) => {
      if (value.files.length === 0) {
        return (
          <Statement headingLevel={3} title="No accounts connected">
            <p className={styles["empty"]}>
              Requests need at least one provider account.{" "}
              <a href={OLD_PANEL_CONNECT}>Connect an account</a> to start.
            </p>
          </Statement>
        );
      }

      const accounts = value.files.toSorted(byUrgency);

      return (
        <>
          <AttentionLine accounts={accounts} />
          <div className={styles["grid"]}>
            {accounts.map((entry) => (
              <AccountStatement key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      );
    },
  });
};

const UsageTable = ({ summary }: { readonly summary: UsageSummary }) => {
  const largest = Math.max(1, ...summary.groups.map((group) => group.total_tokens));

  return (
    <>
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
      <table className={styles["table"]}>
        <caption className={styles["visuallyHidden"]}>Usage by model, last 24 hours</caption>
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
              <span className={styles["visuallyHidden"]}>Share of tokens</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.groups.map((group) => (
            <tr key={group.key}>
              <th scope="row" className={styles["model"]}>
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
    </>
  );
};

const LastDay = () => {
  const result = useAtomValue(usageLastDayAtom);

  return (
    <Statement title="Last 24 hours" busy={result.waiting}>
      {AsyncResult.match(result, {
        onInitial: () => <p className={styles["muted"]}>Loading usage…</p>,
        onFailure: (failure) => <p>Could not load usage. {failureMessage(failure)}</p>,
        onSuccess: ({ value }) =>
          value.totals.requests === 0 ? (
            <p className={styles["muted"]}>No requests in the last 24 hours.</p>
          ) : (
            <UsageTable summary={value} />
          ),
      })}
    </Statement>
  );
};

export const OverviewPage = () => {
  usePageTitle("Overview");

  return (
    <div className={styles["page"]}>
      <h1 className={styles["visuallyHidden"]}>Overview</h1>
      <section aria-label="Accounts" className={styles["accounts"]}>
        <Accounts />
      </section>
      <LastDay />
    </div>
  );
};
