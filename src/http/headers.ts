// Port of sdk/api/handlers/header_filter.go (FilterUpstreamHeaders, WriteUpstreamHeaders, IsCPAReservedResponseHeader).

const GATEWAY_HEADER_PREFIXES = ["x-litellm-", "helicone-", "x-portkey-", "cf-aig-", "x-kong-", "x-bt-"] as const

/** RFC 7230 hop-by-hop headers plus headers the proxy manages itself. */
const BLOCKED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "content-length",
  "content-encoding"
])

const CPA_RESERVED_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "x-cpa-trace-id"
])

/** Whether a downstream response header is owned by the proxy (CORS, trace id). */
export const isCPAReservedResponseHeader = (name: string): boolean => CPA_RESERVED_HEADERS.has(name.toLowerCase())

/**
 * Copy of upstream response headers without hop-by-hop, security-sensitive, proxy-owned, `Connection`-scoped and
 * AI-gateway fingerprint headers (`cf-aig-*` matters on Workers).
 */
export const filterUpstreamHeaders = (source: Headers): Headers => {
  const connectionScoped = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "")
  )

  const out = new Headers()
  source.forEach((value, name) => {
    const lower = name.toLowerCase()

    if (BLOCKED_HEADERS.has(lower) || CPA_RESERVED_HEADERS.has(lower) || connectionScoped.has(lower)) return

    if (GATEWAY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return
    out.append(name, value)
  })

  return out
}

/** `WriteUpstreamHeaders`: adds `source` headers to `target` without overwriting names already present. */
export const mergeUpstreamHeaders = (
  target: Record<string, string>,
  source: Headers | undefined
): Record<string, string> => {
  if (source === undefined) return target
  const present = new Set(Object.keys(target).map((name) => name.toLowerCase()))
  source.forEach((value, name) => {
    const lower = name.toLowerCase()

    if (present.has(lower)) return
    target[lower] = value
  })

  return target
}
