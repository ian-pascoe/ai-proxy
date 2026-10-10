/**
 * Claude Code device profile stabiliser (`upstream.claude.header-defaults.stabilize-device-profile`).
 *
 * Go source: internal/runtime/executor/helps/claude_device_profile.go (`ResolveClaudeDeviceProfileRequired` local mode:
 * `extractClaudeDeviceProfile`, `pinClaudeDeviceProfilePlatform`, `meetsClaudeDeviceProfileBaseline`,
 * `normalizeClaudeDeviceProfile`, `shouldUpgradeClaudeDeviceProfile`, scope keys, `ApplyClaudeDeviceProfileHeaders`).
 * With the feature on, a confirmed Claude Code client contributes its real software profile (user agent and Stainless
 * package/runtime versions) which is then reused for that credential, so the upstream sees one stable identity;
 * unconfirmed clients always get the configured baseline. Go keeps the profiles in a per-process map (7 d TTL); here
 * they live in the `SessionState` Durable Object (one instance per credential scope, sliding 7 d TTL, compare-and-swap
 * upgrades) with the per-isolate fallback of `session-state/client.ts`. The Home KV mode is not ported.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { Config } from "../../config/schema.ts";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  keepValue,
  makeMemoryBackend,
  putValue,
  resolveBackend,
  updateEntry,
} from "../../session-state/client.ts";
import type { SessionAddress } from "../../session-state/protocol.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { defaultDeviceProfile, type DeviceProfile } from "./headers.ts";

const TTL_MS = 7 * 24 * 3_600_000;

const STORE_NAME = "claude-device-profile";

const ENTRY_KEY = "profile";

const CLI_VERSION = /^claude-cli\/(\d+)\.(\d+)\.(\d+)/;

const NATIVE_USER_AGENT =
  /^claude-cli\/[0-9]+\.[0-9]+\.[0-9]+\s+\(external,\s*[^,)]+(?:,\s*agent-sdk\/[0-9]+\.[0-9]+\.[0-9]+)?\)$/i;

const USER_AGENT_DETAILS = /^claude-cli\/\S+\s+\(external,\s*([^,)]+)(?:,\s*agent-sdk\/([^,)]+))?/i;

const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const RUNTIME_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

const NATIVE_ENTRYPOINTS = new Set(["cli", "sdk-cli", "claude-vscode"]);

type Version = readonly [number, number, number];

const parseVersion = (userAgent: string): Version | undefined => {
  const match = CLI_VERSION.exec(userAgent.trim());

  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareVersions = (left: Version, right: Version): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);

    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
};

/** `shouldUpgradeClaudeDeviceProfile`: only a newer CLI version replaces the stored profile. */
export const shouldUpgradeProfile = (candidate: DeviceProfile, current: DeviceProfile): boolean => {
  const candidateVersion = parseVersion(candidate.userAgent);

  if (candidate.userAgent === "" || candidateVersion === undefined) return false;
  const currentVersion = parseVersion(current.userAgent);

  if (current.userAgent === "" || currentVersion === undefined) return true;

  return compareVersions(candidateVersion, currentVersion) > 0;
};

/** `meetsClaudeDeviceProfileBaseline`: the software tuple must equal the baseline's exactly. */
export const meetsBaseline = (candidate: DeviceProfile, baseline: DeviceProfile): boolean => {
  const candidateVersion = parseVersion(candidate.userAgent);
  const baselineVersion = parseVersion(baseline.userAgent);

  if (candidate.userAgent === "" || candidateVersion === undefined) return false;

  if (baseline.userAgent === "" || baselineVersion === undefined) return false;

  return (
    compareVersions(candidateVersion, baselineVersion) === 0 &&
    candidate.packageVersion === baseline.packageVersion &&
    candidate.runtimeVersion === baseline.runtimeVersion
  );
};

/** `pinClaudeDeviceProfilePlatform`: the platform is always the configured one. */
const pinPlatform = (profile: DeviceProfile, baseline: DeviceProfile): DeviceProfile => ({
  ...profile,
  os: baseline.os,
  arch: baseline.arch,
});

/** `normalizeClaudeDeviceProfile`: pinned platform; a software tuple that is not the baseline is replaced. */
export const normalizeProfile = (
  profile: DeviceProfile,
  baseline: DeviceProfile,
): DeviceProfile => {
  const pinned = pinPlatform(profile, baseline);

  return meetsBaseline(pinned, baseline)
    ? pinned
    : {
        ...pinned,
        userAgent: baseline.userAgent,
        packageVersion: baseline.packageVersion,
        runtimeVersion: baseline.runtimeVersion,
      };
};

const headerOr = (headers: Headers, name: string, fallback: string): string => {
  const value = headers.get(name)?.trim() ?? "";

  return value === "" ? fallback : value;
};

