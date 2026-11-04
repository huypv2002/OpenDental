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
$install=Join-Path $env:LOCALAPPDATA 'LUKDental\ODCalendarHotkey'
if (Get-Process -Name LukOdCalendarHotkey -ErrorAction SilentlyContinue) { throw 'Hotkey app is running. Exit its tray icon before updating.' }
[void][IO.Directory]::CreateDirectory($install)
$build=Join-Path $env:TEMP ('luk-od-hotkey-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($build)
try {
 $exe=Join-Path $build 'LukOdCalendarHotkey.exe'
 $references=@('/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:WindowsBase.dll',
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
 Start-Process -FilePath $exe
 Write-Host 'Select OD Appointments and press Ctrl+Alt+6. Exit through the tray icon.'
 Write-Host "Result file: $(Join-Path $install 'last-result.txt')"
}
