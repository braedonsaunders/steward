#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3010}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

LEGACY_STANDALONE_SERVER_PATH="${REPO_ROOT}/.next/standalone/server.js"
RUNTIME_STANDALONE_SERVER_PATH="${REPO_ROOT}/build/standalone-runtime/server.js"

stop_legacy_standalone_server() {
  mapfile -t pids < <(pgrep -f "$LEGACY_STANDALONE_SERVER_PATH" || true)
  if (( ${#pids[@]} == 0 )); then
    return
  fi

  echo "Stopping legacy Steward standalone server that locks .next (${pids[*]})..."
  kill "${pids[@]}" >/dev/null 2>&1 || true
  sleep 1
}

stop_steward_listener_on_port() {
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  mapfile -t pids < <(lsof -ti TCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if (( ${#pids[@]} == 0 )); then
    return
  fi

  local steward_pids=()
  for pid in "${pids[@]}"; do
    local command_line
    command_line="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if [[ "$command_line" == *"scripts/start-prod.mjs"* || "$command_line" == *"$LEGACY_STANDALONE_SERVER_PATH"* || "$command_line" == *"$RUNTIME_STANDALONE_SERVER_PATH"* ]]; then
      steward_pids+=("$pid")
      continue
    fi

    echo "Port ${PORT} is already in use by non-Steward process ${pid}. Stop it manually before running Steward." >&2
    exit 1
  done

  if (( ${#steward_pids[@]} == 0 )); then
    return
  fi

  echo "Stopping current Steward listener on port ${PORT} (${steward_pids[*]})..."
  kill "${steward_pids[@]}" >/dev/null 2>&1 || true
  sleep 1
}

echo "Installing production prerequisites..."
bash "${SCRIPT_DIR}/install-prod.sh"

stop_legacy_standalone_server

echo "Building production bundle..."
npm run build

stop_steward_listener_on_port

echo "Starting Steward on port ${PORT}..."
npm run start -- -p "$PORT"
