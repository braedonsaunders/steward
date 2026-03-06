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

function Test-DependenciesInstalled {
  if (-not (Test-Path "node_modules")) {
    return $false
  }

  & npm ls --depth=0 --silent *> $null
  return $LASTEXITCODE -eq 0
}

if (-not (Test-DependenciesInstalled)) {
  Invoke-Step "Installing dependencies..." { npm ci }
}

Invoke-Step "Ensuring Playwright runtime..." { node scripts/ensure-playwright.mjs }
Invoke-Step "Ensuring required network tools (nmap, tshark, snmpget, snmpwalk)..." { node scripts/ensure-network-tools.mjs }

Invoke-Step "Building production bundle..." { npm run build }

Invoke-Step "Starting Steward on port $Port..." { npm run start -- -p $Port }
