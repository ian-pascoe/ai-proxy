import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CORS_EXPOSED_RESPONSE_HEADERS } from "../src/http/cors.ts";

const fetchWorker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://proxy.test${path}`, init));

const expectCors = (response: Response) => {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  expect(response.headers.get("access-control-allow-headers")).toBe("*");
  expect(response.headers.get("access-control-expose-headers")).toBe(
    CORS_EXPOSED_RESPONSE_HEADERS.join(", "),
  );
};

describe("GET /healthz", () => {
  it("returns {status:ok} as JSON", async () => {
    const response = await fetchWorker("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe('{"status":"ok"}');
    expectCors(response);
  });

  it("HEAD returns 200 with an empty body", async () => {
    const response = await fetchWorker("/healthz", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expectCors(response);
  });
});

describe("GET /", () => {
  it("is the control panel, gated like the management API (no public banner)", async () => {
    // proxy.test has no Access settings, so the management zone fails closed.
    const response = await fetchWorker("/");
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS", () => {
  it("answers OPTIONS on a known path with an empty 204", async () => {
    const response = await fetchWorker("/healthz", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expectCors(response);
  });

  it("answers OPTIONS on an unknown path with an empty 204", async () => {
    const response = await fetchWorker("/v1/chat/completions", {
      method: "OPTIONS",
      headers: { origin: "https://x.test" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectCors(response);
  });

  it("adds CORS headers to unknown routes (404)", async () => {
    const response = await fetchWorker("/nope");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 page not found");
    expectCors(response);
  });
});
