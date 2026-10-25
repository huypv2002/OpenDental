param([string]$WindowsDir=([IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot,'../windows'))))
$ErrorActionPreference='Stop'
foreach($file in [IO.Directory]::GetFiles($WindowsDir,'*scheduler*.ps1')) {
  $tokens=$null;$parseErrors=$null
  [Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$parseErrors) > $null
  if($parseErrors.Count){throw "PowerShell syntax failed: $file"}
}
. ([IO.Path]::Combine($WindowsDir,'scheduler-target.ps1'))
function Assert-LukEqual($Actual,$Expected){if($Actual -cne $Expected){throw "Expected $Expected; got $Actual"}}
$temp=[IO.Path]::Combine([IO.Path]::GetTempPath(),('luk source scheduler '+[Guid]::NewGuid().ToString()))
[IO.Directory]::CreateDirectory($temp) > $null
try {
  $source=[IO.Path]::Combine($temp,'source app');$windows=[IO.Path]::Combine($source,'windows')
  [IO.Directory]::CreateDirectory($windows) > $null
  [IO.File]::WriteAllText([IO.Path]::Combine($source,'package.json'),'{"name":"luk-dental-sms-electron"}')
  $target=Get-LukSmsTarget ([IO.Path]::Combine($windows,'.'))
  Assert-LukEqual $target.appPath $source
  Assert-LukEqual $target.workingDirectory $source
  Assert-LukEqual $target.runtimeDir $windows
  Assert-LukEqual $target.exe ([IO.Path]::Combine($source,'node_modules/electron/dist/electron.exe'))
  Assert-LukEqual $target.installer ([IO.Path]::Combine($source,'windows/scheduler.ps1'))
  $start=Get-LukSmsLaunch $target @('--start-reminder-monitoring')
  Assert-LukEqual $start.ArgumentList ('"'+$source+'" --start-reminder-monitoring')
  $stop=Get-LukSmsLaunch $target @('--stop-reminder-monitoring','--stop-recall-monitoring')
  Assert-LukEqual $stop.ArgumentList ('"'+$source+'" --stop-reminder-monitoring --stop-recall-monitoring')
  $noMonitoring=Get-LukSmsLaunch $target
  Assert-LukEqual $noMonitoring.ArgumentList ('"'+$source+'"')
  [IO.File]::WriteAllText([IO.Path]::Combine($source,'Autologon64.exe'),'')
  Assert-LukEqual (Get-LukSmsTarget $windows).autologon ([IO.Path]::Combine($source,'Autologon64.exe'))
  $packaged=[IO.Path]::Combine($temp,'packaged app');[IO.Directory]::CreateDirectory($packaged) > $null
  [IO.File]::WriteAllText([IO.Path]::Combine($packaged,'LUK Dental SMS Electron.exe'),'')
  $target=Get-LukSmsTarget $packaged
  Assert-LukEqual $target.appPath ''
  Assert-LukEqual $target.runtimeDir $packaged
  Assert-LukEqual (Get-LukSmsLaunch $target @('--start-reminder-monitoring')).ArgumentList '--start-reminder-monitoring'
  Assert-LukEqual (Get-LukSmsRuntimeDir @{exe=[IO.Path]::Combine($packaged,'LUK Dental SMS Electron.exe')}) $packaged
  'Scheduler source/package planning passed: quoted paths, start/stop flags, no-monitoring launch, runtime location and legacy config. No Windows tasks or SMS executed.'
} finally {[IO.Directory]::Delete($temp,$true)}
