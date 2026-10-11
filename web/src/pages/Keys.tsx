// API keys: every configured provider key by provider and group, with its state and recent requests, and per key a
// connection test, clearing its cooldowns, and Disable. Editing a group (and adding or removing keys) is on its own
// page (KeyGroup.tsx). Keys show only as their last characters: the secrets never reach the browser.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Plug, Plus, Power, Search, Timer } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import type { ApiKeysList, ProbeResult } from "#contract/api-keys.ts";
import {
  API_KEYS,
  apiKeysAtom,
  nowAtom,
  probeKeyAtom,
  resetCooldownAtom,
  setDisabledAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { ResetBlade, TrailMark } from "../components/Signs.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatClock, formatCount, formatDuration, formatLatency } from "../lib/format.ts";
import {
  type AnyKeyView,
  type GroupRef,
  groupFacts,
  groupTitle,
  keyMatches,
  keySections,
  keyStanding,
  keyTail,
  liveCooldowns,
  needsAttention,
  recentRequests,
} from "../lib/keys.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Keys.module.css";

/** Requests per key are counted over the recent-requests ring: ten-minute buckets. */
const BUCKET_MS = 10 * 60_000;

type Filter = "all" | "attention" | "disabled";

/** The last thing done to a key (a test, a toggle, a cleared cooldown), said under its state. */
interface Note {
  readonly tone: "done" | "problem";
  readonly text: string;
}

const probeLine = (result: ProbeResult): string => {
  if (!result.ok) {
    const status = result.status_code === undefined ? "" : `HTTP ${result.status_code}: `;

    return `${status}${result.error ?? "the provider refused the test"}`;
  }

  const models =
    result.models === undefined
      ? ""
      : ` · ${formatCount(result.models.length)} model${result.models.length === 1 ? "" : "s"} listed`;

  return `Answered in ${formatLatency(result.latency_ms)}${models}`;
};

const KeyRow = ({
  group,
  keyView,
  now,
}: {
  readonly group: GroupRef;
  readonly keyView: AnyKeyView;
  readonly now: number;
}) => {
  const probe = useAction(probeKeyAtom(keyView.runtime?.auth_index ?? ""));
  const reset = useAction(resetCooldownAtom);
  const toggle = useAction(setDisabledAtom);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const standing = keyStanding(keyView, now);
  const [requests, failed] = recentRequests(keyView);
  const runtime = keyView.runtime;
  const tail = keyTail(keyView.key_preview);
  const label = tail === "" ? "Key without a secret" : `Key ${tail}`;
  const compat = group.family === "openai-compatibility";

  return (
    <tr className={styles["row"]} data-disabled={keyView.disabled}>
      <th scope="row" className={styles["keyCell"]}>
        <div className={styles["keyWho"]}>
          <span className={styles["markSlot"]}>
            {standing.tone === "closed" ? <TrailMark /> : null}
          </span>
          <span className={styles["key"]}>
            <span className={styles["tail"]}>{tail === "" ? "No key" : tail}</span>
            {keyView.weight === undefined || keyView.weight === 1 ? null : (
              <span className={styles["weight"]}>Weight {formatCount(keyView.weight)}</span>
            )}
          </span>
        </div>
      </th>
      <td className={styles["state"]}>
        <div className={styles["stateStack"]}>
          <span className={styles["standing"]} data-tone={standing.tone}>
            {standing.label}
          </span>
          {standing.backAt === undefined || standing.backAt <= now ? null : (
            <ResetBlade
              destination="Back in"
              time={formatDuration(standing.backAt - now)}
              label={`${label} back in ${formatDuration(standing.backAt - now)}`}
              closed={true}
              demanding={false}
              caption={formatClock(standing.backAt)}
            />
          )}
          <span className={styles["note"]} role="status" data-tone={note?.tone}>
            {note?.text}
          </span>
        </div>
      </td>
      <td className={styles["requests"]}>
        <span className={styles["count"]}>{formatCount(requests)}</span>
        {failed > 0 ? <span className={styles["failed"]}>{formatCount(failed)} failed</span> : null}
      </td>
      <td className={styles["actions"]}>
        {runtime === null ? null : (
          <>
            <button
              type="button"
              className={kit["secondary"]}
              disabled={probe.busy}
              aria-busy={probe.busy}
              aria-label={`Test ${label}`}
              onClick={async () => {
                setNote(undefined);
                const outcome = await probe.run();

                setNote(
                  !outcome.ok
                    ? { tone: "problem", text: `Could not test the key. ${outcome.message}` }
                    : outcome.value.ok
                      ? { tone: "done", text: probeLine(outcome.value) }
                      : {
                          tone: "problem",
                          // The closed state above already says why; the test only confirms it.
                          text:
                            standing.tone === "closed"
                              ? "Test failed just now."
                              : probeLine(outcome.value),
                        },
                );
              }}
            >
              <Plug
                aria-hidden="true"
                size={16}
                strokeWidth={2.25}
                className={probe.busy ? kit["spinning"] : undefined}
              />
              {probe.busy ? "Testing…" : "Test"}
            </button>
            {liveCooldowns(keyView, now).length === 0 ? null : (
              <button
                type="button"
                className={kit["secondary"]}
                disabled={reset.busy}
                aria-label={`Clear the cooldowns of ${label}`}
                onClick={async () => {
                  const outcome = await reset.run({
                    payload: { auth_index: runtime.auth_index },
                    reactivityKeys: API_KEYS,
                  });

                  setNote(
                    outcome.ok
                      ? { tone: "done", text: "Cooldowns cleared." }
                      : {
                          tone: "problem",
                          text: `Could not clear the cooldowns. ${outcome.message}`,
                        },
                  );
                }}
              >
                <Timer aria-hidden="true" size={16} strokeWidth={2.25} />
                Clear cooldowns
              </button>
            )}
            {compat ? null : (
              <button
                type="button"
                className={kit["secondary"]}
                disabled={toggle.busy}
                aria-label={`${keyView.disabled ? "Enable" : "Disable"} ${label}`}
                onClick={async () => {
                  const disabled = !keyView.disabled;

                  const outcome = await toggle.run({
                    payload: { name: runtime.id, auth_index: runtime.auth_index, disabled },
                    reactivityKeys: API_KEYS,
                  });

                  setNote(
                    outcome.ok
                      ? {
                          tone: "done",
                          text: disabled
                            ? "Disabled. The proxy sends it no requests."
                            : "Enabled. The proxy sends it requests again.",
                        }
                      : {
                          tone: "problem",
                          text: `Could not ${disabled ? "disable" : "enable"} the key. ${outcome.message}`,
                        },
                  );
                }}
              >
                <Power aria-hidden="true" size={16} strokeWidth={2.25} />
                {keyView.disabled ? "Enable" : "Disable"}
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
};

const Group = ({
  group,
  keys,
  now,
  showTitle,
  span,
}: {
  readonly group: GroupRef;
  readonly keys: ReadonlyArray<AnyKeyView>;
  readonly now: number;
  readonly showTitle: boolean;
  readonly span: string;
}) => {
  const title = groupTitle(group.family, group.view);
  const endpointOff = "disabled" in group.view.group && group.view.group.disabled === true;

  return (
    <div className={styles["group"]}>
      <div className={styles["groupHead"]}>
        <div className={styles["groupWho"]}>
          {showTitle ? <h3 className={styles["groupTitle"]}>{title}</h3> : null}
          <p className={styles["facts"]}>
            {endpointOff ? <span className={styles["off"]}>Endpoint disabled</span> : null}
            {groupFacts(group.family, group.view)
              .filter((fact) => !showTitle || fact !== title)
              .map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
          </p>
        </div>
        <Link
          to="/keys/$family/$index"
          params={{ family: group.family, index: String(group.index) }}
          className={kit["sectionLink"]}
          aria-label={`Edit ${title}`}
        >
          Edit
        </Link>
      </div>
      {keys.length === 0 ? (
        <p className={kit["muted"]}>
          {group.view.group.keys.length === 0 ? "No keys in this group." : "No key matches."}
        </p>
      ) : (
        <>
          <p className={styles["mobileKey"]} aria-hidden="true">
            Requests, last {span}
          </p>
          <table className={styles["keys"]}>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">State</th>
                <th scope="col" className={styles["number"]}>
                  Requests, last {span}
                </th>
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((keyView, position) => (
                <KeyRow
                  key={keyView.auth_index ?? `entry-${position}`}
                  group={group}
                  keyView={keyView}
                  now={now}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};

const FILTERS: ReadonlyArray<{ readonly id: Filter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "disabled", label: "Disabled" },
];

const List = ({ list }: { readonly list: ApiKeysList }) => {
  const now = useAtomValue(nowAtom);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const searchId = useId();
  const sections = keySections(list);

  const keep = (key: AnyKeyView): boolean =>
    filter === "all" || (filter === "disabled" ? key.disabled : needsAttention(key, now));

  const allKeys = sections.flatMap((section) =>
    section.groups.flatMap((group): ReadonlyArray<AnyKeyView> => group.view.group.keys),
  );

  const counts: Readonly<Record<Filter, number>> = {
    all: allKeys.length,
    attention: allKeys.filter((key) => needsAttention(key, now)).length,
    disabled: allKeys.filter((key) => key.disabled).length,
  };

  const span = formatDuration(
    Math.max(1, ...allKeys.map((key) => key.runtime?.recent_requests.length ?? 0)) * BUCKET_MS,
  );

  const shown = sections.flatMap((section) => {
    const groups = section.groups.flatMap((group) => {
      const all: ReadonlyArray<AnyKeyView> = group.view.group.keys;
      const keys = all.filter((key) => keep(key) && keyMatches(group, key, section.title, query));
      const untouched = filter === "all" && query === "";

      return keys.length > 0 || untouched ? [{ group, keys }] : [];
    });

    return groups.length === 0 ? [] : [{ section, groups }];
  });

  return (
    <>
      <div className={styles["toolbar"]}>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {FILTERS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={filter === candidate.id}
              className={kit["tab"]}
              onClick={() => setFilter(candidate.id)}
            >
              {candidate.label}
              <span className={kit["tabCount"]}>{formatCount(counts[candidate.id])}</span>
            </button>
          ))}
        </div>
        <div className={styles["search"]}>
          <label htmlFor={searchId} className={kit["visuallyHidden"]}>
            Search keys
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
            placeholder="Search keys"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className={styles["empty"]}>
          {query === ""
            ? filter === "attention"
              ? "Nothing needs attention: every active key is taking requests."
              : "No disabled keys."
            : `No key matches “${search.trim()}”.`}
        </p>
      ) : (
        <div className={styles["sections"]}>
          {shown.map(({ section, groups }) => (
            <section key={section.id} className={styles["section"]} aria-label={section.title}>
              <header className={styles["sectionHead"]}>
                <h2 className={styles["sectionTitle"]}>{section.title}</h2>
                {section.caption === undefined ? null : (
                  <p className={styles["caption"]}>{section.caption}</p>
                )}
              </header>
              {groups.map(({ group, keys }) => (
                <Group
                  key={`${group.family}:${group.index}`}
                  group={group}
                  keys={keys}
                  now={now}
                  showTitle={group.family !== "openai-compatibility"}
                  span={span}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
};

export const KeysPage = () => {
  usePageTitle("API keys");
  const result = useAtomValue(apiKeysAtom);
  const retry = useAtomRefresh(apiKeysAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>API keys</h1>
        <Link to="/keys/new" className={kit["primary"]}>
          <Plus aria-hidden="true" size={18} strokeWidth={2.5} />
          Add API key
        </Link>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading API keys…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the API keys. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) =>
          keySections(value).length === 0 ? (
            <p className={styles["empty"]}>
              No API keys yet. Add a provider key to let the proxy answer requests with it.
            </p>
          ) : (
            <List list={value} />
          ),
      })}
    </div>
  );
};
