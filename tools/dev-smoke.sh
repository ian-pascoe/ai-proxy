#!/bin/sh
# Boots the stack under `alchemy dev` (local emulators, local state, no Cloudflare login) and checks that the bundled
# Worker starts and answers: the CI replacement for a deploy dry run. Builds the control panel first so `/` is served.
# Usage: pnpm smoke
set -eu
cd "$(dirname "$0")/.."
pnpm -s web:build >/dev/null
log=$(mktemp)
ALCHEMY_STATE=local pnpm exec alchemy dev --stage smoke >"$log" 2>&1 &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf .alchemy/state/cliproxy/smoke .alchemy/local
}
trap cleanup EXIT INT TERM

url=""
i=0
while [ "$i" -lt 180 ]; do
  url=$(sed -n 's/.*\[Proxy\] ready at \(http[^ ]*\).*/\1/p' "$log" | tail -n 1)
  if [ -n "$url" ] && curl -fsS "$url/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$log"; echo "alchemy dev exited" >&2; exit 1; fi
  i=$((i + 1))
  sleep 1
done
if [ -z "$url" ] || ! curl -fsS "$url/healthz" >/dev/null 2>&1; then
  cat "$log"
  echo "the Worker did not become healthy" >&2
  exit 1
fi

check() {
  status=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  echo "$status $*"
  [ "$status" = 200 ] || { cat "$log"; exit 1; }
}
check "$url/healthz"
check "$url/"
check "$url/accounts"
check "$url/v1/models"
check "$url/v8/management/config"
check "$url/v8/management/observability/usage/summary"
check "$url/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*"
echo "smoke ok: $url"
