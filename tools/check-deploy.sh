#!/usr/bin/env bash
# Post-deploy check through Cloudflare Access with a service token: the public health route and an authenticated proxy
# route (which proves the Worker accepts the Access JWT, i.e. ACCESS_AUD and the team domain are wired). Retries while
# a new workers.dev hostname or Access application propagates.
# Usage: CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… tools/check-deploy.sh <base-url>
set -euo pipefail

base="${1:?usage: check-deploy.sh <base-url>}"
base="${base%/}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required}"

status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    "$base$1" || echo 000
}

for path in /healthz /v1/models; do
  for attempt in $(seq 1 30); do
    code="$(status "$path")"
    if [ "$code" = 200 ]; then
      echo "$path: 200"
      continue 2
    fi
    echo "$path: $code (attempt $attempt/30)"
    sleep 10
  done
  echo "::error::$base$path did not answer 200 through Access" >&2
  exit 1
done
