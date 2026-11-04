# Run locally on each Windows OD workstation. Compiles against its installed DLL.
# Does not register plugins or modify the database or OpenDental.exe.
param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
if (-not $InstallDir) {
 $InstallDir = @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental') |
  Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDental.exe') } | Select-Object -First 1
}
if (-not $InstallDir) { throw 'Open Dental installation not found. Supply -InstallDir.' }
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
$exe = Join-Path $InstallDir 'OpenDental.exe'
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
if ($version.FileMajorPart -ne 24 -or $version.FileMinorPart -ne 3) {
 throw "This plugin targets OD 24.3 only. Installed: $($version.FileVersion)"
}
if (Get-Process -Name OpenDental -ErrorAction SilentlyContinue) { throw 'Close Open Dental on this computer before installing.' }
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler not found.' }
$source = Join-Path $PSScriptRoot 'od-calendar-plugin\LukCalendarNavigation.cs'
$business = Join-Path $InstallDir 'OpenDentBusiness.dll'
$buildDir = Join-Path $env:TEMP ('luk-calendar-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDir | Out-Null
try {
 $dll = Join-Path $buildDir 'LukCalendarNavigation.dll'
 & $compiler /nologo /target:library /platform:anycpu /optimize+ /reference:$business /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:$dll $source
 if ($LASTEXITCODE -ne 0) { throw 'Compilation failed. Nothing installed.' }
 $dest = Join-Path $InstallDir 'LukCalendarNavigation.dll'
 if (Test-Path -LiteralPath $dest) {
  $backup = $dest + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.bak'
  Copy-Item -LiteralPath $dest -Destination $backup -ErrorAction Stop
  Write-Host "Previous plugin backed up: $backup"
 }
 Copy-Item -LiteralPath $dll -Destination $dest -Force
 Write-Host "Installed: $dest"
 Write-Host 'Preview whitelist: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\whitelist-manager.ps1 -PluginToAllow "LukCalendarNavigation.dll"'
 Write-Host 'Review the target DB and preview, then repeat with -Apply. Keep the backup and restart OD clients.'
 Write-Host 'After distributing this DLL to all OD clients, register LukCalendarNavigation.dll in Setup > Program Links, then reopen OD.'
} finally {
 Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
}
