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
 # The main assembly can be AnyCPU while CodeBase/CDT requires x86.
 # Inspect metadata without loading any OD code into this process first.
 $architectures = @()
 foreach ($name in @('OpenDentBusiness.dll', 'CodeBase.dll', 'CDT.dll')) {
  $dependencyPath = Join-Path $install $name
  if (-not (Test-Path -LiteralPath $dependencyPath)) { throw ("Missing OD dependency: " + $dependencyPath) }
  $architectures += [Reflection.AssemblyName]::GetAssemblyName($dependencyPath).ProcessorArchitecture.ToString()
 }
 $needs32 = $architectures -contains 'X86'
 $needs64 = $architectures -contains 'Amd64'
 if ($needs32 -and $needs64) { throw 'OD DLLs have incompatible x86/x64 architectures. Check the installed OD files.' }
 if ($needs32 -and [IntPtr]::Size -eq 8) {
  # Ask Node to retry once; never nest PowerShell child processes.
  @{ok=$false;retry32=$true;install=$install;error='Use the 32-bit OD helper for its dependencies.'} | ConvertTo-Json -Compress
  exit 2
 }
 if ($needs64 -and [IntPtr]::Size -eq 4) { throw 'OD dependencies require a 64-bit helper. Check the installed OD files.' }
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
  if ($hash -eq 'BadImageFormatException') { throw (New-Object System.BadImageFormatException('An OD native dependency could not load in this process architecture.')) }
  # OD catches native library failures and returns the exception type as text.
  # Never accept that text as a valid hash, or use a blank fallback.
  if ([string]::IsNullOrWhiteSpace($hash) -or $hash.Length -lt 16 -or $hash -match 'Exception$' -or $hash -match '\s') { throw 'OD did not return a valid SecurityHash for the new split. Check CDT.dll and its dependencies on SERVER.' }
  $results += $hash
 }
 @{ok=$true;processBits=([IntPtr]::Size * 8);version=$version.ToString();culture=[Globalization.CultureInfo]::CurrentCulture.Name;hashes=@($results)} | ConvertTo-Json -Compress -Depth 5
 exit 0
} catch {
 $failure = $_.Exception
 $messages = @($failure.Message)
 $badImage = $failure -is [System.BadImageFormatException]
 while ($failure.InnerException) {
  $failure = $failure.InnerException
  if ($failure -is [System.BadImageFormatException]) { $badImage = $true }
  if ($messages -notcontains $failure.Message) { $messages += $failure.Message }
 }
 # Managed AnyCPU assemblies may load an x86 native dependency only when
 # invoked. Retry only this architecture error, once, through the Node launcher.
 if ($badImage -and [IntPtr]::Size -eq 8 -and $install) {
  @{ok=$false;retry32=$true;install=$install;error='Retry the OD native dependency in a 32-bit helper.'} | ConvertTo-Json -Compress
  exit 2
 }
 @{ok=$false;error=("OD helper (" + ([IntPtr]::Size * 8) + "-bit) [" + $install + "]: " + ($messages -join ' -> '))} | ConvertTo-Json -Compress
 exit 1
} finally {
 if ($resolver) { $resolver.Dispose() }
}
