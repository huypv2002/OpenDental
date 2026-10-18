# Internal helper for NEW split values only. Never reads/writes the OD database,
# modifies an existing row, patches a DLL, or disables integrity checks.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 $rawInput = [Console]::In.ReadToEnd()
 $inputData = $rawInput | ConvertFrom-Json
 $candidates = @()
 if ($env:METLIFE_OD_INSTALL_DIR) { $candidates += $env:METLIFE_OD_INSTALL_DIR }
 $candidates += @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental')
 $install = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDentBusiness.dll') } | Select-Object -First 1
 if (-not $install) { throw 'OpenDentBusiness.dll was not found on SERVER. Check the OD installation directory; METLIFE_OD_INSTALL_DIR is optional for a custom location.' }
 $install = (Resolve-Path -LiteralPath $install).Path
 [Environment]::CurrentDirectory = $install
 Set-Location -LiteralPath $install
 $dll = Join-Path $install 'OpenDentBusiness.dll'
 $architecture = [Reflection.AssemblyName]::GetAssemblyName($dll).ProcessorArchitecture.ToString()
 if ($architecture -eq 'X86' -and [IntPtr]::Size -eq 8) {
  # Ask the Node launcher to retry once with the 32-bit PowerShell executable.
  # Do not nest PowerShell child processes that can outlive the request timeout.
  @{ok=$false;retry32=$true;install=$install;error='Use the 32-bit OD helper.'} | ConvertTo-Json -Compress
  exit 2
 }
 # PowerShell's application base is its own installation directory. Resolve
 # managed OD dependencies explicitly from this installation, on CLR threads
 # as well as the PowerShell thread. Never substitute a different identity.
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public sealed class MetlifeOdAssemblyResolver : IDisposable {
 private readonly string directory;
 public MetlifeOdAssemblyResolver(string directory) {
  this.directory=directory;
  AppDomain.CurrentDomain.AssemblyResolve+=Resolve;
 }
 private Assembly Resolve(object sender, ResolveEventArgs args) {
  var requested=new AssemblyName(args.Name);
  if(String.IsNullOrEmpty(requested.Name) || requested.Name!=Path.GetFileName(requested.Name)
    || requested.Name.IndexOfAny(new char[]{'/', '\\', ':'})>=0) return null;
  var path=Path.Combine(directory,requested.Name+".dll");
  if(!File.Exists(path)) return null;
  var actual=AssemblyName.GetAssemblyName(path);
  if(!String.Equals(actual.FullName,requested.FullName,StringComparison.OrdinalIgnoreCase))
   throw new FileLoadException("OD dependency identity mismatch: requested "+requested.FullName+"; found "+actual.FullName,path);
  return Assembly.LoadFrom(path);
 }
 public void Dispose() { AppDomain.CurrentDomain.AssemblyResolve-=Resolve; }
}
'@
 $resolver = New-Object MetlifeOdAssemblyResolver($install)
 $assembly = [Reflection.Assembly]::LoadFrom($dll)
 $version = $assembly.GetName().Version
 if ($version.Major -ne 24 -or $version.Minor -ne 3) { throw 'The installed OD assembly must be version 24.3 for this adapter.' }
 # Preload direct dependencies, checking identities before CLR binding can
 # unify a different assembly version in the default load context.
 $odAssemblies = @($assembly)
 foreach ($dependency in @('CodeBase.dll', 'CDT.dll')) {
  $dependencyPath = Join-Path $install $dependency
  if (-not (Test-Path -LiteralPath $dependencyPath)) { throw ("Missing OD dependency: " + $dependencyPath) }
  $odAssemblies += [Reflection.Assembly]::LoadFrom($dependencyPath)
 }
 foreach ($odAssembly in $odAssemblies) {
  foreach ($reference in $odAssembly.GetReferencedAssemblies()) {
   $localPath = Join-Path $install ($reference.Name + '.dll')
   if (Test-Path -LiteralPath $localPath) {
    $actual = [Reflection.AssemblyName]::GetAssemblyName($localPath)
    if ($actual.FullName -ne $reference.FullName) { throw ("OD dependency identity mismatch: requested " + $reference.FullName + "; found " + $actual.FullName) }
   }
  }
 }
 $splitType = $assembly.GetType('OpenDentBusiness.PaySplit', $true)
 $serviceType = $assembly.GetType('OpenDentBusiness.PaySplits', $true)
 $method = $serviceType.GetMethod('HashFields', [Type[]]@($splitType))
 if (-not $method) { throw 'The installed OD assembly does not expose PaySplits.HashFields.' }
 $results = @()
 foreach ($row in @($inputData.splits)) {
  if ([string]$row.patNum -notmatch '^[1-9]\d{0,17}$' -or [string]$row.amount -notmatch '^\d+\.\d{2}$' -or [string]$row.date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Invalid new split input.' }
  $split = [Activator]::CreateInstance($splitType)
  $splitType.GetField('PatNum').SetValue($split, [long]$row.patNum)
  $splitType.GetField('SplitAmt').SetValue($split, [double]::Parse($row.amount, [Globalization.CultureInfo]::InvariantCulture))
  $splitType.GetField('DatePay').SetValue($split, [DateTime]::ParseExact($row.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))
  $hash = [string]$method.Invoke($null, @($split))
  # OD catches native library failures and returns the exception type as text.
  # Never accept that text as a valid hash, or use a blank fallback.
  if ([string]::IsNullOrWhiteSpace($hash) -or $hash.Length -lt 16 -or $hash -match 'Exception$' -or $hash -match '\s') { throw 'OD did not return a valid SecurityHash for the new split. Check CDT.dll and its dependencies on SERVER.' }
  $results += $hash
 }
 @{ok=$true;version=$version.ToString();culture=[Globalization.CultureInfo]::CurrentCulture.Name;hashes=@($results)} | ConvertTo-Json -Compress -Depth 5
 exit 0
} catch {
 $failure = $_.Exception
 $messages = @($failure.Message)
 while ($failure.InnerException) {
  $failure = $failure.InnerException
  if ($messages -notcontains $failure.Message) { $messages += $failure.Message }
 }
 @{ok=$false;error=("OD helper [" + $install + "]: " + ($messages -join ' -> '))} | ConvertTo-Json -Compress
 exit 1
} finally {
 if ($resolver) { $resolver.Dispose() }
}
