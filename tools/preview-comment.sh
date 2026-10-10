#!/usr/bin/env bash
# Creates or updates this workflow's single preview comment on a pull request (found by a hidden marker).
# Usage: GH_TOKEN=… tools/preview-comment.sh <pr-number> <markdown>
set -euo pipefail

pr="${1:?usage: preview-comment.sh <pr-number> <markdown>}"
marker="<!-- cliproxy-preview -->"
body="$marker
$2"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

id="$(gh api --paginate "repos/$repo/issues/$pr/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1)"

if [ -n "$id" ]; then
  gh api --method PATCH "repos/$repo/issues/comments/$id" -f body="$body" >/dev/null
else
  gh api --method POST "repos/$repo/issues/$pr/comments" -f body="$body" >/dev/null
fi
