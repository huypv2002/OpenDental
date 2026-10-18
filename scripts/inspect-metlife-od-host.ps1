# Build/run a named standalone .NET host. No database connection, no DLL changes.
param([string]$OutputPath='metlife-od-host-context.json',[string]$InstallDir,[ValidateSet('x86','x64')][string]$Architecture='x86')
$ErrorActionPreference='Stop'
$reportPath=[IO.Path]::GetFullPath($OutputPath)
if (-not $InstallDir) {
 $InstallDir=$env:METLIFE_OD_INSTALL_DIR
 $envFile=Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
 if (-not $InstallDir -and (Test-Path -LiteralPath $envFile)) {
  $setting=Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*METLIFE_OD_INSTALL_DIR\s*=' } | Select-Object -Last 1
  if ($setting) { $InstallDir=($setting -split '=',2)[1].Trim().Trim('"').Trim("'") }
 }
}
if (-not $InstallDir) {
 $InstallDir=@("${env:ProgramFiles(x86)}\Open Dental","$env:ProgramFiles\Open Dental",'C:\Open Dental') | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDentBusiness.dll') } | Select-Object -First 1
}
if (-not $InstallDir) { throw 'OD installation not found. Pass -InstallDir.' }
$InstallDir=(Resolve-Path -LiteralPath $InstallDir).Path
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler not found.' }
$buildDir=Join-Path $env:TEMP ('metlife-od-host-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDir | Out-Null
try {
 $exe=Join-Path $buildDir 'MetlifeOdContextHost.exe'
 & $compiler /nologo /target:exe ('/platform:'+$Architecture) /reference:System.Web.Extensions.dll ('/out:'+$exe) (Join-Path $PSScriptRoot 'metlife-od-context-host.cs')
 if ($LASTEXITCODE -ne 0) { throw 'Standalone diagnostic host compilation failed.' }
 & $exe $InstallDir $reportPath
 if ($LASTEXITCODE -ne 0) { throw 'Standalone diagnostic host could not run.' }
} finally {
 Remove-Item -LiteralPath $buildDir -Recurse -Force
}
