/**
 * Download of the management control panel (`management.html`) from its GitHub release, verified against the
 * release asset's SHA-256 digest.
 *
 * Go source: internal/managementasset/updater.go (`resolveReleaseURL`, `fetchLatestAsset`, `downloadAsset`). Same
 * rules: the release asset named `management.html` (case-insensitive) carries a `digest` (`sha256:<hex>`); a
 * downloaded file whose hash differs is never installed. Unlike Go there is no unverified fallback download: an
 * unverifiable panel is an error (pass `allowUnverified` to accept a release without a digest).
 */
import type { Json, JsonObject } from "../../src/json/index.ts";

export const DEFAULT_REPOSITORY = "router-for-me/Cli-Proxy-API-Management-Center";

export const ASSET_NAME = "management.html";

const USER_AGENT = "CLIProxyAPI-management-updater";

/** Go reads at most 50 MiB. */
export const MAX_PANEL_BYTES = 50 * 1024 * 1024;

export type PanelSyncErrorCode =
  | "invalid_repository"
  | "release_unavailable"
  | "asset_missing"
  | "digest_missing"
  | "digest_mismatch"
  | "too_large"
  | "download_failed";

export class PanelSyncError extends Error {
  override readonly name = "PanelSyncError";
  readonly code: PanelSyncErrorCode;
  // No parameter properties: the CLI runs through Node's type stripping.
  constructor(code: PanelSyncErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** `owner/repo`, `https://github.com/owner/repo[.git]` or an `api.github.com/repos/owner/repo` URL -> API path. */
export const releaseApiUrl = (repository: string, tag?: string): string => {
  const text = repository.trim().replace(/\/+$/, "");
  let slug: string | undefined;
  const direct = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);

  if (direct !== null) {
    const [, owner, name = ""] = direct;
    slug = `${owner}/${name.replace(/\.git$/, "")}`;
  } else {
    try {
      const url = new URL(text);
      const parts = url.pathname.split("/").filter((part) => part !== "");

      const [first, second, third] = parts;

      if (url.hostname === "github.com" && second !== undefined) {
        slug = `${first}/${second.replace(/\.git$/, "")}`;
      } else if (url.hostname === "api.github.com" && first === "repos" && third !== undefined) {
        slug = `${second}/${third}`;
      }
    } catch {
      // Falls through to the error below.
    }
  }

  if (slug === undefined)
    throw new PanelSyncError("invalid_repository", `unsupported panel repository: ${repository}`);
  const suffix = tag === undefined || tag === "" ? "latest" : `tags/${encodeURIComponent(tag)}`;

  return `https://api.github.com/repos/${slug}/releases/${suffix}`;
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export interface PanelRelease {
  readonly tag: string;
  readonly downloadUrl: string;
  /** Lower-case hex SHA-256 from the release asset `digest`, when present. */
  readonly sha256: string | undefined;
}

const asRecord = (value: Json | undefined): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

const asText = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/** Picks the `management.html` asset of a GitHub release document. */
export const selectPanelAsset = (release: Json | undefined): PanelRelease => {
  const document = asRecord(release);
  const assets = Array.isArray(document?.assets) ? document.assets : [];

  for (const raw of assets) {
    const asset = asRecord(raw);

    if (asset === undefined || asText(asset.name).trim().toLowerCase() !== ASSET_NAME) continue;
    const downloadUrl = asText(asset.browser_download_url).trim();

    if (downloadUrl === "") continue;

    const digest =
      typeof asset.digest === "string"
        ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest.trim())
        : null;

    return {
      tag: asText(document?.tag_name).trim(),
      downloadUrl,
      sha256: digest?.[1]?.toLowerCase(),
    };
  }

  throw new PanelSyncError("asset_missing", `the release has no ${ASSET_NAME} asset`);
};

export interface FetchPanelOptions {
  readonly repository?: string;
  /** A release tag; the latest release when omitted. */
  readonly tag?: string;
  /** GitHub token (optional; raises the API rate limit). Never logged. */
  readonly token?: string;
  /** Accept a release whose asset has no digest (the downloaded bytes are then unverified). */
  readonly allowUnverified?: boolean;
  /** SHA-256 of the file already installed: the download is skipped when it equals the release digest. */
  readonly installedSha256?: string;
  readonly maxBytes?: number;
  readonly fetch?: typeof fetch;
}

export type FetchPanelResult =
  | { readonly status: "up-to-date"; readonly tag: string; readonly sha256: string }
  | {
      readonly status: "downloaded";
      readonly tag: string;
      readonly sha256: string;
      readonly bytes: Uint8Array;
    };

const readJson = async (response: Response): Promise<Json | undefined> => {
  try {
    const parsed: Json = JSON.parse(await response.text());

    return parsed;
  } catch {
    return undefined;
  }
};

export const fetchPanel = async (options: FetchPanelOptions = {}): Promise<FetchPanelResult> => {
  const doFetch = options.fetch ?? fetch;

  const apiHeaders = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    ...(options.token !== undefined && options.token !== ""
      ? { authorization: `Bearer ${options.token}` }
      : {}),
  };

  const releaseResponse = await doFetch(
    releaseApiUrl(options.repository ?? DEFAULT_REPOSITORY, options.tag),
    {
      headers: apiHeaders,
    },
  ).catch(() => undefined);

  if (releaseResponse === undefined || !releaseResponse.ok) {
    throw new PanelSyncError(
      "release_unavailable",
      `could not read the panel release (${releaseResponse === undefined ? "network error" : `HTTP ${releaseResponse.status}`})`,
    );
  }

  const release = selectPanelAsset(await readJson(releaseResponse));

  if (release.sha256 === undefined && options.allowUnverified !== true) {
    throw new PanelSyncError(
      "digest_missing",
      "the release asset has no sha256 digest; refusing to install it",
    );
  }

  if (release.sha256 !== undefined && options.installedSha256?.toLowerCase() === release.sha256) {
    return { status: "up-to-date", tag: release.tag, sha256: release.sha256 };
  }

  const limit = options.maxBytes ?? MAX_PANEL_BYTES;

  const download = await doFetch(release.downloadUrl, {
    headers: { "user-agent": USER_AGENT },
  }).catch(() => undefined);

  if (download === undefined || !download.ok) {
    throw new PanelSyncError(
      "download_failed",
      `could not download ${ASSET_NAME} (${download === undefined ? "network error" : `HTTP ${download.status}`})`,
    );
  }

  const bytes = new Uint8Array(await download.arrayBuffer());

  if (bytes.length > limit)
    throw new PanelSyncError("too_large", `${ASSET_NAME} exceeds ${limit} bytes`);
  const actual = await sha256Hex(bytes);

  if (release.sha256 !== undefined && actual !== release.sha256) {
    throw new PanelSyncError(
      "digest_mismatch",
      `digest mismatch: expected ${release.sha256}, got ${actual}`,
    );
  }

  return { status: "downloaded", tag: release.tag, sha256: actual, bytes };
};
