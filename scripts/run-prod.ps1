param(
  [int]$Port = 3010
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm ci
}

Write-Host "Building production bundle..."
npm run build

Write-Host "Starting Steward on port $Port..."
npm run start -- -p $Port
