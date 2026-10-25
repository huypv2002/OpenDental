param([Parameter(Mandatory=$true)][string]$AppDir,[string]$EnableLogin='08:59',[string]$Restart='09:00',[string]$StartTool='10:55',[string]$Lock='12:05',[switch]$Disable,[switch]$NoMonitoring,[string]$AutoUser='',[string]$AutoDomain='')
$ErrorActionPreference='Stop'
$helper=Join-Path $AppDir 'resources\windows\scheduler-target.ps1'
if (-not (Test-Path -LiteralPath $helper)) {$helper=Join-Path $AppDir 'scheduler-target.ps1'}
. $helper
$target=Get-LukSmsTarget $AppDir
$config=@{mode=if($Disable){'off'}else{'on'};exe=$target.exe;appPath=$target.appPath;workingDirectory=$target.workingDirectory;runtimeDir=$target.runtimeDir;autologon=$target.autologon;enableLogin=$EnableLogin;restart=$Restart;startTool=$StartTool;lock=$Lock;autoStartReminder=(-not $NoMonitoring);autoUser=$AutoUser;autoDomain=$AutoDomain}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('luk-sms-scheduler-'+[Guid]::NewGuid().ToString()+'.json')
try {
  $config | ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding UTF8
  & $target.installer -ConfigPath $temp
  exit $LASTEXITCODE
} finally { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
