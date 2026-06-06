#!/usr/bin/env bash
# Thin curl wrapper for the DFD orchestrator REST API.
#
# Usage:
#   orch_api.sh get  <path>
#   orch_api.sh post <path> [json-body]
#   orch_api.sh put  <path> [json-body]
#   orch_api.sh del  <path>
#
# Env:
#   ORCH_API_BASE  base URL (default http://127.0.0.1:8002)
#   ORCH_CLIENT    x-orch-client id   (default agent-cli)
#   ORCH_TOKEN     bearer token       (only if the server requires one)
#
# Prints the raw JSON response. Pipe to `jq` to extract fields, e.g.:
#   wf=$(orch_api.sh post /api/workflows '{"name":"demo"}' | jq -r .id)
set -euo pipefail

BASE="${ORCH_API_BASE:-http://127.0.0.1:8002}"
CLIENT="${ORCH_CLIENT:-agent-cli}"

method="${1:?usage: get|post|put|del <path> [body]}"
path="${2:?missing path}"
body="${3:-}"

args=(-sS -X)
case "$method" in
  get)  args+=(GET) ;;
  post) args+=(POST) ;;
  put)  args+=(PUT) ;;
  del)  args+=(DELETE) ;;
  *) echo "unknown method: $method (use get|post|put|del)" >&2; exit 2 ;;
esac

args+=(-H "content-type: application/json" -H "x-orch-client: $CLIENT")
[ -n "${ORCH_TOKEN:-}" ] && args+=(-H "authorization: Bearer $ORCH_TOKEN")
[ -n "$body" ] && args+=(--data "$body")

# Surface HTTP errors (4xx/5xx) instead of silently returning an error body.
args+=(-w '\n%{http_code}' "$BASE$path")

resp="$(curl "${args[@]}")"
code="${resp##*$'\n'}"
payload="${resp%$'\n'*}"
printf '%s' "$payload"
if [ "$code" -ge 400 ]; then
  echo >&2
  echo "HTTP $code for $method $path" >&2
  exit 1
fi
