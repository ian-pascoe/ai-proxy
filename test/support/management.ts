// Test harness for the management routes: Access gate with a fake JWKS, real ControlPlane, mocked outbound HTTP.
import { env } from "cloudflare:workers";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { makeAccessLayer, makeWithAccess } from "../../src/access/layer.ts";
import { RootRoutes } from "../../src/http/routes.ts";
import { ManagementRoutes } from "../../src/management/routes.ts";
import { OAuthCallbackRoutes } from "../../src/oauth/public-routes.ts";
import { requestContext } from "../../src/platform/env.ts";
import { ModelRegistryLive } from "../../src/registry/live.ts";
import { AUD, fakeJwksLayer, makeFakeJwks, makeKey, signToken, userClaims } from "./access.ts";
import { type MockHandler, mockHttp } from "./refresh.ts";
import type { Json } from "../../src/json/index.ts";

const key = await makeKey("management-kid");

export const ADMIN = "admin@example.com";

const baseEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  ACCESS_ADMIN_EMAILS: ADMIN,
  ACCESS_ADMIN_SERVICE_TOKENS: "",
  ACCESS_DEV_BYPASS: "",
};

const ctx = {} as unknown as ExecutionContext;

export const token = async (email: string = ADMIN): Promise<string> =>
  await signToken({ key, now: Math.floor(Date.now() / 1000), claims: userClaims(email) });

export const controlPlane = () => env.CONTROL_PLANE.getByName("global");

/** Restores a pristine ControlPlane (no credentials, default config). */
export const resetControlPlane = async (): Promise<void> => {
  const stub = controlPlane();
  const entries = await stub.listCredentials();
  await stub.removeCredentials(entries.map((entry) => entry.id));
  await stub.putConfig("");
};

export interface Harness {
  readonly call: (
    path: string,
    init?: RequestInit & { readonly auth?: false | string },
  ) => Promise<Response>;
  readonly json: (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: unknown; headers: Headers }>;
  readonly requests: ReturnType<typeof mockHttp>["requests"];
  readonly dispose: () => Promise<void>;
}

export const makeHarness = (
  http: MockHandler = () => ({ status: 404 }),
  bindings: Partial<Env> = {},
): Harness => {
  const outbound = mockHttp(http);
  const access = makeAccessLayer(fakeJwksLayer(makeFakeJwks([key])));

  const routes = ManagementRoutes.pipe(
    Layer.provide(Layer.mergeAll(ModelRegistryLive, outbound.layer)),
  );

  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(RootRoutes, OAuthCallbackRoutes, access, makeWithAccess(access)(routes)),
    {
      disableLogger: true,
    },
  );

  const call: Harness["call"] = async (path, init = {}) => {
    const { auth, ...rest } = init;
    const headers = new Headers(rest.headers);

    if (auth !== false) headers.set("Cf-Access-Jwt-Assertion", auth ?? (await token()));

    return await web.handler(
      new Request(`https://proxy.test${path}`, { ...rest, headers }),
      requestContext({ ...baseEnv, ...bindings }, ctx),
    );
  };

  return {
    call,
    json: async (path, init) => {
      const response = await call(path, init);
      const text = await response.text();

      return {
        status: response.status,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
        headers: response.headers,
      };
    },
    requests: outbound.requests,
    dispose: web.dispose,
  };
};

export const jsonInit = (method: string, body: Json): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const claudeFile = (extra: Record<string, unknown> = {}) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-secret-access",
  refresh_token: "secret-refresh",
  expired: "2999-01-01T00:00:00Z",
  ...extra,
});