/** `extractClaudeDeviceProfile`: the profile a native Claude Code client announces (undefined for anything else). */
export const extractProfile = (
  headers: Headers | undefined,
  baseline: DeviceProfile,
): DeviceProfile | undefined => {
  if (headers === undefined) return undefined;
  const userAgent = headers.get("user-agent")?.trim() ?? "";

  if (parseVersion(userAgent) === undefined || !NATIVE_USER_AGENT.test(userAgent)) return undefined;
  let packageVersion = headerOr(headers, "x-stainless-package-version", baseline.packageVersion);

  if (!PACKAGE_VERSION.test(packageVersion)) packageVersion = baseline.packageVersion;
  let runtimeVersion = headerOr(headers, "x-stainless-runtime-version", baseline.runtimeVersion);

  if (!RUNTIME_VERSION.test(runtimeVersion)) runtimeVersion = baseline.runtimeVersion;

  return {
    userAgent,
    packageVersion,
    runtimeVersion,
    os: headerOr(headers, "x-stainless-os", baseline.os),
    arch: headerOr(headers, "x-stainless-arch", baseline.arch),
  };
};

/** `ClaudeDeviceProfileStabilizationEnabled`. */
export const deviceProfileStabilizationEnabled = (config: Config): boolean =>
  config.upstream.claude["header-defaults"]["stabilize-device-profile"] === true;

/** `claudeDeviceProfileSubclientScope`: distinct first-party clients never replace each other's stored profile. */
const subclientScope = (profile: DeviceProfile | undefined): string => {
  if (profile === undefined) return "";
  const entrypoint = (USER_AGENT_DETAILS.exec(profile.userAgent.trim())?.[1] ?? "")
    .trim()
    .toLowerCase();

  if (entrypoint === "" || entrypoint === "cli") return "";

  return NATIVE_ENTRYPOINTS.has(entrypoint) ? entrypoint : "other";
};

/** `claudeDeviceProfileScopedKey`. */
export const profileScopeKey = (
  credential: Pick<CredentialSnapshot, "id">,
  apiKey: string,
  profile: DeviceProfile | undefined,
): string => {
  const id = credential.id.trim();
  let key = id !== "" ? `auth:${id}` : apiKey.trim() !== "" ? `api_key:${apiKey.trim()}` : "global";
  const subclient = subclientScope(profile);

  if (subclient !== "") key += `|subclient:${subclient}`;

  return key;
};

const addressOf = (scopeKey: string): SessionAddress => ({
  store: STORE_NAME,
  scope: "",
  session: createHash("sha256").update(scopeKey).digest("hex"),
});

const parseStored = (text: string | undefined): DeviceProfile | undefined => {
  if (text === undefined) return undefined;

  try {
    const parsed = JSON.parse(text) as Partial<Record<keyof DeviceProfile, unknown>> | null;

    if (parsed === null || typeof parsed !== "object") return undefined;
    const field = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

    const profile: DeviceProfile = {
      userAgent: field(parsed.userAgent),
      packageVersion: field(parsed.packageVersion),
      runtimeVersion: field(parsed.runtimeVersion),
      os: field(parsed.os),
      arch: field(parsed.arch),
    };

    return profile.userAgent === "" ? undefined : profile;
  } catch {
    return undefined;
  }
};

export interface DeviceProfileStore {
  /**
   * `ResolveClaudeDeviceProfile`: the stabilised profile for a request of a confirmed Claude Code client. Storage
   * failures degrade to the candidate (or the baseline) instead of failing the request.
   */
  readonly resolve: (
    credential: Pick<CredentialSnapshot, "id">,
    apiKey: string,
    headers: Headers | undefined,
    config: Config,
  ) => Effect.Effect<DeviceProfile>;
}

export const makeSessionStateDeviceProfileStore = (
  backend: BackendResolver = resolveBackend(),
): DeviceProfileStore => ({
  resolve: (credential, apiKey, headers, config) => {
    const baseline = defaultDeviceProfile(config);
    let candidate = extractProfile(headers, baseline);

    if (candidate !== undefined) candidate = pinPlatform(candidate, baseline);

    if (candidate !== undefined && !meetsBaseline(candidate, baseline)) candidate = undefined;
    const address = addressOf(profileScopeKey(credential, apiKey, candidate));

    return bestEffort(
      "claude device profile",
      candidate ?? baseline,
      Effect.gen(function* () {
        const state = yield* backend;
        let result: DeviceProfile = candidate ?? baseline;
        yield* updateEntry(
          state,
          address,
          ENTRY_KEY,
          { ttlMs: TTL_MS, maxEntries: 1, slideTtl: true },
          (current) => {
            const stored = parseStored(current);
            const cached = stored === undefined ? undefined : normalizeProfile(stored, baseline);

            if (candidate !== undefined) {
              if (cached !== undefined && !shouldUpgradeProfile(candidate, cached)) {
                result = cached;

                return JSON.stringify(cached) === current
                  ? keepValue
                  : putValue(JSON.stringify(cached));
              }

              result = candidate;

              return putValue(JSON.stringify(candidate));
            }

            if (cached === undefined) {
              result = baseline;

              return keepValue;
            }

            result = cached;

            return JSON.stringify(cached) === current
              ? keepValue
              : putValue(JSON.stringify(cached));
          },
        );

        return result;
      }),
    );
  },
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryDeviceProfileStore = (now?: () => number): DeviceProfileStore =>
  makeSessionStateDeviceProfileStore(fixedBackend(makeMemoryBackend(now)));
