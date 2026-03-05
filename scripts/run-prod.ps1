param(
  [int]$Port = 3010
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host $Label
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path "node_modules")) {
  Invoke-Step "Installing dependencies..." { npm ci }
}

Invoke-Step "Building production bundle..." { npm run build }

Invoke-Step "Starting Steward on port $Port..." { npm run start -- -p $Port }
