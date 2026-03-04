#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

if command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist | grep -q '"name":"steward"'; then
    echo "Stopping PM2 process 'steward'..."
    pm2 stop steward >/dev/null
    echo "Stopped PM2 process."
  else
    echo "No PM2 process named 'steward' is running."
  fi
else
  echo "PM2 is not installed. Skipping PM2 shutdown."
fi

if command -v docker >/dev/null 2>&1; then
  echo "Stopping Docker Compose service if running..."
  docker compose stop steward >/dev/null || true
  echo "Docker Compose stop attempted."
else
  echo "Docker is not installed. Skipping Docker shutdown."
fi
