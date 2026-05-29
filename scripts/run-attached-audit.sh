#!/bin/zsh

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <npm-script> [args...]"
  exit 1
fi

SCRIPT_NAME="$1"
shift

ARGS=("$@")
URL_INDEX=""

for index in "${(@k)ARGS}"; do
  value="${ARGS[$index]}"
  if [[ "${value}" == http://* || "${value}" == https://* ]]; then
    URL_INDEX="${index}"
    break
  fi
done

ORDERED_ARGS=("${ARGS[@]}")
if [[ -n "${URL_INDEX}" && "${URL_INDEX}" -ne 1 ]]; then
  URL_ARG="${ARGS[$URL_INDEX]}"
  ORDERED_ARGS=("${URL_ARG}")
  for index in "${(@k)ARGS}"; do
    if [[ "${index}" -ne "${URL_INDEX}" ]]; then
      ORDERED_ARGS+=("${ARGS[$index]}")
    fi
  done
fi

BROWSER_URL="${PAGE_AUDIT_MCP_BROWSER_URL:-http://127.0.0.1:9222}"
CHROME_APP="${PAGE_AUDIT_CHROME_APP:-Google Chrome}"
CHROME_USER_DATA_DIR="${PAGE_AUDIT_CHROME_USER_DATA_DIR:-/tmp/chrome-page-audit}"
WAIT_SECONDS="${PAGE_AUDIT_CHROME_WAIT_SECONDS:-15}"

if ! curl -s "${BROWSER_URL}/json/version" >/dev/null 2>&1; then
  echo "Starting ${CHROME_APP} with remote debugging on ${BROWSER_URL}..."
  open -na "${CHROME_APP}" --args \
    --remote-debugging-port=9222 \
    --user-data-dir="${CHROME_USER_DATA_DIR}"

  ready="false"
  for _ in $(seq 1 "${WAIT_SECONDS}"); do
    if curl -s "${BROWSER_URL}/json/version" >/dev/null 2>&1; then
      ready="true"
      break
    fi
    sleep 1
  done

  if [[ "${ready}" != "true" ]]; then
    echo "Chrome debugging endpoint did not become ready at ${BROWSER_URL}."
    exit 1
  fi
fi

exec npm run "${SCRIPT_NAME}" -- "${ORDERED_ARGS[@]}" --browser-url "${BROWSER_URL}"
