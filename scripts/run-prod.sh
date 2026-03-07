#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3010}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

echo "Installing production prerequisites..."
bash "${SCRIPT_DIR}/install-prod.sh"

echo "Building production bundle..."
npm run build

echo "Starting Steward on port ${PORT}..."
npm run start -- -p "$PORT"
