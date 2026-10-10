// `pnpm panel:sync` download logic: release lookup, digest verification, up-to-date detection.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPOSITORY,
  fetchPanel,
  PanelSyncError,
  releaseApiUrl,
  selectPanelAsset,
  sha256Hex,
} from "../tools/panel-sync/release.ts";
import type { Json } from "../src/json/index.ts";

const html = new TextEncoder().encode("<!doctype html><title>panel</title>");

const htmlDigest = await sha256Hex(html);

const releaseDocument = (asset: Record<string, unknown> = {}) => ({
  tag_name: "v1.2.3",
  assets: [
    { name: "other.txt", browser_download_url: "https://dl.example/other.txt" },
    {
      name: "Management.HTML",
      browser_download_url: "https://dl.example/management.html",
      digest: `sha256:${htmlDigest}`,
      ...asset,
    },
  ],
});

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const fakeFetch = (release: Json, download: () => Response = () => new Response(html)) => {
  const calls: Call[] = [];

  const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") return input;

    return input instanceof URL ? input.href : input.url;
  };

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) });

    return url.startsWith("https://api.github.com/") ? Response.json(release) : download();
  }) as typeof fetch;

  return { impl, calls };
};

const failure = async (promise: Promise<unknown>): Promise<PanelSyncError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PanelSyncError) return error;
    throw error;
  }

  throw new Error("expected a PanelSyncError");
};

describe("release URLs", () => {
  it("accepts slugs, repository URLs and API URLs", () => {
    const latest = "https://api.github.com/repos/o/r/releases/latest";
    expect(releaseApiUrl("o/r")).toBe(latest);
    expect(releaseApiUrl("https://github.com/o/r.git")).toBe(latest);
    expect(releaseApiUrl("https://github.com/o/r/")).toBe(latest);
    expect(releaseApiUrl("https://api.github.com/repos/o/r")).toBe(latest);
    expect(releaseApiUrl("o/r", "v1.0.0")).toBe(
      "https://api.github.com/repos/o/r/releases/tags/v1.0.0",
    );
    expect(releaseApiUrl(DEFAULT_REPOSITORY)).toContain("Cli-Proxy-API-Management-Center");
    expect(() => releaseApiUrl("https://example.com/o/r")).toThrow(PanelSyncError);
    expect(() => releaseApiUrl("nonsense")).toThrow(PanelSyncError);
  });

  it("selects the management.html asset case-insensitively and reads its digest", () => {
    expect(selectPanelAsset(releaseDocument())).toEqual({
      tag: "v1.2.3",
      downloadUrl: "https://dl.example/management.html",
      sha256: htmlDigest,
    });
    expect(selectPanelAsset(releaseDocument({ digest: "md5:abc" })).sha256).toBeUndefined();
    expect(() => selectPanelAsset({ assets: [] })).toThrow(PanelSyncError);
    expect(() => selectPanelAsset(undefined)).toThrow(PanelSyncError);
  });
});

describe("fetchPanel", () => {
  it("downloads and verifies the asset", async () => {
    const { impl, calls } = fakeFetch(releaseDocument());
    const result = await fetchPanel({ fetch: impl, token: "ghp_secret" });
    expect(result).toMatchObject({ status: "downloaded", tag: "v1.2.3", sha256: htmlDigest });
    expect(result.status === "downloaded" && Array.from(result.bytes)).toEqual(Array.from(html));
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/${DEFAULT_REPOSITORY}/releases/latest`,
    );
    expect(calls[0]?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      authorization: "Bearer ghp_secret",
    });
    // The token is only sent to the API, never to the asset host.
    expect(calls[1]?.headers.authorization).toBeUndefined();
  });

  it("skips the download when the installed file already matches", async () => {
    const { impl, calls } = fakeFetch(releaseDocument());
    expect(await fetchPanel({ fetch: impl, installedSha256: htmlDigest.toUpperCase() })).toEqual({
      status: "up-to-date",
      tag: "v1.2.3",
      sha256: htmlDigest,
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses a tampered download", async () => {
    const { impl } = fakeFetch(releaseDocument(), () => new Response("<script>evil()</script>"));
    const error = await failure(fetchPanel({ fetch: impl }));
    expect(error.code).toBe("digest_mismatch");
  });

  it("refuses releases without a digest unless allowed", async () => {
    const release = releaseDocument({ digest: undefined });
    expect((await failure(fetchPanel({ fetch: fakeFetch(release).impl }))).code).toBe(
      "digest_missing",
    );
    const allowed = await fetchPanel({ fetch: fakeFetch(release).impl, allowUnverified: true });
    expect(allowed).toMatchObject({ status: "downloaded", sha256: htmlDigest });
  });

  it("reports unavailable releases, failed downloads and oversized files", async () => {
    const down = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect((await failure(fetchPanel({ fetch: down }))).code).toBe("release_unavailable");

    const offline = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;

    expect((await failure(fetchPanel({ fetch: offline }))).code).toBe("release_unavailable");
    expect(
      (
        await failure(
          fetchPanel({
            fetch: fakeFetch(releaseDocument(), () => new Response("x", { status: 404 })).impl,
          }),
        )
      ).code,
    ).toBe("download_failed");
    expect(
      (await failure(fetchPanel({ fetch: fakeFetch(releaseDocument()).impl, maxBytes: 3 }))).code,
    ).toBe("too_large");
  });
});
