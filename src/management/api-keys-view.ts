/**
 * `GET /v8/management/api-keys` (`contract/api-keys.ts` `ApiKeysList`): the config's `api-keys` groups joined with
 * the runtime state of the credentials they produced. Built inside the ControlPlane Durable Object so the config
 * version and the runtime state are one snapshot.
 *
 * Workers addition, no Go counterpart (Go's panel reads raw keys from `GET /config` and masks them in the browser;
 * here the browser never sees them, PRODUCT.md). Nothing secret is included: keys become `[redacted]…abcd`
 * previews, header values whose names look secret are masked, `proxy-url` and `experimental-cch-signing` are left
 * out (a warning says they exist), and error messages are scrubbed of the key and of token-shaped text.
 */
import type { ApiKeyGroup, Config, OpenAICompatGroup } from "../config/schema.ts";
import { isSecretName, maskSecret } from "../credentials/summary.ts";
import { redactSecrets } from "../credentials/redact.ts";
import type { RefreshTarget } from "../credentials/pool.ts";
import { DEFAULT_BASE_URL as CLAUDE_DEFAULT_BASE_URL } from "../executor/claude/credentials.ts";
import { CODEX_DEFAULT_BASE_URL } from "../executor/codex/headers.ts";
import { GEMINI_ENDPOINT, VERTEX_DEFAULT_BASE_URL } from "../executor/gemini/targets.ts";
import { META_DEFAULT_BASE_URL } from "../executor/meta/credentials.ts";
import { XAI_DEFAULT_API_BASE_URL } from "../executor/xai/credentials.ts";
import type { JsonObject } from "../json/index.ts";
import { authIndexOf } from "./auth-index.ts";
import { configKeyIds } from "./config-document.ts";
import { cooldownSnapshot, recentRequestBuckets } from "./credential-entry.ts";
import type { ApiKeyFamily } from "./contract/api-keys.ts";

/** Base URL a family talks to when the group sets none (what the executors use). */
export const DEFAULT_BASE_URLS: Readonly<
  Record<Exclude<ApiKeyFamily, "openai-compatibility">, string>
> = {
  gemini: GEMINI_ENDPOINT,
  interactions: GEMINI_ENDPOINT,
  vertex: VERTEX_DEFAULT_BASE_URL,
  codex: CODEX_DEFAULT_BASE_URL,
  claude: CLAUDE_DEFAULT_BASE_URL,
  xai: XAI_DEFAULT_API_BASE_URL,
  meta: META_DEFAULT_BASE_URL,
};

/** Copy through JSON: drops `undefined` and detaches readonly config values from the plain wire shape. */
const plainObject = <T extends object>(value: T): JsonObject =>
  // SAFETY: only objects (config groups and keys without their secrets) are passed in, and JSON.parse of their
  // serialization is a JSON object.
  JSON.parse(JSON.stringify(value)) as JsonObject;

/** Masks header values whose names look secret; `$name` values copy a client header and are not secrets. */
export const maskHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isSecretName(name) && value !== "" && !value.startsWith("$") ? maskSecret(value) : value,
    ]),
  );

const keyPreview = (key: string): string => (key === "" ? "" : maskSecret(key));

const iso = (ms: number): string => new Date(ms).toISOString();

/** Runtime of one config credential; `secret` is scrubbed from the last error. */
const runtimeOf = (target: RefreshTarget, now: number): JsonObject => {
  const { credential, state } = target;
  const cooldowns = cooldownSnapshot(state, now);
  const blocked = state.unavailable || cooldowns.length > 0;
  const nextRetry = state.nextRetryAfter > now ? state.nextRetryAfter : 0;
  const secret = credential.attributes.api_key ?? "";
  const error = state.lastError;

  const scrub = (message: string): string =>
    redactSecrets(secret === "" ? message : message.replaceAll(secret, "[redacted]"));

  const lastError: JsonObject | undefined =
    error === undefined
      ? undefined
      : {
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
          ...(error.message === "" ? {} : { message: scrub(error.message) }),
        };

  return {
    id: credential.id,
    auth_index: authIndexOf(credential.id),
    status: credential.disabled
      ? "disabled"
      : blocked && state.status === "active"
        ? "error"
        : state.status,
    unavailable: blocked,
    success: state.success,
    failed: state.failed,
    recent_requests: recentRequestBuckets(state.recentRequests, now),
    cooldowns,
    ...(nextRetry > 0 ? { next_retry_after: iso(nextRetry) } : {}),
    ...(lastError === undefined ? {} : { last_error: lastError }),
  };
};

const isDisablingPattern = (pattern: string): boolean => pattern.trim() === "*";

const hasText = (value: string | undefined): boolean => (value ?? "").trim() !== "";

