param([Parameter(Mandatory=$true)][ValidateSet('run','enable-login','lock')][string]$Mode,[Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'scheduler-target.ps1')
$runtimeDir=Get-LukSmsRuntimeDir $config
$log=Join-Path $runtimeDir 'scheduler-run.log'
function Log([string]$Message) {
  $line="[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch { Write-Host $line }
}
try {
  Log "$Mode task started as $([Security.Principal.WindowsIdentity]::GetCurrent().Name)."
  switch ($Mode) {
    'enable-login' {
      Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '1'
      Log 'Auto-login enabled for the daily restart.'
    }
    'lock' {
      try { Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '0' }
      finally { & rundll32.exe user32.dll,LockWorkStation }
      Log 'Auto-login disabled; lock command sent.'
    }
    'run' {
      if (-not (Test-Path -LiteralPath $config.exe)) { throw 'Electron EXE missing. Reinstall scheduler after moving the app.' }
      Log 'Opening Phone Link.'
      Start-Process explorer.exe 'shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App'
      Start-Sleep -Seconds 15
      $arguments=@()
      $autoStart=$config.autoStartReminder -ne $false
      $flag=Join-Path $runtimeDir 'scheduler-start-reminder.flag'
      if (Test-Path -LiteralPath $flag) { $autoStart=(Get-Content -LiteralPath $flag -Raw).Trim() -ne '0' }
      if ($autoStart) { $arguments=@('--start-reminder-monitoring') }
      Log "Starting Electron; automatic monitoring=$($config.autoStartReminder)."
      $start=Get-LukSmsLaunch $config $arguments
      $process=Start-Process @start
      Log "Electron launched (PID $($process.Id)); app enforces one instance and preserves an active job."
    }
  }
  exit 0
} catch {
  Log "FAILED: $($_.Exception.Message)"
  Write-Error $_.Exception.Message
  exit 1
}
