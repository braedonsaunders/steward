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

echo "Ensuring Playwright runtime..."
node scripts/ensure-playwright.mjs

echo "Ensuring required network tools (nmap, tshark)..."
node scripts/ensure-network-tools.mjs

if ! command -v pwsh >/dev/null 2>&1; then
  echo "Warning: PowerShell 7 (pwsh) is not installed. Linux/macOS Steward can still run, but WinRM access to Windows endpoints will be unavailable until pwsh is installed."
fi

echo "Building production bundle..."
npm run build

echo "Starting Steward on port ${PORT}..."
npm run start -- -p "$PORT"
