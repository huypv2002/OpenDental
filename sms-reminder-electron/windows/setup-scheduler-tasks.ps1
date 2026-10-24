param([Parameter(Mandatory=$true)][string]$AppDir,[string]$EnableLogin='08:59',[string]$Restart='09:00',[string]$StartTool='10:55',[string]$Lock='12:05',[switch]$Disable,[switch]$NoMonitoring,[string]$AutoUser='',[string]$AutoDomain='')
$ErrorActionPreference='Stop'
$config=@{mode=if($Disable){'off'}else{'on'};exe=(Join-Path $AppDir 'LUK Dental SMS Electron.exe');autologon=(Join-Path $AppDir 'Autologon64.exe');enableLogin=$EnableLogin;restart=$Restart;startTool=$StartTool;lock=$Lock;autoStartReminder=(-not $NoMonitoring);autoUser=$AutoUser;autoDomain=$AutoDomain}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('luk-sms-scheduler-'+[Guid]::NewGuid().ToString()+'.json')
try {
  $config | ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding UTF8
  & (Join-Path $AppDir 'resources\windows\scheduler.ps1') -ConfigPath $temp
  exit $LASTEXITCODE
} finally { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
