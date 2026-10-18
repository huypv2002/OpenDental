# Internal diagnostics only: no database connection and no real patient inputs.
param([string]$OutputPath='metlife-od-context.json',[string]$InstallDir)
$ErrorActionPreference='Stop'
$oldInstall=$env:METLIFE_OD_INSTALL_DIR
$reportPath=[IO.Path]::GetFullPath($OutputPath)
try {
 if ($InstallDir) { $env:METLIFE_OD_INSTALL_DIR=$InstallDir }
 else {
  # Read only this non-secret path setting; never export the .env contents.
  $envFile=Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  if (Test-Path -LiteralPath $envFile) {
   $setting=Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*METLIFE_OD_INSTALL_DIR\s*=' } | Select-Object -Last 1
   if ($setting) { $env:METLIFE_OD_INSTALL_DIR=($setting -split '=',2)[1].Trim().Trim('"').Trim("'") }
  }
 }
 $request='{"splits":[{"patNum":"1","amount":"0.01","date":"2000-01-01"}]}'
 $helper=Join-Path $PSScriptRoot 'metlife-new-split-hashes.ps1'
 $probes=@()
 foreach ($folder in @('System32','SysWOW64')) {
  $exe=Join-Path $env:SystemRoot ($folder+'\WindowsPowerShell\v1.0\powershell.exe')
  if (-not (Test-Path -LiteralPath $exe)) { continue }
  $raw=$request | & $exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -ContextDiagnostics
  $exitCode=$LASTEXITCODE
  try { $result=($raw -join "`n") | ConvertFrom-Json }
  catch { $result=@{ok=$false;error='Helper did not return JSON.'} }
  # Do not export synthetic hash values either; context is all that is needed.
  if ($result.PSObject.Properties['hashes']) { $result.PSObject.Properties.Remove('hashes') }
  $probes+=@{launcher=$exe;exitCode=$exitCode;result=$result}
 }
 $clients=@(Get-Process -Name OpenDental -ErrorAction SilentlyContinue | ForEach-Object {
  $clientPath=$null;$modules=@();$inspectionError=$null
  try {
   $clientPath=$_.MainModule.FileName
   $modules=@($_.Modules | Where-Object { $_.ModuleName -in @('OpenDental.exe','OpenDentBusiness.dll','CodeBase.dll','CDT.dll','clr.dll') } | ForEach-Object {
    @{name=$_.ModuleName;path=$_.FileName;fileVersion=$_.FileVersionInfo.FileVersion}
   })
  } catch { $inspectionError=$_.Exception.Message }
  @{id=$_.Id;path=$clientPath;modules=$modules;inspectionError=$inspectionError}
 })
 $report=@{
  capturedAt=[DateTime]::UtcNow.ToString('o')
  databaseAccess=$false
  syntheticInputOnly=$true
  limitations='Client process metadata only; this does not execute code inside Open Dental or reproduce its complete runtime context.'
  clients=$clients
  probes=$probes
 }
 $json=$report | ConvertTo-Json -Depth 12
 [IO.File]::WriteAllText($reportPath,$json,(New-Object Text.UTF8Encoding($false)))
 Write-Output ('Saved OD context diagnostics: '+$reportPath)
 foreach ($probe in $probes) {
  Write-Output ($probe.launcher+': ok='+$probe.result.ok)
  if ($probe.result.error) { Write-Output $probe.result.error }
 }
} finally {
 $env:METLIFE_OD_INSTALL_DIR=$oldInstall
}
