[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'NEXORA Local Paper Dashboard'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = $nodeCommand.Source
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw "Task '$taskName' already exists. Inspect it in Task Scheduler; this script never overwrites an existing task."
}

if ($WhatIfPreference) {
  $null = $PSCmdlet.ShouldProcess($taskName, 'Register current-user Task Scheduler entry')
  Write-Output "WhatIf: would run '$nodePath --env-file-if-exists=.env src/server.mjs' from '$projectRoot' at interactive logon."
  Write-Output 'WhatIf: current-user, limited privileges, loopback/paper-only, at most three one-minute restart attempts; no task was registered or started.'
  return
}

$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument '--env-file-if-exists=.env src/server.mjs' `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

if ($PSCmdlet.ShouldProcess($taskName, 'Register current-user Task Scheduler entry')) {
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts the local NEXORA paper-only dashboard at interactive logon; no live trading or broker credentials are enabled.' | Out-Null

  Write-Output "Registered '$taskName' for interactive logon of $userId. It was not started now."
  Write-Output 'Review the task in Task Scheduler. The application remains loopback-only and paper-only.'
}
