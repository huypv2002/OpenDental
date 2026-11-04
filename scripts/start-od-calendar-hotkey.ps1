# Compile a standalone hotkey app; no administrator rights, SQL, or plugin registration.
param([switch]$Inspect,[switch]$BuildOnly)
$ErrorActionPreference='Stop'
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
if (Get-Process -Name LukOdCalendarHotkey -ErrorAction SilentlyContinue) { throw 'Hotkey app is running. Exit its tray icon before updating.' }
[void][IO.Directory]::CreateDirectory($install)
$build=Join-Path $env:TEMP ('luk-od-hotkey-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($build)
try {
 $exe=Join-Path $build 'LukOdCalendarHotkey.exe'
 $references=@('/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',('/reference:'+$windowsBase),
  ('/reference:'+(Join-Path $uia 'UIAComWrapper.dll')),('/reference:'+(Join-Path $uia 'Interop.UIAutomationClient.dll')))
 & $compiler /nologo /target:winexe /platform:anycpu /optimize+ @references /out:$exe $source (Join-Path $PSScriptRoot 'od-calendar-hotkey\DatePolicy.cs')
 if ($LASTEXITCODE -ne 0) { throw 'Hotkey compilation failed; nothing launched.' }
 Copy-Item -LiteralPath $exe -Destination $install -Force
 foreach ($file in $manifest.files.PSObject.Properties) { Copy-Item -LiteralPath (Join-Path $uia $file.Name) -Destination $install -Force }
} finally { Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue }
$exe=Join-Path $install 'LukOdCalendarHotkey.exe'
Write-Host "Built: $exe"
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
