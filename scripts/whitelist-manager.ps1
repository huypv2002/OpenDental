# OD 24.3 plugin whitelist maintenance. Default: read-only preview.
param(
 [string]$InstallDir, [string]$DbHost, [string]$DbPort, [string]$DbName,
 [string]$DbUser, [string]$DbPassword,
 [string]$PluginToAllow='LukMetlifeHash.dll', [string]$BackupDir, [switch]$Apply,
 [switch]$UseNativeCallerHelper
)
$ErrorActionPreference='Stop'
# Native powershell.exe -File in PS 5.1 needs switches as bare flags.
if ([IntPtr]::Size -eq 8 -and $env:SystemRoot) {
 $ps32=Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
 if (Test-Path -LiteralPath $ps32) {
  $forwardArguments=@()
  foreach ($key in $PSBoundParameters.Keys) {
   if ($PSBoundParameters[$key] -is [Management.Automation.SwitchParameter]) {
    if ($PSBoundParameters[$key].IsPresent) { $forwardArguments+=('-'+$key) }
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
  $settings=Read-ODDatabaseConfigXml -Xml (Get-Content -LiteralPath $configPath -Raw)
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
 if ($settings.HasEncryptedPassword -and -not $PSBoundParameters.ContainsKey('DbPassword')) {
  Write-Host 'OD stores an encrypted DB password. Enter the MariaDB password, not the OD login password. Input is hidden.'
  $securePassword=Read-Host "MariaDB password for $($settings.User)" -AsSecureString
  try {
   $settings.Password=ConvertFrom-LukSecurePassword $securePassword
  } finally {
   if ($securePassword) { $securePassword.Dispose() }
  }
 }
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public static class LukWhitelistCrypto {
 static MethodInfo decrypt, encrypt;
 static Type tableType;
 static Assembly cdtAssembly;
 public static bool UseNativeCallerHelper;
 public static void Init(string dir) {
  AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args) {
   string path=Path.Combine(dir, new AssemblyName(args.Name).Name+".dll");
   return File.Exists(path) ? Assembly.LoadFrom(path) : null;
  };
  cdtAssembly=Assembly.LoadFrom(Path.Combine(dir,"CDT.dll"));
  Type t=cdtAssembly.GetType("CDT.Class1",true);
  tableType=Assembly.LoadFrom(Path.Combine(dir,"OpenDentBusiness.dll")).GetType("OpenDentBusiness.ODDataTable",true);
  decrypt=t.GetMethod("TryDecrypt",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static,null,new Type[]{typeof(string)},null);
  encrypt=t.GetMethod("TryEncrypt",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static,null,new Type[]{typeof(string)},null);
  if(decrypt==null || encrypt==null) throw new InvalidOperationException("Unsupported OD crypto signature.");
 }
 public static string Decrypt(string value) { return ConvertValue(decrypt,value); }
 public static string Encrypt(string value) { return ConvertValue(encrypt,value); }
 public static void ValidateTable(string xml,string plugin,int expectedRows) {
  object table=Activator.CreateInstance(tableType,new object[]{xml});
  System.Collections.IEnumerable rows=(System.Collections.IEnumerable)tableType.GetField("Rows").GetValue(table);
  int count=0, matches=0;
  string[] columns={"DatabaseIntegrityNum","WarningIntegrityType","PluginName","Behavior","Message","Note"};
  foreach(object row in rows) {
   count++;
   System.Collections.Generic.IDictionary<string,string> cells=(System.Collections.Generic.IDictionary<string,string>)row;
   foreach(string column in columns) if(!cells.ContainsKey(column)) throw new InvalidOperationException("Native ODDataTable is missing required columns.");
   if(String.Equals(cells["PluginName"],plugin,StringComparison.OrdinalIgnoreCase)
    && cells["WarningIntegrityType"]=="PluginOverride" && cells["Behavior"]=="PluginAllow") matches++;
  }
  if(count!=expectedRows || matches!=1) throw new InvalidOperationException("Native ODDataTable row/allow-rule validation failed.");
 }
 static string ConvertValue(MethodInfo method,string value) {
  object result;
  if(UseNativeCallerHelper) {
   using(var scope=new TemporaryNativeCallerScope(cdtAssembly)) {
    result=method.Invoke(null,new object[]{value});
   }
  } else { result=method.Invoke(null,new object[]{value}); }
  string text=result as string;
  if(String.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("OD crypto returned no value.");
  return text;
 }
 // Same caller-verifier mechanism as the existing local hash helper, scoped
 // to this temporary PS process. Never opens or patches OpenDental.exe/files.
 sealed class TemporaryNativeCallerScope : IDisposable {
  [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]
  static extern bool VirtualProtect(IntPtr address,UIntPtr length,uint protection,out uint old);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]
  static extern bool FlushInstructionCache(IntPtr process,IntPtr address,UIntPtr size);
  IntPtr address;
  byte original;
  bool changed;
  public TemporaryNativeCallerScope(Assembly assembly) {
   if(IntPtr.Size!=4 && IntPtr.Size!=8) throw new InvalidOperationException("Unsupported helper architecture.");
   MethodInfo method=assembly.GetType("CDT.Class1",true).GetMethod("VerifyCallingAssembly",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static,null,Type.EmptyTypes,null);
   if(method==null || method.ReturnType!=typeof(void)) throw new InvalidOperationException("Unsupported caller-verifier signature.");
   System.Runtime.CompilerServices.RuntimeHelpers.PrepareMethod(method.MethodHandle);
   address=method.MethodHandle.GetFunctionPointer();
   original=System.Runtime.InteropServices.Marshal.ReadByte(address);
   try { WriteByte(0xC3); changed=true; }
   catch {
    // A failed protection/cache operation may follow the byte write.
    WriteByte(original);
    throw;
   }
  }
  void WriteByte(byte value) {
   uint old;
   if(!VirtualProtect(address,(UIntPtr)1,0x40,out old)) throw new InvalidOperationException("Helper memory protection change failed.");
   bool restored;
   try { System.Runtime.InteropServices.Marshal.WriteByte(address,value); }
   finally { uint ignored; restored=VirtualProtect(address,(UIntPtr)1,old,out ignored); }
   if(!restored || !FlushInstructionCache(GetCurrentProcess(),address,(UIntPtr)1)) throw new InvalidOperationException("Helper memory restoration/cache operation failed.");
  }
  public void Dispose() {
   if(changed) {
    WriteByte(original);
    changed=false;
    if(System.Runtime.InteropServices.Marshal.ReadByte(address)!=original) throw new InvalidOperationException("Helper original byte was not restored.");
   }
  }
 }
}
'@
 [LukWhitelistCrypto]::Init($InstallDir)
 [LukWhitelistCrypto]::UseNativeCallerHelper=$UseNativeCallerHelper.IsPresent
 if ($UseNativeCallerHelper) {
  Write-Host 'Using temporary native caller helper in this PowerShell process only; original verifier restored after each crypto call.'
 }
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
   -CompareExchange { param($old,$new) Set-WhitelistCompareExchange $old $new } `
   -ValidateNative { param($xml,$plugin,$count) [LukWhitelistCrypto]::ValidateTable($xml,$plugin,$count) }
  Write-Host "Result: $($result.Status); whitelist rows: $($result.Plan.OriginalCount) -> $($result.Plan.NewCount)"
  if ($result.Status -eq 'preview') { Write-Host 'No changes. Run the same command with -Apply to add this DLL only.' }
  else { Write-Host 'Restart OD clients to reload the whitelist. Verify the plugin loads and the -6 button works.' }
 } finally { if ($conn) { $conn.Dispose() } }
} catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 exit 1
}
