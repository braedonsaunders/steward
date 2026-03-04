$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "PM2 is not installed. Skipping PM2 shutdown."
} else {
  $pm2Process = pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq "steward" }

  if ($null -eq $pm2Process) {
    Write-Host "No PM2 process named 'steward' is running."
  } else {
    Write-Host "Stopping PM2 process 'steward'..."
    pm2 stop steward | Out-Null
    Write-Host "Stopped PM2 process."
  }
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
  Write-Host "Stopping Docker Compose service if running..."
  docker compose stop steward | Out-Null
  Write-Host "Docker Compose stop attempted."
} else {
  Write-Host "Docker is not installed. Skipping Docker shutdown."
}
