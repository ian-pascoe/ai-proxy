// The `web/` control panel: `index.html` for `/` and every page path, bundle files under `/assets`, all behind the
// Access admin gate (src/management/web-panel.ts, src/access/routes.ts).
import { afterAll, describe, expect, it } from "vitest";
import { classifyPath } from "../src/access/routes.ts";
import { PANEL_CSP, PANEL_NOT_BUILT } from "../src/management/web-panel.ts";
import { makeHarness, token } from "./support/management.ts";

const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc.js"></script></head></html>';

const fetched: string[] = [];

const assets = (built: boolean) =>
  ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      fetched.push(path);

      if (!built) return new Response("not found", { status: 404 });

      if (path === "/")
        return new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });

      if (path === "/assets/index-abc.js") {
        return new Response("export {}", {
          headers: {
            "content-type": "text/javascript",
            "cache-control": "public, max-age=31536000, immutable",
            etag: '"js"',
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  }) as unknown as Fetcher;

const built = makeHarness(undefined, { ASSETS: assets(true) });

const missing = makeHarness(undefined, { ASSETS: assets(false) });

afterAll(async () => {
  await built.dispose();
  await missing.dispose();
});

describe("web panel", () => {
  it.each([
    "/",
    "/accounts",
    "/accounts/claude-a.json",
    "/keys",
    "/models",
    "/usage",
    "/settings/",
  ])("serves index.html for %s with the panel's security headers", async (path) => {
    fetched.length = 0;
    const response = await built.call(path);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    expect(fetched).toEqual(["/"]);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(PANEL_CSP);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("passes bundle files through with their caching headers", async () => {
    const response = await built.call("/assets/index-abc.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {}");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe('"js"');
    expect((await built.call("/assets/nope.js")).status).toBe(404);
  });

  it("says so when the panel is not built", async () => {
    const response = await missing.call("/");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: PANEL_NOT_BUILT });
  });

  it("is only served to administrators", async () => {
    expect((await built.call("/", { auth: false })).status).toBe(401);
    expect((await built.call("/assets/index-abc.js", { auth: false })).status).toBe(401);
    expect((await built.call("/usage", { auth: await token("user@example.com") })).status).toBe(
      403,
    );
  });

  it("classifies the panel paths as management and leaves look-alikes alone", () => {
    for (const path of ["/", "/accounts", "/Accounts/x", "/assets/a.js", "/settings/", "//keys"]) {
      expect(classifyPath(`https://x.test${path}`)).toBe("management");
    }

    for (const path of ["/healthz", "/accountsx", "/nope", "/key"]) {
      expect(classifyPath(`https://x.test${path}`)).toBe("public");
    }
  });
});
