param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$prefix='LUK Dental SMS Electron'
. (Join-Path $PSScriptRoot 'scheduler-target.ps1')
$taskRegistrationStarted=$false
$autologonChanged=$false
$bstr=[IntPtr]::Zero
try {
  $config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $admin=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Run scheduler setup as Administrator.'}
  if ($config.mode -eq 'off') {
    @('Enable Auto Login','Daily Restart','Start Monitoring','Lock Screen','Screen Off','Daily Recall') | ForEach-Object {
      Unregister-ScheduledTask -TaskName "$prefix - $_" -Confirm:$false -ErrorAction SilentlyContinue
    }
    Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '0'
    if (Test-Path -LiteralPath $config.exe) {
      $stopLaunch=Get-LukSmsLaunch $config @('--stop-reminder-monitoring','--stop-recall-monitoring')
      Start-Process @stopLaunch | Out-Null
    }
    Write-Host 'Daily Appointment + 6M Recall scheduler disabled.'
    exit 0
  }
  if ($config.mode -ne 'on') {throw 'Invalid scheduler mode.'}
  foreach ($key in @('enableLogin','restart','startTool','lock')) {
    if ([string]$config.$key -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {throw 'Scheduler times must use HH:MM.'}
  }
  if (-not (Test-Path -LiteralPath $config.autologon)) {throw 'Select Microsoft Sysinternals Autologon64.exe first.'}
  if (-not (Test-Path -LiteralPath $config.exe)) {throw 'Electron runtime missing. In the source checkout, run npm ci inside sms-reminder-electron first.'}
  $runtime=Join-Path $PSScriptRoot 'scheduler-runtime.ps1'
  if (-not (Test-Path -LiteralPath $runtime)) {throw 'Scheduler runtime script missing.'}
  $requestedUser="$env:COMPUTERNAME\$env:USERNAME"
  if ($config.autoUser) { $requestedUser=if($config.autoDomain){"$($config.autoDomain)\$($config.autoUser)"}else{[string]$config.autoUser} }
  $credential=Get-Credential -UserName $requestedUser -Message 'Windows PASSWORD for auto-login, not a PIN'
  if ($null -eq $credential) {throw 'Setup cancelled.'}
  $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $user=$credential.GetNetworkCredential().UserName
  $domain=$credential.GetNetworkCredential().Domain
  if (-not $domain) {$domain=$env:COMPUTERNAME}
  if (-not $plain) {throw 'The real Windows password is required.'}
  $autologonChanged=$true
  . (Join-Path $PSScriptRoot 'autologon-process.ps1')
  Write-Host 'Waiting for Sysinternals Autologon. Accept its license dialog if shown.'
  Invoke-LukAutologon $config.autologon $user $domain $plain
  $workingDirectory=if($config.workingDirectory){$config.workingDirectory}else{Split-Path -Parent $config.exe}
  $runtimeDir=Get-LukSmsRuntimeDir $config
  $runtimePath=Join-Path $runtimeDir 'scheduler-runtime.json'
  @{exe=$config.exe;appPath=$config.appPath;workingDirectory=$workingDirectory;runtimeDir=$runtimeDir;autoStartReminder=($config.autoStartReminder -ne $false)} | ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding UTF8
  $(if ($config.autoStartReminder -eq $false) {'0'} else {'1'}) | Set-Content -LiteralPath (Join-Path $runtimeDir 'scheduler-start-reminder.flag') -Encoding ASCII
  foreach ($obsolete in @('scheduler-start-holiday.flag','scheduler-start-treatment.flag')) {
    Remove-Item -LiteralPath (Join-Path $runtimeDir $obsolete) -ErrorAction SilentlyContinue
  }
  $systemPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $interactivePrincipal=New-ScheduledTaskPrincipal -UserId "$domain\$user" -LogonType Interactive -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  . (Join-Path $PSScriptRoot 'scheduler-plan.ps1')
  $plan=@(Get-LukSmsTaskPlan $config $runtime $runtimePath $workingDirectory)
  $taskRegistrationStarted=$true
  Unregister-ScheduledTask -TaskName "$prefix - Daily Recall" -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "$prefix - Screen Off" -Confirm:$false -ErrorAction SilentlyContinue
  foreach ($task in $plan) {
    $principal=if($task.principal -eq 'SYSTEM'){$systemPrincipal}else{$interactivePrincipal}
    $action=New-ScheduledTaskAction -Execute $task.exe -Argument $task.args -WorkingDirectory $task.workingDirectory
    Register-ScheduledTask -TaskName $task.name -Action $action -Trigger (New-ScheduledTaskTrigger -Daily -At $task.time) -Principal $principal -Settings $settings -Force | Out-Null
  }
  Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '0'
  foreach ($name in @('Enable Auto Login','Daily Restart','Start Monitoring','Lock Screen')) {
    $task=Get-ScheduledTask -TaskName "$prefix - $name"
    Write-Host "$($task.TaskName): $($task.State)"
  }
  Write-Host 'Electron scheduler created. Times use the Windows workstation time zone.'
  exit 0
} catch {
  if ($taskRegistrationStarted) {
    @('Enable Auto Login','Daily Restart','Start Monitoring','Lock Screen') | ForEach-Object {
      Unregister-ScheduledTask -TaskName "$prefix - $_" -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
  if ($autologonChanged) { Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '0' -ErrorAction SilentlyContinue }
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  $plain=$null
  if ($bstr -ne [IntPtr]::Zero) {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
  Remove-Item -LiteralPath $ConfigPath -ErrorAction SilentlyContinue
}
