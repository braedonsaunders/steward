param(
  [int]$Port = 3010
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$legacyStandaloneServerPath = Join-Path $repoRoot ".next\standalone\server.js"
$runtimeStandaloneServerPath = Join-Path $repoRoot "build\standalone-runtime\server.js"

function Get-NodeProcessInfo {
  @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine })
}

function Stop-ProcessesById {
  param(
    [int[]]$ProcessIds,
    [string]$Reason
  )

  $uniqueProcessIds = @($ProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($uniqueProcessIds.Count -eq 0) {
    return
  }

  Write-Host "$Reason ($($uniqueProcessIds -join ', '))..."
  Stop-Process -Id $uniqueProcessIds -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 750
}

function Stop-LegacyStandaloneServer {
  $legacyProcessIds = @(Get-NodeProcessInfo |
      Where-Object { $_.CommandLine.Contains($legacyStandaloneServerPath) } |
      ForEach-Object { [int]$_.ProcessId })

  Stop-ProcessesById -ProcessIds $legacyProcessIds -Reason "Stopping legacy Steward standalone server that locks .next"
}

function Stop-StewardListenerOnPort {
  param(
    [int]$TargetPort
  )

  $listenerProcessIds = @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { [int]$_ })
  if ($listenerProcessIds.Count -eq 0) {
    return
  }

  $processesById = @{}
  foreach ($process in Get-NodeProcessInfo) {
    $processesById[[int]$process.ProcessId] = $process
  }

  $stewardProcessIds = New-Object System.Collections.Generic.List[int]
  foreach ($processId in $listenerProcessIds) {
    $process = $processesById[$processId]
    if ($null -eq $process) {
      throw "Port $TargetPort is already in use by process $processId. Stop it manually before running Steward."
    }

    $commandLine = [string]$process.CommandLine
    $isStewardProcess =
      $commandLine.Contains("scripts/start-prod.mjs") -or
      $commandLine.Contains($legacyStandaloneServerPath) -or
      $commandLine.Contains($runtimeStandaloneServerPath)

    if (-not $isStewardProcess) {
      throw "Port $TargetPort is already in use by non-Steward process $processId. Stop it manually before running Steward."
    }

    [void]$stewardProcessIds.Add($processId)
  }

  Stop-ProcessesById -ProcessIds $stewardProcessIds.ToArray() -Reason "Stopping current Steward listener on port $TargetPort"
}

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
Stop-LegacyStandaloneServer
Invoke-Step "Building production bundle..." { npm run build }
Stop-StewardListenerOnPort -TargetPort $Port
Invoke-Step "Starting Steward on port $Port..." { npm run start -- -p $Port }
