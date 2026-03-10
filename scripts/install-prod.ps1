param()

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

function Test-CommandAvailable {
  param([string]$CommandName)
  return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Test-NodeSupported {
  if (-not (Test-CommandAvailable node)) {
    return $false
  }

  & node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major > 20 || (major === 20 && minor >= 9)) ? 0 : 1)"
  return $LASTEXITCODE -eq 0
}

function Add-CommonInstallPaths {
  $candidatePaths = @(
    "C:\Program Files\nodejs",
    "C:\Program Files\Docker\Docker\resources\bin"
  ) | Where-Object { Test-Path $_ }

  foreach ($candidate in $candidatePaths) {
    if (-not (($env:Path -split ';') -contains $candidate)) {
      $env:Path = "$candidate;$env:Path"
    }
  }
}

function Install-WingetPackageIfNeeded {
  param(
    [string]$PackageId,
    [string]$DisplayName
  )

  if (-not (Test-CommandAvailable winget)) {
    throw "winget is required to install $DisplayName automatically."
  }

  Write-Host "Installing $DisplayName via winget..."
  & winget install --exact --id $PackageId --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget install for $DisplayName failed with exit code $LASTEXITCODE"
  }

  Add-CommonInstallPaths
}

function Ensure-Node {
  Add-CommonInstallPaths
  if (Test-NodeSupported) {
    return
  }

  Install-WingetPackageIfNeeded -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
  if (-not (Test-NodeSupported)) {
    throw "Node.js 20.9+ is required, but a supported version is still unavailable."
  }
}

function Ensure-DockerDesktop {
  Add-CommonInstallPaths
  if (Test-CommandAvailable docker) {
    return
  }

  Install-WingetPackageIfNeeded -PackageId "Docker.DockerDesktop" -DisplayName "Docker Desktop"
}

function Test-DependenciesInstalled {
  if (-not (Test-Path "node_modules")) {
    return $false
  }

  & npm ls --depth=0 --silent *> $null
  return $LASTEXITCODE -eq 0
}

Ensure-Node
Ensure-DockerDesktop

if (-not (Test-DependenciesInstalled)) {
  Invoke-Step "Installing dependencies..." { npm ci }
}

Invoke-Step "Ensuring Playwright runtime..." { node scripts/ensure-playwright.mjs }
Invoke-Step "Ensuring required network tools (nmap, tshark, snmpget, snmpwalk)..." { node scripts/ensure-network-tools.mjs }
Invoke-Step "Ensuring remote desktop runtime (guacd)..." { node scripts/ensure-remote-desktop-runtime.mjs }
