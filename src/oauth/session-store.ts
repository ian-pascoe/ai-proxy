/**
 * OAuth login sessions.
 *
 * Go source: internal/api/handlers/management/oauth_sessions.go (`oauthSessionStore`: `Register`, `SetError`,
 * `Complete`, `Get`, `IsPending`, `Cancel`; TTL 30 min, completed sessions kept 1 min, lazy purging). The session
 * table lives in the ControlPlane Durable Object's SQLite (`SqliteSessionTable`); the rules are in
 * `OAuthSessions` over the tiny `SessionTable` interface so they run against a `Map` in unit tests.
 * Secrets of a flow (PKCE verifier, device code) are kept in `data` and wiped as soon as the session ends.
 */
import type { JsonObject } from "../json/index.ts"
import type { OAuthProvider } from "./names.ts"

/** `oauthSessionTTL`: must cover the 30 minute xAI device flow. */
export const SESSION_TTL_MS = 30 * 60_000
/** `oauthCompletedSessionTTL`. */
export const COMPLETED_TTL_MS = 60_000
/** A poll or exchange in flight blocks others for at most this long (guards against an interrupted request). */
export const BUSY_LEASE_MS = 2 * 60_000

export type SessionFlow = "callback" | "device"

export interface OAuthSession {
  readonly state: string
  readonly provider: OAuthProvider
  readonly flow: SessionFlow
  /** Error text of a failed login; empty while pending or completed. */
  readonly status: string
  readonly completed: boolean
  readonly expiresAt: number
  /** End of the callback window (5 min) or of the device approval window. */
  readonly deadlineAt: number
  /** Device flows: the earliest time of the next upstream poll. */
  readonly nextPollAt: number
  readonly intervalMs: number
  readonly busyUntil: number
  readonly data: JsonObject
}

export interface SessionTable {
  get(state: string): OAuthSession | undefined
  put(session: OAuthSession): void
  delete(state: string): void
  /** Removes every session that expired at or before `now`. */
  purge(now: number): void
}

export class MemorySessionTable implements SessionTable {
  readonly rows = new Map<string, OAuthSession>()
  get(state: string): OAuthSession | undefined {
    return this.rows.get(state)
  }
  put(session: OAuthSession): void {
    this.rows.set(session.state, session)
  }
  delete(state: string): void {
    this.rows.delete(state)
  }
  purge(now: number): void {
    for (const [state, session] of this.rows) if (session.expiresAt <= now) this.rows.delete(state)
  }
}

interface SessionRow {
  state: string
  provider: string
  flow: string
  status: string
  completed: number
  expires_at: number
  deadline_at: number
  next_poll_at: number
  interval_ms: number
  busy_until: number
  data: string
  [column: string]: SqlStorageValue
}

export class SqliteSessionTable implements SessionTable {
  readonly #sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.#sql = sql
    sql.exec(
      `CREATE TABLE IF NOT EXISTS oauth_sessions (
         state TEXT PRIMARY KEY,
         provider TEXT NOT NULL,
         flow TEXT NOT NULL,
         status TEXT NOT NULL,
         completed INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         deadline_at INTEGER NOT NULL,
         next_poll_at INTEGER NOT NULL,
         interval_ms INTEGER NOT NULL,
         busy_until INTEGER NOT NULL,
         data TEXT NOT NULL
       )`
    )
  }

  get(state: string): OAuthSession | undefined {
    const rows = this.#sql.exec<SessionRow>("SELECT * FROM oauth_sessions WHERE state = ?", state).toArray()
    const row = rows[0]
    return row === undefined
      ? undefined
      : {
          state: row.state,
          provider: row.provider as OAuthProvider,
          flow: row.flow as SessionFlow,
          status: row.status,
          completed: row.completed === 1,
          expiresAt: row.expires_at,
          deadlineAt: row.deadline_at,
          nextPollAt: row.next_poll_at,
          intervalMs: row.interval_ms,
          busyUntil: row.busy_until,
          data: JSON.parse(row.data) as JsonObject
        }
  }

  put(session: OAuthSession): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO oauth_sessions
         (state, provider, flow, status, completed, expires_at, deadline_at, next_poll_at, interval_ms, busy_until, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.state,
      session.provider,
      session.flow,
      session.status,
      session.completed ? 1 : 0,
      session.expiresAt,
      session.deadlineAt,
      session.nextPollAt,
      session.intervalMs,
      session.busyUntil,
      JSON.stringify(session.data)
    )
  }

  delete(state: string): void {
    this.#sql.exec("DELETE FROM oauth_sessions WHERE state = ?", state)
  }

  purge(now: number): void {
    this.#sql.exec("DELETE FROM oauth_sessions WHERE expires_at <= ?", now)
  }
}

