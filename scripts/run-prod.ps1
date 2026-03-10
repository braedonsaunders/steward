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

Invoke-Step "Installing production prerequisites..." { & "$PSScriptRoot\install-prod.ps1" }
Invoke-Step "Building production bundle..." { npm run build }
Invoke-Step "Starting Steward on port $Port..." { npm run start -- -p $Port }
