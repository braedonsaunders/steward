param(
  [int]$Port = 3010
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$legacyStandaloneServerPath = Join-Path $repoRoot ".next\standalone\server.js"
$runtimeStandaloneRootPrefix = Join-Path $repoRoot "build\standalone-runtime"

function Get-NodeProcessInfo {
  @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine })
}

function Test-IsStewardNodeProcess {
  param(
    $ProcessInfo
  )

  if ($null -eq $ProcessInfo) {
    return $false
  }

  $commandLine = [string]$ProcessInfo.CommandLine
  return (
    $commandLine.Contains("scripts/start-prod.mjs") -or
    $commandLine.Contains($legacyStandaloneServerPath) -or
    $commandLine.Contains($runtimeStandaloneRootPrefix)
  )
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

function Expand-StewardProcessTree {
  param(
    [hashtable]$ProcessesById,
    [int[]]$SeedProcessIds
  )

  $expandedProcessIds = New-Object System.Collections.Generic.HashSet[int]
  $pendingProcessIds = New-Object System.Collections.Generic.Queue[int]

  foreach ($processId in $SeedProcessIds) {
    if ($processId -gt 0) {
      $pendingProcessIds.Enqueue([int]$processId)
    }
  }

  while ($pendingProcessIds.Count -gt 0) {
    $currentProcessId = $pendingProcessIds.Dequeue()
    if (-not $expandedProcessIds.Add($currentProcessId)) {
      continue
    }

    $processInfo = $ProcessesById[$currentProcessId]
    if ($null -eq $processInfo) {
      continue
    }

    $parentProcessId = [int]$processInfo.ParentProcessId
    if ($parentProcessId -gt 0) {
      $parentProcess = $ProcessesById[$parentProcessId]
      if (Test-IsStewardNodeProcess -ProcessInfo $parentProcess) {
        $pendingProcessIds.Enqueue($parentProcessId)
      }
    }
  }

  return @($expandedProcessIds)
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

  $stewardSeedProcessIds = New-Object System.Collections.Generic.List[int]
  foreach ($processId in $listenerProcessIds) {
    $process = $processesById[$processId]
    if ($null -eq $process) {
      throw "Port $TargetPort is already in use by process $processId. Stop it manually before running Steward."
    }

    if (-not (Test-IsStewardNodeProcess -ProcessInfo $process)) {
      throw "Port $TargetPort is already in use by non-Steward process $processId. Stop it manually before running Steward."
    }

    [void]$stewardSeedProcessIds.Add($processId)
  }

  $stewardProcessIds = Expand-StewardProcessTree -ProcessesById $processesById -SeedProcessIds $stewardSeedProcessIds.ToArray()
  Stop-ProcessesById -ProcessIds $stewardProcessIds -Reason "Stopping current Steward listener on port $TargetPort"
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