const proxyWarning =
  "proxy-url is set: outbound proxies do not exist on Workers, so it has no effect (kept in the config)";

const signingWarning = (count: number): string =>
  `experimental-cch-signing is set on ${count} key${count === 1 ? "" : "s"}: it has no effect on Workers (kept in the config)`;

interface Lookup {
  readonly ids: ReturnType<typeof configKeyIds>;
  readonly runtime: ReadonlyMap<string, RefreshTarget>;
  readonly now: number;
}

const runtimeFor = (lookup: Lookup, id: string | undefined): JsonObject | null => {
  const target = id === undefined ? undefined : lookup.runtime.get(id);

  return target === undefined ? null : runtimeOf(target, lookup.now);
};

const groupView = (
  family: Exclude<ApiKeyFamily, "openai-compatibility">,
  group: ApiKeyGroup,
  index: number,
  lookup: Lookup,
): JsonObject => {
  const ids = lookup.ids[family][index]?.keys ?? [];
  const { keys, headers, "proxy-url": groupProxy, ...rest } = group;
  let signing = 0;
  let proxy = hasText(groupProxy);

  const keyViews = keys.map((entry, keyIndex): JsonObject => {
    const {
      "api-key": apiKey,
      "proxy-url": keyProxy,
      "experimental-cch-signing": cch,
      headers: keyHeaders,
      ...visible
    } = entry;

    if (hasText(keyProxy)) proxy = true;

    if (cch !== undefined) signing += 1;
    const id = ids[keyIndex];
    const excluded = entry["excluded-models"] ?? group["excluded-models"] ?? [];

    return {
      ...(id === undefined ? {} : { auth_index: authIndexOf(id) }),
      key_preview: keyPreview(apiKey),
      disabled: excluded.some(isDisablingPattern),
      runtime: runtimeFor(lookup, id),
      ...plainObject(visible),
      ...(keyHeaders === undefined ? {} : { headers: maskHeaders(keyHeaders) }),
    };
  });

  return {
    index,
    group: {
      ...plainObject(rest),
      ...(headers === undefined ? {} : { headers: maskHeaders(headers) }),
      keys: keyViews,
    },
    effective_base_url: (group["base-url"] ?? "").trim() || DEFAULT_BASE_URLS[family],
    warnings: [...(proxy ? [proxyWarning] : []), ...(signing > 0 ? [signingWarning(signing)] : [])],
  };
};

const compatGroupView = (group: OpenAICompatGroup, index: number, lookup: Lookup): JsonObject => {
  const ids = lookup.ids["openai-compatibility"][index]?.keys ?? [];
  const { keys, headers, ...rest } = group;
  const disabled = group.disabled === true;
  const proxy = keys.some((entry) => hasText(entry["proxy-url"]));

  const keyViews = keys.map((entry, keyIndex): JsonObject => ({
    ...(ids[keyIndex] === undefined ? {} : { auth_index: authIndexOf(ids[keyIndex]) }),
    key_preview: keyPreview(entry["api-key"]),
    disabled,
    runtime: runtimeFor(lookup, ids[keyIndex]),
    ...(entry.weight === undefined ? {} : { weight: entry.weight }),
  }));

  return {
    index,
    group: {
      ...plainObject(rest),
      ...(headers === undefined ? {} : { headers: maskHeaders(headers) }),
      keys: keyViews,
    },
    effective_base_url: group["base-url"].trim(),
    warnings: proxy ? [proxyWarning] : [],
  };
};

/**
 * The `ApiKeysList` of `config` (stored at `version`); `entries` are the pool's credentials, of which only the
 * config ones are used. `now` is epoch milliseconds.
 */
export const buildApiKeysList = (
  version: number,
  config: Pick<Config, "api-keys">,
  entries: ReadonlyArray<RefreshTarget>,
  now: number,
): JsonObject => {
  const runtime = new Map<string, RefreshTarget>();

  for (const entry of entries)
    if (entry.credential.source === "config") runtime.set(entry.credential.id, entry);

  const lookup: Lookup = {
    ids: configKeyIds(config, { includeDisabledGroups: true }),
    runtime,
    now,
  };

  const apiKeys = config["api-keys"];

  const standard = (family: Exclude<ApiKeyFamily, "openai-compatibility">): JsonObject[] =>
    apiKeys[family].map((group, index) => groupView(family, group, index, lookup));

  return {
    version,
    families: {
      gemini: standard("gemini"),
      interactions: standard("interactions"),
      vertex: standard("vertex"),
      codex: standard("codex"),
      claude: standard("claude"),
      xai: standard("xai"),
      meta: standard("meta"),
      "openai-compatibility": apiKeys["openai-compatibility"].map((group, index) =>
        compatGroupView(group, index, lookup),
      ),
    },
  };
};
