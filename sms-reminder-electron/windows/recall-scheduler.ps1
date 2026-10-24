param([Parameter(Mandatory=$true)][string]$AppDir,[ValidateSet('on','off')][string]$Mode='on',[string]$StartTool='10:55')
$ErrorActionPreference='Stop'
try {
  $taskName='LUK Dental SMS Electron - Daily Recall'
  $exe=Join-Path $AppDir 'LUK Dental SMS Electron.exe'
  $admin=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Run this BAT as Administrator.'}
  if (-not (Test-Path -LiteralPath $exe)) {throw 'Extract the full Electron package before setting up Recall.'}
  if ($Mode -eq 'off') {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Start-Process -FilePath $exe -ArgumentList '--stop-recall-monitoring' -WorkingDirectory $AppDir
    Write-Host 'Recall schedule disabled; Appointment tasks were not changed.'
    exit 0
  }
  if ($StartTool -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {throw 'Recall Open tool time must use HH:MM.'}
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest
  $action=New-ScheduledTaskAction -Execute $exe -Argument '--start-recall-monitoring' -WorkingDirectory $AppDir
  $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger (New-ScheduledTaskTrigger -Daily -At $StartTool) -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "Recall task created for $identity at $StartTool (Windows time zone)."
  Write-Host 'Set Recall send time independently in Electron Settings. Open tool before that time.'
  Write-Host 'R5 must be signed in and unlocked with Phone Link ready. Recall does not configure restart, auto-login or locking.'
  Write-Host 'Appointment tasks were not changed. Recall starts at the next daily trigger.'
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
