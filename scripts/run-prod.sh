#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3010}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm ci
fi

echo "Building production bundle..."
npm run build

echo "Starting Steward on port ${PORT}..."
npm run start -- -p "$PORT"
