# Compile a standalone hotkey app; no administrator rights, SQL, or plugin registration.
param([switch]$Inspect,[switch]$BuildOnly,[switch]$Startup,[switch]$Restart)
$ErrorActionPreference='Stop'
if ($Inspect -and ($Startup -or $Restart)) { throw '-Inspect cannot be combined with -Startup or -Restart.' }
$root=Split-Path $PSScriptRoot -Parent
$source=Join-Path $PSScriptRoot 'od-calendar-hotkey\LukOdCalendarHotkey.cs'
$uia=Join-Path $root 'metlife-electron\windows\uia3'
$manifest=Get-Content -LiteralPath (Join-Path $uia 'manifest.json') -Raw | ConvertFrom-Json
foreach ($file in $manifest.files.PSObject.Properties) {
 if ((Get-FileHash -LiteralPath (Join-Path $uia $file.Name) -Algorithm SHA256).Hash -ine $file.Value) { throw ('UIA library checksum mismatch: '+$file.Name) }
}
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler not found.' }
# csc.exe does not search its WPF subdirectory for bare assembly filenames.
$frameworkDir=Split-Path $compiler -Parent
$windowsBase=@((Join-Path $frameworkDir 'WPF\WindowsBase.dll'),(Join-Path $frameworkDir 'WindowsBase.dll')) |
 Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $windowsBase) {
 try {
  $assembly=[Reflection.Assembly]::Load('WindowsBase, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  if ($assembly.GetName().Version.Major -eq 4 -and $assembly.Location -and (Test-Path -LiteralPath $assembly.Location)) { $windowsBase=$assembly.Location }
 } catch { }
}
if (-not $windowsBase) { throw 'WindowsBase.dll for .NET Framework 4.x was not found in WPF or the assembly cache. Nothing launched.' }
$install=Join-Path $env:LOCALAPPDATA 'LUKDental\ODCalendarHotkey'
if (-not $Restart -and (Get-Process -Name LukOdCalendarHotkey -ErrorAction SilentlyContinue)) { throw 'Hotkey app is running. Exit its tray icon or use -Restart before updating.' }
[void][IO.Directory]::CreateDirectory($install)
$build=Join-Path $env:TEMP ('luk-od-hotkey-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($build)
try {
 $exe=Join-Path $build 'LukOdCalendarHotkey.exe'
 $references=@('/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',('/reference:'+$windowsBase),
  ('/reference:'+(Join-Path $uia 'UIAComWrapper.dll')),('/reference:'+(Join-Path $uia 'Interop.UIAutomationClient.dll')))
 & $compiler /nologo /target:winexe /platform:anycpu /optimize+ @references /out:$exe $source (Join-Path $PSScriptRoot 'od-calendar-hotkey\DatePolicy.cs')
 if ($LASTEXITCODE -ne 0) { throw 'Hotkey compilation failed; nothing launched.' }
 # Compile first, then replace only this user's installed running utility.
 if ($Restart) {
  $installedExe=Join-Path $install 'LukOdCalendarHotkey.exe'
  $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
  $running=@(Get-Process -Name LukOdCalendarHotkey -ErrorAction SilentlyContinue)
  foreach ($item in $running) {
   if ($item.SessionId -ne $session -or $item.Path -ine $installedExe) { throw 'A different hotkey installation/session is running. Close that instance before updating.' }
  }
  foreach ($item in $running) {
   Stop-Process -Id $item.Id -ErrorAction Stop
   if (-not $item.WaitForExit(5000)) { throw 'The old hotkey app did not exit. Nothing launched.' }
  }
 }
 Copy-Item -LiteralPath $exe -Destination $install -Force
 foreach ($file in $manifest.files.PSObject.Properties) { Copy-Item -LiteralPath (Join-Path $uia $file.Name) -Destination $install -Force }
} finally { Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue }
$exe=Join-Path $install 'LukOdCalendarHotkey.exe'
Write-Host "Built: $exe"
if ($Startup) {
 $runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
 $entry='LUKOdCalendarHotkey'
 $command='"'+$exe+'"'
 if (-not (Test-Path -LiteralPath $runKey)) { [void](New-Item -Path $runKey -Force) }
 $previous=Get-ItemProperty -LiteralPath $runKey -Name $entry -ErrorAction SilentlyContinue
 if ($previous -and $previous.$entry -cne $command) {
  @{RegistryPath=$runKey;Name=$entry;PreviousValue=$previous.$entry} | ConvertTo-Json |
   Set-Content -LiteralPath (Join-Path $install ('startup-backup-'+[Guid]::NewGuid().ToString('N')+'.json')) -Encoding UTF8
 }
 [void](New-ItemProperty -LiteralPath $runKey -Name $entry -Value $command -PropertyType String -Force)
 if ((Get-ItemPropertyValue -LiteralPath $runKey -Name $entry) -cne $command) { throw 'Startup registry readback failed.' }
 Write-Host 'Startup enabled for this Windows account (HKCU Run). No shortcut created.'
}
if ($Inspect) {
 $report=Join-Path $install 'inspect.txt'
 Start-Process -FilePath $exe -ArgumentList @('--inspect',('"'+$report+'"')) -Wait
 Get-Content -LiteralPath $report
} elseif (-not $BuildOnly) {
 $process=Start-Process -FilePath $exe -PassThru
 Write-Host "Started process: $($process.Id)"
 Write-Host 'Select OD Appointments and press Alt+6. Exit through the tray icon.'
 Write-Host "Result file: $(Join-Path $install 'last-result.txt')"
 Write-Host 'The file now includes Build and UTC time. WAITING means no hotkey has been received in this run; RUNNING means the shortcut reached the app.'
}
