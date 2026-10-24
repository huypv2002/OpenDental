# Read-only workstation report: no SMS, restart, lock, login changes or task writes.
param([string]$AppDir=(Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference='Stop'
$report=[ordered]@{checkedAt=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss');machine=$env:COMPUTERNAME;windowsUser="$env:USERDOMAIN\$env:USERNAME";windowsTimeZone=(Get-TimeZone).Id;tasks=@();bridge=$null;phoneLink=@();issues=@()}
foreach ($prefix in @('LUK Dental SMS Electron','LUK Dental SMS','LUK Dental SMS UIAutomation')) {
  foreach ($name in @('Enable Auto Login','Daily Restart','Start Monitoring','Lock Screen','Screen Off')) {
    $task=Get-ScheduledTask -TaskName "$prefix - $name" -ErrorAction SilentlyContinue
    if ($task) {
      $info=Get-ScheduledTaskInfo -TaskName $task.TaskName
      $report.tasks+=@{name=$task.TaskName;state=[string]$task.State;user=$task.Principal.UserId;logonType=[string]$task.Principal.LogonType;nextRun=[string]$info.NextRunTime;lastResult=$info.LastTaskResult;actions=@($task.Actions | ForEach-Object {@{exe=$_.Execute;args=$_.Arguments}});triggers=@($task.Triggers | ForEach-Object {$_.StartBoundary})}
    }
  }
}
$report.phoneLink=@(Get-Process -Name 'YourPhone','PhoneExperienceHost' -ErrorAction SilentlyContinue | ForEach-Object {@{name=$_.ProcessName;pid=$_.Id;session=$_.SessionId}})
$configPath=Join-Path $env:APPDATA 'LUK Dental SMS Electron\workstation\sms_config.json'
if (-not (Test-Path -LiteralPath $configPath)) {$configPath=Join-Path $AppDir 'sms_config.json'}
try {
  $config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $uri=$config.bridge_url.TrimEnd('/')+'/health'
  $health=Invoke-RestMethod -Method Get -Uri $uri -Headers @{Authorization='Bearer '+$config.api_token} -TimeoutSec 20
  $report.bridge=@{connected=($health.ok -eq $true);url=$config.bridge_url;clinicTimeZone=$config.time_zone;sendTime=$config.scheduled_send_time;workstationMode=$config.workstation_mode}
} catch { $report.bridge=@{connected=$false;error=$_.Exception.Message} }
if (@($report.tasks | Where-Object {$_.name -notlike 'LUK Dental SMS Electron*' -and $_.state -ne 'Disabled'}).Count -gt 0) {$report.issues+='Old Python tasks are still enabled. Check before enabling Electron monitoring.'}
if ($report.phoneLink.Count -eq 0) {$report.issues+='Phone Link is not running.'}
$file=Join-Path $AppDir 'r5-check-result.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding UTF8
Write-Host "Read-only report saved: $file"
Write-Host 'No SMS or task changes were performed. This report does not prove delivery or UIA compatibility.'
