// One account: its allowance (each window with its reset blade), cooldowns, tokens per past window, routing fields,
// details, the models it serves, and the actions on it (check quota, refresh tokens, enable or disable, delete).
import { useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, ChevronRight, Gauge, Power, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import type { CredentialEntry } from "#contract/credentials.ts";
import {
  accountModelsAtom,
  accountSeriesAtom,
  CREDENTIALS,
  checkQuotaAtom,
  credentialsAtom,
  nowAtom,
  patchFieldsAtom,
  refreshAtom,
  removeAtom,
  resetCooldownAtom,
  setDisabledAtom,
} from "../api/client.ts";
import { HistoryChart } from "../components/HistoryChart.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { Meter } from "../components/Meter.tsx";
import { ResetBlade, TrailMark } from "../components/Signs.tsx";
import { accountName, assess, refreshable } from "../lib/accounts.ts";
import { failureMessage } from "../lib/failure.ts";
import {
  formatAgo,
  formatClock,
  formatCount,
  formatDate,
  formatDay,
  formatDuration,
} from "../lib/format.ts";
import { dailyHistory, type HistoryBar, windowHistory } from "../lib/history.ts";
import { providerName } from "../lib/providers.ts";
import { checksQuota, type QuotaWindow, quotaReading, windowLevel } from "../lib/quota.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Account.module.css";

const route = getRouteApi("/accounts/$authIndex");

interface Notice {
  readonly tone: "done" | "problem";
  readonly text: string;
}

const parsed = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const at = Date.parse(raw);

  return Number.isNaN(at) ? undefined : at;
};

// ---------------------------------------------------------------------------------------------------------------
// Allowance

const WindowRow = ({ window, now }: { readonly window: QuotaWindow; readonly now: number }) => {
  const level = windowLevel(window);

  return (
    <li className={styles["window"]}>
      <Meter label={window.label} percent={window.usedPercent} level={level} />
      {window.resetsAt === undefined ? (
        <span className={kit["muted"]}>No reset reported</span>
      ) : window.resetsAt <= now ? (
        <span className={kit["muted"]}>Reset {formatAgo(now - window.resetsAt)}</span>
      ) : (
        <ResetBlade
          destination={level === "out" ? "Back in" : "Resets in"}
          time={formatDuration(window.resetsAt - now)}
          label={`${window.label} window ${level === "out" ? "used up; back in" : "resets in"} ${formatDuration(window.resetsAt - now)}`}
          closed={level === "out"}
          demanding={level === "near"}
          caption={formatClock(window.resetsAt)}
        />
      )}
    </li>
  );
};