export interface NewSession {
  readonly state: string
  readonly provider: OAuthProvider
  readonly flow: SessionFlow
  readonly deadlineAt: number
  readonly nextPollAt?: number
  readonly intervalMs?: number
  readonly data: JsonObject
}

/** Session rules; every method is synchronous so a read-modify-write is atomic inside the Durable Object. */
export class OAuthSessions {
  readonly #table: SessionTable

  constructor(table: SessionTable) {
    this.#table = table
  }

  /** `Register`: (re)creates a pending session. */
  register(session: NewSession, now: number): void {
    this.#table.purge(now)
    this.#table.put({
      state: session.state,
      provider: session.provider,
      flow: session.flow,
      status: "",
      completed: false,
      expiresAt: now + SESSION_TTL_MS,
      deadlineAt: session.deadlineAt,
      nextPollAt: session.nextPollAt ?? 0,
      intervalMs: session.intervalMs ?? 0,
      busyUntil: 0,
      data: session.data
    })
  }

  /** `Get`: expired sessions are gone. */
  get(state: string, now: number): OAuthSession | undefined {
    this.#table.purge(now)
    return this.#table.get(state)
  }

  /** `IsPending`: exists, not completed, no error; optionally for one provider. */
  isPending(state: string, now: number, provider?: OAuthProvider): boolean {
    const session = this.get(state, now)
    return (
      session !== undefined &&
      !session.completed &&
      session.status === "" &&
      (provider === undefined || session.provider === provider)
    )
  }

  /** `SetError`: ignored for unknown or completed sessions; refreshes the TTL; drops the flow secrets. */
  setError(state: string, message: string, now: number): void {
    const session = this.get(state, now)
    if (session === undefined || session.completed) return
    this.#table.put({
      ...session,
      status: message.trim() === "" ? "Authentication failed" : message.trim(),
      expiresAt: now + SESSION_TTL_MS,
      busyUntil: 0,
      data: {}
    })
  }

  /** `Complete`: ignored for unknown or already completed sessions. */
  complete(state: string, now: number): void {
    const session = this.get(state, now)
    if (session === undefined || session.completed) return
    this.#table.put({
      ...session,
      status: "",
      completed: true,
      expiresAt: now + COMPLETED_TTL_MS,
      busyUntil: 0,
      data: {}
    })
  }

  /** `Cancel`: removes a pending session; completed and failed ones are left alone. */
  cancel(state: string, now: number): boolean {
    const session = this.get(state, now)
    if (session === undefined || session.completed || session.status !== "") return false
    this.#table.delete(state)
    return true
  }

  /** Takes the busy lease (one poll/exchange at a time); `false` when another one is in flight. */
  acquire(state: string, now: number): boolean {
    const session = this.get(state, now)
    if (session === undefined || session.busyUntil > now) return false
    this.#table.put({ ...session, busyUntil: now + BUSY_LEASE_MS })
    return true
  }

  /** Releases the lease and records the next allowed poll time / interval (no-op once the session ended). */
  release(state: string, now: number, poll?: { readonly nextPollAt: number; readonly intervalMs: number }): void {
    const session = this.get(state, now)
    if (session === undefined) return
    this.#table.put({ ...session, busyUntil: 0, ...(poll === undefined ? {} : poll) })
  }
}
