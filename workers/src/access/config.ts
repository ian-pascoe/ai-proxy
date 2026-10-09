// Configuration of Cloudflare Access verification, read from the Worker env (vars/secrets).
// New in the Workers port (Go used `access.api-keys`); see docs/workers-port/ARCHITECTURE.md "Authentication".
import { Effect } from "effect"
import { ConfigurationError } from "../errors.ts"
import type { Principal } from "./principal.ts"

export interface AccessConfig {
  /** Issuer expected in `iss`, e.g. `https://team.cloudflareaccess.com`. */
  readonly issuer: string
  readonly jwksUrl: string
  /** Accepted Access application AUD tags. */
  readonly audiences: ReadonlyArray<string>
  /** Lowercased admin emails. */
  readonly adminEmails: ReadonlySet<string>
  /** Admin service token client ids (`common_name`). */
  readonly adminServiceTokens: ReadonlySet<string>
}

const DEFAULT_DEV_EMAIL = "dev@localhost"
const TEAM_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

const splitList = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "")

/** Accepts `team`, `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com[/]`. */
const normalizeTeamHost = (raw: string): string | undefined => {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
  if (host === "" || !TEAM_HOST.test(host)) return undefined
  return host.includes(".") ? host : `${host}.cloudflareaccess.com`
}

type AccessEnv = Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "ACCESS_ADMIN_EMAILS" | "ACCESS_ADMIN_SERVICE_TOKENS">

/** Parses and validates the Access settings. Fails closed when the team domain or AUD is missing. */
export const loadAccessConfig = (env: AccessEnv): Effect.Effect<AccessConfig, ConfigurationError> => {
  const host = normalizeTeamHost(env.ACCESS_TEAM_DOMAIN ?? "")
  if (host === undefined) {
    return Effect.fail(new ConfigurationError({ message: "ACCESS_TEAM_DOMAIN is missing or invalid" }))
  }
  const audiences = splitList(env.ACCESS_AUD)
  if (audiences.length === 0) {
    return Effect.fail(new ConfigurationError({ message: "ACCESS_AUD is missing" }))
  }
  return Effect.succeed({
    issuer: `https://${host}`,
    jwksUrl: `https://${host}/cdn-cgi/access/certs`,
    audiences,
    adminEmails: new Set(splitList(env.ACCESS_ADMIN_EMAILS).map((email) => email.toLowerCase())),
    adminServiceTokens: new Set(splitList(env.ACCESS_ADMIN_SERVICE_TOKENS))
  })
}

export const isAdmin = (config: Pick<AccessConfig, "adminEmails" | "adminServiceTokens">, principal: Principal) =>
  principal.kind === "user"
    ? config.adminEmails.has(principal.email.toLowerCase())
    : config.adminServiceTokens.has(principal.commonName)

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * `ACCESS_DEV_BYPASS` is honoured only when the request itself targets a loopback host, which is only the case under
 * `wrangler dev`: production traffic always arrives with the Access-protected custom domain as host. The bypass
 * principal is a user and is treated as an administrator. Returns the dev email, or undefined when inactive.
 */
export const devBypassEmail = (env: Pick<Env, "ACCESS_DEV_BYPASS">, requestUrl: string): string | undefined => {
  const value = (env.ACCESS_DEV_BYPASS ?? "").trim()
  if (value === "") return undefined
  let hostname: string
  try {
    hostname = new URL(requestUrl).hostname
  } catch {
    return undefined
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return undefined
  return /^(1|true|yes)$/i.test(value) ? DEFAULT_DEV_EMAIL : value
}
