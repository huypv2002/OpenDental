# OD 24.3 plugin whitelist maintenance. Default: read-only preview.
param(
 [string]$InstallDir, [string]$DbHost, [string]$DbPort, [string]$DbName,
 [string]$DbUser, [string]$DbPassword,
 [string]$PluginToAllow='LukMetlifeHash.dll', [string]$BackupDir, [switch]$Apply
)
$ErrorActionPreference='Stop'
# Native powershell.exe -File in PS 5.1 needs switches as bare flags.
if ([IntPtr]::Size -eq 8 -and $env:SystemRoot) {
 $ps32=Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
 if (Test-Path -LiteralPath $ps32) {
  $forwardArguments=@()
  foreach ($key in $PSBoundParameters.Keys) {
   if ($key -eq 'Apply') {
    if ($Apply) { $forwardArguments+='-Apply' }
   } else {
    $forwardArguments+=('-'+$key)
    $forwardArguments+=[string]$PSBoundParameters[$key]
   }
  }
  & $ps32 -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @forwardArguments
  exit $LASTEXITCODE
 }
}
try {
 if (-not $env:SystemRoot) { throw 'Run this script in Windows PowerShell on the OD workstation.' }
 . (Join-Path $PSScriptRoot 'whitelist-manager-core.ps1')
 if (-not $InstallDir) {
  $InstallDir=@("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental') |
   Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDental.exe') } | Select-Object -First 1
 }
 if (-not $InstallDir) { throw 'OD installation not found. Supply -InstallDir.' }
 $InstallDir=(Resolve-Path -LiteralPath $InstallDir).Path
 $version=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $InstallDir 'OpenDental.exe'))
 if ($version.FileMajorPart -ne 24 -or $version.FileMinorPart -ne 3) { throw 'This script targets OD 24.3 only.' }
 if ($PluginToAllow -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*\.dll$') { throw 'Expected a DLL filename, without a directory.' }
 if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $PluginToAllow))) { throw "Plugin DLL is not installed: $PluginToAllow" }
 # Explicit parameters override one config source. Never silently guess localhost/root.
 $configPath=@((Join-Path $InstallDir 'FreeDentalConfig.xml'), 'C:\OpenDental\FreeDentalConfig.xml',
  (Join-Path $env:LOCALAPPDATA 'Open_Dental_Software\FreeDentalConfig.xml')) |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
 $settings=@{}
 if ($configPath) {
  [xml]$config=Get-Content -LiteralPath $configPath -Raw
  $root=$config.SelectSingleNode('/ConnectionData')
  if (-not $root) { throw 'Unknown FreeDentalConfig.xml layout.' }
  $connections=@($root.SelectNodes('DatabaseConnection'))
  if ($connections.Count -gt 1) { throw 'Multiple DB connections in config; inspect before choosing a target.' }
  if ($connections.Count -eq 1) { $connection=$connections[0] } else { $connection=$root }
  $settings.Host=[string]$connection.ComputerName; $settings.Name=[string]$connection.Database
  $settings.User=[string]$connection.User; $settings.Password=[string]$connection.Password
  if ($connection.SelectSingleNode('MySQLPassHash') -and [string]$connection.MySQLPassHash) {
   if (-not $PSBoundParameters.ContainsKey('DbPassword')) { throw 'Encrypted DB password detected; supply DB credentials explicitly.' }
  }
 }
 if ($DbHost) { $settings.Host=$DbHost }; if ($DbName) { $settings.Name=$DbName }
 if ($DbUser) { $settings.User=$DbUser }
 if ($PSBoundParameters.ContainsKey('DbPassword')) { $settings.Password=$DbPassword }
 if (-not $settings.Host -or -not $settings.Name -or -not $settings.User) {
  throw 'Incomplete DB configuration. Supply -DbHost, -DbName, -DbUser and credentials or use the installed FreeDentalConfig.xml.'
 }
 $port=3306; if ($DbPort) { $port=[int]$DbPort }
 if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid DB port.' }
 Write-Host "Target: $($settings.Host):$port / $($settings.Name); plugin: $PluginToAllow"
 Write-Host ('Mode: '+$(if ($Apply) { 'APPLY (backup + guarded update)' } else { 'PREVIEW ONLY (no writes)' }))
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public static class LukWhitelistCrypto {
 static MethodInfo decrypt, encrypt;
 public static void Init(string dir) {
  AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args) {
   string path=Path.Combine(dir, new AssemblyName(args.Name).Name+".dll");
   return File.Exists(path) ? Assembly.LoadFrom(path) : null;
  };
  Type t=Assembly.LoadFrom(Path.Combine(dir,"CDT.dll")).GetType("CDT.Class1",true);
  decrypt=t.GetMethod("TryDecrypt",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static,null,new Type[]{typeof(string)},null);
  encrypt=t.GetMethod("TryEncrypt",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static,null,new Type[]{typeof(string)},null);
  if(decrypt==null || encrypt==null) throw new InvalidOperationException("Unsupported OD crypto signature.");
 }
 public static string Decrypt(string value) { return ConvertValue(decrypt,value); }
 public static string Encrypt(string value) { return ConvertValue(encrypt,value); }
 static string ConvertValue(MethodInfo method,string value) {
  object result=method.Invoke(null,new object[]{value});
  string text=result as string;
  if(String.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("OD crypto returned no value.");
  return text;
 }
}
'@
 [LukWhitelistCrypto]::Init($InstallDir)
 $conn=$null
 foreach ($provider in @(
  @{File='MySqlConnector.dll'; Type='MySqlConnector.MySqlConnection'},
  @{File='MySql.Data.dll'; Type='MySql.Data.MySqlClient.MySqlConnection'})) {
  $path=Join-Path $InstallDir $provider.File
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $assembly=[Reflection.Assembly]::LoadFrom($path)
  $type=$assembly.GetType($provider.Type,$true); $conn=[Activator]::CreateInstance($type)
  break
 }
 if (-not $conn) { throw 'MySqlConnector.dll or MySql.Data.dll is required in the OD installation. No CLI password fallback is used.' }
 $builder=New-Object System.Data.Common.DbConnectionStringBuilder
 $builder['Server']=$settings.Host; $builder['Database']=$settings.Name
 $builder['User ID']=$settings.User; $builder['Password']=$settings.Password
 $builder['Port']=$port; $builder['Connection Timeout']=10
 $conn.ConnectionString=$builder.ConnectionString
 try {
  try { $conn.Open() } catch { throw 'Database connection failed. Check OD config/credentials; no DB change was attempted.' }
  function Read-WhitelistValue {
   $cmd=$conn.CreateCommand()
   try {
    $cmd.CommandText="SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList'"
    $reader=$cmd.ExecuteReader()
    try {
     if (-not $reader.Read()) { throw 'Whitelist preference row is missing.' }
     $value=$reader.GetValue(0)
     if ($reader.Read()) { throw 'Duplicate whitelist preference rows; stop for review.' }
     return $value
    } finally { $reader.Dispose() }
   } finally { $cmd.Dispose() }
  }
  function Set-WhitelistCompareExchange([string]$OldValue,[string]$NewValue) {
   $cmd=$conn.CreateCommand()
   try {
    $cmd.CommandText="UPDATE preference SET ValueString=@new WHERE PrefName='DatabaseIntegritiesWhiteList' AND BINARY ValueString=BINARY @old"
    foreach ($pair in @(@{Name='@new';Value=$NewValue},@{Name='@old';Value=$OldValue})) {
     $parameter=$cmd.CreateParameter(); $parameter.ParameterName=$pair.Name; $parameter.Value=$pair.Value
     [void]$cmd.Parameters.Add($parameter)
    }
    return $cmd.ExecuteNonQuery()
   } finally { $cmd.Dispose() }
  }
  function Save-WhitelistBackup([string]$OldValue,[string]$NewValue) {
   if (-not $BackupDir) { $BackupDir=Join-Path $env:LOCALAPPDATA 'LUKDental\Backups\plugin-whitelist' }
   [void][IO.Directory]::CreateDirectory($BackupDir)
   $file=Join-Path $BackupDir ((Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'-'+[Guid]::NewGuid().ToString('N')+'.json')
   $backup=[ordered]@{Kind='OD-plugin-whitelist-backup-v1';TimeUtc=[DateTime]::UtcNow.ToString('o')
    Server=$settings.Host;Database=$settings.Name;Plugin=$PluginToAllow
    OriginalCipher=$OldValue;IntendedCipher=$NewValue}
   $bytes=[Text.Encoding]::UTF8.GetBytes(($backup | ConvertTo-Json -Depth 5))
   $stream=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
   Write-Host "Backup: $file"
   return $file
  }
  $result=Invoke-PluginWhitelistChange -PluginName $PluginToAllow -Apply:$Apply `
   -ReadValue { Read-WhitelistValue } -Decrypt { param($value) [LukWhitelistCrypto]::Decrypt($value) } `
   -Encrypt { param($value) [LukWhitelistCrypto]::Encrypt($value) } `
   -SaveBackup { param($old,$new) Save-WhitelistBackup $old $new } `
   -CompareExchange { param($old,$new) Set-WhitelistCompareExchange $old $new }
  Write-Host "Result: $($result.Status); whitelist rows: $($result.Plan.OriginalCount) -> $($result.Plan.NewCount)"
  if ($result.Status -eq 'preview') { Write-Host 'No changes. Run the same command with -Apply to add this DLL only.' }
  else { Write-Host 'Restart OD clients to reload the whitelist. Verify the plugin loads and the -6 button works.' }
 } finally { if ($conn) { $conn.Dispose() } }
} catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 exit 1
}