const Allowance = ({ entry, now }: { readonly entry: CredentialEntry; readonly now: number }) => {
  const reading = quotaReading(entry);
  const report = entry.quota_report;
  const checkedAt = parsed(report?.checked_at);

  return (
    <Section title="Allowance">
      {reading.windows.length === 0 ? (
        <p className={kit["muted"]}>
          {checksQuota(entry.provider)
            ? "No figures yet. Check quota to read them from the provider."
            : `${providerName(entry.provider)} does not report quota.`}
        </p>
      ) : (
        <>
          <ul className={styles["windows"]}>
            {reading.windows.map((window) => (
              <WindowRow key={window.label} window={window} now={now} />
            ))}
          </ul>
          {reading.readAt === undefined ? null : (
            <p className={styles["source"]}>
              {reading.source === "check"
                ? `Read by the quota check ${formatAgo(now - reading.readAt)}.`
                : `Read from the last response ${formatAgo(now - reading.readAt)}.`}
            </p>
          )}
        </>
      )}
      {report?.error === undefined ? null : (
        <div className={styles["checkFailed"]}>
          <TrailMark />
          <p>
            The last quota check
            {checkedAt === undefined ? "" : `, ${formatAgo(now - checkedAt)},`} failed:{" "}
            {report.error}
          </p>
        </div>
      )}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Cooldowns

const Cooldowns = ({
  entry,
  now,
  onNotice,
}: {
  readonly entry: CredentialEntry;
  readonly now: number;
  readonly onNotice: (notice: Notice) => void;
}) => {
  const reset = useAction(resetCooldownAtom);
  const live = entry.cooldowns.filter((cooldown) => (parsed(cooldown.retry_at) ?? 0) > now);

  if (live.length === 0) return null;

  return (
    <Section
      title="Cooldowns"
      aside={
        <button
          type="button"
          className={kit["secondary"]}
          disabled={reset.busy}
          onClick={async () => {
            const outcome = await reset.run({
              payload: { auth_index: entry.auth_index },
              reactivityKeys: CREDENTIALS,
            });

            onNotice(
              outcome.ok
                ? { tone: "done", text: "Cooldowns cleared. The account takes requests again." }
                : { tone: "problem", text: `Could not clear the cooldowns. ${outcome.message}` },
            );
          }}
        >
          Clear cooldowns
        </button>
      }
    >
      <p className={styles["lead"]}>
        The provider turned requests away, so the proxy is resting this account until the times
        below. Clear them to try it again now.
      </p>
      <table className={`${styles["table"]} ${styles["cooldowns"]}`}>
        <thead>
          <tr>
            <th scope="col">Applies to</th>
            <th scope="col">Reason</th>
            <th scope="col">Back in</th>
          </tr>
        </thead>
        <tbody>
          {live.map((cooldown) => {
            const at = parsed(cooldown.retry_at) ?? now;

            return (
              <tr key={`${cooldown.scope}:${cooldown.model_key ?? ""}`}>
                <th scope="row">
                  {cooldown.scope === "credential" ? "Whole account" : (cooldown.model_key ?? "")}
                </th>
                <td>
                  {cooldownReason(cooldown.reason)}
                  {cooldown.http_status === undefined ? "" : ` (HTTP ${cooldown.http_status})`}
                </td>
                <td>
                  <ResetBlade
                    destination="Back in"
                    time={formatDuration(at - now)}
                    label={`Back in ${formatDuration(at - now)}`}
                    closed={true}
                    demanding={false}
                    caption={formatClock(at)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
};

const cooldownReason = (reason: string): string => {
  switch (reason) {
    case "quota":
      return "Rate limit";
    case "credential_quota":
      return "Account quota used up";
    case "cloudflare_challenge":
      return "Blocked by a Cloudflare challenge";
    case "unknown":
      return "Unknown";
    default:
      return reason;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// History

const DAY_SECONDS = 86_400;

const period = (bar: HistoryBar, seconds: number): string => {
  if (seconds >= DAY_SECONDS) {
    const last = bar.end - 1;

    return seconds === DAY_SECONDS
      ? formatDay(bar.start)
      : `${formatDay(bar.start)} – ${formatDay(last)}`;
  }

  return `${formatDay(bar.start)}, ${formatClock(bar.start).replace(/^\w+ /, "")}`;
};

const chartTitle = (window: QuotaWindow): string => {
  if (window.seconds === 7 * DAY_SECONDS) return "Tokens per week";

  if (window.seconds === DAY_SECONDS) return "Tokens per day";

  return `Tokens per ${window.label.toLowerCase()} window`;
};

const History = ({ entry, now }: { readonly entry: CredentialEntry; readonly now: number }) => {
  const result = useAtomValue(accountSeriesAtom(entry.id));

  return (
    <Section title="History">
      {AsyncResult.match(result, {
        onInitial: () => <p className={kit["muted"]}>Loading usage…</p>,
        onFailure: (failure) => <Problem>Could not load usage. {failureMessage(failure)}</Problem>,
        onSuccess: ({ value }) => {
          if (value.points.length === 0) {
            return <p className={kit["muted"]}>No requests in the last 30 days.</p>;
          }

          const seen = new Set<number>();

          const timed = quotaReading(entry).windows.flatMap((window) => {
            if (window.resetsAt === undefined || window.seconds === undefined) return [];

            if (seen.has(window.seconds)) return [];
            seen.add(window.seconds);

            return [{ ...window, resetsAt: window.resetsAt, seconds: window.seconds }];
          });

          if (timed.length === 0) {
            return (
              <div className={styles["charts"]}>
                <HistoryChart
                  title="Tokens per day"
                  bars={dailyHistory(value.points, 14, now)}
                  currentLabel="Today"
                  period={(bar) => period(bar, DAY_SECONDS)}
                />
              </div>
            );
          }

          return (
            <div className={styles["charts"]}>
              {timed.map((window) => (
                <HistoryChart
                  key={window.seconds}
                  title={chartTitle(window)}
                  bars={windowHistory(value.points, window, value.since, now)}
                  period={(bar) => period(bar, window.seconds)}
                  note={
                    window.seconds < DAY_SECONDS
                      ? "Counted back from the current reset. The provider starts a window with its first request, so earlier windows are approximate."
                      : undefined
                  }
                />
              ))}
            </div>
          );
        },
      })}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Routing

const Routing = ({
  entry,
  onNotice,
}: {
  readonly entry: CredentialEntry;
  readonly onNotice: (notice: Notice) => void;
}) => {
  const save = useAction(patchFieldsAtom);
  const ids = useId();
  const [priority, setPriority] = useState(entry.priority?.toString() ?? "");
  const [note, setNote] = useState(entry.note ?? "");
  const trimmedPriority = priority.trim();
  const priorityValid = trimmedPriority === "" || /^-?\d+$/.test(trimmedPriority);
  const nextPriority = trimmedPriority === "" ? undefined : Number(trimmedPriority);
  const priorityChanged = nextPriority !== entry.priority;
  const noteChanged = note.trim() !== (entry.note ?? "");
  const changed = priorityChanged || noteChanged;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (!priorityValid || !changed) return;

    const outcome = await save.run({
      payload: {
        name: entry.name,
        ...(priorityChanged ? { priority: nextPriority ?? null } : {}),
        ...(noteChanged ? { note: note.trim() === "" ? null : note.trim() } : {}),
      },
      reactivityKeys: CREDENTIALS,
    });

    onNotice(
      outcome.ok
        ? { tone: "done", text: "Routing saved." }
        : { tone: "problem", text: `Could not save routing. ${outcome.message}` },
    );
  };

  return (
    <Section title="Routing">
      <form className={styles["form"]} onSubmit={submit} noValidate>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-priority`}>
            Priority
          </label>
          <input
            id={`${ids}-priority`}
            className={kit["input"]}
            inputMode="numeric"
            value={priority}
            placeholder="0"
            aria-invalid={!priorityValid}
            aria-describedby={`${ids}-priority-hint`}
            onChange={(event) => setPriority(event.target.value)}
          />
          {priorityValid ? (
            <span id={`${ids}-priority-hint`} className={styles["hint"]}>
              The proxy uses the highest priority first; empty counts as 0.
            </span>
          ) : (
            <span id={`${ids}-priority-hint`} className={kit["fieldError"]}>
              Enter a whole number, such as 10 or -1.
            </span>
          )}
        </div>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-note`}>
            Note
          </label>
          <input
            id={`${ids}-note`}
            className={kit["input"]}
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className={kit["secondary"]}
          disabled={!changed || !priorityValid || save.busy}
        >
          {save.busy ? "Saving…" : "Save routing"}
        </button>
      </form>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Details and models

const Details = ({ entry, now }: { readonly entry: CredentialEntry; readonly now: number }) => {
  const plan = entry.quota_report?.plan ?? entry.id_token?.plan_type;
  const until = parsed(entry.id_token?.chatgpt_subscription_active_until);
  const created = parsed(entry.created_at);
  const updated = parsed(entry.updated_at);
  const refreshed = parsed(entry.last_refresh);

  const rows: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Plan", plan],
    ["Subscription until", until === undefined ? undefined : formatDate(until)],
    ["Project", entry.project_id],
    ["Tokens refreshed", refreshed === undefined ? entry.last_refresh : formatAgo(now - refreshed)],
    ["Connected", created === undefined ? undefined : formatDate(created)],
    ["Changed", updated === undefined ? undefined : formatDate(updated)],
    ["Requests served", formatCount(entry.success)],
    ["Requests failed", formatCount(entry.failed)],
    ["Weight", entry.weight?.toString()],
    ["Retries", entry.request_retry?.toString()],
    ["File", entry.name],
    ["Index", entry.auth_index],
  ];

  return (
    <Section title="Details">
      <dl className={styles["details"]}>
        {rows.flatMap(([term, value]) =>
          value === undefined || value === "" ? (
            []
          ) : (
            <div key={term}>
              <dt>{term}</dt>
              <dd data-bad={term === "Requests failed" && entry.failed > 0}>{value}</dd>
            </div>
          ),
        )}
      </dl>
    </Section>
  );
};

const ModelList = ({ name }: { readonly name: string }) => {
  const result = useAtomValue(accountModelsAtom(name));

  return AsyncResult.match(result, {
    onInitial: () => <p className={kit["muted"]}>Loading models…</p>,
    onFailure: (failure) => <Problem>Could not load models. {failureMessage(failure)}</Problem>,
    onSuccess: ({ value }) =>
      value.models.length === 0 ? (
        <p className={kit["muted"]}>This account serves no models.</p>
      ) : (
        <ul className={styles["models"]}>
          {value.models.map((model) => (
            <li key={model.id} title={model.display_name}>
              {model.id}
            </li>
          ))}
        </ul>
      ),
  });
};

const Models = ({ entry }: { readonly entry: CredentialEntry }) => {
  const [open, setOpen] = useState(false);

  return (
    <Section title="Models">
      <details
        className={styles["disclosure"]}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <ChevronRight
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={styles["disclosureIcon"]}
          />
          Show the models this account serves
        </summary>
        {open ? <ModelList name={entry.name} /> : null}
      </details>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Delete

const Remove = ({
  entry,
  onNotice,
}: {
  readonly entry: CredentialEntry;
  readonly onNotice: (notice: Notice) => void;
}) => {
  const remove = useAction(removeAtom);
  const dialog = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const titleId = useId();

  return (
    <Section title="Delete">
      <p className={styles["lead"]}>
        The proxy stops using this account and forgets its tokens. You can connect it again later.
      </p>
      <button type="button" className={kit["danger"]} onClick={() => dialog.current?.showModal()}>
        <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
        Delete account
      </button>
      <dialog ref={dialog} className={styles["dialog"]} aria-labelledby={titleId}>
        <form
          method="dialog"
          className={styles["dialogBody"]}
          onSubmit={async (event) => {
            event.preventDefault();

            const outcome = await remove.run({
              query: { name: entry.name },
              reactivityKeys: CREDENTIALS,
            });

            dialog.current?.close();

            if (outcome.ok) {
              await navigate({ to: "/accounts" });
            } else {
              onNotice({
                tone: "problem",
                text: `Could not delete the account. ${outcome.message}`,
              });
            }
          }}
        >
          <h2 id={titleId} className={styles["dialogTitle"]}>
            Delete {accountName(entry)}?
          </h2>
          <p>
            Requests stop going to this {providerName(entry.provider)} account and its tokens are
            removed from the proxy.
          </p>
          <div className={styles["dialogActions"]}>
            <button type="submit" className={kit["danger"]} disabled={remove.busy}>
              {remove.busy ? "Deleting…" : "Delete account"}
            </button>
            <button
              type="button"
              className={kit["secondary"]}
              onClick={() => dialog.current?.close()}
            >
              Keep it
            </button>
          </div>
        </form>
      </dialog>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Page

const Actions = ({
  entry,
  onNotice,
  children,
}: {
  readonly entry: CredentialEntry;
  readonly onNotice: (notice: Notice) => void;
  /** The last action's result, beside the buttons. */
  readonly children: ReactNode;
}) => {
  const check = useAction(checkQuotaAtom);
  const refresh = useAction(refreshAtom);
  const toggle = useAction(setDisabledAtom);

  return (
    <div className={styles["actions"]}>
      {checksQuota(entry.provider) ? (
        <button
          type="button"
          className={kit["secondary"]}
          disabled={check.busy}
          aria-busy={check.busy}
          onClick={async () => {
            const outcome = await check.run({
              payload: { name: entry.name },
              reactivityKeys: CREDENTIALS,
            });

            if (!outcome.ok) {
              onNotice({ tone: "problem", text: `Could not check quota. ${outcome.message}` });
            } else if (outcome.value.report.error === undefined) {
              onNotice({ tone: "done", text: "Quota checked." });
            } else {
              onNotice({
                tone: "problem",
                text: `The provider did not report quota: ${outcome.value.report.error}`,
              });
            }
          }}
        >
          <Gauge
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={check.busy ? kit["spinning"] : undefined}
          />
          {check.busy ? "Checking…" : "Check quota"}
        </button>
      ) : null}
      {refreshable(entry.provider) ? (
        <button
          type="button"
          className={kit["secondary"]}
          disabled={refresh.busy}
          aria-busy={refresh.busy}
          onClick={async () => {
            const outcome = await refresh.run({
              payload: { name: entry.name },
              reactivityKeys: CREDENTIALS,
            });

            onNotice(
              outcome.ok
                ? { tone: "done", text: "Tokens refreshed." }
                : { tone: "problem", text: `Could not refresh the tokens. ${outcome.message}` },
            );
          }}
        >
          <RefreshCw
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={refresh.busy ? kit["spinning"] : undefined}
          />
          {refresh.busy ? "Refreshing…" : "Refresh tokens"}
        </button>
      ) : null}
      <button
        type="button"
        className={kit["secondary"]}
        disabled={toggle.busy}
        onClick={async () => {
          const disabled = !entry.disabled;

          const outcome = await toggle.run({
            payload: { name: entry.name, disabled },
            reactivityKeys: CREDENTIALS,
          });

          onNotice(
            outcome.ok
              ? {
                  tone: "done",
                  text: disabled
                    ? "Account disabled. The proxy sends it no requests."
                    : "Account enabled. The proxy sends it requests again.",
                }
              : {
                  tone: "problem",
                  text: `Could not ${disabled ? "disable" : "enable"} the account. ${outcome.message}`,
                },
          );
        }}
      >
        <Power aria-hidden="true" size={16} strokeWidth={2.25} />
        {entry.disabled ? "Enable" : "Disable"}
      </button>
      {children}
    </div>
  );
};

const AccountView = ({ entry }: { readonly entry: CredentialEntry }) => {
  const now = useAtomValue(nowAtom);
  const { closed, note, tone } = assess(entry);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  usePageTitle(accountName(entry));

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Link to="/accounts" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Accounts
        </Link>
        <div className={styles["identity"]}>
          <span className={styles["markSlot"]}>{closed ? <TrailMark /> : null}</span>
          <div className={styles["who"]}>
            <p className={styles["provider"]}>{providerName(entry.provider)}</p>
            <h1 className={styles["name"]}>{accountName(entry)}</h1>
            {note === undefined ? null : (
              <p className={styles["note"]} data-tone={tone}>
                {note}
              </p>
            )}
            {entry.note === undefined ? null : <p className={styles["ownNote"]}>{entry.note}</p>}
          </div>
        </div>
        <Actions entry={entry} onNotice={setNotice}>
          <p className={styles["notice"]} role="status" data-tone={notice?.tone}>
            {notice === undefined ? null : (
              <>
                {notice.tone === "problem" ? <TrailMark /> : null}
                {notice.text}
              </>
            )}
          </p>
        </Actions>
      </header>
      <div className={styles["columns"]}>
        <div className={styles["main"]}>
          <Allowance entry={entry} now={now} />
          <Cooldowns entry={entry} now={now} onNotice={setNotice} />
          <History entry={entry} now={now} />
        </div>
        <div className={styles["side"]}>
          <Routing
            key={`${entry.priority ?? ""}:${entry.note ?? ""}`}
            entry={entry}
            onNotice={setNotice}
          />
          <Details entry={entry} now={now} />
          <Models entry={entry} />
          <Remove entry={entry} onNotice={setNotice} />
        </div>
      </div>
    </div>
  );
};

const Missing = () => {
  usePageTitle("Account not found");

  return (
    <div className={styles["missing"]}>
      <h1 className={styles["name"]}>Account not found</h1>
      <p className={kit["muted"]}>
        No connected account has this address. It may have been deleted.{" "}
        <Link to="/accounts">See every account</Link>.
      </p>
    </div>
  );
};

export const AccountPage = () => {
  const { authIndex } = route.useParams();
  const result = useAtomValue(credentialsAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the account…
      </p>
    ),
    onFailure: (failure) => (
      <Problem>Could not load the account. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const entry = value.files.find((file) => file.auth_index === authIndex);

      return entry === undefined ? <Missing /> : <AccountView entry={entry} />;
    },
  });
};
